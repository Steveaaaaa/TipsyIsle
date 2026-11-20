import * as z from 'zod';
import _ from 'lodash';
import { normalizeMvuVariables } from '../pipeline/mvu-data';
import { mvuPathParts, type MvuCommand } from '../pipeline/mvu-commands';
import { assertMvuKey, mvuJsonValue, parseMvuCommandValue } from '../pipeline/mvu-values';

export type MvuSchemaProvider = z.ZodType | (() => z.ZodType);

export function resolveMvuSchema(provider: MvuSchemaProvider): z.ZodType {
    const source = typeof provider === 'function' ? provider() : provider;
    if (!source || typeof source.parseAsync !== 'function') throw new Error('MVU 变量结构必须是 Zod Schema 或返回 Schema 的函数');
    return source instanceof z.ZodObject ? z.looseObject(source.shape) : source;
}

/** Follow mvu_zod's loose root and root merge, while retaining the author's nested rules/transforms. */
export async function parseMvuVariables(variables: Record<string, any>, provider?: MvuSchemaProvider): Promise<Record<string, any>> {
    const normalized = normalizeMvuVariables(variables).variables;
    if (!provider) return normalized;
    const schema = resolveMvuSchema(provider);
    const parsed = await schema.parseAsync(structuredClone(normalized.stat_data ?? {}));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('MVU 变量结构必须返回对象');
    return { ...normalized, stat_data: { ...normalized.stat_data, ...parsed } };
}

/** Independent adapter for the pinned mvu_zod command contract. Per-command
 * candidates preserve earlier valid updates when a later command fails validation. */
export async function applyMvuSchemaCommands(variables: Record<string, any>, commands: MvuCommand[], provider: MvuSchemaProvider,
    warning: (command: MvuCommand, error: unknown) => void): Promise<void> {
    const schema = resolveMvuSchema(provider);
    const path = (value: unknown) => {
        const parts = mvuPathParts(value);
        if (['stat_data', 'status_current_variables'].includes(parts[0])) parts.shift();
        return parts;
    };
    const protectedPath = (parts: string[]) => parts.some(part => part.startsWith('_'));
    const parsedValue = async (value: any) => mvuJsonValue(await parseMvuCommandValue(value, false));
    const remove = (root: any, parts: string[]) => {
        if (!parts.length) throw new Error('不能删除 MVU 根变量表');
        const parent = parts.length === 1 ? root : _.get(root, parts.slice(0, -1));
        if (Array.isArray(parent)) {
            const index = Number(parts.at(-1));
            if (!Number.isInteger(index) || index < 0 || index >= parent.length) throw new Error('MVU Zod 删除下标越界');
            parent.splice(index, 1);
        } else if (parent && typeof parent === 'object') delete parent[parts.at(-1)!];
    };
    const validate = async (candidate: any): Promise<Record<string, any>> => {
        const parsed = await schema.parseAsync(candidate);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('MVU 变量结构必须返回对象');
        return mvuJsonValue(parsed);
    };
    if (commands.length > 4096) throw new Error('单条消息的 MVU 命令超过 4096 项');
    for (const command of commands) {
        try {
            if (!command || !Array.isArray(command.args)) throw new Error('MVU 命令缺少 args');
            const target = path(command.args[0]);
            if (protectedPath(target)) continue;
            const { $internal: _internal, ...business } = variables.stat_data ?? {};
            let candidate = structuredClone(business);
            let parsed: Record<string, any>;
            const removed: string[][] = [];
            const assign = (parts: string[], value: any) => {
                if (!parts.length) candidate = value;
                else _.set(candidate, parts, value);
            };
            const read = () => target.length ? _.get(candidate, target) : candidate;
            switch (command.type) {
                case 'set': {
                    if (command.args.length < 2) throw new Error('set 缺少值');
                    assign(target, await parsedValue(command.args.at(-1))); parsed = await validate(candidate); break;
                }
                case 'add': {
                    if (!target.length || typeof read() !== 'number') throw new Error('MVU Zod add 只能更新数值字段');
                    const delta = Number(await parseMvuCommandValue(command.args[1], false));
                    assign(target, mvuJsonValue(read() + delta)); parsed = await validate(candidate); break;
                }
                case 'assign': case 'insert': {
                    if (command.args.length < 2) throw new Error('insert 缺少值');
                    const indexed = command.args.length >= 3;
                    const key = indexed ? await parseMvuCommandValue(command.args[1], false) : undefined;
                    const value = await parsedValue(command.args.at(-1));
                    const insert = (container: any) => {
                        if (!container || typeof container !== 'object') throw new Error('MVU Zod insert 的目标必须为集合');
                        if (Array.isArray(container)) {
                            if (indexed && key !== '-' && !Number.isInteger(Number(key))) throw new Error('MVU Zod 数组下标无效');
                            container.splice(!indexed || key === '-' ? container.length : Number(key), 0, structuredClone(value));
                        } else if (indexed) {
                            const name = String(key); assertMvuKey(name);
                            container[name] = structuredClone(value);
                        } else {
                            if (!value || typeof value !== 'object') throw new Error('MVU Zod 对象插入需要对象值');
                            Object.assign(container, structuredClone(value));
                        }
                    };
                    if (read() == null) {
                        const base = structuredClone(candidate);
                        try { assign(target, {}); insert(read()); parsed = await validate(candidate); }
                        catch { candidate = base; assign(target, []); insert(read()); parsed = await validate(candidate); }
                    } else { insert(read()); parsed = await validate(candidate); }
                    break;
                }
                case 'remove': case 'unset': case 'delete': {
                    const deleted = command.args.length > 1 ? [...target, ...path(command.args[1])] : target;
                    if (protectedPath(deleted)) continue;
                    remove(candidate, deleted); removed.push(deleted); parsed = await validate(candidate); break;
                }
                case 'move': case 'copy': {
                    const destination = path(command.args[1]);
                    if (protectedPath(destination)) continue;
                    if (!target.length || !_.has(candidate, target)) throw new Error('MVU Zod 移动源不存在');
                    if (destination.length > target.length && target.every((part, i) => destination[i] === part)) throw new Error('不能移动到自身子节点');
                    const value = structuredClone(_.get(candidate, target));
                    if (command.type === 'move') {
                        remove(candidate, target); removed.push(target);
                        candidate = await validate(candidate);
                    }
                    assign(destination, value); parsed = await validate(candidate); break;
                }
                case 'test': {
                    if (!_.isEqual(read(), await parsedValue(command.args[1]))) throw new Error('JSONPatch test 条件不成立');
                    continue;
                }
                default: throw new Error(`MVU Zod 不支持的命令：${command.type}`);
            }
            for (const deleted of removed) if (!_.has(parsed, deleted)) remove(business, deleted);
            variables.stat_data = { ...business, ...parsed, ...(_internal === undefined ? {} : { $internal: _internal }) };
        } catch (error) {
            // Preserve the existing host's strict assertion extension even with Zod registered.
            if (command?.type === 'test') throw error;
            warning(command, error);
        }
    }
}

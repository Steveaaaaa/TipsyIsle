import _ from 'lodash';
import JSON5 from 'json5';
import { parse as parseYaml } from 'yaml';
import { findUpdateMarkupBlocks, scanUpdateMarkup } from './mvu-markup';
import { applyMvuPatches, mvuPointerParts, readMvuPatchBlocks, type MvuPatch } from './mvu-patch';
import { normalizeMvuNode, normalizeMvuVariables, reconcileMvuVariables, type MvuDataSchema } from './mvu-data';
import { assertMvuKey, mvuJsonValue, parseMvuCommandValue } from './mvu-values';

export interface MvuCommand {
    type: 'set' | 'insert' | 'delete' | 'add' | 'move' | 'copy' | 'test' | 'assign' | 'remove' | 'unset';
    full_match: string;
    args: any[];
    reason: string;
}
export interface MvuCommandPlan {
    commands: MvuCommand[];
    /** Keep strict patch provenance outside author-visible objects. Never match by reason text. */
    patches: WeakMap<MvuCommand, { patch: MvuPatch; type: MvuCommand['type']; args: any[] }>;
}
const own = (value: object, key: string) => Object.hasOwn(value, key);
const object = (value: any): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
const collection = (value: any) => !!value && typeof value === 'object';
const vwd = (value: any) => Array.isArray(value) && value.length === 2 && typeof value[1] === 'string';
const canonicalPath = (parts: string[]) => parts.map(part => `[${JSON.stringify(part)}]`).join('');
const pointer = (parts: string[]) => parts.length ? '/' + parts.map(part => part.replace(/~/g, '~0').replace(/\//g, '~1')).join('/') : '';
const aliases: Partial<Record<string, MvuCommand['type']>> = { assign: 'insert', remove: 'delete', unset: 'delete' };

/** Parse only the path literal. It must never pass through math or macro evaluation. */
export function mvuPathParts(value: unknown, encoded = false): string[] {
    if (typeof value !== 'string') throw new Error('MVU 路径必须是字符串');
    let path = value.trim();
    if (!encoded) {
        if (path.length >= 2 && path[0] === path.at(-1) && ['"', "'", '`'].includes(path[0]!)) {
            if (path[0] === '`') path = path.slice(1, -1);
            else {
                try { path = path[0] === '"' ? JSON5.parse(path) : parseYaml(path); }
                catch { path = path.slice(1, -1); }
            }
        }
        // Quoted dot segments are literal keys, including embedded dots/spaces.
        path = path.replace(/(^|\.)(["'])([^"']*)\2(?=\.|\[|$)/g, (_all, _prefix, _quote, key) => `[${JSON.stringify(key)}]`);
    }
    if (!path) return [];
    // JSON Pointer adapters use JSON-quoted brackets. Lodash does not decode
    // JSON control/unicode escapes, so parse this canonical representation as data.
    const bracketParts: string[] = [];
    const bracket = /\[((?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'))\]/gy;
    let end = 0;
    for (let match; (match = bracket.exec(path));) { bracketParts.push(JSON5.parse(match[1])); end = bracket.lastIndex; }
    const parts: string[] = end === path.length ? bracketParts : _.toPath(path);
    if (parts.length > 128) throw new Error('MVU 路径层级过深');
    parts.forEach(assertMvuKey);
    return parts;
}

/** Balanced scanner for arguments: quoted text/comments cannot split or close calls. */
function readArguments(text: string, start: number): { args: string[]; end: number } | undefined {
    const stack = [')'];
    const args: string[] = [];
    let cursor = start; let quote = ''; let escaped = false; let lineComment = false; let blockComment = false;
    for (let i = start; i < text.length; i++) {
        const char = text[i]!;
        if (lineComment) { if (char === '\n') lineComment = false; continue; }
        if (blockComment) { if (char === '*' && text[i + 1] === '/') { blockComment = false; i++; } continue; }
        if (quote) {
            if (escaped) escaped = false;
            else if (char === '\\') escaped = true;
            else if (char === quote) {
                if (quote === "'" && text[i + 1] === "'") i++;
                else quote = '';
            }
            continue;
        }
        if (['"', "'", '`'].includes(char)) { quote = char; continue; }
        if (char === '/' && text[i + 1] === '/') { lineComment = true; i++; continue; }
        if (char === '/' && text[i + 1] === '*') { blockComment = true; i++; continue; }
        if ('([{'.includes(char)) { stack.push({ '(': ')', '[': ']', '{': '}' }[char]!); continue; }
        if (')]}'.includes(char)) {
            if (stack.pop() !== char) return undefined;
            if (!stack.length) { if (text.slice(cursor, i).trim()) args.push(text.slice(cursor, i).trim()); return { args, end: i + 1 }; }
            continue;
        }
        if (char === ',' && stack.length === 1) { args.push(text.slice(cursor, i).trim()); cursor = i + 1; }
    }
    return undefined;
}

function patchCommand(patch: MvuPatch): MvuCommand {
    if (!patch || typeof patch !== 'object' || typeof patch.op !== 'string') throw new Error('JSONPatch 操作格式无效');
    const parts = mvuPointerParts(patch.path);
    const path = canonicalPath(parts);
    const base = { full_match: JSON.stringify(patch), reason: 'json_patch' };
    if (['add', 'insert', 'replace', 'delta', 'test'].includes(patch.op) && !own(patch, 'value')) throw new Error('JSONPatch 操作缺少 value');
    switch (patch.op) {
        case 'replace': return { ...base, type: 'set', args: [path, JSON.stringify(patch.value)] };
        case 'delta': return { ...base, type: 'add', args: [path, JSON.stringify(patch.value)] };
        case 'add': case 'insert': return { ...base, type: 'insert', args: parts.length
            ? [canonicalPath(parts.slice(0, -1)), /^(0|[1-9]\d*)$/.test(parts.at(-1)!) ? parts.at(-1)! : JSON.stringify(parts.at(-1)), JSON.stringify(patch.value)]
            : ['', JSON.stringify(patch.value)] };
        case 'remove': return { ...base, type: 'delete', args: [path] };
        case 'move': case 'copy': return { ...base, type: patch.op, args: [canonicalPath(mvuPointerParts(patch.from)), path] };
        case 'test': return { ...base, type: 'test', args: [path, JSON.stringify(patch.value)] };
        default: throw new Error(`不支持的 JSONPatch 操作：${patch.op}`);
    }
}

export function readMvuCommands(text: string): MvuCommandPlan {
    if (typeof text !== 'string' || text.length > 4 * 1024 * 1024) throw new Error('MVU 消息必须是字符串且不超过 4 MiB');
    const patches: MvuCommandPlan['patches'] = new WeakMap();
    const ordered: Array<{ index: number; command: MvuCommand }> = [];
    for (const block of readMvuPatchBlocks(text)) for (const patch of block.patches) {
        const command = patchCommand(patch);
        patches.set(command, { patch, type: command.type, args: structuredClone(command.args) });
        ordered.push({ index: block.start, command });
    }
    // Structural view also masks strings/comments. The original supplies argument bytes.
    const chars = scanUpdateMarkup(text).structural.split('');
    for (const block of findUpdateMarkupBlocks(text, 'patch')) chars.fill(' ', block.start, block.end);
    for (const block of findUpdateMarkupBlocks(text, 'initial')) chars.fill(' ', block.start, block.end);
    const visible = chars.join('');
    const matcher = /_\.(set|insert|assign|remove|unset|delete|add|move)\(/g;
    for (let match; (match = matcher.exec(visible));) {
        const parsed = readArguments(text, matcher.lastIndex);
        if (!parsed) continue;
        matcher.lastIndex = parsed.end;
        if (text[parsed.end] !== ';') continue;
        const reason = /^[ \t]*\/\/([^\r\n]*)/.exec(text.slice(parsed.end + 1));
        const end = parsed.end + 1 + (reason?.[0].length ?? 0);
        matcher.lastIndex = end;
        const type = (aliases[match[1]] ?? match[1]) as MvuCommand['type'];
        const valid = type === 'delete' ? parsed.args.length >= 1
            : type === 'add' || type === 'move' ? parsed.args.length === 2 : parsed.args.length >= 2;
        if (valid) ordered.push({ index: match.index, command: { type, full_match: text.slice(match.index, end), args: parsed.args, reason: reason?.[1]?.trim() ?? '' } });
        if (ordered.length > 4096) throw new Error('单条消息的 MVU 命令超过 4096 项');
    }
    return { commands: ordered.sort((a, b) => a.index - b.index).map(item => item.command), patches };
}

function get(root: any, parts: string[]): any {
    let value = root;
    for (const part of parts) {
        if (!collection(value) || !own(value, part)) throw new Error(`MVU 路径不存在：${canonicalPath(parts)}`);
        value = value[part];
    }
    return value;
}
function write(root: any, parts: string[], value: any): any {
    if (!parts.length) {
        if (!object(value)) throw new Error('MVU stat_data 必须保持为对象');
        return value;
    }
    const parent = get(root, parts.slice(0, -1));
    if (!collection(parent)) throw new Error('MVU 父路径不是集合');
    parent[parts.at(-1)!] = value;
    return root;
}
function schemaAt(schema: unknown, parts: string[]): MvuDataSchema | undefined {
    let node = object(schema) && typeof schema.type === 'string' ? schema as MvuDataSchema : undefined;
    for (const part of parts) {
        if (node?.type === 'array' && /^\d+$/.test(part)) node = node.elementType;
        else if (node?.type === 'object' && node.properties && own(node.properties, part)) node = node.properties[part];
        else return undefined;
    }
    return node;
}
function applyTemplate(value: any, template: any, schema: any): any {
    if (!template) return value;
    const safeTemplate = mvuJsonValue(template);
    if (object(value) && object(safeTemplate)) return _.merge({}, safeTemplate, value);
    if (Array.isArray(safeTemplate) && (Array.isArray(value) || !collection(value) && !schema?.strictTemplate)) {
        const array = Array.isArray(value) ? value : [value];
        return schema?.concatTemplateArray === false ? _.merge([], safeTemplate, array) : [...array, ...safeTemplate];
    }
    return value;
}

interface CommandChange { root: Record<string, any>; path: string; oldValue: any; newValue: any; description?: string; schema?: MvuDataSchema; skip?: boolean }
async function applyLegacy(variables: Record<string, any>, command: MvuCommand, encoded: boolean): Promise<CommandChange> {
    const parts = mvuPathParts(command.args[0], encoded);
    const path = canonicalPath(parts);
    const { $internal: _internal, ...businessData } = variables.stat_data;
    let root = structuredClone(businessData);
    const schema = variables.schema;
    const target = get(root, parts);
    const oldValue = structuredClone(target);
    const type = aliases[command.type] ?? command.type;
    switch (type) {
        case 'set': {
            if (command.args.length < 2) throw new Error('set 缺少值');
            let value = mvuJsonValue(await parseMvuCommandValue(command.args.at(-1)));
            const useDescription = !schema?.strictSet && vwd(target) && !Array.isArray(target[0]);
            if (useDescription) {
                if (typeof target[0] === 'number' && value !== null) value = mvuJsonValue(Number(value));
                target[0] = value;
                return { root, path, oldValue: oldValue[0], newValue: value };
            }
            if (typeof target === 'number' && typeof value === 'string') value = mvuJsonValue(Number(value));
            root = write(root, parts, value);
            return { root, path, oldValue, newValue: value };
        }
        case 'add': {
            if (command.args.length !== 2) throw new Error('add 需要路径和增量');
            const useDescription = vwd(target) && typeof target[0] !== 'object';
            const current = useDescription ? target[0] : target;
            const delta = await parseMvuCommandValue(command.args[1]);
            if (typeof delta !== 'number' || !Number.isFinite(delta)) throw new Error('add 的增量必须为有限数值');
            let value: any;
            if (typeof current === 'number') value = mvuJsonValue(Number((current + delta).toPrecision(12)));
            else if (typeof current === 'string' && Number.isNaN(Number(current)) && Number.isFinite(new Date(current).getTime())) value = new Date(new Date(current).getTime() + delta).toISOString();
            else throw new Error('add 只支持数值或日期（日期增量单位为毫秒）');
            if (useDescription) target[0] = value; else root = write(root, parts, value);
            return { root, path, oldValue, newValue: get(root, parts) };
        }
        case 'insert': {
            if (!collection(target)) throw new Error('insert 的目标必须为对象或数组');
            const rule = schemaAt(schema, parts);
            const indexed = command.args.length >= 3;
            const key = indexed ? await parseMvuCommandValue(command.args[1]) : undefined;
            if (rule?.type === 'array' && rule.extensible !== true) throw new Error('不能向不可扩展数组插入元素');
            if (rule?.type === 'object' && rule.extensible === false && (!indexed || !rule.properties || !own(rule.properties, String(key)))) throw new Error('不能向不可扩展对象增加属性');
            let value = mvuJsonValue(await parseMvuCommandValue(command.args[indexed ? 2 : 1]));
            if (Array.isArray(target)) {
                if (indexed && key !== '-' && (typeof key !== 'number' || !Number.isInteger(key))) throw new Error('数组插入下标必须为整数或 -');
                value = applyTemplate(value, rule?.template, schema);
                target.splice(!indexed || key === '-' ? target.length : key, 0, value);
            } else if (indexed) {
                const name = String(key); assertMvuKey(name);
                target[name] = applyTemplate(value, rule?.template, schema);
            } else {
                if (!object(value)) throw new Error('对象 insert 的双参数形式只接受对象');
                _.merge(target, value);
            }
            const normalized = normalizeMvuNode(target, rule);
            root = write(root, parts, normalized.data);
            // Reconcile only declared collections here, so unrelated no-schema data stays unconstrained this round.
            let updatedSchema: MvuDataSchema | undefined;
            if (rule && object(schema)) {
                updatedSchema = structuredClone(schema) as MvuDataSchema;
                Object.assign(schemaAt(updatedSchema, parts)!, normalized.schema);
            }
            return { root, path, oldValue, newValue: normalized.data, schema: updatedSchema,
                description: `ASSIGNED ${JSON.stringify(value)} into '${path}'` };
        }
        case 'delete': {
            let parentParts = parts.slice(0, -1);
            let parent = parts.length ? get(root, parentParts) : undefined;
            let key: any = parts.at(-1);
            let eventParts = parts;
            let old = oldValue;
            if (command.args.length > 1) {
                parent = target; parentParts = parts; eventParts = parts;
                key = await parseMvuCommandValue(command.args[1]);
                if (Array.isArray(parent)) key = typeof key === 'number' ? key : parent.findIndex(item => _.isEqual(item, key));
                else if (object(parent) && typeof key === 'number') key = Object.keys(parent)[key];
            } else if (Array.isArray(parent)) { eventParts = parentParts; old = structuredClone(parent); }
            if (!collection(parent) || key === undefined) throw new Error('delete 目标不是有效的集合成员');
            const rule = schemaAt(schema, parentParts);
            if (Array.isArray(parent)) {
                const index = Number(key);
                if (!Number.isInteger(index) || index < 0 || index >= parent.length) throw new Error('delete 数组下标越界或目标值不存在');
                if (rule?.type === 'array' && rule.extensible !== true) throw new Error('不能删除不可扩展数组的元素');
                parent.splice(index, 1);
            } else {
                key = String(key); assertMvuKey(key);
                if (!own(parent, key)) throw new Error('delete 属性不存在');
                if (rule?.properties?.[key]?.required) throw new Error('不能删除 schema 标记为必需的属性');
                delete parent[key];
            }
            return { root, path: canonicalPath(eventParts), oldValue: old, newValue: command.args.length === 1 && !Array.isArray(parent) ? undefined : parent,
                description: `REMOVED '${path}'` };
        }
        case 'move': case 'copy': {
            const toParts = mvuPathParts(command.args[1], encoded);
            const result = applyMvuPatches({ stat_data: root }, '', [{ op: type, from: pointer(parts), path: pointer(toParts) }]);
            return { root: result.data.stat_data, path: canonicalPath(toParts), oldValue: undefined, newValue: get(result.data.stat_data, toParts), description: `${type.toUpperCase()} '${path}'` };
        }
        case 'test': {
            const value = mvuJsonValue(await parseMvuCommandValue(command.args[1]));
            if (!_.isEqual(target, value)) throw new Error('MVU test 条件不成立');
            return { root, path, oldValue, newValue: target, skip: true };
        }
        default: throw new Error(`不支持的 MVU 命令：${type}`);
    }
}

/** Restore RFC-like operations from the mutable public command view after author hooks. */
async function strictPatch(command: MvuCommand, source: NonNullable<ReturnType<MvuCommandPlan['patches']['get']>>): Promise<MvuPatch> {
    const original = source.patch;
    if (_.isEqual(command.args, source.args)) return structuredClone(original);
    const parts = mvuPathParts(command.args[0], true);
    switch (command.type) {
        case 'set': case 'add': case 'test': return { op: original.op, path: pointer(parts), value: mvuJsonValue(await parseMvuCommandValue(command.args.at(-1))) };
        case 'insert': {
            if (command.args.length >= 3) parts.push(String(await parseMvuCommandValue(command.args[1])));
            parts.forEach(assertMvuKey);
            return { op: original.op, path: pointer(parts), value: mvuJsonValue(await parseMvuCommandValue(command.args.at(-1))) };
        }
        case 'delete': return { op: original.op, path: pointer(parts) };
        case 'move': case 'copy': return { op: original.op, from: pointer(parts), path: pointer(mvuPathParts(command.args[1], true)) };
        default: throw new Error('JSONPatch 对应命令结构无效');
    }
}

export async function applyMvuCommands(variables: Record<string, any>, plan: MvuCommandPlan, hooks: {
    updated(root: Record<string, any>, path: string, oldValue: any, newValue: any): Promise<void>;
    warning(command: MvuCommand, error: unknown): void;
}): Promise<void> {
    if (!Array.isArray(plan.commands) || plan.commands.length > 4096) throw new Error('单条消息的 MVU 命令超过 4096 项');
    for (const command of plan.commands) {
        const source = plan.patches.get(command);
        let change: CommandChange;
        try {
            if (!command || typeof command.type !== 'string' || !Array.isArray(command.args)) throw new Error('MVU 命令必须包含 type 和 args');
            if (!object(variables.stat_data)) throw new Error('MVU stat_data 必须为对象');
            if (source && source.type === command.type) {
                const patch = await strictPatch(command, source);
                const { $internal: _internal, ...businessData } = variables.stat_data;
                const oldValue = patch.path === '' ? businessData : _.get(businessData, mvuPointerParts(patch.path));
                const result = applyMvuPatches({ stat_data: businessData }, '', [patch]);
                change = { root: result.data.stat_data, path: canonicalPath(mvuPointerParts(patch.path)), oldValue,
                    newValue: patch.path === '' ? result.data.stat_data : _.get(result.data.stat_data, mvuPointerParts(patch.path)), skip: patch.op === 'test' };
            } else change = await applyLegacy(variables, command, !!source || command.reason === 'json_patch');
        } catch (error) {
            // Strict patch failures invalidate the whole settlement. Legacy MVU records and skips invalid commands.
            if (source) throw error;
            hooks.warning(command, error); continue;
        }
        if (change.skip) continue;
        const internal = variables.stat_data.$internal;
        variables.stat_data = { ...change.root, ...(internal ? { $internal: internal } : {}) };
        if (change.schema) variables.schema = change.schema;
        const description = `${change.description ?? `${JSON.stringify(change.oldValue)}->${JSON.stringify(change.newValue)}`} ${command.reason ? `(${command.reason})` : ''}`;
        if (change.path) {
            if (internal?.display_data) _.set(internal.display_data, mvuPathParts(change.path, true), description);
            if (internal?.delta_data) _.set(internal.delta_data, mvuPathParts(change.path, true), description);
        }
        // Listener errors must abort, never be swallowed as malformed model commands.
        await hooks.updated(variables.stat_data, change.path, change.oldValue, change.newValue);
    }
}

export async function setMvuVariable(statData: Record<string, any>, path: string, value: any, reason = '', recursive = false,
    updated?: (root: Record<string, any>, path: string, oldValue: any, newValue: any) => Promise<void>): Promise<boolean> {
    const parts = mvuPathParts(path);
    if (!parts.length) return false;
    let current: any;
    try { current = get(statData, parts); } catch { return false; }
    const isDescription = Array.isArray(current) && current.length === 2;
    const old = structuredClone(isDescription ? current[0] : current);
    const next = mvuJsonValue(value);
    if (isDescription) current[0] = next; else write(statData, parts, next);
    const description = `${JSON.stringify(old)}->${JSON.stringify(next)} ${reason ? `(${reason})` : ''}`;
    if (statData.$internal?.display_data) _.set(statData.$internal.display_data, parts, description);
    if (statData.$internal?.delta_data) _.set(statData.$internal.delta_data, parts, description);
    if (recursive) await updated?.(statData, path, old, next);
    return true;
}

/** Append the MVU status placeholder and strip echoed current-variable blocks on settled assistant replies. */
export function formatMvuMessageContent(content: string, hasMvuData: boolean): string {
    if (!hasMvuData) return content;
    let next = content;
    if (!next.includes('<StatusPlaceHolderImpl/>')) next += '\n\n<StatusPlaceHolderImpl/>';
    next = next.replace(/<(status_current_variable)>(?:(?!<\1>).)*<\/\1?>/gis, '');
    return next;
}

/** Script-free sessions use the same interpreter and schema metadata rules. */
export async function settleMvuWithoutScripts(before: Record<string, any>, text: string,
    warning: (command: MvuCommand, error: unknown) => void): Promise<Record<string, any>> {
    const next = structuredClone(normalizeMvuVariables(before).variables);
    const hadMvuData = Object.hasOwn(before, 'stat_data');
    let plan: MvuCommandPlan;
    try {
        plan = readMvuCommands(text);
    } catch (error) {
        if (!hadMvuData) return next;
        throw error;
    }
    if (!plan.commands.length) return next;
    next.stat_data ??= {};
    if (!object(next.stat_data)) throw new Error('MVU stat_data 必须为对象');
    next.stat_data.$internal = { display_data: structuredClone(next.stat_data), delta_data: {} };
    await applyMvuCommands(next, plan, { updated: async () => {}, warning });
    next.display_data = next.stat_data.$internal?.display_data ?? {};
    next.delta_data = next.stat_data.$internal?.delta_data ?? {};
    delete next.stat_data.$internal;
    const result = _.isEqual(next.stat_data, before.stat_data) ? next : reconcileMvuVariables(next);
    result.stat_data = mvuJsonValue(result.stat_data);
    return result;
}

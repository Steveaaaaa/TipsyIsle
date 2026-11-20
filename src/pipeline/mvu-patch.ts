import _ from 'lodash';
import { findUpdateMarkupBlocks, scanUpdateMarkup } from './mvu-markup';
import { mvuJsonValue, parseMvuStructuredValue } from './mvu-values';

export type MvuPatch = { op: string; path: string; value?: unknown; from?: string };
const own = (object: unknown, key: string) => Object.prototype.hasOwnProperty.call(object, key);
export function mvuPointerParts(value: unknown): string[] {
    if (typeof value !== 'string' || (value !== '' && !value.startsWith('/'))) throw new Error('JSONPatch 路径必须是 JSON Pointer');
    if (/~(?![01])/g.test(value)) throw new Error('JSONPatch 包含无效转义');
    const parts = value === '' ? [] : value.slice(1).split('/').map(s => s.replace(/~1/g, '/').replace(/~0/g, '~'));
    if (parts.some(key => ['__proto__', 'prototype', 'constructor'].includes(key))) throw new Error('JSONPatch 包含非法路径');
    return parts;
}
function location(root: any, parts: string[]): { parent: any; key: string } {
    if (!parts.length) throw new Error('此操作需要非根路径');
    let parent = root;
    for (const part of parts.slice(0, -1)) {
        if (!parent || typeof parent !== 'object' || !own(parent, part)) throw new Error(`JSONPatch 父路径不存在：/${parts.join('/')}`);
        parent = parent[part];
    }
    if (!parent || typeof parent !== 'object') throw new Error('JSONPatch 目标父节点不是对象');
    return { parent, key: parts.at(-1)! };
}
function arrayIndex(parent: any[], key: string, insert = false): number {
    if (insert && key === '-') return parent.length;
    if (!/^(0|[1-9]\d*)$/.test(key)) throw new Error('JSONPatch 数组下标无效');
    const index = Number(key);
    if (index >= parent.length + (insert ? 1 : 0)) throw new Error('JSONPatch 数组下标越界');
    return index;
}
/** Read commands separately so author handlers can inspect them before they are applied. */
export function readMvuPatches(text: string): MvuPatch[] {
    return readMvuPatchBlocks(text).flatMap(block => block.patches);
}
export function readMvuPatchBlocks(text: string): Array<{ start: number; patches: MvuPatch[] }> {
    const blocks = findUpdateMarkupBlocks(text, 'patch');
    const tokens = scanUpdateMarkup(text).tokens.filter(token => token.name === 'patch');
    if (blocks.some(block => !block.closed) || tokens.length !== blocks.length * 2) throw new Error('JSONPatch 标签不完整');
    const allPatches: MvuPatch[] = [];
    const result: Array<{ start: number; patches: MvuPatch[] }> = [];
    for (const block of blocks) {
        if (block.discarded) continue;
        const patches: MvuPatch[] = mvuJsonValue(parseMvuStructuredValue(text.slice(block.contentStart, block.contentEnd)));
        if (!Array.isArray(patches) || patches.length > 4096) throw new Error('JSONPatch 必须是操作数组（最多 4096 项）');
        allPatches.push(...patches);
        if (allPatches.length > 4096) throw new Error('单条消息的 JSONPatch 操作超过 4096 项');
        result.push({ start: block.start, patches });
    }
    return result;
}
/** Pure transaction: malformed patches never alter the caller's snapshot. */
export function applyMvuPatches(variables: Record<string, any>, text: string, parsed?: MvuPatch[]): { data: Record<string, any>; changed: boolean; patches: MvuPatch[] } {
    const allPatches = parsed ?? readMvuPatches(text);
    if (allPatches.length > 4096) throw new Error('单条消息的 JSONPatch 操作超过 4096 项');
    const data = structuredClone(variables);
    let root: any = data.stat_data ?? {};
        for (const patch of allPatches) {
            if (!patch || typeof patch !== 'object' || typeof patch.op !== 'string') throw new Error('JSONPatch 操作格式无效');
            if (['add', 'insert', 'replace', 'delta', 'test'].includes(patch.op) && !own(patch, 'value')) throw new Error('JSONPatch 操作缺少 value');
            const parts = mvuPointerParts(patch.path);
            const read = (path: string[]) => {
                let current = root;
                for (const part of path) {
                    if (!current || typeof current !== 'object' || !own(current, part)) throw new Error('JSONPatch 读取的路径不存在');
                    current = current[part];
                }
                return current;
            };
            const remove = (path: string[]) => {
                const { parent, key } = location(root, path);
                if (!own(parent, key)) throw new Error('JSONPatch 删除的路径不存在');
                if (Array.isArray(parent)) parent.splice(arrayIndex(parent, key), 1); else delete parent[key];
            };
            const write = (path: string[], value: unknown, insert: boolean) => {
                if (!path.length) { root = structuredClone(value); return; }
                const { parent, key } = location(root, path);
                if (Array.isArray(parent)) {
                    const i = arrayIndex(parent, key, insert);
                    if (insert) parent.splice(i, 0, structuredClone(value)); else parent[i] = structuredClone(value);
                } else {
                    if (!insert && !own(parent, key)) throw new Error('JSONPatch 替换的路径不存在');
                    parent[key] = structuredClone(value);
                }
            };
            switch (patch.op) {
                case 'add': case 'insert': write(parts, patch.value, true); break;
                case 'replace': write(parts, patch.value, false); break;
                case 'remove': remove(parts); break;
                case 'delta': {
                    const value = read(parts);
                    if (typeof value !== 'number' || typeof patch.value !== 'number' || !Number.isFinite(value + patch.value)) throw new Error('delta 只接受有限数值');
                    write(parts, value + patch.value, false); break;
                }
                case 'move': case 'copy': {
                    const from = mvuPointerParts(patch.from);
                    if (patch.op === 'move' && parts.length > from.length && from.every((p, i) => p === parts[i])) throw new Error('不能将节点移动到其子节点');
                    if (patch.op === 'move' && _.isEqual(from, parts)) { read(from); break; }
                    const value = structuredClone(read(from));
                    if (patch.op === 'move') remove(from);
                    write(parts, value, true); break;
                }
                case 'test': if (!_.isEqual(read(parts), patch.value)) throw new Error('JSONPatch test 条件不成立'); break;
                default: throw new Error(`不支持的 JSONPatch 操作：${patch.op}`);
            }
        }
    if (!root || typeof root !== 'object' || Array.isArray(root)) throw new Error('stat_data 必须保持为对象');
    const changed = allPatches.length > 0 || /<JSONPatch\b/i.test(text);
    if (changed) data.stat_data = root;
    return { data, changed, patches: allPatches };
}

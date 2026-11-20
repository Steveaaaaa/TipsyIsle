import _ from 'lodash';
import { jsonrepair } from 'jsonrepair';

export const parseTemplateJSON = (text: string): any => JSON.parse(jsonrepair(text));
function path(pointer: unknown): string[] {
    if (typeof pointer !== 'string' || pointer && !pointer.startsWith('/') || typeof pointer === 'string' && /~(?![01])/.test(pointer)) throw new Error('模板 JSON Patch 需要有效 JSON Pointer');
    const parts = pointer ? pointer.slice(1).split('/').map(key => key.replace(/~1/g, '/').replace(/~0/g, '~')) : [];
    if (parts.some(key => ['__proto__', 'prototype', 'constructor'].includes(key))) throw new Error('模板 JSON Patch 包含非法路径');
    return parts;
}
/** Pinned Template jsonPatch uses lodash assignment semantics for array indices
 * (distinct from MVU's RFC-style array insertion), and returns the original on
 * a failed test operation. Keep these two public contracts separate. */
export function patchTemplateJSON(document: any, operations: Array<Record<string, any>>, warn: (message: string) => void = console.warn): any {
    if (!Array.isArray(operations) || operations.length > 4096) throw new Error('模板 JSON Patch 必须为至多 4096 项的操作数组');
    let result = structuredClone(document);
    const get = (keys: string[]) => keys.length ? _.get(result, keys) : result;
    const put = (keys: string[], value: unknown) => { if (keys.length) _.set(result, keys, structuredClone(value)); else result = structuredClone(value); };
    for (const operation of operations) {
        if (!operation || typeof operation !== 'object' || typeof operation.op !== 'string') throw new Error('模板 JSON Patch 操作无效');
        const target = path(operation.path);
        if (['set', 'assign', 'add', 'replace'].includes(operation.op)) {
            if (!Object.hasOwn(operation, 'value')) throw new Error('模板 JSON Patch 缺少 value');
            if (target.at(-1) === '-') {
                const parent = get(target.slice(0, -1));
                if (Array.isArray(parent)) parent.push(structuredClone(operation.value)); else warn('模板 JSON Patch 不能追加到非数组节点');
            } else put(target, operation.value);
        } else if (operation.op === 'remove') {
            if (!target.length) result = undefined;
            else if (!_.unset(result, target)) warn(`模板 JSON Patch 无法删除 ${operation.path}`);
        } else if (operation.op === 'copy' || operation.op === 'move') {
            const source = path(operation.from), value = structuredClone(get(source));
            if (value === undefined) { warn(`模板 JSON Patch 源路径不存在：${operation.from}`); continue; }
            if (operation.op === 'move') {
                if (target.length > source.length && source.every((key, index) => key === target[index])) throw new Error('不能将节点移动到自身子节点');
                if (source.length) _.unset(result, source); else result = undefined;
            }
            put(target, value);
        } else if (operation.op === 'test') {
            if (!_.isEqual(get(target), operation.value)) { warn(`模板 JSON Patch test 失败：${operation.path}`); return document; }
        } else warn(`模板 JSON Patch 未知操作：${operation.op}`);
    }
    return result;
}

import { z } from 'zod';
import type { Json, JsonMap } from '../../../packages/plugin-sdk/index.js';
import { canonical } from '../../core/sync/protocol';
import { digest } from '../../../packages/plugin-sdk/package-format.mjs';
import { PluginApiError } from './errors';
import { validateJson } from './storage';

export const idSchema = z.string().min(1).max(480);
export const localId = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
export const roleSchema = z.enum(['system', 'user', 'assistant']);
export const refSchema = z.strictObject({ messageId: idSchema, swipeId: idSchema, revision: idSchema });
export const routeSchema = z.strictObject({ chatId: idSchema, routeId: idSchema });
export const limitSchema = z.number().int().min(1).max(100).optional();
export const cursorSchema = z.string().max(512).optional();
export const uidSchema = z.union([z.string().min(1).max(200), z.number().int()]);
const key = z.union([z.string().min(1).max(160), z.number().int().min(0).max(100_000)]).refine(value =>
    !['__proto__', 'constructor', 'prototype', '$tipsyRecord', '$tipsyImage'].includes(String(value)), '路径包含保留字段');
export const pathSchema = z.array(key).max(20);
export const jsonEditSchema = z.discriminatedUnion('op', [
    z.strictObject({ op: z.literal('set'), path: pathSchema.min(1), value: z.unknown().refine(v => v !== undefined) }),
    z.strictObject({ op: z.literal('remove'), path: pathSchema.min(1) }),
]);
export const jsonEditsSchema = z.array(jsonEditSchema).min(1).max(100);
export type JsonPatch = z.infer<typeof jsonEditSchema>;
export const operationSchema = z.string().min(1).max(120);
export const sliceInt = z.number().int().nonnegative();
export const signature = (value: unknown) => digest(new TextEncoder().encode(canonical(value)), crypto.subtle);
export function jsonObject(value: unknown): JsonMap {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new PluginApiError('INVALID_ARGUMENT', '需要一个 JSON 对象');
    return validateJson(value, 400_000) as JsonMap;
}
export function patchObject(value: Record<string, unknown>, edits: JsonPatch[]): Record<string, unknown> {
    const output = structuredClone(value);
    for (const edit of edits) {
        let parent: any = output;
        for (const part of edit.path.slice(0, -1)) {
            if (Object.hasOwn(parent, part) && parent[part] && typeof parent[part] === 'object') parent = parent[part];
            else throw new PluginApiError('INVALID_ARGUMENT', '修改路径的上级字段不存在');
        }
        const part = edit.path.at(-1)!;
        if (Array.isArray(parent) && (typeof part !== 'number' || part > parent.length)) throw new PluginApiError('INVALID_ARGUMENT', '无效的数组位置');
        if (edit.op === 'set') parent[part] = validateJson(edit.value, 150_000);
        else if (Array.isArray(parent)) parent.splice(Number(part), 1);
        else delete parent[part];
    }
    return output;
}
export function readJsonPath(value: unknown, path?: (string | number)[]): Json {
    let item = value;
    for (const key of path ?? []) item = item && typeof item === 'object' && Object.hasOwn(item, key) ? (item as any)[key] : undefined;
    const encoded = JSON.stringify(item ?? null);
    if (encoded.length > 400_000) throw new PluginApiError('QUOTA_EXCEEDED', '数据太长，请读取指定字段');
    return JSON.parse(encoded);
}
export const conflict = () => new PluginApiError('VERSION_CONFLICT', '目标已有更新，请重新读取后再提交');
export const missing = (name: string) => new PluginApiError('NOT_FOUND', `找不到${name}`);
export function page<T>(items: T[], cursor?: string, limit = 20, version = '') {
    const prefix = `${version}:`;
    const index = cursor === undefined ? 0 : cursor.startsWith(prefix) ? Number(cursor.slice(prefix.length)) : NaN;
    if (!Number.isSafeInteger(index) || index < 0) throw conflict();
    return { items: items.slice(index, index + limit), next: index + limit < items.length ? `${prefix}${index + limit}` : null };
}

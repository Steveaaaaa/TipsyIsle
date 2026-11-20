import { z } from 'zod';
import type { Json, JsonMap, StoragePatch } from '../../../packages/plugin-sdk/index.js';
import { digest } from '../../../packages/plugin-sdk/package-format.mjs';
import { PluginApiError } from './errors';

export interface PluginBucket {
    owner: string;
    schemaVersion: number;
    version: number;
    values: JsonMap;
    operations?: [id: string, digest: string][];
}
export type PluginBuckets = Record<string, PluginBucket>;
export type SwipePluginBuckets = Record<string, PluginBuckets>;

export const emptyPluginBucket = (owner: string, schemaVersion: number): PluginBucket => ({ owner, schemaVersion, version: 0, values: {} });
export const storageLimit = 16 * 1024;
const forbiddenKeys = new Set(['__proto__', 'constructor', 'prototype', '$tipsyRecord', '$tipsyImage']);
const storageKey = z.string().min(1).max(96).refine(key => !forbiddenKeys.has(key), '无效的插件存储键');
const operationId = z.string().min(1).max(180);
const utf8 = new TextEncoder();
export const jsonBytes = (value: unknown) => utf8.encode(JSON.stringify(value) ?? '').length;
export function validateJson(value: unknown, limit = storageLimit): Json {
    const visit = (item: unknown, depth: number): void => {
        if (item === null || typeof item === 'string' || typeof item === 'boolean' || typeof item === 'number' && Number.isFinite(item)) return;
        if (!item || typeof item !== 'object' || depth > 20) throw new Error('插件数据必须是有界的 JSON 值');
        if (Array.isArray(item)) { item.forEach(value => visit(value, depth + 1)); return; }
        for (const [key, nested] of Object.entries(item)) {
            storageKey.parse(key); visit(nested, depth + 1);
        }
    };
    visit(value, 0);
    if (jsonBytes(value) > limit) throw new PluginApiError('QUOTA_EXCEEDED', '插件数据超过存储配额');
    return value as Json;
}
export function pluginValues(value: unknown): JsonMap {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('插件存储必须是键值对象');
    return validateJson(value) as JsonMap;
}

const patchSchema = z.strictObject({ set: z.unknown().optional(), remove: z.array(storageKey).max(100).optional(), operationId: operationId.optional() });
export async function applyPluginPatch(bucket: PluginBucket, raw: unknown, generatedId: string): Promise<PluginBucket> {
    const patch = patchSchema.parse(raw) as StoragePatch;
    const id = patch.operationId ?? generatedId;
    const set = patch.set === undefined ? {} : pluginValues(patch.set);
    const remove = [...new Set(patch.remove ?? [])].sort();
    const key = (value: any): any => Array.isArray(value) ? value.map(key) : value && typeof value === 'object'
        ? Object.fromEntries(Object.keys(value).sort().map(name => [name, key(value[name])])) : value;
    const signature = await digest(utf8.encode(JSON.stringify([key(set), remove])), crypto.subtle);
    const previous = bucket.operations?.find(item => item[0] === id);
    if (previous) {
        if (previous[1] !== signature) throw new PluginApiError('STORAGE_CONFLICT', '同一操作编号不能用于不同的写入');
        return bucket;
    }
    const values = { ...bucket.values, ...set };
    for (const name of remove) delete values[name];
    pluginValues(values);
    const operations = [...bucket.operations ?? [], [id, signature] as [string, string]].slice(-64);
    return { ...bucket, values, version: bucket.version + 1, operations };
}

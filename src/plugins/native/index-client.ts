import { z } from 'zod';
import type { IndexDocument } from '../../../packages/plugin-sdk/index.js';
import type { IndexJob } from './plugin-index.worker';
import { validateJson } from './storage';
import { localId } from './edits';
import { PluginApiError } from './errors';

let seq = 0;
let worker: Worker | undefined;
const waiting = new Map<number, { resolve(value: unknown): void; reject(error: unknown): void }>();
const vector = z.array(z.number().finite()).min(1).max(3072);
const docId = z.string().regex(/^[\p{L}\p{N}_:.@~-]{1,180}$/u);
const collection = localId;
const document = z.strictObject({ id: docId, text: z.string().max(24_000), value: z.unknown().optional(), vector: vector.optional() });
export function indexRpc(owner: string, method: string, input: unknown, signal: AbortSignal) {
    let job: IndexJob;
    if (method === 'put') {
        const parsed = z.strictObject({ collection, documents: z.array(document).min(1).max(64) }).parse(input);
        for (const row of parsed.documents) if (row.value !== undefined) validateJson(row.value, 4800);
        job = { ...parsed, documents: parsed.documents as IndexDocument[], owner, kind: 'put' };
    } else if (method === 'remove') {
        job = { ...z.strictObject({ collection, ids: z.array(docId).max(100) }).parse(input), owner, kind: 'remove' };
    } else {
        const query = z.strictObject({ collection, text: z.string().max(1200).optional(), vector: vector.optional(), limit: z.number().int().min(1).max(50).default(10) }).parse(input);
        if (!query.text && !query.vector) throw new PluginApiError('INVALID_ARGUMENT', '请提供检索词或向量');
        job = { ...query, owner, kind: 'search' };
    }
    signal.throwIfAborted();
    if (!worker) {
        worker = new Worker(new URL('./plugin-index.worker.ts', import.meta.url), { type: 'module', name: 'tipsy-plugin-index' });
        worker.onmessage = ({ data }) => {
            const pending = waiting.get(data.id);
            if (data.error) pending?.reject(new PluginApiError(data.error.code, data.error.message));
            else pending?.resolve(data.result);
        };
        worker.onerror = () => {
            for (const pending of waiting.values()) pending.reject(new PluginApiError('UNAVAILABLE', '插件索引线程已停止'));
            worker?.terminate(); worker = undefined;
        };
    }
    const id = ++seq;
    return new Promise((resolve, reject) => {
        const finish = () => { waiting.delete(id); signal.removeEventListener('abort', abort); };
        const abort = () => { finish(); reject(signal.reason); };
        waiting.set(id, { resolve: value => { finish(); resolve(value); }, reject: error => { finish(); reject(error); } });
        signal.addEventListener('abort', abort, { once: true });
        worker!.postMessage({ id, job });
    });
}

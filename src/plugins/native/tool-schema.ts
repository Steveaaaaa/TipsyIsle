import type { JsonMap } from '../../../packages/plugin-sdk/index.js';
import { PluginApiError } from './errors';

type Job = { resolve(): void; reject(error: unknown): void; timer: ReturnType<typeof setTimeout> };
let worker: Worker | undefined, sequence = 0;
const pending = new Map<number, Job>();
const close = (error: unknown) => {
    worker?.terminate(); worker = undefined;
    for (const job of pending.values()) { clearTimeout(job.timer); job.reject(error); }
    pending.clear();
};
export function checkToolSchema(schema: JsonMap, value?: JsonMap) {
    return new Promise<void>((resolve, reject) => {
        if (!worker) {
            worker = new Worker(new URL('./tool-schema.worker.ts', import.meta.url), { name: 'tipsy-tool-schema', type: 'module' });
            worker.onmessage = (event: MessageEvent<{ id: number; error?: string }>) => {
                const { id, error } = event.data, job = pending.get(id);
                if (!job) return;
                clearTimeout(job.timer); pending.delete(id);
                if (error) job.reject(new PluginApiError('INVALID_ARGUMENT', error)); else job.resolve();
            };
            worker.onerror = () => close(new PluginApiError('HOST_ERROR', '工具参数校验未能运行'));
        }
        const id = ++sequence;
        const timer = setTimeout(() => close(new PluginApiError('TIMEOUT', '工具参数校验超时')), 1500);
        pending.set(id, { resolve, reject, timer });
        try { worker.postMessage({ id, schema, value }); } catch (error) { close(error); }
    });
}

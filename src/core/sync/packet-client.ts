import type { SealedPacket, SyncPacket } from './protocol';

let worker: Worker | undefined;
let sequence = 0;
const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
function request<T>(operation: 'seal' | 'unseal', value: SyncPacket | SealedPacket, secret: string, images = false): Promise<T> {
    if (!worker) {
        worker = new Worker(new URL('./packet.worker.ts', import.meta.url), { type: 'module' });
        worker.onmessage = ({ data }) => {
            const task = pending.get(data.id); if (!task) return;
            pending.delete(data.id);
            if (data.error) task.reject(new Error(data.error)); else task.resolve(data.result);
        };
        worker.onerror = () => {
            worker?.terminate(); worker = undefined;
            for (const task of pending.values()) task.reject(new Error('同步数据处理失败，请重试同步。'));
            pending.clear();
        };
    }
    const target = worker, id = ++sequence;
    return new Promise<T>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        try { target.postMessage({ id, operation, value, secret, images }); }
        catch (error) { pending.delete(id); reject(error); }
    });
}
export const sealPacket = (value: SyncPacket, secret: string, images: boolean) => request<SealedPacket>('seal', value, secret, images);
export const unsealPacket = (value: SealedPacket, secret: string) => request<SyncPacket>('unseal', value, secret);

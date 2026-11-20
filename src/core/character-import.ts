import type { NormalizedCharacterCard } from '../types';

/** Parsing, CRC and normalization of multi-megabyte cards do not occupy the UI thread. */
export function importCharacterFile(file: Blob, png = true): Promise<NormalizedCharacterCard> {
    return new Promise((resolve, reject) => {
        const worker = new Worker(new URL('./character-import.worker.ts', import.meta.url), { type: 'module' });
        worker.onmessage = (event: MessageEvent<{ card?: NormalizedCharacterCard; error?: string }>) => {
            worker.terminate();
            if (event.data.card) resolve(event.data.card);
            else reject(new Error(event.data.error ?? '角色卡解析失败'));
        };
        worker.onerror = event => { worker.terminate(); reject(new Error(event.message || '角色卡解析线程失败')); };
        worker.postMessage({ file, png });
    });
}

import { platformStorage } from '../core/platform-bridge';

interface StoredFile { base64: string; contentType: string }
let queue: Promise<unknown> = Promise.resolve();
export function requestFile(operation: string, params: Record<string, any>): Promise<unknown> {
    const run = queue.then(async () => {
        const filename = String(params.filename ?? '').replace(/^(?:\/?users\/files\/)/, '');
        if (!filename || filename.includes('..') || /[\\/\x00-\x1f]/.test(filename)) throw new Error('文件名无效');
        const key = `author_file:${filename}`;
        if (operation === 'get') return platformStorage.loadSnapshot<StoredFile | null>(key, null);
        if (operation === 'delete') {
            const existing = await platformStorage.loadSnapshot<StoredFile | null>(key, null);
            if (!existing) return false;
            await platformStorage.saveSnapshot(key, null); return true;
        }
        if (operation !== 'upload') throw new Error(`未知文件操作：${operation}`);
        const input = String(params.base64); const match = /^data:([^;,]+)?;base64,([\s\S]*)$/.exec(input);
        const base64 = match?.[2] ?? input;
        atob(base64);
        const contentType = match?.[1] ?? (filename.endsWith('.json') ? 'application/json' : /\.(txt|md|csv)$/i.test(filename) ? 'text/plain;charset=utf-8' : 'application/octet-stream');
        await platformStorage.saveSnapshot(key, { base64, contentType }); return filename;
    });
    queue = run.catch(() => {}); return run;
}

import { PluginApiError } from './errors';

export function fromBase64(text: string): Uint8Array<ArrayBuffer> {
    try { return Uint8Array.from(atob(text), ch => ch.charCodeAt(0)); }
    catch { throw new PluginApiError('INVALID_ARGUMENT', '无效的 Base64 数据'); }
}
export function toBase64(data: Uint8Array) {
    let binary = '';
    for (let start = 0; start < data.length; start += 8192) binary += String.fromCharCode(...data.subarray(start, start + 8192));
    return btoa(binary);
}
export async function readLimited(response: Response, limit: number, signal: AbortSignal, progress?: (fraction: number) => void) {
    const size = Number(response.headers.get('content-length'));
    if (size > limit) { await response.body?.cancel(); throw new PluginApiError('QUOTA_EXCEEDED', '响应超过大小限制'); }
    const reader = response.body?.getReader();
    if (!reader) return new Blob();
    let total = 0;
    const chunks: ArrayBuffer[] = [];
    try {
        for (;;) {
            signal.throwIfAborted();
            const part = await reader.read();
            if (part.done) break;
            total += part.value.byteLength;
            if (total > limit) throw new PluginApiError('QUOTA_EXCEEDED', '响应超过大小限制');
            chunks.push(new Uint8Array(part.value).buffer);
            if (size) progress?.(Math.min(total / size, .99));
        }
    } catch (error) { await reader.cancel().catch(() => {}); throw error; }
    finally { reader.releaseLock(); }
    return new Blob(chunks, { type: response.headers.get('content-type') ?? '' });
}

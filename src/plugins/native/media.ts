import { z } from 'zod';
import type { MediaHandle } from '../../../packages/plugin-sdk/index.js';
import { backgroundDb, requestResult, transactionDone, type StoredMedia } from './background-store';
import { cursorSchema, idSchema, limitSchema, missing, page, sliceInt } from './edits';
import { PluginApiError } from './errors';
import { fromBase64, toBase64 } from './bytes';

export const mediaLimit = 20 * 1024 * 1024;
const totalLimit = 1024 * 1024 * 1024, maxItems = 2048;
export async function transcodeToWebP(blob:Blob, quality=.90) {
    if(blob.type==='image/webp')return blob;
    const bitmap=await createImageBitmap(blob);
    try { if(bitmap.width*bitmap.height>16777216)throw new Error('图像尺寸过大');
        if(typeof OffscreenCanvas!=='undefined'){const canvas=new OffscreenCanvas(bitmap.width,bitmap.height);canvas.getContext('2d')!.drawImage(bitmap,0,0);return await canvas.convertToBlob({type:'image/webp',quality});}
        const canvas=document.createElement('canvas');canvas.width=bitmap.width;canvas.height=bitmap.height;canvas.getContext('2d')!.drawImage(bitmap,0,0);return await new Promise<Blob>((resolve,reject)=>canvas.toBlob(value=>value?resolve(value):reject(new Error('转码失败')),'image/webp',quality));
    } finally {bitmap.close();}
}
const contentType = (mime: string) => mime.split(';')[0]?.trim().toLowerCase() || 'application/octet-stream';
const project = ({ id, mime, size, name }: StoredMedia): MediaHandle => ({ id, mime, size, name });
export function mediaIdentity(plugin: { manifest: { id: string }; fingerprint: string }) { return `${plugin.manifest.id}:${plugin.fingerprint}`; }
export async function saveMedia(owner: string, name: string, blob: Blob, signal?: AbortSignal) {
    if (!blob.size || blob.size > mediaLimit) throw new PluginApiError('QUOTA_EXCEEDED', '媒体文件必须小于 20 MiB');
    const db = await backgroundDb(); signal?.throwIfAborted();
    const tx = db.transaction(['media', 'blobs'], 'readwrite'), done = transactionDone(tx);
    const store = tx.objectStore('media');
    const items: StoredMedia[] = await requestResult(store.index('owner').getAll(owner));
    if (items.length >= maxItems || items.reduce((size, row) => size + row.size, blob.size) > totalLimit) {
        await done; throw new PluginApiError('QUOTA_EXCEEDED', '插件媒体空间已满');
    }
    signal?.throwIfAborted();
    const item: StoredMedia = { id: crypto.randomUUID(), owner, name: name.slice(0, 160), size: blob.size, mime: contentType(blob.type), readers: [] };
    store.add(item); tx.objectStore('blobs').add(blob, item.id);
    await done;
    return project(item);
}
export async function loadMedia(owner: string, id: string) {
    const db = await backgroundDb(), tx = db.transaction(['media', 'blobs']);
    const row: StoredMedia | undefined = await requestResult(tx.objectStore('media').get(id));
    if (!row || row.owner !== owner && !row.readers.includes(owner)) throw missing('媒体');
    const blob: Blob = await requestResult(tx.objectStore('blobs').get(id));
    return { handle: project(row), blob };
}
export async function shareMedia(owner: string, reader: string, ids: string[]) {
    if (!ids.length) return;
    const db = await backgroundDb(), tx = db.transaction('media', 'readwrite'), done = transactionDone(tx);
    const store = tx.objectStore('media');
    const rows: (StoredMedia | undefined)[] = await Promise.all(ids.map(id => requestResult(store.get(id))));
    if (rows.some(row => !row || row.owner !== owner)) { await done; throw missing('可共享的媒体'); }
    for (const row of rows) if (row && !row.readers.includes(reader)) store.put({ ...row, readers: [...row.readers, reader].slice(-64) });
    await done;
}
export async function mediaRpc(owner: string, method: string, args: unknown, signal: AbortSignal) {
    if (method === 'put') {
        const { mime, name, base64 } = z.strictObject({ mime: z.string().max(120), name: idSchema, base64: z.string().max(480_000) }).parse(args);
        return saveMedia(owner, name, new Blob([fromBase64(base64)], { type: mime }), signal);
    }
    if (method === 'read') {
        const { id, offset = 0, length = 64_000 } = z.strictObject({ id: idSchema, offset: sliceInt.optional(), length: sliceInt.min(1).max(300_000).optional() }).parse(args);
        const { blob } = await loadMedia(owner, id);
        return { base64: toBase64(new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer())), next: offset + length < blob.size ? offset + length : null };
    }
    const db = await backgroundDb(); signal.throwIfAborted();
    if(method==='stats'){z.null().parse(args);const rows:StoredMedia[]=await requestResult(db.transaction('media').objectStore('media').index('owner').getAll(owner));return {items:rows.length,bytes:rows.reduce((sum,row)=>sum+row.size,0),maxItems,totalLimit};}
    if (method === 'remove') {
        const id = idSchema.parse(args), tx = db.transaction(['media', 'blobs'], 'readwrite'), done = transactionDone(tx);
        const store = tx.objectStore('media'), row: StoredMedia | undefined = await requestResult(store.get(id));
        if (!row || row.owner !== owner) { await done; throw missing('所属媒体'); }
        store.delete(id); tx.objectStore('blobs').delete(id); await done; return;
    }
    const { cursor, limit } = z.strictObject({ cursor: cursorSchema, limit: limitSchema }).parse(args);
    const rows: StoredMedia[] = await requestResult(db.transaction('media').objectStore('media').index('owner').getAll(owner));
    return page(rows.map(project), cursor, limit);
}

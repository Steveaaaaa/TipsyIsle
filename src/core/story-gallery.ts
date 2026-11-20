import { compatibilityOrigin, isNativeRuntime, platformFetch } from './native-runtime';
import { detectRuntimeFlavor, platformStorage } from './platform-bridge';
import { enqueuePersistentOperation } from '../store/persistence';
import type { GalleryImage, StoryGallery } from './gallery-types';

export async function readStoryGallery(storyId: string): Promise<StoryGallery | null> {
    const response = await platformFetch(`${compatibilityOrigin}/local-gallery/${encodeURIComponent(storyId)}/manifest.json`, { cache: 'no-store' });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error('无法读取本地图库');
    return response.json();
}

export async function pickGalleryArchive(): Promise<File | undefined> {
    if (isNativeRuntime()) {
        const { open } = await import('@tauri-apps/plugin-dialog');
        const path = await open({ multiple: false, directory: false, pickerMode: 'document', filters: [{ name: '本地图库', extensions: ['rar', 'zip'] }] });
        if (!path) return;
        const { readFile } = await import('@tauri-apps/plugin-fs');
        const { basename } = await import('@tauri-apps/api/path');
        return new File([new Uint8Array(await readFile(path)).buffer], await basename(path));
    }
    return new Promise(resolve => {
        const input = document.createElement('input'); input.type = 'file'; input.accept = '.rar,.zip';
        input.onchange = () => { resolve(input.files?.[0]); input.remove(); };
        input.oncancel = () => { resolve(undefined); input.remove(); };
        input.hidden = true; document.body.append(input); input.click();
    });
}

export async function writeGalleryFile(storyId: string, path: string, data: ArrayBuffer): Promise<void> {
    if (isNativeRuntime()) {
        await window.__TAURI_INTERNALS__!.invoke('tipsy_gallery_write', { storyId, path, data: Array.from(new Uint8Array(data)) });
    } else {
        const response = await fetch(`/api/tipsy-isle/gallery/${encodeURIComponent(storyId)}?path=${encodeURIComponent(path)}`, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: data });
        if (!response.ok) throw new Error(`图库保存失败 (${response.status})`);
    }
}

export async function bindStoryGallery(storyId: string, archive: File, onProgress: (text: string) => void, password?: string): Promise<StoryGallery> {
    onProgress('正在解压图库…');
    const data = await archive.arrayBuffer();
    const worker = new Worker(new URL('./gallery-worker.ts', import.meta.url), { type: 'module' });
    let files: GalleryImage[];
    try {
        files = await new Promise((resolve, reject) => {
            worker.onmessage = event => event.data.error ? reject(new Error(event.data.error)) : resolve(event.data.files);
            worker.onerror = event => reject(new Error(event.message));
            worker.postMessage({ data, password }, [data]);
        });
    } finally { worker.terminate(); }
    const manifest: StoryGallery = { version: crypto.randomUUID(), name: archive.name, files: files.map(file => file.path), bytes: files.reduce((sum, file) => sum + file.data.byteLength, 0) };
    let next = 0, saved = 0;
    await Promise.all(Array.from({ length: Math.min(3, files.length) }, async () => {
        while (next < files.length) {
            const file = files[next++];
            await writeGalleryFile(storyId, `${manifest.version}/${file.path}`, file.data);
            file.data = new ArrayBuffer(0); onProgress(`正在保存图库 ${++saved} / ${files.length}`);
        }
    }));
    await writeGalleryFile(storyId, 'manifest.json', new TextEncoder().encode(JSON.stringify(manifest)).buffer);
    window.dispatchEvent(new Event('tipsy-gallery-changed'));
    return manifest;
}

export async function unbindStoryGallery(storyId: string): Promise<void> {
    if (await detectRuntimeFlavor() === 'browser-offline') return;
    if (isNativeRuntime()) await window.__TAURI_INTERNALS__!.invoke('tipsy_gallery_remove', { storyId });
    else {
        const response = await fetch(`/api/tipsy-isle/gallery/${encodeURIComponent(storyId)}`, { method: 'DELETE' });
        if (!response.ok) throw new Error('移除图库失败');
    }
    window.dispatchEvent(new Event('tipsy-gallery-changed'));
}

let cleanupJob: Promise<void> | undefined;
export function drainGalleryCleanup(): Promise<void> {
    return cleanupJob ??= (async () => {
        for (;;) {
            const [id] = await platformStorage.loadSnapshot<string[]>('gallery_cleanup', []);
            if (!id) break;
            await unbindStoryGallery(id);
            await enqueuePersistentOperation(async () => {
                const pending = await platformStorage.loadSnapshot<string[]>('gallery_cleanup', []);
                await platformStorage.saveSnapshots({ gallery_cleanup: pending.filter(item => item !== id) }, false);
            });
        }
    })().finally(() => { cleanupJob = undefined; });
}

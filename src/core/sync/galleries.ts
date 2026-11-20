import { compatibilityOrigin, platformFetch } from '../native-runtime';
import { readStoryGallery, writeGalleryFile, unbindStoryGallery } from '../story-gallery';
import { bytes64, from64, revise, type SyncState } from './protocol';
import type { StoryGallery } from '../gallery-types';

interface GallerySnapshot { storyId: string; manifest: StoryGallery; files: Array<{ path: string; hash: string }> }
export async function captureGalleries(state: SyncState, stories: string[], progress: (text: string) => void): Promise<void> {
    for (const storyId of stories) {
        const id = `gallery:${storyId}`;
        const manifest = await readStoryGallery(storyId);
        const previous = state.records[id]?.value as GallerySnapshot | null;
        if (!manifest) { if (previous) revise(state, id, null); continue; }
        if (previous?.manifest.version === manifest.version) continue;
        const files: GallerySnapshot['files'] = [];
        for (const [index, path] of manifest.files.entries()) {
            progress(`正在准备图库 ${index + 1} / ${manifest.files.length}`);
            const response = await platformFetch(`${compatibilityOrigin}/local-gallery/${encodeURIComponent(storyId)}/${manifest.version}/${path.split('/').map(encodeURIComponent).join('/')}`);
            if (!response.ok) throw new Error(`无法读取图库图片：${path}`);
            const data = await response.arrayBuffer();
            const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', data))].map(v => v.toString(16).padStart(2, '0')).join('');
            if (!state.records[`blob:${hash}`]) revise(state, `blob:${hash}`, bytes64(new Uint8Array(data)));
            files.push({ path, hash });
        }
        revise(state, id, { storyId, manifest, files });
    }
    for (const record of Object.values(state.records)) {
        if (record.id.startsWith('gallery:') && !record.id.includes('~') && !stories.includes(record.id.slice(8)) && record.value !== null) revise(state, record.id, null);
    }
}
export async function applyGalleries(state: SyncState, changed: Set<string>, progress: (text: string) => void): Promise<void> {
    for (const id of changed) {
        if (!id.startsWith('gallery:') || id.includes('~')) continue;
        const snapshot = state.records[id].value as GallerySnapshot | null;
        if (!snapshot) { await unbindStoryGallery(id.slice(8)); continue; }
        for (const [index, file] of snapshot.files.entries()) {
            progress(`正在保存图库 ${index + 1} / ${snapshot.files.length}`);
            await writeGalleryFile(snapshot.storyId, `${snapshot.manifest.version}/${file.path}`, from64(state.records[`blob:${file.hash}`].value).buffer);
        }
        await writeGalleryFile(snapshot.storyId, 'manifest.json', new TextEncoder().encode(JSON.stringify(snapshot.manifest)).buffer);
    }
}

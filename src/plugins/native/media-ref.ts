import type { MediaRef, Permission, StoryParticipant } from '../../../packages/plugin-sdk/index.js';
import { compatibilityOrigin, platformFetch } from '../../core/native-runtime';
import { detectRuntimeFlavor } from '../../core/platform-bridge';
import { readStoryGallery } from '../../core/story-gallery';
import { getActiveCharacter, getActivePersona, getAvailableWorldbooks, getCharacterWorldbooks } from '../../store/workspace-store';
import { themeEngineStore } from '../../theme/theme-engine';
import { readLimited } from './bytes';
import { getCardVisualIndex } from './card-visual-index';
import { httpEndpoint } from './connections';
import { PluginApiError } from './errors';
import { loadMedia, mediaLimit } from './media';
import { liveStory } from './story-port';

const PRIVATE_HOST_RE = /^(?:localhost|127\.0\.0\.1|\[::1\]|::1|0\.0\.0\.0|10\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.)/i;
const remoteAssetCache = new Map<string, Blob>();
let remoteAssetCacheBytes = 0;
const REMOTE_CACHE_MAX_ITEMS = 24;
const REMOTE_CACHE_MAX_BYTES = 48 * 1024 * 1024;

function sniffImageMime(bytes: Uint8Array): 'image/png' | 'image/jpeg' | 'image/webp' | null {
    if (bytes.length < 12) return null;
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
    if (
        bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
        bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
    ) {
        return 'image/webp';
    }
    return null;
}

function cacheRemoteAsset(key: string, blob: Blob) {
    if (blob.size > mediaLimit) return;
    if (remoteAssetCache.has(key)) {
        remoteAssetCacheBytes -= remoteAssetCache.get(key)!.size;
        remoteAssetCache.delete(key);
    }
    while (
        remoteAssetCache.size >= REMOTE_CACHE_MAX_ITEMS ||
        (remoteAssetCacheBytes + blob.size > REMOTE_CACHE_MAX_BYTES && remoteAssetCache.size > 0)
    ) {
        const oldestKey = remoteAssetCache.keys().next().value;
        if (oldestKey === undefined) break;
        remoteAssetCacheBytes -= remoteAssetCache.get(oldestKey)!.size;
        remoteAssetCache.delete(oldestKey);
    }
    remoteAssetCache.set(key, blob);
    remoteAssetCacheBytes += blob.size;
}

export function participants(): StoryParticipant[] {
    const card = getActiveCharacter();
    const persona = getActivePersona();
    const route = liveStory().route;
    return [
        {
            role: 'character',
            id: card.id,
            name: card.name,
            description: card.description.slice(0, 8000),
            avatar: card.avatar ? { source: 'character.avatar', characterId: card.id } : null,
        },
        ...(persona
            ? [{
                role: 'persona' as const,
                id: persona.avatar_id,
                name: persona.name,
                description: String(persona.description ?? '').slice(0, 8000),
                avatar: persona.image && route ? { source: 'persona.avatar' as const, route } : null,
            }]
            : []),
    ];
}

export async function visualSources() {
    const card = getActiveCharacter();
    const bound = getCharacterWorldbooks(card);
    const names = new Set([bound.primary, ...bound.additional]);
    const gallery = await readStoryGallery(card.id).catch(() => null);
    const books = [
        card.characterBook,
        card.embeddedLorebook,
        ...getAvailableWorldbooks().filter((book) => names.has(book.name)),
    ];
    const index = getCardVisualIndex(card, books, gallery);
    return {
        characterId: card.id,
        layoutMode: themeEngineStore.getState().layoutMode,
        people: index.people,
        profiles: index.profiles,
        gallery: index.gallery,
        characters: index.characters,
    };
}

export async function resolveReference(
    owner: string,
    ref: MediaRef,
    permissions: Permission[],
    signal: AbortSignal,
): Promise<Blob> {
    const permission = ref.source === 'media' ? 'media.manage' : 'assets.read';
    if (!permissions.includes(permission)) throw new PluginApiError('PERMISSION_DENIED', `参考图需要 ${permission}`);
    if (ref.source === 'media') {
        const { blob } = await loadMedia(owner, ref.id);
        if (!/^image\/(jpeg|png|webp)$/.test(blob.type)) throw new Error('不支持的参考图格式');
        return blob;
    }
    const card = getActiveCharacter();
    const route = liveStory().route;
    if (
        ('characterId' in ref && ref.characterId !== card.id) ||
        (ref.source === 'persona.avatar' && (ref.route.chatId !== route?.chatId || ref.route.routeId !== route.routeId))
    ) {
        throw new PluginApiError('STALE_ROUTE', '参考图不属于当前剧情');
    }
    if (ref.source === 'card.asset') {
        const bound = getCharacterWorldbooks(card);
        const names = new Set([bound.primary, ...bound.additional]);
        const gallery = await readStoryGallery(card.id).catch(() => null);
        const books = [
            card.characterBook,
            card.embeddedLorebook,
            ...getAvailableWorldbooks().filter((book) => names.has(book.name)),
        ];
        const index = getCardVisualIndex(card, books, gallery);
        const asset = index.assetsById.get(ref.assetId);
        if (!asset) throw new Error('角色卡参考图不存在');

        if (asset.localGalleryPath && gallery?.files.includes(asset.localGalleryPath)) {
            const url = [card.id, gallery.version, ...asset.localGalleryPath.split('/')].map(encodeURIComponent).join('/');
            const response = await platformFetch(`${compatibilityOrigin}/local-gallery/${url}`, { signal });
            if (response.ok) return readLimited(response, mediaLimit, signal);
        }

        const cacheKey = `${card.id}:${ref.assetId}`;
        const cached = remoteAssetCache.get(cacheKey);
        if (cached) return cached;

        const urls = [asset.url, ...(asset.fallbackUrls ?? [])].filter((item): item is string => !!item);
        const gateway = (await detectRuntimeFlavor()) === 'local-gateway';
        for (const rawUrl of urls) {
            signal.throwIfAborted();
            try {
                const parsed = httpEndpoint(rawUrl);
                if (
                    PRIVATE_HOST_RE.test(parsed.hostname) ||
                    (typeof location !== 'undefined' && location.origin === parsed.origin)
                ) {
                    continue;
                }
                const response = gateway
                    ? await fetch('/api/tipsy-isle/llm/image', {
                        method: 'POST',
                        signal,
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            url: parsed.href,
                            method: 'GET',
                            protocol: 'result_url',
                            approvedOrigin: parsed.origin,
                        }),
                    })
                    : await platformFetch(parsed.href, {
                        signal,
                        redirect: 'error',
                        credentials: 'omit',
                    });
                if (!response.ok) {
                    await response.body?.cancel();
                    continue;
                }
                const limited = await readLimited(response, mediaLimit, signal);
                const bytes = new Uint8Array(await limited.arrayBuffer());
                const mime = sniffImageMime(bytes);
                if (!mime) continue;
                const blob = new Blob([bytes], { type: mime });
                cacheRemoteAsset(cacheKey, blob);
                return blob;
            } catch (error) {
                if (signal.aborted) throw error;
            }
        }
        throw new Error('远程参考图加载失败');
    }
    if (ref.source === 'story.gallery') {
        const info = await readStoryGallery(card.id);
        if (!info?.files.includes(ref.path) || ref.path.split(/[\\/]/).some((part) => !part || part === '..' || part === '.')) {
            throw new Error('图库图片不存在');
        }
        const url = [card.id, info.version, ...ref.path.split('/')].map(encodeURIComponent).join('/');
        const response = await platformFetch(`${compatibilityOrigin}/local-gallery/${url}`, { signal });
        if (!response.ok) throw new Error('读取图库失败');
        return readLimited(response, mediaLimit, signal);
    }
    const image = ref.source === 'persona.avatar' ? getActivePersona()?.image : card.avatar;
    if (!image || !/^data:image\/(?:png|jpeg|webp);base64,/i.test(image)) {
        throw new Error('没有可读取的本地头像');
    }
    return readLimited(await fetch(image, { signal }), mediaLimit, signal);
}

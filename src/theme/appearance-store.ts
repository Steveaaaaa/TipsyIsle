import { platformStorage } from '../core/platform-bridge';
import _ from 'lodash';
import { createReactiveStore } from '../store/reactive-store';
import { acknowledgeSnapshots, enqueuePersistentOperation, registerSnapshotSource } from '../store/persistence';
import { areas, blankAppearance, type Appearance, type AppearanceAsset, type Device, type Layout } from './appearance-model';

export const APPEARANCE_SNAPSHOT = 'appearance_state';
const LIBRARY_SNAPSHOT = 'appearance_library';
const packKey = (id: string) => `appearance_pack:${id}`;
export const isAppearanceLibrarySnapshot = (key: string) => key === LIBRARY_SNAPSHOT || key.startsWith('appearance_pack:');
export interface AppearanceState { saved: Appearance | null; previous: Appearance | null; legacyCss: string; activePackId: string | null; previousPackId: string | null }
export interface AppearancePackEntry { id: string; name: string }
const initial: AppearanceState = { saved: null, previous: null, legacyCss: '', activePackId: null, previousPackId: null };
export const appearanceStore = createReactiveStore<AppearanceState>(() => initial);
export const appearanceLibrary = createReactiveStore<{ packs: AppearancePackEntry[] }>(() => ({ packs: [] }));
registerSnapshotSource(APPEARANCE_SNAPSHOT, appearanceStore.getState);

const packName = (skin: Appearance) => skin.name.trim() || '未命名外观';
const packEntry = (skin: Appearance): AppearancePackEntry => ({ id: crypto.randomUUID(), name: packName(skin) });

const deviceKey = 'tipsy:appearance-device';
const pauseKey = 'tipsy:appearance-paused';
function loadDevice() {
    try { return JSON.parse(localStorage.getItem(deviceKey) ?? '{}') as Partial<Record<Device, Layout>>; } catch { return {}; }
}
export const appearanceDevice = createReactiveStore(() => ({
    layouts: loadDevice(), paused: new URLSearchParams(location.search).get('appearance') === 'off' || localStorage.getItem(pauseKey) === '1',
}));
export function pauseAppearance(paused: boolean) {
    localStorage.setItem(pauseKey, paused ? '1' : '0');
    if (!paused) {
        const current = new URL(location.href);
        if (current.searchParams.get('appearance') === 'off') {
            current.searchParams.delete('appearance'); history.replaceState(history.state, '', current);
        }
    }
    appearanceDevice.setState({ paused });
}
export function saveDeviceLayouts(layouts: Partial<Record<Device, Layout>>) {
    localStorage.setItem(deviceKey, JSON.stringify(layouts)); appearanceDevice.setState({ layouts });
}

function layoutOf(value: unknown): Layout {
    if (!value || typeof value !== 'object') return {};
    return Object.fromEntries(Object.keys(areas).flatMap(area => {
        const ids = (value as Record<string, unknown>)[area];
        return Array.isArray(ids) ? [[area, ids.filter((id): id is string => typeof id === 'string')]] : [];
    }));
}
export function decodeAppearance(value: unknown): Appearance {
    const raw = value as Partial<Appearance> | undefined;
    if (!raw || raw.version !== 1 || typeof raw.name !== 'string') throw new Error('这个外观包的格式不受支持。');
    const defaults = blankAppearance();
    const text = Object.fromEntries(Object.entries(raw.text ?? {}).filter(([, v]) => typeof v === 'string'));
    const assets = Object.fromEntries(Object.entries(raw.assets ?? {}).filter(([key, item]) => /^[\w-]+$/.test(key) && item && typeof item.name === 'string'
        && /^(?:image\/(?:png|jpeg|webp|gif|avif|svg\+xml)|font\/(?:woff2?|ttf|otf))$/.test(item.mime)
        && typeof item.data === 'string' && item.data.startsWith(`data:${item.mime};base64,`) && /^[a-z0-9+/=]+$/i.test(item.data.split(',')[1] ?? '')));
    const hasAsset = (id: string, category: 'image' | 'font') => Object.hasOwn(assets, id) && assets[id].mime.startsWith(`${category}/`);
    const art = Object.fromEntries(Object.entries(raw.art ?? {}).filter(([, id]) => typeof id === 'string' && hasAsset(id, 'image')));
    const fonts = Object.fromEntries(Object.entries(raw.fonts ?? {}).flatMap(([key, font]) => !font || typeof font !== 'object' ? [] : [[key, {
        family: typeof font.family === 'string' ? font.family : '', asset: hasAsset(font.asset, 'font') ? font.asset : '',
        size: Number.isFinite(font.size) ? Math.max(0, Math.min(64, font.size)) : 0,
    }]]));
    const paper = raw.wallpaper;
    return { ...defaults, name: raw.name, text, assets, art, fonts,
        wallpaper: { source: typeof paper?.source === 'string' ? paper.source : '', fit: paper?.fit === 'contain' || paper?.fit === 'tile' ? paper.fit : 'cover',
            position: typeof paper?.position === 'string' ? paper.position : 'center', shade: Number.isFinite(paper?.shade) ? Math.min(0.9, Math.max(0, paper!.shade)) : 0 },
        layout: { desktop: layoutOf(raw.layout?.desktop), mobile: layoutOf(raw.layout?.mobile) },
        widgets: (Array.isArray(raw.widgets) ? raw.widgets : []).filter(w => w && typeof w.id === 'string' && /^widget-[\w-]+$/.test(w.id) && typeof w.label === 'string').map(w => ({
            id: w.id, label: w.label, image: hasAsset(w.image, 'image') ? w.image : '',
            value: (['character', 'messages', 'library', 'time'] as string[]).includes(w.value) ? w.value : '',
            action: (['routes', 'settings', 'appearance'] as string[]).includes(w.action) ? w.action : '',
        })), css: typeof raw.css === 'string' ? raw.css : '',
    };
}

export async function hydrateAppearance() {
    const saved = await platformStorage.loadSnapshot<Partial<AppearanceState> | null>(APPEARANCE_SNAPSHOT, null);
    const next = { ...initial, ...saved };
    const packs = await platformStorage.loadSnapshot<AppearancePackEntry[] | null>(LIBRARY_SNAPSHOT, null);
    if (packs) { appearanceStore.setState(next); appearanceLibrary.setState({ packs }); return; }

    if (!saved) {
        const old = await platformStorage.loadSnapshot<{ tokens?: { wallpaperUrl?: string }; scopedCustomCss?: string } | null>('theme_state', null);
        next.legacyCss = old?.scopedCustomCss ?? '';
        if (old?.tokens?.wallpaperUrl) {
            next.saved = blankAppearance(); next.saved.wallpaper.source = old.tokens.wallpaperUrl;
        }
    }
    const entries: AppearancePackEntry[] = [];
    const copies: Record<string, Appearance> = {};
    const keep = (skin: Appearance) => {
        const entry = packEntry(skin);
        entries.push(entry); copies[packKey(entry.id)] = skin;
        return entry.id;
    };
    if (next.saved) next.activePackId = keep(next.saved);
    if (next.previous) next.previousPackId = next.activePackId && _.isEqual(next.saved, next.previous) ? next.activePackId : keep(next.previous);
    if (entries.length) {
        await platformStorage.saveSnapshots({ [APPEARANCE_SNAPSHOT]: next, [LIBRARY_SNAPSHOT]: entries, ...copies }, false);
        acknowledgeSnapshots({ [APPEARANCE_SNAPSHOT]: next });
    }
    appearanceStore.setState(next);
    appearanceLibrary.setState({ packs: entries });
}

async function writeAppearance(next: AppearanceState, extras: Record<string, unknown> = {}) {
    await platformStorage.saveSnapshots({ ...extras, [APPEARANCE_SNAPSHOT]: next });
    appearanceStore.setState(next);
    acknowledgeSnapshots({ [APPEARANCE_SNAPSHOT]: next });
}

export function importAppearancePacks(skins: Appearance[]) {
    return enqueuePersistentOperation(async () => {
        const entries = skins.map(packEntry);
        const packs = [...entries, ...appearanceLibrary.getState().packs];
        await platformStorage.saveSnapshots({ [LIBRARY_SNAPSHOT]: packs, ...Object.fromEntries(entries.map((entry, index) => [packKey(entry.id), skins[index]])) }, false);
        appearanceLibrary.setState({ packs });
    });
}

export async function loadAppearancePack(id: string): Promise<Appearance> {
    const pack = await platformStorage.loadSnapshot<Appearance | null>(packKey(id), null);
    if (!pack) throw new Error('找不到这个外观包，可能已被删除。');
    return pack;
}

function withActivePack(before: AppearanceState, skin: Appearance | null, id: string | null): AppearanceState {
    return { ...before, saved: skin, activePackId: id, previous: before.saved, previousPackId: before.activePackId };
}

export function useAppearancePack(id: string) {
    return enqueuePersistentOperation(async () => {
        const before = appearanceStore.getState();
        if (before.activePackId !== id) await writeAppearance(withActivePack(before, await loadAppearancePack(id), id));
    });
}

export function saveAppearance(skin: Appearance | null, id: string | null) {
    return enqueuePersistentOperation(async () => {
        const before = appearanceStore.getState();
        if (!skin) { await writeAppearance(withActivePack(before, null, null)); return; }
        const pack = decodeAppearance(skin);
        const existing = appearanceLibrary.getState().packs;
        const idInLibrary = existing.find(entry => entry.id === id)?.id;
        const entry = idInLibrary ? { id: idInLibrary, name: packName(pack) } : packEntry(pack);
        const packs = idInLibrary ? existing.map(item => item.id === id ? entry : item) : [entry, ...existing];
        await writeAppearance(withActivePack(before, pack, entry.id), { [LIBRARY_SNAPSHOT]: packs, [packKey(entry.id)]: pack });
        appearanceLibrary.setState({ packs });
    });
}

export function deleteAppearancePack(id: string) {
    return enqueuePersistentOperation(async () => {
        const packs = appearanceLibrary.getState().packs.filter(entry => entry.id !== id);
        const before = appearanceStore.getState();
        const extras = { [LIBRARY_SNAPSHOT]: packs, [packKey(id)]: null };
        if (before.activePackId === id || before.previousPackId === id) {
            await writeAppearance({ ...before,
                ...(before.activePackId === id && { saved: null, activePackId: null }),
                ...(before.previousPackId === id && { previous: null, previousPackId: null }),
            }, extras);
        } else await platformStorage.saveSnapshots(extras, false);
        appearanceLibrary.setState({ packs });
    });
}

const mimeByExtension: Record<string, string> = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif', svg: 'image/svg+xml',
    woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
};
export async function appearanceAsset(file: File, category: 'image' | 'font'): Promise<AppearanceAsset> {
    const mime = mimeByExtension[file.name.split('.').at(-1)?.toLowerCase() ?? ''] ?? file.type;
    if (!mime.startsWith(`${category}/`) || !Object.values(mimeByExtension).includes(mime)) throw new Error('不支持这种素材格式。');
    const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(new Blob([file], { type: mime }));
    });
    return { name: file.name, mime, data };
}

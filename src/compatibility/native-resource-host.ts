import _ from 'lodash';
import { platformStorage } from '../core/platform-bridge';
import { serializeCharacterCard, serializeLorebook } from '../pipeline/asset-serializer';
import { workspaceStore, persistWorkspaceNow, updateCharacterDocument, type WorkspaceState } from '../store/workspace-store';
import { characterAvatarId } from './asset-identity';
import { toNativeWorldbookEntry } from './worldbook-codec';
import type { NormalizedCharacterCard } from '../types';

let readSources: unknown[] = [];
let readJob: Promise<[Pick<WorkspaceState, 'characters' | 'lorebooks' | 'presets'>, Partial<WorkspaceState>]> | undefined;
function readSavedResources() {
    const state = workspaceStore.getState();
    const sources = [state.characters, state.lorebooks, state.presets, state.characterWorldbookBindings];
    if (!readJob || sources.some((value, index) => value !== readSources[index])) {
        readSources = sources;
        const job = Promise.all([
            platformStorage.loadSnapshot<Pick<WorkspaceState, 'characters' | 'lorebooks' | 'presets'>>('workspace_assets', { characters: [], lorebooks: [], presets: [] }),
            platformStorage.loadSnapshot<Partial<WorkspaceState>>('workspace_snapshot', {}),
        ]);
        readJob = job;
        void job.catch(() => { if (readJob === job) readJob = undefined; });
    }
    return readJob;
}
function rawCharacter(card: NormalizedCharacterCard) {
    const raw = serializeCharacterCard(card);
    return { ...raw, ...(raw.data ?? raw) as object, data: raw.data ?? raw, avatar: characterAvatarId(card) };
}

/** Allowlisted original-host operations, backed by the existing durable storage. */
export async function requestNativeResource(path: string, body: Record<string, any>): Promise<unknown> {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('宿主请求正文必须为对象');
    if (path === '/api/characters/merge-attributes') {
        const card = workspaceStore.getState().characters.find(card => characterAvatarId(card) === body.avatar);
        if (!card) throw new Error('找不到角色');
        if (!body.data || typeof body.data !== 'object' || Array.isArray(body.data)) throw new Error('角色修改数据必须为对象');
        const raw = serializeCharacterCard(card);
        const data = (raw.data ?? raw) as Record<string, unknown>;
        _.mergeWith(data, body.data, (_old: unknown, next: unknown) => Array.isArray(next) ? structuredClone(next) : undefined);
        if (body.data.extensions?.regex_scripts !== undefined) {
            for (const alias of ['regexScripts', 'regex_scripts']) { delete data[alias]; delete raw[alias]; }
        }
        updateCharacterDocument(card.id, raw);
        await persistWorkspaceNow();
        return { ok: true };
    }
    if (!['/api/characters/get', '/api/settings/get', '/api/worldinfo/get'].includes(path)) throw new Error(`未适配宿主资源路径：${path}`);
    await persistWorkspaceNow();
    const [assets, workspace] = await readSavedResources();
    if (path === '/api/characters/get') {
        const card = assets.characters.find(card => characterAvatarId(card) === body.avatar_url);
        if (!card) throw new Error('找不到已保存的角色');
        return rawCharacter(card);
    }
    const books = [...new Map([...assets.lorebooks, ...assets.characters.flatMap(card => card.characterBook ?? card.embeddedLorebook ?? [])].map(book => [book.id, book])).values()];
    if (path === '/api/worldinfo/get') {
        const book = books.find(book => book.name === body.name);
        if (!book) throw new Error('找不到已保存的世界书');
        return { ...serializeLorebook(book), entries: Object.fromEntries(book.entries.map(entry => [entry.uid, toNativeWorldbookEntry(entry)])) };
    }
    const charLore = assets.characters.map(card => ({ name: characterAvatarId(card).replace(/\.[^/.]+$/, ''),
        extraBooks: workspace.characterWorldbookBindings?.[card.id]?.additional ?? card.additionalWorldbooks ?? [] }));
    return { world_names: [...new Set(books.map(book => book.name))], settings: JSON.stringify({ world_info_settings: { world_info: { charLore } } }) };
}

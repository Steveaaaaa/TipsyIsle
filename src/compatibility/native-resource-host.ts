import _ from 'lodash';
import { platformStorage } from '../core/platform-bridge';
import { serializeCharacterCard } from '../pipeline/asset-serializer';
import { activePath } from '../store/chat-tree';
import { loadChatArchive } from '../store/chat-archives';
import { workspaceStore, persistWorkspaceNow, updateCharacterDocument, getActiveChatMessages, getActiveCharacter, getActivePreset, writeHelperPreset, worldbooksChanged, type WorkspaceState } from '../store/workspace-store';
import { characterAvatarId } from './asset-identity';
import { hostMessageHidden, messageExtra, messageTopLevel } from './chat-message-codec';
import { fromNativePreset, toNativePreset } from './preset-codec';
import { allWorldbooks, requestWorldbook } from './worldbook-host';
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
    if (path === '/api/worldinfo/list') {
        return requestWorldbook('worldbook.native.list', {});
    }
    if (path === '/api/worldinfo/get') {
        if (typeof body.name !== 'string' || !body.name.trim()) throw new Error('世界书名称必须是非空字符串');
        return requestWorldbook('worldbook.native.get', { name: body.name });
    }
    if (path === '/api/worldinfo/edit') {
        if (typeof body.name !== 'string' || !body.name.trim()) throw new Error('World file must have a name');
        if (!body.data || typeof body.data !== 'object' || Array.isArray(body.data) || !('entries' in body.data) || !body.data.entries || typeof body.data.entries !== 'object') {
            throw new Error('Is not a valid world info file');
        }
        await requestWorldbook('worldbook.native.save', { name: body.name, data: body.data });
        return { ok: true };
    }
    if (path === '/api/worldinfo/delete') {
        if (typeof body.name !== 'string' || !body.name.trim()) throw new Error('世界书名称必须是非空字符串');
        const deleted = await requestWorldbook('worldbook.delete', { name: body.name });
        if (!deleted) throw new Error(`World info file ${body.name}.json doesn't exist.`);
        return { ok: true };
    }
    if (path === '/api/presets/save') {
        if (typeof body.name !== 'string' || !body.name.trim()) throw new Error('预设名称必须是非空字符串');
        if (!body.preset || typeof body.preset !== 'object' || Array.isArray(body.preset)) throw new Error('预设内容必须为对象');
        const name = body.name.trim();
        const previous = workspaceStore.getState().presets.find(item => item.name === name);
        const next = fromNativePreset(body.preset as Record<string, any>, name, previous);
        writeHelperPreset(next, previous?.id, false);
        if (previous && previous.id === workspaceStore.getState().activePresetId) {
            writeHelperPreset(structuredClone(next), previous.id, true);
        }
        await persistWorkspaceNow();
        worldbooksChanged();
        return { name };
    }
    if (path === '/api/chats/get') {
        await persistWorkspaceNow();
        const state = workspaceStore.getState();
        const fileName = typeof body.file_name === 'string' ? body.file_name : '';
        const isCurrent = !fileName || fileName === state.activeChatId;
        const archived = isCurrent ? null : await loadChatArchive(fileName).catch(() => null);
        if (!isCurrent && !archived) throw new Error('找不到指定的聊天记录');
        const nodes = isCurrent ? getActiveChatMessages(state) : activePath(archived!.messages, archived!.activeLeafId);
        const chatMetadata = isCurrent ? state.chatMetadata : archived!.continuation?.chatMetadata;
        const userName = isCurrent ? state.userName : archived!.continuation?.userName ?? state.userName;
        const card = isCurrent ? getActiveCharacter(state) : archived!.continuation?.character ?? state.characters.find(c => c.id === archived!.characterId);
        const header = {
            user_name: userName,
            character_name: card?.name ?? '',
            create_date: nodes[0]?.createdAt ?? 0,
            chat_metadata: structuredClone(chatMetadata ?? {}),
        };
        const rows = nodes.map(node => ({
            ...messageTopLevel(node),
            name: node.speakerName,
            is_user: node.role === 'user',
            is_system: hostMessageHidden(node, chatMetadata),
            mes: node.content,
            swipe_id: node.activeSwipeIndex,
            swipes: node.swipes.map(s => typeof s === 'string' ? s : s.content),
            extra: messageExtra(node, node.activeSwipeIndex, chatMetadata),
            swipe_info: node.swipes.map((_, i) => ({ extra: messageExtra(node, i, chatMetadata) })),
        }));
        return [header, ...rows];
    }
    if (!['/api/characters/get', '/api/settings/get'].includes(path)) throw new Error(`未适配宿主资源路径：${path}`);
    await persistWorkspaceNow();
    const [assets, workspace] = await readSavedResources();
    const state = workspaceStore.getState();
    const characters = assets.characters.length ? assets.characters : state.characters;
    if (path === '/api/characters/get') {
        const card = characters.find(card => characterAvatarId(card) === body.avatar_url);
        if (!card) throw new Error('找不到已保存的角色');
        return rawCharacter(card);
    }
    const worldNames = [...new Set(allWorldbooks().map(book => book.name))];
    const charLore = characters.map(card => ({ name: characterAvatarId(card).replace(/\.[^/.]+$/, ''),
        extraBooks: workspace.characterWorldbookBindings?.[card.id]?.additional ?? state.characterWorldbookBindings?.[card.id]?.additional ?? card.additionalWorldbooks ?? [] }));
    const presets = assets.presets.length ? assets.presets : state.presets;
    const activePreset = workspace.inUsePreset
        ?? presets.find(item => item.id === (workspace.activePresetId ?? state.activePresetId))
        ?? getActivePreset(state);
    return {
        world_names: worldNames,
        openai_setting_names: presets.map(preset => preset.name),
        openai_settings: presets.map(preset => toNativePreset(preset)),
        settings: JSON.stringify({
            world_info_settings: { world_info: { charLore } },
            oai_settings: toNativePreset(activePreset),
        }),
    };
}

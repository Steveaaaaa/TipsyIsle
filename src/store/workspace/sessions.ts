import { listChatArchives, loadChatArchive, saveChatArchive, deleteChatArchives, updateChatArchive, summarizeChat, freeChatName, type ArchivedChat, type ChatSessionKind, type FreeChatDetails } from '../chat-archives';
import { batchReactiveUpdates, cloneStateValue, withoutStoreNotifications } from '../reactive-store';
import { normalizeChatPayload } from '../../pipeline/normalizer';
import { emptyStory } from '../../core/empty-workspace';
import { removeStarterContinuation } from '../../core/retired-starter-content';
import { restoreStoryResources } from '../../core/story-save';
import type { StoryImport } from '../../core/story-save-format';
import { platformStorage } from '../../core/platform-bridge';
import { getSchemaValues, schemaRegistryStore, setSchemaValues } from '../../registry/schema-registry';
import { presetSchemaValues } from '../../core/generation-settings';
import { scopedVariableStore, replaceExtensionVariables, replaceScopedVariables } from '../scoped-variable-store';
import { activePath, branchExcerpt, swipeId, storyRoutes, withSwipe } from '../chat-tree';
import { branchMessageVariables } from '../branch-state';
import { pendingBranchOperations, runBranchOperation } from '../branch-runtime';
import { compatibilityComposer } from '../../compatibility/composer-bridge';
import { mvuProjectionKeys } from '../../pipeline/mvu-data';
import { routeGraph, vertexPath } from '../../plugins/native/route-graph';
import { tavernEventBus } from '../../sandbox/event-bus';
import { stopCompatibilityRuntime } from '../../compatibility/runtime-client';
import { readExtensionVariables } from '../../compatibility/extension-variables';
import type { ChatMessageNode, NormalizedCharacterCard, NormalizedPreset } from '../../types';
import { enqueuePersistentOperation, suspendRegisteredPersistence, waitForReplicaCommit, holdReplicaCommit, registeredSnapshots, acknowledgeSnapshots } from '../persistence';
import { workspaceStore, type WorkspaceState } from './state';
import { getActivePreset, getActiveLorebooks, getCharacterWorldbooks, getActiveCharacter, getActivePersona } from './library';
import { schedulePreview, invalidateTemplateEnvironment } from './prompt';
import { commitWorkspaceMutation, persistWorkspace, persistWorkspaceNow } from './storage';
import { setStatusBanner } from './notice';
import { getActiveChatMessages, preserveAuthorMessageRevision, getEffectiveMvuSettings } from './queries';
import { branchBusy, isNativeStorySaving } from './activity';
import { routePluginBucketsAt, routeWorldbooks } from './route-resources';
import { normalizeMessageVariableSnapshots, ensureInitialVariables } from './story-initialization';
import { syncCharacterScriptsFromLibrary, syncPresetScriptsFromLibrary } from './scripts';

function buildInitialMessages(card: NormalizedCharacterCard): ChatMessageNode[] {
    const firstMes = card.firstMessage ?? '';
    const alternate = Array.isArray(card.alternateGreetings) ? card.alternateGreetings : [];
    const swipes = [firstMes, ...alternate];
    const greeting = swipes[0];
    const now = Date.now();
    const id = `msg_${crypto.randomUUID()}`;
    return [
        {
            id,
            messageId: id,
            parentId: null,
            floor: 0,
            role: 'assistant',
            speakerName: card.name,
            content: greeting,
            swipes,
            activeSwipeIndex: 0,
            createdAt: now,
            updatedAt: now,
            extra: { tipsy_mvu_initialization_pending: true },
        },
    ];
}

function captureActiveChatForArchive(): void {
    const state = workspaceStore.getState(), leaf = getActiveChatMessages(state).at(-1);
    if (leaf) batchReactiveUpdates(() => {
        sessionBranches.capture(leaf.id);
        preserveAuthorMessageRevision(state.messages, workspaceStore.getState().messages);
    });
}

async function archiveActiveChat(): Promise<void> {
    captureActiveChatForArchive();
    const entry = readActiveArchive(workspaceStore.getState().activeChatId);
    if (entry) await saveChatArchive(entry, true);
}

export function readNativeChat(id: string): ArchivedChat | null {
    if (workspaceStore.getState().sessionKind === 'free') return null;
    return readActiveArchive(id);
}

function readActiveArchive(id: string): ArchivedChat | null {
    const state = workspaceStore.getState();
    if (!id || id !== state.activeChatId) return null;
    if (state.sessionKind !== 'free' && !state.messages.length) return null;
    if (state.sessionKind === 'free') return { id, kind: 'free', freeChat: state.freeChat, characterId: '', messages: state.messages,
        activeLeafId: state.activeLeafId, timedStates: {} };
    return { id: state.activeChatId, title: state.storyChatTitle, characterId: state.activeCharacterId, importedFrom: state.storyImportFingerprint,
        messages: state.messages, deletedMessageIds: state.deletedMessageIds, activeLeafId: state.activeLeafId, timedStates: state.timedStates, worldbookName: state.chatWorldbookBindings[state.activeChatId] ?? null, templateInjections: state.templateInjections, templateActivations: state.templateActivations,
        continuation: captureChatContinuation() };
}

export async function listArchivedChats() {
    const archives = await listChatArchives();
    const state = workspaceStore.getState();
    const names = new Map(state.characters.map(card => [card.id, card.name]));
    return archives.filter(chat => chat.id !== state.activeChatId).map(chat => {
        const characterName = chat.characterName ?? names.get(chat.characterId) ?? '角色';
        const preview = branchExcerpt(chat.lastMessage, 90);
        const title = chat.kind === 'free' ? chat.freeChat?.title || freeChatName : chat.title || chat.syncLabel || '';
        return { id: chat.id, characterId: chat.characterId, kind: chat.kind, title, characterName, preview,
            label: chat.kind === 'free' ? `${title} · ${chat.activeCount} 条` : `${title ? `${title} · ` : ''}${characterName} · ${chat.messageCount} 条${preview ? ` · ${preview}` : ''}`,
            messageCount: chat.activeCount, lastActivity: chat.lastActivity ?? (Date.parse(chat.lastDate ?? '') || undefined) };
    });
}

export async function readHelperChatArchives(characterId?: string, files?: string[]): Promise<any> {
    const state = workspaceStore.getState();
    const current: ArchivedChat = { id: state.activeChatId, characterId: state.activeCharacterId, messages: state.messages, deletedMessageIds: state.deletedMessageIds,
        activeLeafId: state.activeLeafId, timedStates: state.timedStates };
    const summaries = (await listChatArchives()).filter(chat => chat.kind !== 'free' && chat.id !== current.id);
    if (state.sessionKind !== 'free' && state.messages.length) summaries.push(summarizeChat(current));
    if (!files) return summaries.filter(chat => chat.characterId === characterId).map(chat => ({ file_name: `${chat.id}.jsonl`,
        chat_items: chat.activeCount, mes: chat.lastMessage, last_mes: chat.lastDate ?? '',
        ch_name: state.characters.find(card => card.id === chat.characterId)?.name ?? '' }));
    const selected = summaries.filter(chat => files.includes(`${chat.id}.jsonl`) || files.includes(chat.id));
    const archives = (await Promise.all(selected.map(chat => chat.id === current.id ? current : loadChatArchive(chat.id))))
        .filter((chat): chat is ArchivedChat => !!chat);
    if (files) return Object.fromEntries(archives.filter(chat => files.includes(`${chat.id}.jsonl`) || files.includes(chat.id)).map(chat => [files.find(file => file === chat.id || file === `${chat.id}.jsonl`)!,
        activePath(chat.messages, chat.activeLeafId).map(node => ({ name: node.speakerName, is_user: node.role === 'user', is_system: !!node.isHidden,
            mes: node.content, send_date: node.sendDate, swipe_id: node.activeSwipeIndex, swipes: node.swipes.map(swipe => typeof swipe === 'string' ? swipe : swipe.content),
            variables: node.swipes.map((_, index) => (node.extra?.swipeVariables as Record<string, unknown> | undefined)?.[index] ?? {}),
            variables_initialized: node.swipes.map((_, index) => !!(node.extra?.tipsy_template_variables_initialized as Record<string, boolean> | undefined)?.[index]),
            extra: node.extra }))]));

}

export async function importHelperChat(content: string): Promise<string> {
    const state = workspaceStore.getState();
    const lines = content.split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line));
    const messages = normalizeChatPayload(lines);
    const chatVariables = lines[0]?.chat_metadata?.variables;
    if (chatVariables && typeof chatVariables === 'object' && !Array.isArray(chatVariables)) {
        for (const node of messages) node.extra = { ...node.extra, chatVariables: structuredClone(chatVariables) };
    }
    const id = `chat_${state.activeCharacterId}_${crypto.randomUUID()}`;
    const quickReply = lines[0]?.chat_metadata?.quickReply;
    if (Array.isArray(quickReply?.setList)) {
        const settings = structuredClone(readExtensionVariables(scopedVariableStore.getState().extension, 'quickReplyV2'));
        (settings.chatConfigs ??= {})[id] = structuredClone(quickReply);
        replaceExtensionVariables('quickReplyV2', settings);
    }
    await saveChatArchive({ id, characterId: state.activeCharacterId, messages,
        activeLeafId: messages.at(-1)?.id ?? null, timedStates: {} });
    return id;
}

export function storySaveAvailable() {
    if (branchBusy() || characterSwitchJob) throw new Error('请等待本轮生成或会话切换结束后再操作。');
}

function tavernArchive(data: Extract<StoryImport, { kind: 'tavern' }>, card: NormalizedCharacterCard): ArchivedChat {
    const state = workspaceStore.getState();
    const id = `chat_${card.id}_${crypto.randomUUID()}`;
    const personaState = { ...state, storyCharacter: undefined, storyCharacterBinding: undefined, storyWorldbooks: undefined, storyPersona: undefined, activeCharacterId: card.id, activeChatId: id };
    applyCharacterPersona(personaState, card.id);
    const leaf = data.messages.at(-1)!;
    const messageVariables = Object.fromEntries(data.messages.flatMap(node => {
        const value = (node.extra?.swipeVariables as Record<number, Record<string, unknown>> | undefined)?.[node.activeSwipeIndex];
        return value ? [[node.id, value]] : [];
    }));
    const latestMvu = [...data.messages].reverse().map(node => messageVariables[node.id]).find(value => value?.stat_data);
    const projection = latestMvu && getEffectiveMvuSettings(personaState).settings['mvu.update_chat'] === true
        ? Object.fromEntries(mvuProjectionKeys.flatMap(key => key in latestMvu ? [[key, latestMvu[key]]] : [])) : {};
    const variables = { ...projection, ...data.variables };
    const continuation = captureChatContinuation({ ...personaState, messages: [] });
    const messages = [...data.messages.slice(0, -1), { ...leaf, extra: { ...leaf.extra, chatVariables: variables, swipeChatVariables: { [leaf.activeSwipeIndex]: variables } } }];
    const extensions = data.quickReply ? { quickReplyV2: { chatConfigs: { [id]: data.quickReply } } } : {};
    return { id, characterId: card.id, messages, activeLeafId: leaf.id, timedStates: {}, syncLabel: '从酒馆导入',
        importedFrom: data.fingerprint, continuation: { ...continuation, portable: true,
            extensions, extensionKeys: [],
            userName: continuation.persona?.name ?? (data.userName || continuation.userName), variables: { ...continuation.variables, global: {}, chat: { [id]: variables }, message: messageVariables } } };
}

export async function storySaveDuplicate(data: StoryImport, characterId?: string) {
    const state = workspaceStore.getState();
    if (state.storyImportFingerprint === data.fingerprint && (data.kind === 'tipsy' || state.activeCharacterId === characterId)) return true;
    return (await listChatArchives()).some(chat => chat.importedFrom === data.fingerprint && (data.kind === 'tipsy' || chat.characterId === characterId));
}

export async function importStorySave(data: StoryImport, characterId: string, copy: boolean, beforeOpen: (chat: ArchivedChat) => void) {
    await waitForReplicaCommit();
    storySaveAvailable();
    return runBranchOperation(async () => {
        if (!copy && await storySaveDuplicate(data, characterId)) throw new Error('这份文件已导入。要再保留一份，请选择「另存为副本」。');
        const state = workspaceStore.getState();
        const card = state.characters.find(item => item.id === characterId);
        if (data.kind === 'tavern' && !card) throw new Error('目标角色卡已不在馆藏中，请重新选择。');
        const source=data.kind==='tipsy'&&await (await import('../../core/story-plugin-archive')).restoreImages(data.chat,data.images??[],async(owner,blob)=>(await (await import('../../plugins/native/media')).saveMedia(owner,'存档插图',blob)).id);
        const result = data.kind === 'tipsy' ? restoreStoryResources(source || data.chat, data.character, state)
            : { chat: tavernArchive(data, card!), added: { characters: [], lorebooks: [], presets: [] } };
        const chat = { ...result.chat, importedFrom: data.fingerprint };
        const index = await listChatArchives();
        await applyArchivedChat(chat, false, () => {
            if (branchBusy(true)) throw new Error('请等待本轮生成或会话切换结束后再操作。');
            if (data.kind === 'tavern' && !workspaceStore.getState().characters.some(item => item.id === characterId)) throw new Error('目标角色卡已不在馆藏中，请重新选择。');
        }, { assets: result.added, index, beforeOpen: () => beforeOpen(chat) });
        compatibilityComposer('');
        void tavernEventBus.emit('character_changed', getActiveCharacter());
        return chat;
    });
}

export async function readStoryForExport(id: string) {
    await waitForReplicaCommit();
    storySaveAvailable();
    if (id === workspaceStore.getState().activeChatId) captureActiveChatForArchive();
    await persistWorkspaceNow();
    storySaveAvailable();
    const state = workspaceStore.getState();
    const chat = readNativeChat(id) ?? await loadChatArchive(id);
    if (!chat) throw new Error('找不到要导出的会话。');
    const character = chat.continuation?.character ?? state.characters.find(card => card.id === chat.characterId);
    if (!character) throw new Error('角色卡已移除，请重新导入原角色卡后再导出此会话。');
    const path = activePath(chat.messages, chat.activeLeafId);
    const current = path.at(-1);
    const fallback = { ...state, activeCharacterId: character.id, activeChatId: chat.id, storyCharacter: character, storyCharacterBinding: undefined,
        storyWorldbooks: undefined, storyPersona: undefined, activePersonaId: null, userName: path.find(node => node.role === 'user')?.speakerName ?? state.userName,
        messages: [] };
    const continuation = chat.continuation ?? { ...captureChatContinuation(fallback), variables: { global: {},
        chat: { [chat.id]: (current?.extra?.chatVariables ?? {}) as Record<string, unknown> }, message: Object.fromEntries(path.map(node => [node.id,
            (node.extra?.swipeVariables as Record<number, Record<string, unknown>> | undefined)?.[node.activeSwipeIndex] ?? {}])) } };
    return { chat: { ...chat, continuation }, character };
}

export async function restoreArchivedChat(id: string, selectedRoute?: string): Promise<void> {
    await waitForReplicaCommit();
    while (characterSwitchJob) await characterSwitchJob;
    const state = workspaceStore.getState();
    if (branchBusy() || id === state.activeChatId) return;
    await runBranchOperation(() => openArchivedChat(id, selectedRoute));
}

export async function openArchivedChat(id: string, selectedRoute?: string, keepChoices = false, check?: () => void): Promise<void> {
    let chat = await loadChatArchive(id);
    if (!chat) throw new Error('找不到已保存的会话');
    if (selectedRoute) {
        const tip = keepChoices ? routeGraph(chat.messages).vertices.get(selectedRoute) : undefined;
        const route = tip ? { path: vertexPath(tip), nodeId: tip.node.id } : storyRoutes(chat.messages).find(item => item.key === selectedRoute);
        if (!route) throw new Error('这条路线已经发生变化，请重新打开路线列表');
        const savedLeaf = keepChoices && !!chat.continuation && chat.activeLeafId === route.nodeId
            && chat.messages.find(node => node.id === route.nodeId)?.activeSwipeIndex === route.path.at(-1)?.activeSwipeIndex;
        chat = structuredClone(chat);
        const selected = new Map(route.path.map(node => [node.id, node.activeSwipeIndex]));
        chat.messages = chat.messages.map(node => selected.has(node.id) ? withSwipe(node, selected.get(node.id)!) : node);
        chat.activeLeafId = route.nodeId;
        const leaf = chat.messages.find(node => node.id === route.nodeId)!;
        const point = leaf.branchStates?.[swipeId(leaf)];
        if (point && !savedLeaf) {
            const variables = Object.fromEntries(route.path.map(node => [node.id, (node.extra?.swipeVariables as Record<number, unknown>)?.[node.activeSwipeIndex] ?? {}]));
            chat.continuation = { ...point.continuation, variables: { ...point.continuation.variables,
                message: { ...variables, ...branchMessageVariables(point) } as Record<string, Record<string, unknown>> } };
            chat.timedStates = point.timedStates; chat.templateInjections = point.templateInjections; chat.templateActivations = point.templateActivations;
            if (point.continuation.portable || !keepChoices) chat.worldbookName = point.worldbookName;
        } else if (!savedLeaf && chat.continuation) {
            chat.continuation = { ...chat.continuation, nativePluginRoute: routePluginBucketsAt(route.path) };
        }
    }
    await archiveActiveChat();
    check?.();
    await applyArchivedChat(chat, keepChoices, check);
}

export const SYNC_EXTENSIONS = ['tipsy_regex', 'tipsy_worldinfo', 'tavern_helper', 'EjsTemplate', 'quickReplyV2'];

function storyExtensionBucket(key: string, bucket: Record<string, unknown>): Record<string, unknown> {
    if (key !== 'tavern_helper') return bucket;
    const { scripts: _globalScripts, ...settings } = bucket;
    return settings;
}

export function captureChatExtensions(extension: ReturnType<typeof scopedVariableStore.getState>['extension'], extensionKeys?: string[]): Record<string, unknown> {
    return Object.fromEntries([...new Set([...SYNC_EXTENSIONS, ...extensionKeys ?? []])]
        .filter(key => key in extension).map(key => [key, storyExtensionBucket(key, extension[key])]));
}

export function restoreChatExtensions(extension: ReturnType<typeof scopedVariableStore.getState>['extension'], continuation: NonNullable<ArchivedChat['continuation']>, chatId: string, previousKeys?: string[]): void {
    if (continuation.portable) {
        const config = continuation.extensions.quickReplyV2?.chatConfigs?.[chatId];
        if (Array.isArray(config?.setList)) {
            const local = extension.quickReplyV2;
            extension.quickReplyV2 = { ...local, chatConfigs: { ...(local?.chatConfigs as Record<string, unknown> | undefined), [chatId]: structuredClone(config) } };
        }
        return;
    }
    for (const key of new Set([...SYNC_EXTENSIONS, ...previousKeys ?? [], ...continuation.extensionKeys ?? []])) {
        if (key === 'tavern_helper') {
            const scripts = extension[key]?.scripts;
            const settings = storyExtensionBucket(key, continuation.extensions[key] ?? {});
            if (Array.isArray(scripts)) extension[key] = { ...structuredClone(settings), scripts };
            else if (Object.keys(settings).length) extension[key] = structuredClone(settings);
            else delete extension[key];
        } else if (key in continuation.extensions) extension[key] = structuredClone(continuation.extensions[key]);
        else delete extension[key];
    }
}

export const syncStorySetting = (key: string) => /^(sampler\.|lorebook\.)/.test(key)
    || ['mvu.mode', 'mvu.automatic', 'mvu.update_chat', 'mvu.sendas_assistant', 'mvu.preset', 'mvu.prompt_strategy', 'mvu.random_header', 'mvu.disable_thinking', 'mvu.pseudo_stream'].includes(key);

export function captureChatContinuation(state = workspaceStore.getState(), variables = scopedVariableStore.getState(), settings = getSchemaValues()): NonNullable<ArchivedChat['continuation']> {
    return { portable: state.portableStory, chatMetadata: state.chatMetadata, nativePluginRoute: state.nativePluginRoute, variables: { global: variables.global,
        character: { [state.activeCharacterId]: variables.character[state.activeCharacterId] ?? {} },
        preset: { [state.activePresetId]: variables.preset[state.activePresetId] ?? {} },
        chat: { [state.activeChatId]: variables.chat[state.activeChatId] ?? {} },
        message: Object.fromEntries(state.messages.map(message => [message.id, variables.message[message.id] ?? {}])) },
        extensions: captureChatExtensions(variables.extension, state.branchExtensionKeys),
        extensionKeys: state.branchExtensionKeys,
        activePresetId: state.activePresetId, inUsePreset: getActivePreset(state), activeLorebookIds: state.activeLorebookIds,
        userName: state.userName, activePersonaId: state.activePersonaId,
        settings: Object.fromEntries(Object.entries(settings).filter(([key]) => syncStorySetting(key))),
        worldbooks: getActiveLorebooks(state), characterBinding: getCharacterWorldbooks(getActiveCharacter(state), state),
        character: getActiveCharacter(state), persona: getActivePersona(state) };
}

export async function applyArchivedChat(chat: ArchivedChat, keepChoices = false, check?: () => void, imported?: {
    assets: Pick<WorkspaceState, 'characters' | 'lorebooks' | 'presets'>; index: Awaited<ReturnType<typeof listChatArchives>>; beforeOpen?: () => void;
}): Promise<void> {
    await enqueuePersistentOperation(async () => {
        await persistWorkspaceNow();
        check?.();
        const release = holdReplicaCommit(), finish = suspendRegisteredPersistence();
        const oldWorkspace = workspaceStore.getState(), oldVariables = scopedVariableStore.getState(), oldSettings = schemaRegistryStore.getState();
        let candidate!: { workspace: WorkspaceState; variables: typeof oldVariables; settings: typeof oldSettings; snapshots: Record<string, unknown> };
        let replays: Array<() => number> = [];
        try {
            withoutStoreNotifications(() => {
                try {
                    let archives: Record<string, unknown> = {};
                    if (imported) {
                        captureActiveChatForArchive();
                        const old = readActiveArchive(workspaceStore.getState().activeChatId);
                        const entries = old ? [old, chat] : [chat];
                        archives = { chat_archive_index: [...imported.index.filter(item => !entries.some(entry => entry.id === item.id)), ...entries.map(summarizeChat)],
                            ...Object.fromEntries(entries.map(entry => [`chat_archive:${entry.id}`, entry])) };
                        workspaceStore.setState(draft => {
                            draft.characters.push(...imported.assets.characters); draft.lorebooks.push(...imported.assets.lorebooks); draft.presets.push(...imported.assets.presets);
                        });
                    }
                    applyArchivedChatState(chat, keepChoices);
                    candidate = { workspace: workspaceStore.getState(), variables: scopedVariableStore.getState(), settings: schemaRegistryStore.getState(), snapshots: { ...registeredSnapshots(), ...archives } };
                } finally { workspaceStore.setState(oldWorkspace); scopedVariableStore.setState(oldVariables); schemaRegistryStore.setState(oldSettings); }
            });
            const unlock = [workspaceStore.holdWrites(), scopedVariableStore.holdWrites(), schemaRegistryStore.holdWrites()];
            try {
                await platformStorage.saveSnapshots(candidate.snapshots);
                acknowledgeSnapshots(candidate.snapshots);
                imported?.beforeOpen?.();
                replays = unlock.map(unlock => unlock());
                batchReactiveUpdates(() => { workspaceStore.setState(candidate.workspace); scopedVariableStore.setState(candidate.variables); schemaRegistryStore.setState(candidate.settings); });
            } finally { if (!replays.length) replays = unlock.map(unlock => unlock()); }
            if (chat.kind !== 'free') { void tavernEventBus.emit('chat_changed', chat.id); schedulePreview(); }
        } finally {
            await finish(false);
            const replayed = batchReactiveUpdates(() => replays.reduce((count, replay) => count + replay(), 0)); release();
            if (replayed) await persistWorkspaceNow();
        }
    });
}

function applyRememberedCharacterPreset(draft: WorkspaceState, characterId: string): NormalizedPreset | undefined {
    if (!characterId || !Object.hasOwn(draft.characterPresetBindings, characterId)) return undefined;
    const rememberedId = draft.characterPresetBindings[characterId];
    if (!rememberedId) {
        draft.activePresetId = '';
        draft.inUsePreset = undefined;
        return undefined;
    }
    const preset = draft.presets.find(item => item.id === rememberedId);
    if (!preset) return undefined;
    const cloned = cloneStateValue(preset);
    draft.activePresetId = cloned.id;
    draft.inUsePreset = cloned;
    return cloned;
}

export function applyArchivedChatState(chat: ArchivedChat, keepChoices = false): void {
    if (chat.kind === 'free') {
        workspaceStore.setState(draft => {
            Object.assign(draft, emptyStory(), { sessionKind: 'free', freeChat: chat.freeChat, activeChatId: chat.id,
                messages: chat.messages, activeLeafId: chat.activeLeafId, streamingReasoning: '' });
        });
        return;
    }
    if (chat.continuation) chat = { ...chat, continuation: removeStarterContinuation(chat.continuation) };
    if (chat.continuation) {
        const continuation = chat.continuation;
        if (continuation.settings && !keepChoices) {
            schemaRegistryStore.setState(draft => {
                const preserveChannelSettings = !continuation.portable && Boolean(draft.values['api.active_profile']);
                for (const [key, value] of Object.entries(continuation.settings!)) {
                    if (preserveChannelSettings && ['sampler.reasoning_effort', 'sampler.prompt_post_processing', 'sampler.use_sysprompt'].includes(key)) continue;
                    draft.values[key] = value;
                }
            });
        }
        scopedVariableStore.setState(draft => {
            if (!continuation.portable) draft.global = structuredClone(continuation.variables.global);
            Object.assign(draft.chat, structuredClone(continuation.variables.chat));
            Object.assign(draft.message, structuredClone(continuation.variables.message));
            Object.assign(draft.character, structuredClone(continuation.variables.character ?? {}));
            Object.assign(draft.preset, structuredClone(continuation.variables.preset ?? {}));
            restoreChatExtensions(draft.extension, continuation, chat.id, workspaceStore.getState().branchExtensionKeys);
        });
    }
    let restoredPreset: NormalizedPreset | undefined;
    workspaceStore.setState(draft => {
        draft.sessionKind = 'character'; draft.freeChat = undefined; draft.storyChatTitle = chat.title;
        applyCharacterPersona(draft, chat.characterId);
        if (chat.continuation) {
            const { activePresetId, inUsePreset, activeLorebookIds, userName, activePersonaId } = chat.continuation;
            Object.assign(draft, structuredClone(keepChoices
                ? { userName, activePersonaId, ...(chat.continuation.portable ? { activeLorebookIds } : {}) }
                : { activePresetId, inUsePreset, ...(chat.continuation.portable ? { activeLorebookIds } : {}), userName, activePersonaId }));
        }
        if (!chat.continuation?.portable && Object.hasOwn(draft.characterPresetBindings, chat.characterId)) {
            restoredPreset = applyRememberedCharacterPreset(draft, chat.characterId);
        }
        draft.lastAssembledPrompt = null;
        draft.branchExtensionKeys = chat.continuation?.extensionKeys ?? [];
        draft.chatMetadata = chat.continuation?.chatMetadata;
        draft.nativePluginRoute = chat.continuation?.nativePluginRoute;
        draft.storyWorldbooks = cloneStateValue(keepChoices && !chat.continuation?.portable ? routeWorldbooks(chat.continuation?.worldbooks, draft) : chat.continuation?.worldbooks);
        draft.storyCharacterBinding = !chat.continuation?.portable && Object.hasOwn(draft.characterWorldbookBindings, chat.characterId)
            ? undefined
            : structuredClone(chat.continuation?.characterBinding);
        draft.storyCharacter = syncCharacterScriptsFromLibrary(structuredClone(chat.continuation?.character), draft.characters, chat.continuation?.portable);
        draft.inUsePreset = syncPresetScriptsFromLibrary(draft.inUsePreset, draft.presets, chat.continuation?.portable);
        draft.storyPersona = structuredClone(chat.continuation?.persona);
        draft.branchEpoch = (draft.branchEpoch ?? 0) + 1;
        draft.storyImportFingerprint = chat.importedFrom;
        draft.portableStory = chat.continuation?.portable;
        draft.deletedMessageIds = chat.deletedMessageIds ?? [];
        draft.activeChatId = chat.id; draft.activeCharacterId = chat.characterId;
        draft.messages = normalizeMessageVariableSnapshots(chat.messages); draft.activeLeafId = chat.activeLeafId;
        draft.timedStates = chat.timedStates;
        draft.templateInjections = chat.templateInjections ?? [];
        draft.templateActivations = chat.templateActivations ?? [];
        if (chat.continuation && (!keepChoices || chat.continuation.portable) || !Object.hasOwn(draft.chatWorldbookBindings, chat.id)) draft.chatWorldbookBindings[chat.id] = chat.worldbookName ?? null;
    });
    if (restoredPreset) setSchemaValues(presetSchemaValues(restoredPreset), false);
    if (!chat.continuation) {
        ensureInitialVariables();
        if (chat.activeLeafId) sessionBranches.restore(chat.activeLeafId);
    }
}

export function applyCharacterPersona(draft: WorkspaceState, characterId: string): void {
    const persona = draft.personas.find(item => item.connections.some(connection => connection.type === 'character' && [characterId, `${characterId}.png`].includes(connection.id)))
        ?? draft.personas.find(item => item.is_default);
    draft.activePersonaId = persona?.avatar_id ?? null;
    draft.userName = persona?.name ?? '用户';
}

export function createChat(card: NormalizedCharacterCard, notify = true): void {
    const messages = buildInitialMessages(card);
    const greeting = messages[0];
    let restoredPreset: NormalizedPreset | undefined;
    workspaceStore.setState(draft => {
        draft.sessionKind = 'character'; draft.freeChat = undefined;
        draft.storyImportFingerprint = undefined;
        draft.storyChatTitle = undefined;
        draft.portableStory = undefined;
        draft.storyWorldbooks = undefined; draft.storyCharacterBinding = undefined; draft.storyCharacter = undefined; draft.storyPersona = undefined;
        applyCharacterPersona(draft, card.id);
        restoredPreset = applyRememberedCharacterPreset(draft, card.id);
        draft.lastAssembledPrompt = null;
        draft.activeCharacterId = card.id;
        draft.activeChatId = `chat_${card.id}_${crypto.randomUUID()}`;
        draft.branchEpoch = 0;
        draft.chatMetadata = undefined;
        draft.nativePluginRoute = undefined;
        draft.branchExtensionKeys = []; draft.deletedMessageIds = [];
        draft.messages = messages;
        draft.activeLeafId = greeting.id;
        draft.timedStates = {};
        draft.templateInjections = [];
        draft.templateActivations = [];
    });
    if (restoredPreset) setSchemaValues(presetSchemaValues(restoredPreset), notify);
    ensureInitialVariables();
    sessionBranches.capture(greeting.id);
    if (notify) {
        persistWorkspace();
        void tavernEventBus.emit('chat_changed', workspaceStore.getState().activeChatId);
        schedulePreview();
    }
}

export async function startExtensionChat(): Promise<string> {
    await waitForReplicaCommit();
    if (branchBusy(true) || workspaceStore.getState().sessionKind === 'free') throw new Error('请等待当前操作结束后再开启角色聊天');
    const card = getActiveCharacter();
    if (!card.id) throw new Error('没有可用的角色');
    await archiveActiveChat();
    await commitWorkspaceMutation(() => createChat(card, false));
    return workspaceStore.getState().activeChatId;
}

/** Replace the opening of a newly created, untouched conversation in one save. */
export async function commitNewChatOpening(session: string, opening: string | null, messages: ChatMessageNode[], chatMetadata: Record<string, unknown>, variables: Record<string, unknown>): Promise<void> {
    await commitWorkspaceMutation(() => {
        const state = workspaceStore.getState();
        const current = getActiveChatMessages(state);
        if (state.activeChatId !== session || state.branchEpoch !== 0 || current.length > 1 || (current[0]?.id ?? null) !== opening || state.isGenerating) {
            throw new Error('新会话的开场已经变化，不能再替换楼层');
        }
        for (const node of messages) {
            const values = node.extra?.variables as Record<string, unknown> | undefined;
            if (values) replaceScopedVariables(values, 'message', { messageId: node.id });
        }
        replaceScopedVariables(variables, 'chat', { chatId: session });
        workspaceStore.setState({ messages, activeLeafId: messages.at(-1)?.id ?? null, chatMetadata });
        if (messages.length) sessionBranches.capture(messages.at(-1)!.id);
    });
    void tavernEventBus.emit('chat_changed', session);
    schedulePreview();
}

let characterSwitchJob: Promise<void> | undefined;

export function currentCharacterSwitch() { return characterSwitchJob; }

let sessionBranches: { capture(id: string): void; restore(id: string): void };

export function connectSessionBranches(branches: typeof sessionBranches) { sessionBranches = branches; }

export async function selectCharacter(characterId: string): Promise<void> {
    await waitForReplicaCommit();
    // Finish the current save before accepting another switch.
    while (characterSwitchJob) await characterSwitchJob;
    const job = runBranchOperation(() => switchCharacter(characterId));
    characterSwitchJob = job;
    try { await job; } finally { if (characterSwitchJob === job) characterSwitchJob = undefined; }
}

async function switchCharacter(characterId: string): Promise<void> {
    const state = workspaceStore.getState();
    if (branchBusy(true) || characterId === state.activeCharacterId) return;
    const target = state.characters.find(card => card.id === characterId);
    if (!target) return;
    try {
        await archiveActiveChat();
        const recent = (await listChatArchives()).reverse().find(chat => chat.characterId === characterId);
        const chat = recent ? await loadChatArchive(recent.id) : null;
        if (chat) await applyArchivedChat(chat); else createChat(target);
        await tavernEventBus.emit('character_changed', target);
    } catch (error) { setStatusBanner(String(error)); throw error; }
}

export async function startNewChat(): Promise<void> {
    await waitForReplicaCommit();
    if (branchBusy()) return;
    const card = getActiveCharacter();
    if (!card.id) return;
    await runBranchOperation(async () => {
        await archiveActiveChat();
        createChat(card);
    });
}

export async function startFreeChat(): Promise<void> {
    await waitForReplicaCommit();
    const state = workspaceStore.getState();
    if (isNativeStorySaving() || state.isGenerating || state.helperGenerationCount || state.mvuExtraAnalysisActive || pendingBranchOperations()) return;
    await runBranchOperation(async () => {
        await archiveActiveChat();
        stopCompatibilityRuntime();
        invalidateTemplateEnvironment();
        workspaceStore.setState({ ...emptyStory(), sessionKind: 'free', freeChat: { createdAt: Date.now() }, activeChatId: `free_${crypto.randomUUID()}`,
            streamingReasoning: '' });
        await persistWorkspaceNow();
    });
}

export function getFreeChatConnection(state: WorkspaceState, settings: Record<string, unknown>) {
    return { source: String(settings['api.chat_completion_source'] ?? 'openai'), baseUrl: String(settings['api.custom_url'] ?? '').trim(),
        apiKey: String(settings['api.key'] ?? '').trim(), model: state.freeChat?.model || String(settings['api.model'] ?? '').trim() };
}

export async function updateFreeChat(id: string, changes: FreeChatDetails): Promise<void> {
    await waitForReplicaCommit();
    if (branchBusy()) return;
    await runBranchOperation(async () => {
        const state = workspaceStore.getState();
        if (state.activeChatId === id && state.sessionKind === 'free') {
            workspaceStore.setState({ freeChat: { ...state.freeChat, ...changes } });
            await persistWorkspaceNow();
        } else {
            const archive = await loadChatArchive(id);
            if (archive?.kind === 'free') await saveChatArchive({ ...archive, freeChat: { ...archive.freeChat, ...changes } });
        }
    });
}

export async function renameStoryChat(id: string, title: string): Promise<void> {
    const name = title.trim();
    if (!name) throw new Error('请填写会话名称');
    await waitForReplicaCommit();
    if (branchBusy()) throw new Error('请等待当前操作完成');
    await runBranchOperation(async () => {
        const state = workspaceStore.getState();
        if (state.activeChatId === id && state.sessionKind === 'character') {
            await enqueuePersistentOperation(() => commitWorkspaceMutation(() => workspaceStore.setState({ storyChatTitle: name })));
        } else await updateChatArchive(id, current => {
            if (!current || current.kind === 'free') throw new Error('找不到该故事会话');
            return { chat: { ...current, title: name }, extras: {} };
        });
    });
}

export async function deleteWorkspaceChats(ids: readonly string[], kind: ChatSessionKind): Promise<{ ids: string[]; removedCurrent: boolean }> {
    await waitForReplicaCommit();
    if (branchBusy()) throw new Error('请等待当前操作完成');
    return runBranchOperation(() => enqueuePersistentOperation(async () => {
        const release = holdReplicaCommit();
        try {
            const state = workspaceStore.getState();
            const requested = new Set(ids);
            const removedCurrent = state.sessionKind === kind && requested.has(state.activeChatId);
            const removed = (await listChatArchives()).filter(chat => requested.has(chat.id) && chat.id !== state.activeChatId
                && (chat.kind ?? 'character') === kind).map(chat => chat.id);
            if (removedCurrent) removed.push(state.activeChatId);
            if (!removed.length) return { ids: removed, removedCurrent };
            if (!removedCurrent) { await deleteChatArchives(removed); return { ids: removed, removedCurrent }; }

            await persistWorkspaceNow();
            const resume = suspendRegisteredPersistence();
            try {
                const cleared = { ...emptyStory(), streamingReasoning: '', nativeToolPreview: undefined, nativeStoryReply: undefined };
                const snapshots = withoutStoreNotifications(() => {
                    workspaceStore.setState(cleared);
                    try { return registeredSnapshots(); }
                    finally { workspaceStore.setState(state); }
                });
                await deleteChatArchives(removed, snapshots);
                acknowledgeSnapshots(snapshots);
                stopCompatibilityRuntime();
                invalidateTemplateEnvironment();
                workspaceStore.setState(cleared);
                void tavernEventBus.emit('chat_changed', '');
            } finally { await resume(false); }
            return { ids: removed, removedCurrent };
        } finally { release(); }
    }));
}

import { listChatArchives, loadChatArchive, saveChatArchive, deleteChatArchive, summarizeChat, freeChatName, type ArchivedChat, type FreeChatDetails } from '../chat-archives';
import { batchReactiveUpdates, cloneStateValue, withoutStoreNotifications } from '../reactive-store';
import { normalizeChatPayload } from '../../pipeline/normalizer';
import { emptyStory } from '../../core/empty-workspace';
import { removeStarterContinuation } from '../../core/retired-starter-content';
import { restoreStoryResources } from '../../core/story-save';
import type { StoryImport } from '../../core/story-save-format';
import { platformStorage } from '../../core/platform-bridge';
import { getSchemaValues, schemaRegistryStore } from '../../registry/schema-registry';
import { scopedVariableStore, replaceExtensionVariables } from '../scoped-variable-store';
import { activePath, swipeId, storyRoutes, withSwipe } from '../chat-tree';
import { branchMessageVariables } from '../branch-state';
import { pendingBranchOperations, runBranchOperation } from '../branch-runtime';
import { compatibilityComposer } from '../../compatibility/composer-bridge';
import { mvuProjectionKeys } from '../../pipeline/mvu-data';
import { routeGraph, vertexPath } from '../../plugins/native/route-graph';
import { tavernEventBus } from '../../sandbox/event-bus';
import { stopCompatibilityRuntime } from '../../compatibility/runtime-client';
import { readExtensionVariables } from '../../compatibility/extension-variables';
import type { ChatMessageNode, NormalizedCharacterCard } from '../../types';
import { enqueuePersistentOperation, suspendRegisteredPersistence, waitForReplicaCommit, holdReplicaCommit, registeredSnapshots, acknowledgeSnapshots } from '../persistence';
import { workspaceStore, type WorkspaceState } from './state';
import { getActivePreset, getActiveLorebooks, getCharacterWorldbooks, getActiveCharacter, getActivePersona } from './library';
import { schedulePreview, invalidateTemplateEnvironment } from './prompt';
import { persistWorkspace, persistWorkspaceNow } from './storage';
import { setStatusBanner } from './notice';
import { getActiveChatMessages, preserveAuthorMessageRevision, getEffectiveMvuSettings } from './queries';
import { branchBusy, isNativeStorySaving } from './activity';
import { routePluginBucketsAt, routeWorldbooks } from './route-resources';
import { normalizeMessageVariableSnapshots, ensureInitialVariables } from './story-initialization';

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
    if (!state.messages.length && !(state.sessionKind === 'free' && (state.freeChat?.title || state.freeChat?.model))) return null;
    if (state.sessionKind === 'free') return { id, kind: 'free', freeChat: state.freeChat, characterId: '', messages: state.messages,
        activeLeafId: state.activeLeafId, timedStates: {} };
    return { id: state.activeChatId, characterId: state.activeCharacterId, importedFrom: state.storyImportFingerprint,
        messages: state.messages, deletedMessageIds: state.deletedMessageIds, activeLeafId: state.activeLeafId, timedStates: state.timedStates, worldbookName: state.chatWorldbookBindings[state.activeChatId] ?? null, templateInjections: state.templateInjections, templateActivations: state.templateActivations,
        continuation: captureChatContinuation() };
}

export async function listArchivedChats() {
    const archives = await listChatArchives();
    const state = workspaceStore.getState();
    return archives.filter(chat => chat.id !== state.activeChatId).map(chat => ({ id: chat.id, characterId: chat.characterId, kind: chat.kind,
        title: chat.freeChat?.title || freeChatName,
        label: chat.kind === 'free' ? `${chat.freeChat?.title || freeChatName} · ${chat.activeCount} 条` : `${chat.syncLabel ? `${chat.syncLabel} · ` : ''}${state.characters.find(card => card.id === chat.characterId)?.name ?? '角色'} · ${chat.messageCount} 条 · ${chat.lastMessage.replace(/\s+/g, ' ').slice(0, 30)}`,
    }));
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
        const result = data.kind === 'tipsy' ? restoreStoryResources(data.chat, data.character, state)
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
        if (key in continuation.extensions) extension[key] = structuredClone(continuation.extensions[key]);
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
        extensions: Object.fromEntries([...new Set([...SYNC_EXTENSIONS, ...state.branchExtensionKeys ?? []])].filter(key => key in variables.extension).map(key => [key, variables.extension[key]])),
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

export function applyArchivedChatState(chat: ArchivedChat, keepChoices = false): void {
    if (chat.kind === 'free') {
        workspaceStore.setState(draft => {
            Object.assign(draft, emptyStory(), { sessionKind: 'free', freeChat: chat.freeChat, activeChatId: chat.id,
                messages: chat.messages, activeLeafId: chat.activeLeafId, activeLorebookIds: [], streamingReasoning: '' });
        });
        return;
    }
    if (chat.continuation) chat = { ...chat, continuation: removeStarterContinuation(chat.continuation) };
    if (chat.continuation) {
        const continuation = chat.continuation;
        if (continuation.settings && !keepChoices) schemaRegistryStore.setState(draft => { Object.assign(draft.values, continuation.settings); });
        scopedVariableStore.setState(draft => {
            if (!continuation.portable) draft.global = structuredClone(continuation.variables.global);
            Object.assign(draft.chat, structuredClone(continuation.variables.chat));
            Object.assign(draft.message, structuredClone(continuation.variables.message));
            Object.assign(draft.character, structuredClone(continuation.variables.character ?? {}));
            Object.assign(draft.preset, structuredClone(continuation.variables.preset ?? {}));
            restoreChatExtensions(draft.extension, continuation, chat.id, workspaceStore.getState().branchExtensionKeys);
        });
    }
    workspaceStore.setState(draft => {
        draft.sessionKind = 'character'; draft.freeChat = undefined;
        applyCharacterPersona(draft, chat.characterId);
        if (chat.continuation) {
            const { activePresetId, inUsePreset, activeLorebookIds, userName, activePersonaId } = chat.continuation;
            Object.assign(draft, structuredClone(keepChoices ? { userName, activePersonaId, ...(chat.continuation.portable ? { activeLorebookIds } : {}) } : { activePresetId, inUsePreset, activeLorebookIds, userName, activePersonaId }));
        }
        draft.lastAssembledPrompt = null;
        draft.branchExtensionKeys = chat.continuation?.extensionKeys ?? [];
        draft.chatMetadata = chat.continuation?.chatMetadata;
        draft.nativePluginRoute = chat.continuation?.nativePluginRoute;
        draft.storyWorldbooks = cloneStateValue(keepChoices && !chat.continuation?.portable ? routeWorldbooks(chat.continuation?.worldbooks, draft) : chat.continuation?.worldbooks);
        draft.storyCharacterBinding = structuredClone(chat.continuation?.characterBinding);
        draft.storyCharacter = structuredClone(chat.continuation?.character);
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
    workspaceStore.setState(draft => {
        draft.sessionKind = 'character'; draft.freeChat = undefined;
        draft.storyImportFingerprint = undefined;
        draft.portableStory = undefined;
        draft.storyWorldbooks = undefined; draft.storyCharacterBinding = undefined; draft.storyCharacter = undefined; draft.storyPersona = undefined;
        applyCharacterPersona(draft, card.id);
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
    ensureInitialVariables();
    sessionBranches.capture(greeting.id);
    if (notify) {
        persistWorkspace();
        void tavernEventBus.emit('chat_changed', workspaceStore.getState().activeChatId);
        schedulePreview();
    }
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
        workspaceStore.setState({ ...emptyStory(), sessionKind: 'free', activeChatId: `free_${crypto.randomUUID()}`,
            activeLorebookIds: [], streamingReasoning: '' });
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

export async function deleteFreeChat(id: string): Promise<void> {
    await waitForReplicaCommit();
    if (branchBusy()) return;
    await runBranchOperation(async () => {
        const state = workspaceStore.getState();
        if (state.activeChatId === id && state.sessionKind === 'free') {
            await persistWorkspaceNow();
            workspaceStore.setState({ ...emptyStory(), streamingReasoning: '' });
            try {
                const snapshots = registeredSnapshots();
                await deleteChatArchive(id, snapshots);
                acknowledgeSnapshots(snapshots);
            } catch (error) { workspaceStore.setState(state); throw error; }
        } else {
            const archive = await loadChatArchive(id);
            if (archive?.kind === 'free') await deleteChatArchive(id);
        }
    });
}

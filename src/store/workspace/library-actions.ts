import { saveExport } from '../../core/platform-files';
import { listChatArchives, loadChatArchive, clearChatArchives, summarizeChat, type ArchivedChat } from '../chat-archives';
import { batchReactiveUpdates, cloneStateValue, withoutStoreNotifications } from '../reactive-store';
import { normalizeCharacterCard, normalizeLorebook, normalizePreset } from '../../pipeline/normalizer';
import { emptyStory } from '../../core/empty-workspace';
import { embedCharacterCardIntoPng } from '../../core/png-chunk-codec';
import { importCharacterFile } from '../../core/character-import';
import { platformStorage } from '../../core/platform-bridge';
import { setSchemaValues, schemaRegistryStore } from '../../registry/schema-registry';
import { scopedVariableStore, replaceExtensionVariables } from '../scoped-variable-store';
import { serializeCharacterCard, serializeLorebook, serializeRegexRule } from '../../pipeline/asset-serializer';
import { tavernEventBus } from '../../sandbox/event-bus';
import { stopCompatibilityRuntime } from '../../compatibility/runtime-client';
import { readExtensionVariables } from '../../compatibility/extension-variables';
import type { NormalizedCharacterCard, NormalizedLorebook, NormalizedPreset, PresetPromptSlot, UserPersona } from '../../types';
import { enqueuePersistentOperation, persistRegisteredSnapshots, suspendRegisteredPersistence, waitForReplicaCommit, holdReplicaCommit, registeredSnapshots, acknowledgeSnapshots } from '../persistence';
import { quickReplySets, type QuickReplySetData } from '../../sandbox/quick-reply';
import { workspaceStore, type WorkspaceState, initialWorkspace } from './state';
import { getCharacterWorldbooks, getActiveCharacter, getAvailableWorldbooks, classifyLibraryJson, isPngAssetName, isPngStoryCharacter, validateStoryCharacterJson, assertNewAsset } from './library';
import { schedulePreview, currentTemplateJobs } from './prompt';
import { persistWorkspace, persistWorkspaceNow } from './storage';
import { setStatusBanner } from './notice';
import { getActiveChatMessages } from './queries';
import { captureChatContinuation, applyCharacterPersona, currentCharacterSwitch, applyArchivedChatState, createChat, storySaveAvailable } from './sessions';
import { captureMessageSnapshot } from './branches';

export function worldbooksChanged(): void { schedulePreview(); }

// Compatibility writes leave persistence and refresh timing to the request handler.
export function saveHelperPersona(next: UserPersona, replace: boolean): void {
    const id = next.avatar_id;
    workspaceStore.setState(draft => {
        if (next.is_default) for (const item of draft.personas) item.is_default = false;
        if (replace) draft.personas[draft.personas.findIndex(item => item.avatar_id === id)] = next; else draft.personas.push(next);
        if (!draft.activePersonaId) draft.activePersonaId = id;
        if (draft.activePersonaId === id) draft.userName = next.name;
    });
}

export function removeHelperPersona(id: string): void {
    workspaceStore.setState(draft => {
        draft.personas = draft.personas.filter(item => item.avatar_id !== id);
        if (draft.activePersonaId === id) {
            const next = draft.personas.find(item => item.is_default) ?? draft.personas[0];
            draft.activePersonaId = next?.avatar_id ?? null;
            if (next) draft.userName = next.name;
        }
    });
}

export function selectPersona(id: string): boolean {
    const persona = workspaceStore.getState().personas.find(item => item.avatar_id === id);
    if (!persona) return false;
    workspaceStore.setState(draft => { draft.activePersonaId = id; draft.userName = persona.name; draft.storyPersona = structuredClone(persona); });
    persistWorkspace(); schedulePreview(); return true;
}

export function savePlayerPersona(value: { name: string; image: string; description: string }, characterId?: string): void {
    const name = value.name.trim();
    if (!name) throw new Error('请填写称呼');
    workspaceStore.setState(draft => {
        const linked = (item: import('../../types').UserPersona) => characterId
            ? item.connections.some(link => link.type === 'character' && [characterId, `${characterId}.png`].includes(link.id)) : item.is_default;
        const previous = draft.personas.find(linked);
        if (characterId && !draft.personas.some(item => item.is_default)) {
            const id = `persona_${crypto.randomUUID()}.png`;
            draft.personas.push({ avatar_id: id, avatar: id, image: '', name: draft.userName || '用户', title: '', description: '',
                position: 0, depth: 2, role: 0, lorebook: '', connections: [], is_default: true });
        }
        // A default profile stays separate when a card receives its own identity.
        const reuse = previous && !(characterId && previous.is_default);
        const id = reuse ? previous.avatar_id : `persona_${crypto.randomUUID()}.png`;
        const persona: import('../../types').UserPersona = { avatar_id: id, avatar: id, title: '',
            position: 0, depth: 2, role: 0, lorebook: '', connections: [], is_default: !characterId,
            ...(reuse ? cloneStateValue(previous) : {}), ...value, name, description_mode: 'supplement' };
        if (characterId) {
            for (const item of draft.personas) item.connections = item.connections.filter(link => !(link.type === 'character' && [characterId, `${characterId}.png`].includes(link.id)));
            persona.connections = [...persona.connections.filter(link => !(link.type === 'character' && [characterId, `${characterId}.png`].includes(link.id))), { type: 'character', id: characterId }];
        } else for (const item of draft.personas) item.is_default = item.avatar_id === persona.avatar_id;
        const index = draft.personas.findIndex(item => item.avatar_id === id);
        if (index < 0) draft.personas.push(persona); else draft.personas[index] = persona;
        applyCharacterPersona(draft, draft.activeCharacterId);
        draft.storyPersona = cloneStateValue(draft.personas.find(item => item.avatar_id === draft.activePersonaId));
    });
    persistWorkspace(); schedulePreview();
}

export function clearCharacterPersona(characterId: string): void {
    workspaceStore.setState(draft => {
        for (const persona of draft.personas) persona.connections = persona.connections.filter(link => !(link.type === 'character' && [characterId, `${characterId}.png`].includes(link.id)));
        applyCharacterPersona(draft, draft.activeCharacterId);
        draft.storyPersona = cloneStateValue(draft.personas.find(item => item.avatar_id === draft.activePersonaId));
    });
    persistWorkspace(); schedulePreview();
}

export function setGlobalWorldbookEnabled(id: string, enabled: boolean): void {
    if (!getAvailableWorldbooks().some(book => book.id === id)) throw new Error('找不到世界书');
    workspaceStore.setState(draft => { draft.activeLorebookIds = [...new Set([...draft.activeLorebookIds.filter(item => item !== id), ...(enabled ? [id] : [])])]; });
    persistWorkspace(); schedulePreview();
}

export function replaceHelperGlobalWorldbookBindings(resolveIds: () => string[]): void {
    // Resolve names when the write is applied, including during held-write replay.
    workspaceStore.setState(draft => { draft.activeLorebookIds = resolveIds(); });
}

export function bindHelperCharacterWorldbooks(cardId: string, primary: string | null, additional: string[]): void {
    workspaceStore.setState(draft => {
        if (draft.storyCharacter && cardId === draft.activeCharacterId) { draft.storyCharacterBinding = { primary, additional }; return; }
        draft.characterWorldbookBindings[cardId] = { primary, additional };
        draft.characters = draft.characters.map(item => item.id === cardId ? { ...item, primaryWorldbook: primary, additionalWorldbooks: additional,
            extensions: { ...item.extensions, world: primary ?? '', extra_worlds: additional } } : item);
    });
}

export function bindHelperChatWorldbook(chatId: string, name: string | null): void {
    workspaceStore.setState(draft => { draft.chatWorldbookBindings[chatId] = name; });
}

export function writeHelperWorldbook(book: NormalizedLorebook): void {
    workspaceStore.setState(draft => {
        if (draft.storyWorldbooks?.some(item => item.id === book.id)) { draft.storyWorldbooks = draft.storyWorldbooks.map(item => item.id === book.id ? book : item); return; }
        const exists = draft.lorebooks.some(item => item.id === book.id);
        draft.lorebooks = exists ? draft.lorebooks.map(item => item.id === book.id ? book : item) : [...draft.lorebooks, book];
        draft.characters = draft.characters.map(card => card.characterBook?.id === book.id || card.embeddedLorebook?.id === book.id
            ? { ...card, ...(card.characterBook?.id === book.id ? { characterBook: book } : {}), ...(card.embeddedLorebook?.id === book.id ? { embeddedLorebook: book } : {}) } : card);
    });
}

export function importHelperWorldbook(book: NormalizedLorebook, previousId?: string): void {
    workspaceStore.setState(draft => {
        if (previousId === undefined) draft.lorebooks.push(book);
        else {
            draft.lorebooks[draft.lorebooks.findIndex(item => item.id === previousId)] = book;
            for (const card of draft.characters) {
                if (card.characterBook?.id === previousId) card.characterBook = book;
                if (card.embeddedLorebook?.id === previousId) card.embeddedLorebook = book;
            }
        }
    });
}

export function updateLorebookEntry(bookId: string, uid: string | number, patch: Partial<NormalizedLorebook['entries'][number]>): void {
    if (workspaceStore.getState().isGenerating) throw new Error('请等待生成结束后修改世界书');
    workspaceStore.setState(draft => {
        const source = draft.storyWorldbooks?.find(b => b.id === bookId) ?? draft.characters.flatMap(c => [c.characterBook, c.embeddedLorebook]).find(b => b?.id === bookId)
            ?? draft.lorebooks.find(b => b.id === bookId);
        if (!source) throw new Error('找不到世界书');
        const book = cloneStateValue(source);
        const entry = book.entries.find(e => e.uid === uid);
        if (!entry) throw new Error('找不到世界书词条');
        Object.assign(entry, patch, { uid, rawData: entry.rawData });
        if (draft.storyWorldbooks?.some(item => item.id === bookId)) { draft.storyWorldbooks = draft.storyWorldbooks.map(item => item.id === bookId ? book : item); return; }
        draft.lorebooks = draft.lorebooks.map(b => b.id === bookId ? book : b);
        draft.characters = draft.characters.map(c => ({ ...c,
            ...(c.characterBook?.id === bookId ? { characterBook: book } : {}),
            ...(c.embeddedLorebook?.id === bookId ? { embeddedLorebook: book } : {}),
        }));
    });
    persistWorkspace();
    schedulePreview();
}

export function updateCharacterDocument(characterId: string, document: Record<string, unknown>): void {
    const state = workspaceStore.getState();
    if (state.isGenerating) throw new Error('请等待生成结束后修改角色卡');
    const previous = state.characters.find(c => c.id === characterId);
    if (!previous) throw new Error('找不到角色卡');
    const next = normalizeCharacterCard(document);
    next.id = previous.id;
    next.avatar = previous.avatar;
    const oldBook = previous.characterBook ?? previous.embeddedLorebook;
    if (next.embeddedLorebook && oldBook) next.embeddedLorebook.id = oldBook.id;
    workspaceStore.setState(draft => {
        draft.characters = draft.characters.map(c => c.id === characterId ? next : c);
        if (draft.storyCharacter?.id === characterId) { draft.storyCharacter = next; draft.storyCharacterBinding = undefined; }
        if (Object.hasOwn(draft.characterWorldbookBindings, characterId)) draft.characterWorldbookBindings[characterId] = {
            primary: typeof next.primaryWorldbook === 'string' ? next.primaryWorldbook : next.primaryWorldbook?.name ?? null, additional: next.additionalWorldbooks ?? [],
        };
        draft.lorebooks = draft.lorebooks.filter(b => b.id !== oldBook?.id);
        if (next.embeddedLorebook) draft.lorebooks.push(next.embeddedLorebook);
        if (!next.embeddedLorebook) draft.activeLorebookIds = draft.activeLorebookIds.filter(id => id !== oldBook?.id);
    });
    persistWorkspace();
    schedulePreview();
}

export function setHelperCharacterAvatar(id: string, avatar: string): void {
    workspaceStore.setState(draft => { draft.characters.find(card => card.id === id)!.avatar = avatar; });
}

export function addHelperCharacter(card: NormalizedCharacterCard): void {
    workspaceStore.setState(draft => { draft.characters.push(card); });
}

export function importHelperCharacter(card: NormalizedCharacterCard, previous?: NormalizedCharacterCard): void {
    workspaceStore.setState(draft => {
        const index = draft.characters.findIndex(item => item.id === card.id);
        if (index >= 0) draft.characters[index] = card; else draft.characters.push(card);
        const oldBook = previous?.characterBook ?? previous?.embeddedLorebook;
        if (oldBook) draft.lorebooks = draft.lorebooks.filter(book => book.id !== oldBook.id);
        if (card.embeddedLorebook) draft.lorebooks.push(card.embeddedLorebook);
    });
}

export function replaceHelperCharacterRegexes(id: string, rules: NormalizedCharacterCard['regexScripts']): void {
    workspaceStore.setState(draft => {
        const target = draft.characters.find(item => item.id === id)!;
        target.regexScripts = rules;
        target.extensions = { ...target.extensions, regex_scripts: rules.map(serializeRegexRule) };
    });
}

export function replaceActiveWorldbookEntries(entries: unknown[]): boolean {
    const card = getActiveCharacter();
    const book = card.characterBook ?? card.embeddedLorebook;
    if (!book) throw new Error('当前角色没有内嵌世界书，请指定需要修改的世界书');
    const document = serializeCharacterCard(card);
    const data = document.data && typeof document.data === 'object' ? document.data as Record<string, unknown> : document;
    const rawBook = data.character_book as Record<string, unknown>;
    // Accept external raw entries or the normalized objects returned by the legacy bridge.
    const normalized = normalizeLorebook({ name: book.name, entries });
    for (let i = 0; i < normalized.entries.length; i++) {
        const value = entries[i] as Record<string, unknown>;
        if (value?.rawData && typeof value.rawData === 'object') normalized.entries[i] = structuredClone(value) as unknown as NormalizedLorebook['entries'][number];
    }
    data.character_book = { ...rawBook, entries: serializeLorebook(normalized).entries };
    updateCharacterDocument(card.id, document);
    return true;
}

export function selectPreset(presetId: string): void {
    if (workspaceStore.getState().activePresetId === presetId) return;
    if (!presetId) { workspaceStore.setState({ activePresetId: '', inUsePreset: undefined }); persistWorkspace(); schedulePreview(); return; }
    const preset = workspaceStore.getState().presets.find(item => item.id === presetId);
    if (!preset) return;
    batchReactiveUpdates(() => {
        workspaceStore.setState(draft => { draft.activePresetId = presetId; draft.inUsePreset = structuredClone(preset); });
        applyPresetSettings(preset);
    });
    persistWorkspace();
    schedulePreview();
}

export function applyPresetSettings(preset: NormalizedPreset): void {
    const values: Record<string, unknown> = {
        temperature: preset.temperature, top_p: preset.topP, top_k: preset.topK,
        min_p: preset.minP, frequency_penalty: preset.frequencyPenalty,
        presence_penalty: preset.presencePenalty, max_tokens: preset.maxResponseTokens,
        context_max_tokens: preset.maxContextTokens,
    };
    const settings = Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined).map(([key, value]) => [`sampler.${key}`, value]));
    if (preset.rawData?.stream_openai !== undefined) settings['api.stream'] = preset.rawData.stream_openai;
    if (preset.rawData?.reasoning_effort !== undefined) settings['sampler.reasoning_effort'] = preset.rawData.reasoning_effort;
    setSchemaValues(settings);
}

export function writeHelperPreset(preset: NormalizedPreset, previousId?: string, inUse = false): void {
    workspaceStore.setState(draft => {
        if (inUse) draft.inUsePreset = preset;
        else if (previousId !== undefined) draft.presets[draft.presets.findIndex(item => item.id === previousId)] = preset;
        else draft.presets.push(preset);
    });
}

export function removeHelperPreset(id: string, wasActive: boolean): void {
    workspaceStore.setState(draft => { draft.presets = draft.presets.filter(item => item.id !== id); });
    if (wasActive) selectPreset(workspaceStore.getState().presets[0].id);
}

export function renameHelperPreset(id: string, name: string): void {
    workspaceStore.setState(draft => {
        const target = draft.presets.find(item => item.id === id)!;
        target.name = name;
        if (target.rawData) target.rawData.name = name;
        if (draft.inUsePreset?.id === id) draft.inUsePreset.name = name;
    });
}

export function replaceHelperPresetRegexes(preset: NormalizedPreset, rules: NonNullable<NormalizedPreset['regexScripts']>, inUse: boolean): void {
    workspaceStore.setState(draft => {
        if (inUse && !draft.inUsePreset) draft.inUsePreset = structuredClone(preset);
        const target = inUse ? draft.inUsePreset! : draft.presets.find(item => item.id === preset.id)!;
        target.regexScripts = rules;
        target.rawData = { ...target.rawData, extensions: { ...(target.rawData?.extensions as object ?? {}), regex_scripts: rules.map(serializeRegexRule) } };
    });
}

export function updatePresetPrompt(presetId: string, identifier: string, patch: Partial<PresetPromptSlot>): void {
    workspaceStore.setState(draft => {
        const preset = presetId === draft.activePresetId && draft.inUsePreset ? draft.inUsePreset : draft.presets.find(item => item.id === presetId);
        if (!preset) return;
        const slots = preset.promptSlots ?? preset.prompts ?? [];
        const slot = slots.find(item => item.identifier === identifier);
        if (slot) Object.assign(slot, patch, { identifier });
        preset.promptSlots = slots;
        preset.prompts = slots;
    });
    persistWorkspace();
    schedulePreview();
}

/** Delete by identity so existing duplicate names can be cleaned up individually. */
export function removeWorldbookFromWorkspace(draft: WorkspaceState, id: string): boolean {
    const book = [...draft.characters.flatMap(card => [card.characterBook, card.embeddedLorebook]), ...draft.lorebooks].find(item => item?.id === id);
    if (!book) return false;
    const name = book.name;
    const sameNameRemains = [...draft.characters.flatMap(card => [card.characterBook, card.embeddedLorebook]), ...draft.lorebooks]
        .some(item => item && item.id !== id && item.name === name);
    draft.lorebooks = draft.lorebooks.filter(item => item.id !== id);
    draft.activeLorebookIds = draft.activeLorebookIds.filter(value => value !== id);
    for (const card of draft.characters) {
        const owns = card.characterBook?.id === id || card.embeddedLorebook?.id === id;
        if (owns) {
            if (card.characterBook?.id === id) card.characterBook = null;
            if (card.embeddedLorebook?.id === id) card.embeddedLorebook = null;
            const raw = cloneStateValue(card.rawData ?? {});
            for (const container of [raw, raw.data].filter((value): value is Record<string, unknown> => !!value && typeof value === 'object')) {
                for (const key of ['character_book', 'characterBook', 'embeddedLorebook']) delete container[key];
            }
            card.rawData = raw;
        }
        if (!sameNameRemains) {
            const primary = typeof card.primaryWorldbook === 'string' ? card.primaryWorldbook : card.primaryWorldbook?.name;
            if (primary === name) card.primaryWorldbook = null;
            if (card.additionalWorldbooks?.includes(name)) card.additionalWorldbooks = card.additionalWorldbooks.filter(value => value !== name);
            if (card.extensions?.world === name) card.extensions.world = '';
            if (Array.isArray(card.extensions?.extra_worlds) && card.extensions.extra_worlds.includes(name)) card.extensions.extra_worlds = card.extensions.extra_worlds.filter(value => value !== name);
        }
    }
    if (!sameNameRemains) {
        for (const binding of Object.values(draft.characterWorldbookBindings)) {
            if (binding.primary === name) binding.primary = null;
            binding.additional = binding.additional.filter(value => value !== name);
        }
        for (const [chatId, value] of Object.entries(draft.chatWorldbookBindings)) if (value === name) draft.chatWorldbookBindings[chatId] = null;
        for (const persona of draft.personas) if (persona.lorebook === name) persona.lorebook = '';
    }
    return true;
}

export function removeLibraryWorldbook(id: string): void {
    workspaceStore.setState(draft => { removeWorldbookFromWorkspace(draft, id); });
}

export async function deleteWorkspaceWorldbook(id: string): Promise<void> {
    const state = workspaceStore.getState();
    if (state.isGenerating || state.helperGenerationCount) throw new Error('请等待生成结束后删除世界书');
    removeLibraryWorldbook(id);
    await persistWorkspaceNow(); worldbooksChanged();
}

export function getCharacterDeletionBooks(characterIds: readonly string[]) {
    const selected = new Set(characterIds), state = workspaceStore.getState();
    const candidates = state.characters.filter(card => selected.has(card.id)).map(card => {
        const binding = getCharacterWorldbooks(card, state);
        return { owned: [card.characterBook, card.embeddedLorebook], names: new Set([binding.primary, ...binding.additional]) };
    });
    return getAvailableWorldbooks(state).filter(book => candidates.some(({ owned, names }) =>
        owned.some(own => own?.id === book.id) || names.has(book.name) && !owned.some(own => own?.name === book.name))).map(book => ({ book,
        shared: state.characters.some(other => {
            if (selected.has(other.id)) return false;
            const own = other.characterBook ?? other.embeddedLorebook;
            if (own?.id === book.id) return true;
            const linked = getCharacterWorldbooks(other, state);
            // A duplicated card with its own same-name book does not own this copy.
            return own?.name !== book.name && (linked.primary === book.name || linked.additional.includes(book.name));
        }) || state.personas.some(persona => persona.lorebook === book.name) || state.activeLorebookIds.includes(book.id)
            || Object.values(state.chatWorldbookBindings).includes(book.name),
    }));
}

export async function deleteWorkspaceCharacter(id: string, deleteChats = false, deleteBookIds: string[] = []): Promise<boolean> {
    return (await deleteWorkspaceCharacters([id], deleteChats, deleteBookIds)) > 0;
}

export async function deleteWorkspaceCharacters(ids: readonly string[], deleteChats = false, deleteBookIds: string[] = []): Promise<number> {
    const requested = new Set(ids);
    await waitForReplicaCommit();
    while (currentCharacterSwitch()) await currentCharacterSwitch();
    return enqueuePersistentOperation(async () => {
    let state = workspaceStore.getState();
    if (state.isGenerating || state.helperGenerationCount || state.mvuExtraAnalysisActive) throw new Error('请等待生成结束后删除角色');
    const cards = state.characters.filter(item => requested.has(item.id));
    if (!cards.length) return 0;
    const selected = new Set(cards.map(card => card.id));
    const switching = selected.has(state.activeCharacterId);
    if (switching && !deleteChats) {
        const leaf = getActiveChatMessages(state).at(-1);
        if (leaf) captureMessageSnapshot(leaf.id);
        state = workspaceStore.getState();
    }
    await persistWorkspaceNow();
    const archives = await listChatArchives();
    const nextCard = switching ? state.characters.find(item => !selected.has(item.id)) : undefined;
    const recent = switching && nextCard ? [...archives].reverse().find(chat => chat.characterId === nextCard.id) : undefined;
    const nextChat = recent ? await loadChatArchive(recent.id) : null;
    const extras: Record<string, any> = {};
    let index = archives;
    if (switching && !deleteChats && state.messages.length) {
        const chat: ArchivedChat = { id: state.activeChatId, characterId: state.activeCharacterId, importedFrom: state.storyImportFingerprint, messages: state.messages, deletedMessageIds: state.deletedMessageIds,
            activeLeafId: state.activeLeafId, timedStates: state.timedStates, worldbookName: state.chatWorldbookBindings[state.activeChatId],
            templateInjections: state.templateInjections, templateActivations: state.templateActivations, continuation: captureChatContinuation() };
        extras[`chat_archive:${chat.id}`] = chat;
        index = [...index.filter(item => item.id !== chat.id), summarizeChat(chat)];
    }
    if (deleteChats) {
        for (const chat of index.filter(item => selected.has(item.characterId))) extras[`chat_archive:${chat.id}`] = null;
        if (switching) extras[`chat_archive:${state.activeChatId}`] = null;
        index = index.filter(item => !selected.has(item.characterId));
    }
    extras.chat_archive_index = index;
    const cleanup = await platformStorage.loadSnapshot<string[]>('gallery_cleanup', []);
    extras.gallery_cleanup = [...new Set([...cleanup, ...selected])];
    const finish = suspendRegisteredPersistence(), release = holdReplicaCommit();
    const oldVariables = scopedVariableStore.getState(), oldSettings = schemaRegistryStore.getState();
    let candidate: ReturnType<typeof registeredSnapshots>;
    let workspace: WorkspaceState, variables: typeof oldVariables, settings: typeof oldSettings;
    let replay: Array<() => number> = [];
    try {
    withoutStoreNotifications(() => {
    try {
    workspaceStore.setState(draft => {
        // Keep embedded books as independent resources unless explicitly selected for deletion.
        for (const card of cards) {
            for (const book of [card.characterBook, card.embeddedLorebook]) if (book && !draft.lorebooks.some(item => item.id === book.id)) draft.lorebooks.push(book);
            delete draft.characterWorldbookBindings[card.id]; delete draft.streamDisplayModes[card.id];
        }
        draft.characters = draft.characters.filter(item => !selected.has(item.id));
        const removedLinks = new Set([...selected].flatMap(id => [id, `${id}.png`]));
        for (const persona of draft.personas) persona.connections = persona.connections.filter(link => link.type !== 'character' || !removedLinks.has(link.id));
    });
    if (switching) {
        if (nextChat) applyArchivedChatState(nextChat);
        else if (nextCard) createChat(nextCard, false);
        else workspaceStore.setState(emptyStory());
    }
    workspaceStore.setState(draft => { for (const bookId of deleteBookIds) removeWorldbookFromWorkspace(draft, bookId); });
    workspace = workspaceStore.getState(); variables = scopedVariableStore.getState(); settings = schemaRegistryStore.getState();
    candidate = { ...registeredSnapshots(), ...extras };
    } finally { workspaceStore.setState(state); scopedVariableStore.setState(oldVariables); schemaRegistryStore.setState(oldSettings); }
    });
    const unlock = [workspaceStore.holdWrites(), scopedVariableStore.holdWrites(), schemaRegistryStore.holdWrites()];
    try {
        await platformStorage.saveSnapshots(candidate!);
        acknowledgeSnapshots(candidate!);
        replay = unlock.map(unlock => unlock());
        batchReactiveUpdates(() => { workspaceStore.setState(workspace!); scopedVariableStore.setState(variables!); schemaRegistryStore.setState(settings!); });
    } finally { if (!replay.length) replay = unlock.map(unlock => unlock()); }
    } finally {
        await finish(false);
        const replayed = batchReactiveUpdates(() => replay.reduce((count, run) => count + run(), 0)); release();
        if (replayed) await persistWorkspaceNow();
    }
    if (switching) {
        void tavernEventBus.emit('chat_changed', workspaceStore.getState().activeChatId);
        void tavernEventBus.emit('character_changed', getActiveCharacter()); schedulePreview();
    }
    void import('../../core/story-gallery').then(module => module.drainGalleryCleanup()).catch(error => setStatusBanner(`图库清理稍后重试：${String(error)}`));
    return cards.length;
    });
}

export async function deleteWorkspacePreset(id: string): Promise<void> {
    const state = workspaceStore.getState();
    if (state.isGenerating || state.helperGenerationCount) throw new Error('请等待生成结束后删除预设');
    const active = state.activePresetId === id || state.inUsePreset?.id === id;
    workspaceStore.setState(draft => {
        draft.presets = draft.presets.filter(preset => preset.id !== id);
    });
    if (active) { workspaceStore.setState({ activePresetId: '', inUsePreset: undefined }); schedulePreview(); }
    await persistWorkspaceNow();
}

/** Developer testing action: remove imported content, then bootstrap defaults. */
export async function clearImportedWorkspace(): Promise<void> {
    const state = workspaceStore.getState();
    if (state.isGenerating || state.helperGenerationCount) throw new Error('请先停止生成再清空');
    stopCompatibilityRuntime();
    const { preload, rendering } = currentTemplateJobs();
    await Promise.allSettled([currentCharacterSwitch(), preload, rendering]);
    await enqueuePersistentOperation(async () => {
        await persistRegisteredSnapshots();
        const resume = suspendRegisteredPersistence();
        try {
            await clearChatArchives();
            const { unbindStoryGallery } = await import('../../core/story-gallery');
            for (const card of state.characters) await unbindStoryGallery(card.id);
            const fresh = initialWorkspace();
            fresh.personas = structuredClone(state.personas);
            const profile = fresh.personas.find(persona => persona.is_default);
            fresh.activePersonaId = profile?.avatar_id ?? null;
            fresh.userName = profile?.name ?? state.userName;
            const { characters, lorebooks, presets, ...snapshot } = fresh;
            await platformStorage.saveSnapshots({ workspace_assets: { characters, lorebooks, presets },
                workspace_snapshot: { ...snapshot, snapshotVersion: 2 },
                scoped_variables: { global: {}, character: {}, preset: {}, chat: {}, message: {}, extension: {} } });
            window.location.reload();
        } catch (error) {
            await resume(false);
            window.dispatchEvent(new Event('tipsy-compatibility-reload'));
            throw error;
        }
    });
}

function addImportedCharacter(card: NormalizedCharacterCard): void {
    const state = workspaceStore.getState();
    assertNewAsset('角色卡', card, state.characters);
    const books = [...new Map([card.characterBook, card.embeddedLorebook].filter((book): book is NormalizedLorebook => !!book).map(book => [book.id, book])).values()];
    const catalog = [...getAvailableWorldbooks(state)];
    for (const book of books) { assertNewAsset('世界书', book, catalog); catalog.push(book); }
    workspaceStore.setState(draft => { draft.characters.push(card); draft.lorebooks.push(...books); });
}

export async function importStoryCharacter(file: File): Promise<string> {
    storySaveAvailable();
    const png = isPngStoryCharacter(file);
    if (!png) validateStoryCharacterJson(await file.text());
    const card = await importCharacterFile(file, png);
    storySaveAvailable();
    addImportedCharacter(card);
    await persistWorkspaceNow();
    return card.id;
}

export async function importAssetFile(file: File): Promise<string> {
    if (workspaceStore.getState().isGenerating || workspaceStore.getState().helperGenerationCount) throw new Error('请等待生成结束后导入角色卡或预设');
    if (isPngAssetName(file.name)) {
        const card = await importCharacterFile(file);

        addImportedCharacter(card);

        await persistWorkspaceNow();
        const book = card.characterBook ?? card.embeddedLorebook;
        return `已导入故事「${card.name}」：世界书 ${book?.entries.length ?? 0} 条，正则 ${card.regexScripts.length} 条。选择故事即可进入，附带世界书自动启用。`;
    }

    const text = await file.text();
    const raw = JSON.parse(text) as Record<string, unknown>;
    const format = classifyLibraryJson(raw);

    if (format.kind === 'quick-reply') {
        const settings = structuredClone(readExtensionVariables(scopedVariableStore.getState().extension, 'quickReplyV2'));
        const set = { ...raw, name: format.name, qrList: format.replies.map((reply: any, index: number) => ({ ...reply,
            id: Number.isInteger(reply.id) ? reply.id : index + 1, label: String(reply.label ?? ''), message: String(reply.message ?? '') })) } as QuickReplySetData;
        settings.sets = [...quickReplySets(settings).filter(item => item.name !== set.name), set];
        settings.config ??= { setList: [] }; settings.config.setList ??= [];
        if (!settings.config.setList.some((link: any) => (typeof link.set === 'string' ? link.set : link.set?.name) === set.name)) settings.config.setList.push({ set: set.name, isVisible: true });
        settings.isEnabled = true;
        replaceExtensionVariables('quickReplyV2', settings); await persistWorkspaceNow();
        return `已导入快捷回复集合「${set.name}」（${set.qrList.length} 条），已启用全局绑定`;
    }

    if (format.kind === 'preset') {
        // 兼容复杂结构：NormalizePreset 本身已处理采样参数解析，这里避免重复判断导致的解析报错
        const preset: NormalizedPreset = {
            ...normalizePreset(raw, String(raw.name || file.name.replace(/\.json$/i, ''))),
            id: `preset_${crypto.randomUUID()}`,
        };

        assertNewAsset('预设', preset, workspaceStore.getState().presets);
        workspaceStore.setState((draft) => {
            draft.presets.push(preset);
        });
        await persistWorkspaceNow();
        return `已导入预设「${preset.name}」，可在「叙事预设」中选择使用。当前对话继续使用原预设。`;
    }

    if (format.kind === 'worldbook') {
        const book = normalizeLorebook(raw, String(raw.name ?? file.name.replace(/\.json$/i, '')));
        assertNewAsset('世界书', book, getAvailableWorldbooks());
        workspaceStore.setState(draft => { draft.lorebooks.push(book); draft.activeLorebookIds.push(book.id); });
        persistWorkspace(); schedulePreview();
        return `已导入世界书「${book.name}」`;
    }

    const card = await importCharacterFile(file, false);
    addImportedCharacter(card);
    await persistWorkspaceNow();
    return `已导入故事「${card.name}」，选择故事即可进入，附带世界书自动启用。`;
}

/**
 * 将当前激活角色卡（含内嵌世界书与正则脚本）编码进标准 PNG (tEXt chara + ccv3) 并触发下载
 */
export async function exportActiveCharacterAsPng(): Promise<string> {
    return exportCharacterAsPng(workspaceStore.getState().activeCharacterId);
}

export async function exportCharacterAsPng(characterId: string): Promise<string> {
    const card = workspaceStore.getState().characters.find(item => item.id === characterId);
    if (!card) throw new Error('找不到要导出的角色卡');

    // 最小合法 1x1 琥珀色 PNG 底图字节流
    const minimalPngBase64 =
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGN4uazyPwAHjAMIqJsA+gAAAABJRU5ErkJggg==';
    const binary = atob(minimalPngBase64);
    let basePng: Uint8Array = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        basePng[i] = binary.charCodeAt(i);
    }

    if (card.avatar.startsWith('data:image/png')) {
        const response = await fetch(card.avatar);
        basePng = new Uint8Array(await response.arrayBuffer());
    }
    const encodedPng = embedCharacterCardIntoPng(basePng, serializeCharacterCard(card));

    const saved = await saveExport(new Blob([new Uint8Array(encodedPng).buffer], { type: 'image/png' }), `${card.name || 'character'}_ccv3.png`);
    if (!saved) return '已取消导出';

    return `已导出角色卡「${card.name}」为标准 V2/V3 PNG 文件`;
}

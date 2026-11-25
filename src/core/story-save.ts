import type { ArchivedChat } from '../store/chat-archives';
import type { BranchState } from '../store/branch-state';
import { hostMessageHidden } from '../compatibility/chat-message-codec';
import { remapRouteMessageData } from '../store/route-message-data';
import { activePath, branchExcerpt, swipeId } from '../store/chat-tree';
import type { ChatMessageNode, LorebookTimedState, NormalizedCharacterCard, NormalizedLorebook, NormalizedPreset } from '../types';
import { worldinfoHash } from '../pipeline/worldinfo-hash';
import { storySaveExtension, type StoryImport } from './story-save-format';

type Continuation = NonNullable<ArchivedChat['continuation']>;
type Assets = { characters: NormalizedCharacterCard[]; lorebooks: NormalizedLorebook[]; presets: NormalizedPreset[] };
const bag = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
export const storyResourceName = (name: string) => name.trim().normalize('NFC').toLowerCase();

function localJob<T>(payload: unknown, signal?: AbortSignal): Promise<T> {
    return new Promise((resolve, reject) => {
        const worker = new Worker(new URL('./story-save.worker.ts', import.meta.url), { type: 'module' });
        const finish = () => { worker.terminate(); signal?.removeEventListener('abort', abort); };
        const abort = () => { finish(); reject(new DOMException('已取消读取', 'AbortError')); };
        if (signal?.aborted) { abort(); return; }
        signal?.addEventListener('abort', abort, { once: true });
        worker.onmessage = ({ data }) => { finish(); if (data.error) reject(new Error(data.error)); else resolve(data.result); };
        worker.onerror = event => { finish(); reject(new Error(event.message || '故事存档处理失败')); };
        worker.postMessage(payload);
    });
}

export const readStorySave = (file: File, signal?: AbortSignal) => localJob<StoryImport>({ file }, signal);
export async function makeStorySave(chat: ArchivedChat, character: NormalizedCharacterCard,plugins=true) {
    const images=plugins?await (await import('./story-plugin-archive')).archiveImages(chat):undefined;
    const bytes = await localJob<Uint8Array<ArrayBuffer>>({ chat, character,images });
    return { blob: new Blob([bytes], { type: 'application/zip' }), name: `${(character.name || '故事').replace(/[\\/:*?"<>|]/g, '-').slice(0, 80)}-${new Date().toISOString().slice(0, 10)}${storySaveExtension}` };
}

export function storySaveExcerpt(chat: Pick<ArchivedChat, 'messages' | 'activeLeafId' | 'continuation'>) {
    return branchExcerpt(activePath(chat.messages, chat.activeLeafId).filter(node => !hostMessageHidden(node, chat.continuation?.chatMetadata)).at(-1)?.content ?? '', 180);
}

export function restoreStoryResources(source: ArchivedChat, sourceCard: NormalizedCharacterCard, library: Assets) {
    const added: Assets = { characters: [], lorebooks: [], presets: [] };
    const importedName = (name: string) => name.replace(/ · 存档(?: \d+)?$/, '');
    const same = <T extends { id: string }>(a: T, b: T) => {
        const { id: _a, ...left } = a; const { id: _b, ...right } = b;
        return JSON.stringify(left) === JSON.stringify(right);
    };
    const sameBook = (a: NormalizedLorebook, b: NormalizedLorebook) => {
        if (a.name !== b.name && importedName(a.name) !== importedName(b.name)) return false;
        const canonical = (book: NormalizedLorebook) => ({ ...book, name: a.name,
            entries: book.entries.map(({ hash: _hash, ...entry }) => ({ ...entry, world: a.name })) });
        return same(canonical(a), canonical(b));
    };
    function allocate<T extends { id: string; name: string }>(value: T, existing: T[], prefix: string): T {
        const equivalent = existing.find(item => same(item, value));
        if (equivalent) return equivalent;
        const nameUsed = (name: string) => existing.some(item => storyResourceName(item.name) === storyResourceName(name));
        let name = value.name;
        for (let copy = 1; nameUsed(name); copy++) name = `${value.name} · 存档${copy === 1 ? '' : ` ${copy}`}`;
        return { ...value, name, id: existing.some(item => item.id === value.id) ? `${prefix}_${crypto.randomUUID()}` : value.id };
    }
    const bookLibrary = [...new Map([...library.lorebooks, ...library.characters.flatMap(card => [card.characterBook, card.embeddedLorebook, typeof card.primaryWorldbook === 'object' ? card.primaryWorldbook : null].filter((book): book is NormalizedLorebook => !!book))].map(book => [book.id, book])).values()];
    const books = new Map<string, { id: string; name: string }>();
    const mappedBooks = new WeakMap<NormalizedLorebook, NormalizedLorebook>();
    const renameBook = (book: NormalizedLorebook, target: { id: string; name: string }) => ({ ...book, ...target,
        entries: book.entries.map(entry => {
            if (entry.world === target.name) return entry;
            const renamed = { ...entry, world: target.name };
            return { ...renamed, ...(entry.hash === undefined ? {} : { hash: worldinfoHash(renamed) }) };
        }) });
    const addBook = (book: NormalizedLorebook, keepLocal = false) => {
        const cached = mappedBooks.get(book);
        if (cached) return cached;
        const prior = books.get(book.id);
        const match = prior ? undefined : bookLibrary.find(item => item.id === book.id && sameBook(item, book)) ?? bookLibrary.find(item => sameBook(item, book));
        const allocated = prior ?? match ?? allocate(book, bookLibrary, 'wb');
        const target = { id: allocated.id, name: allocated.name };
        const next = match ?? renameBook(book, target);
        mappedBooks.set(book, next);
        if (!prior) {
            books.set(book.id, target);
            if (!match) { bookLibrary.push(next); if (keepLocal) added.lorebooks.push(next); }
        }
        return next;
    };
    const snapshots = [source.continuation!, ...source.messages.flatMap(node => [node.branchStates, node.branchBases].flatMap(points => Object.values(points ?? {}).map(point => point.continuation)))];
    for (const book of snapshots[0].worldbooks ?? []) addBook(book, true);
    for (const book of [sourceCard.characterBook, sourceCard.embeddedLorebook, typeof sourceCard.primaryWorldbook === 'object' ? sourceCard.primaryWorldbook : null]) if (book) addBook(book, true);
    for (const snapshot of snapshots.slice(1)) for (const book of snapshot.worldbooks ?? []) addBook(book);
    const bookName = (name: string, context: NormalizedLorebook[] = []) => {
        const original = context.find(book => book.name === name) ?? snapshots[0].worldbooks?.find(book => book.name === name)
            ?? [sourceCard.characterBook, sourceCard.embeddedLorebook, typeof sourceCard.primaryWorldbook === 'object' ? sourceCard.primaryWorldbook : null].find(book => book?.name === name);
        return original ? books.get(original.id)?.name ?? name : name;
    };
    const mapCard = (card: NormalizedCharacterCard, context?: NormalizedLorebook[]): NormalizedCharacterCard => ({ ...card,
        characterBook: card.characterBook && addBook(card.characterBook), embeddedLorebook: card.embeddedLorebook && addBook(card.embeddedLorebook),
        primaryWorldbook: typeof card.primaryWorldbook === 'string' ? bookName(card.primaryWorldbook, context) : card.primaryWorldbook && addBook(card.primaryWorldbook),
        additionalWorldbooks: card.additionalWorldbooks?.map(name => bookName(name, context)) });
    const mappedCard = mapCard(sourceCard);
    const card = library.characters.find(item => same(item, { ...mappedCard, name: item.name }) && importedName(item.name) === importedName(mappedCard.name))
        ?? allocate(mappedCard, library.characters, 'character');
    if (!library.characters.includes(card)) added.characters.push(card);
    const presets = new Map<string, NormalizedPreset>();
    const addPreset = (preset?: NormalizedPreset) => {
        if (!preset?.id) return preset;
        const prior = presets.get(preset.id);
        if (prior) return { ...preset, id: prior.id, name: prior.name };
        const existing = [...library.presets, ...added.presets];
        const next = existing.find(item => same(item, { ...preset, name: item.name }) && importedName(item.name) === importedName(preset.name)) ?? allocate(preset, existing, 'preset');
        if (!existing.includes(next)) added.presets.push(next);
        presets.set(preset.id, next); return next;
    };
    const id = `chat_${card.id}_${crypto.randomUUID()}`;
    const ids = new Map(source.messages.map(node => [node.id, `msg_${crypto.randomUUID()}`]));
    const origins = new Map(ids);
    for (const node of source.messages) if (node.branchOrigin && !origins.has(node.branchOrigin)) origins.set(node.branchOrigin, `msg_${crypto.randomUUID()}`);
    const swipes = new Map(source.messages.flatMap(node => node.swipes.map((_, i) => [swipeId(node, i), `${ids.get(node.id)}:${i}`] as const)));
    const remap = <T>(values: Record<string, T> | undefined, keys: Map<string, string>) => Object.fromEntries(Object.entries(values ?? {}).flatMap(([key, value]) => keys.has(key) ? [[keys.get(key)!, value]] : []));
    const personaIds = new Map<string, string>();
    const mapVariables = (input: Record<string, unknown>, name: (key: string) => string) => {
        const initialized = input.initialized_lorebooks;
        if (!initialized) return input;
        return { ...input, initialized_lorebooks: Array.isArray(initialized) ? initialized.map(key => typeof key === 'string' ? name(key) : key)
            : Object.fromEntries(Object.entries(bag(initialized)).map(([key, value]) => [name(key), value])) };
    };
    const mapping = (context: NormalizedLorebook[] = []) => {
        const name = (key: string) => bookName(key, context);
        const entries = new Map<string, NormalizedLorebook['entries'][number]>(context.flatMap(book => book.entries.map(entry => [`${book.name}::${entry.uid}`, { ...entry, world: book.name }] as const)));
        const timed = (values: Record<string, LorebookTimedState>) => Object.fromEntries(Object.entries(values ?? {}).map(([key, value]) => {
            const entry = entries.get(key);
            if (!entry) return [key, value];
            const next = { ...entry, world: name(entry.world!) };
            const newKey = `${next.world}::${next.uid}`;
            if (newKey === key) return [key, value];
            const oldHash = entry.hash ?? worldinfoHash(entry), newHash = worldinfoHash(next);
            return [newKey, { ...value, effects: Object.fromEntries(Object.entries(value.effects ?? {}).map(([type, effect]) => [type, { ...effect, hash: effect.hash === oldHash ? newHash : effect.hash }])) }];
        }));
        const activations = (values: ArchivedChat['templateActivations']) => values?.map(value => ({ ...value, world: name(value.world) }));
        const vars = (value: Record<string, unknown>) => mapVariables(value, name);
        const messageVars = (values: Continuation['variables']['message']) => Object.fromEntries(Object.entries(remap(values, ids)).map(([key, value]) => [key, vars(value)]));
        const metadata = (value?: Record<string, unknown>) => value && { ...remapRouteMessageData(value, ids, swipes, false),
            ...(value.tipsy_host_hidden_messages ? { tipsy_host_hidden_messages: remap(bag(value.tipsy_host_hidden_messages), swipes) } : {}) };
        return { name, timed, activations, vars, messageVars, metadata };
    };
    const transformContinuation = (value: Continuation): Continuation => {
        const context = value.worldbooks ?? [];
        const m = mapping(context);
        const preset = addPreset(value.inUsePreset);
        const persona = value.persona;
        const personaId = persona ? personaIds.get(persona.avatar_id) ?? `story_persona_${crypto.randomUUID()}` : null;
        if (persona && personaId) personaIds.set(persona.avatar_id, personaId);
        const extensions = { ...value.extensions };
        const quickReply = extensions.quickReplyV2;
        if (quickReply) extensions.quickReplyV2 = { ...quickReply, chatConfigs: { [id]: quickReply.chatConfigs?.[source.id] } };
        return { ...value, portable: true, chatMetadata: m.metadata(value.chatMetadata), extensions,
            variables: { global: {}, chat: { [id]: m.vars(value.variables.chat[source.id] ?? {}) }, message: m.messageVars(value.variables.message),
                character: { [card.id]: m.vars(value.variables.character?.[source.characterId] ?? {}) },
                preset: preset?.id ? { [preset.id]: m.vars(value.variables.preset?.[value.activePresetId] ?? {}) } : {} },
            activePresetId: preset?.id ?? '', inUsePreset: preset,
            activeLorebookIds: value.activeLorebookIds.map(key => books.get(key)?.id ?? key), worldbooks: context.map(book => addBook(book)),
            characterBinding: value.characterBinding && { primary: value.characterBinding.primary ? m.name(value.characterBinding.primary) : null, additional: value.characterBinding.additional.map(m.name) },
            character: { ...mapCard(value.character ?? sourceCard, context), id: card.id, name: card.name },
            activePersonaId: personaId, persona: persona && { ...persona, avatar_id: personaId!, avatar: persona.avatar === persona.avatar_id ? personaId! : persona.avatar,
                lorebook: m.name(persona.lorebook), connections: [], is_default: false } };
    };
    const root = mapping(source.continuation?.worldbooks);
    const mapExtra = (value?: Record<string, unknown>, m = root): Record<string, unknown> | undefined => {
        if (!value) return value;
        const next = { ...value };
        for (const key of ['variables', 'chatVariables']) if (value[key]) next[key] = m.vars(bag(value[key]));
        for (const key of ['swipeVariables', 'swipeChatVariables']) if (value[key]) next[key] = Object.fromEntries(Object.entries(bag(value[key])).map(([i, vars]) => [i, m.vars(bag(vars))]));
        if (value.timedStates) next.timedStates = m.timed(bag(value.timedStates));
        if (value.swipeTimedStates) next.swipeTimedStates = Object.fromEntries(Object.entries(bag(value.swipeTimedStates)).map(([i, timed]) => [i, m.timed(timed)]));
        if (value.templateState) next.templateState = { ...bag(value.templateState), activations: m.activations(bag(value.templateState).activations) };
        if (value.swipeTemplateStates) next.swipeTemplateStates = Object.fromEntries(Object.entries(bag(value.swipeTemplateStates)).map(([i, state]) => [i, { ...state, activations: m.activations(state.activations) }]));
        if (value.swipeHostMetadata) next.swipeHostMetadata = Object.fromEntries(Object.entries(bag(value.swipeHostMetadata)).map(([i, metadata]) => [i, m.metadata(metadata)]));
        return next;
    };
    const points = (value?: Record<string, BranchState>) => value && Object.fromEntries(Object.entries(remap(value, swipes)).map(([key, point]) => {
        const m = mapping(point.continuation.worldbooks);
        return [key, { ...point, continuation: transformContinuation(point.continuation),
            messageVariablePages: point.messageVariablePages?.map(m.messageVars), timedStates: m.timed(point.timedStates),
            templateActivations: m.activations(point.templateActivations) ?? [], worldbookName: point.worldbookName ? m.name(point.worldbookName) : null,
            reply: point.reply && { ...point.reply, extra: mapExtra(point.reply.extra, m) } }];
    }));
    const chat: ArchivedChat = { ...source, id, characterId: card.id, activeLeafId: ids.get(source.activeLeafId!)!, deletedMessageIds: [],
        messages: source.messages.map((node): ChatMessageNode => ({ ...node, id: ids.get(node.id)!, messageId: ids.get(node.id),
            parentId: node.parentId ? ids.get(node.parentId)! : null, parentSwipeId: node.parentSwipeId && swipes.get(node.parentSwipeId),
            swipeIds: node.swipes.map((_, i) => swipes.get(swipeId(node, i))!), branchOrigin: node.branchOrigin && origins.get(node.branchOrigin),
            storySummaries: node.storySummaries && remap(node.storySummaries, swipes), branchStates: points(node.branchStates), branchBases: points(node.branchBases),
            extra: mapExtra(node.extra), nativePluginReplies: node.nativePluginReplies&&remap(node.nativePluginReplies,swipes), nativePluginOpeningRoutes: node.nativePluginOpeningRoutes&&remap(node.nativePluginOpeningRoutes,swipes), nativeRouteAnchors: undefined })),
        continuation: transformContinuation(source.continuation!), worldbookName: source.worldbookName ? root.name(source.worldbookName) : null,
        timedStates: root.timed(source.timedStates), templateActivations: root.activations(source.templateActivations) };
    return { chat, added };
}

import { EMPTY_CHARACTER, NO_PRESET } from '../../core/empty-workspace';
import type { NormalizedCharacterCard, NormalizedLorebook, NormalizedPreset } from '../../types';
import { type WorkspaceState, workspaceStore } from './state';

export function getActiveCharacter(state: WorkspaceState = workspaceStore.getState()): NormalizedCharacterCard {
    if (state.storyCharacter?.id === state.activeCharacterId) return state.storyCharacter;
    return state.characters.find((c) => c.id === state.activeCharacterId) || EMPTY_CHARACTER;
}

export function getActivePreset(state: WorkspaceState = workspaceStore.getState()): NormalizedPreset {
    if (state.sessionKind === 'free') return NO_PRESET;
    return state.inUsePreset ?? state.presets.find((p) => p.id === state.activePresetId) ?? NO_PRESET;
}

let availableBookSources: unknown[] = [];

let availableBooks: NormalizedLorebook[] = [];

export function getAvailableWorldbooks(state: WorkspaceState = workspaceStore.getState()): NormalizedLorebook[] {
    if (availableBookSources[0] === state.characters && availableBookSources[1] === state.lorebooks && availableBookSources[2] === state.storyWorldbooks) return availableBooks;
    availableBookSources = [state.characters, state.lorebooks, state.storyWorldbooks];
    return availableBooks = [...new Map([...state.characters.flatMap(card => [card.characterBook, card.embeddedLorebook].filter((book): book is NormalizedLorebook => !!book)), ...state.lorebooks, ...(state.storyWorldbooks ?? [])].map(book => [book.id, book])).values()];
}

export function getActivePersona(state: WorkspaceState = workspaceStore.getState()) {
    if (state.storyPersona?.avatar_id === state.activePersonaId) return state.storyPersona;
    const selected = state.personas.find(persona => persona.avatar_id === state.activePersonaId);
    if (selected || state.activePersonaId) return selected;
    return state.personas.find(persona => persona.connections.some(link => link.type === 'character'
        && [state.activeCharacterId, `${state.activeCharacterId}.png`].includes(link.id)))
        ?? state.personas.find(persona => persona.is_default);
}

export function getCharacterWorldbooks(card: NormalizedCharacterCard, state: WorkspaceState = workspaceStore.getState()) {
    if (card.id === state.activeCharacterId && state.storyCharacterBinding) return structuredClone(state.storyCharacterBinding);
    const explicit = state.characterWorldbookBindings[card.id];
    if (explicit) return structuredClone(explicit);
    const declared = typeof card.primaryWorldbook === 'string' ? card.primaryWorldbook : card.primaryWorldbook?.name;
    const embedded = card.characterBook ?? card.embeddedLorebook;
    return { primary: declared && getAvailableWorldbooks(state).some(book => book.name === declared) ? declared : embedded?.name ?? declared ?? null, additional: [...(card.additionalWorldbooks ?? [])] };
}

export function getWorldbookGroups(state: WorkspaceState) {
    const card = getActiveCharacter(state);
    const catalog = getAvailableWorldbooks(state);
    const binding = getCharacterWorldbooks(card, state);
    const embeddedName = (card.characterBook ?? card.embeddedLorebook)?.name;
    return {
        character: [...new Set([...(state.characterWorldbookBindings[card.id] ? [] : [embeddedName]), binding.primary].filter((name): name is string => !!name))],
        additional: binding.additional,
        global: state.activeLorebookIds.flatMap(id => catalog.find(book => book.id === id)?.name ?? []),
        persona: getActivePersona(state)?.lorebook ? [getActivePersona(state)!.lorebook] : [], chat: state.chatWorldbookBindings[state.activeChatId] ? [state.chatWorldbookBindings[state.activeChatId]!] : [],
    };
}

let activeBookSources: unknown[] = [];

let activeBooks: NormalizedLorebook[] = [];

const emptyActiveBooks: NormalizedLorebook[] = [];

export function getActiveLorebooks(state: WorkspaceState = workspaceStore.getState()): NormalizedLorebook[] {
    if (state.sessionKind === 'free') return emptyActiveBooks;
    const sources = [state.storyCharacter, state.storyPersona, state.storyWorldbooks, state.storyCharacterBinding, state.characters, state.activeCharacterId, state.lorebooks, state.activeLorebookIds,
        state.characterWorldbookBindings, state.chatWorldbookBindings, state.activeChatId, state.personas, state.activePersonaId];
    if (sources.every((value, index) => value === activeBookSources[index])) return activeBooks;
    activeBookSources = sources;
    const activeSet = new Set(state.activeLorebookIds);
    const all = getAvailableWorldbooks(state);
    const list = all.filter((wb) => wb.id && activeSet.has(wb.id));
    const card = getActiveCharacter(state);
    const embedded = card.characterBook || card.embeddedLorebook;
    const charBook = embedded ? all.find(book => book.id === embedded.id) ?? embedded : undefined;
    const binding = state.storyCharacterBinding ?? state.characterWorldbookBindings[card.id];
    const resolved = getCharacterWorldbooks(card, state);
    const names = [resolved.primary, ...resolved.additional, getActivePersona(state)?.lorebook];
    const bound = names.flatMap(name => name ? (charBook?.name === name ? charBook : all.find(book => book.name === name)) ?? [] : []);
    const chatName = state.chatWorldbookBindings[state.activeChatId];
    const chatBook = chatName ? all.find(book => book.name === chatName) : undefined;
    const next = [...new Map([...(charBook && !binding ? [charBook] : []), ...bound, ...list, ...(chatBook ? [chatBook] : [])].map(book => [book.id, book])).values()];
    if (next.length !== activeBooks.length || next.some((book, index) => book !== activeBooks[index])) activeBooks = next;
    return activeBooks;
}

export function isPngAssetName(name: string): boolean {
    return name.toLowerCase().endsWith('.png');
}

export function isPngStoryCharacter(file: File): boolean {
    return file.type === 'image/png' || /\.png$/i.test(file.name);
}

export function validateStoryCharacterJson(text: string): void {
    const raw = JSON.parse(text);
    const data = raw?.data ?? raw;
    if (typeof data?.name !== 'string' || !('first_mes' in data || 'description' in data || 'alternate_greetings' in data)) {
        throw new Error('请选择角色卡 PNG 或 JSON。');
    }
}

export function classifyLibraryJson(raw: Record<string, unknown>) {
    if (typeof raw.name === 'string' && Array.isArray(raw.qrList)) return { kind: 'quick-reply', name: raw.name, replies: raw.qrList } as const;
    if (Array.isArray(raw.prompts) || Array.isArray(raw.prompt_order)) return { kind: 'preset' } as const;
    if (raw.entries && !raw.data && !raw.first_mes) return { kind: 'worldbook' } as const;
    return { kind: 'character' } as const;
}

const assetNameKey = (name: string) => name.trim().normalize('NFC').toLocaleLowerCase();

export function assertNewAsset(kind: string, asset: { id: string; name: string }, existing: Array<{ id: string; name: string }>): void {
    if (existing.some(item => assetNameKey(item.name) === assetNameKey(asset.name)))
        throw new Error(`已有同名${kind}「${asset.name}」，本次未导入。请先删除旧内容，再导入新版。`);
    if (existing.some(item => item.id === asset.id)) throw new Error(`这份${kind}的标识已存在，本次未导入。`);
}

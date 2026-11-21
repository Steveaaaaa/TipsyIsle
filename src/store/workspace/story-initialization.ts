import { evaluateMacros } from '../../pipeline/macro-regex-engine';
import { getScopedVariables, replaceScopedVariables } from '../scoped-variable-store';
import { loadMvuInitialVariables, readInitialVariables } from '../../pipeline/initial-variables';
import { mvuProjectionKeys, normalizeMvuVariables, normalizeMvuVariableMap } from '../../pipeline/mvu-data';
import type { ChatMessageNode, NormalizedLorebook } from '../../types';
import { workspaceStore, type WorkspaceState } from './state';
import { getCharacterWorldbooks, getActiveCharacter, getAvailableWorldbooks } from './library';
import { getActiveChatMessages, getEffectiveMvuSettings } from './queries';

export function normalizeMessageVariableSnapshots(messages: ChatMessageNode[]): ChatMessageNode[] {
    let changed = false;
    const next = messages.map(node => {
        if (!node.extra) return node;
        const chat = normalizeMvuVariables(node.extra.chatVariables as Record<string, unknown>);
        const swipes = normalizeMvuVariableMap(node.extra.swipeVariables as Record<string, Record<string, unknown>>);
        const swipeChats = normalizeMvuVariableMap(node.extra.swipeChatVariables as Record<string, Record<string, unknown>>);
        if (!chat.changed && !swipes.changed && !swipeChats.changed) return node;
        changed = true;
        return { ...node, extra: { ...node.extra,
            ...(chat.changed ? { chatVariables: chat.variables } : {}),
            ...(swipes.changed ? { swipeVariables: swipes.variables } : {}),
            ...(swipeChats.changed ? { swipeChatVariables: swipeChats.variables } : {}),
        } };
    });
    return changed ? next : messages;
}

export function ensureInitialVariables(): void {
    const state = workspaceStore.getState();
    if (!state.activeCharacterId) return;
    const existing = getScopedVariables('chat', { chatId: state.activeChatId });
    const defaults = readWorkspaceInitialVariables(state);
    const next = { ...initialChatVariables(state, defaults), ...existing };
    if (existing.stat_data && !existing.initialized_lorebooks) delete next.initialized_lorebooks;
    if (getEffectiveMvuSettings(state).settings['mvu.update_chat'] === true) loadMvuInitialVariables(next, initialWorldbooks(state), text => initialMacros(text, state));
    if (JSON.stringify(next) !== JSON.stringify(existing)) replaceScopedVariables(next, 'chat', { chatId: state.activeChatId });
    const first = getActiveChatMessages(state)[0];
    if (first && !Object.keys(getScopedVariables('message', { messageId: first.id })).length) {
        replaceScopedVariables(structuredClone({ ...defaults, ...next }), 'message', { messageId: first.id });
    }
}

function initialWorldbooks(state: WorkspaceState): NormalizedLorebook[] {
    const catalog = getAvailableWorldbooks(state);
    const binding = getCharacterWorldbooks(getActiveCharacter(state), state);
    const names = [...state.activeLorebookIds.flatMap(id => catalog.find(book => book.id === id)?.name ?? []), binding.primary, ...binding.additional];
    return [...new Set(names)].flatMap(name => catalog.find(book => book.name === name) ?? []);
}

function initialMacros(text: string, state: WorkspaceState): string {
    return evaluateMacros(text, { userName: state.userName, charName: getActiveCharacter(state).name,
        variables: getScopedVariables('chat', { chatId: state.activeChatId }), globalVariables: getScopedVariables('global') });
}

export function readWorkspaceInitialVariables(state = workspaceStore.getState()): Record<string, any> {
    return readInitialVariables(getActiveCharacter(state), initialWorldbooks(state), text => initialMacros(text, state));
}

export function initialChatVariables(state = workspaceStore.getState(), initial = readWorkspaceInitialVariables(state)): Record<string, any> {
    if (getEffectiveMvuSettings(state).settings['mvu.update_chat'] === true) return initial;
    return Object.fromEntries(Object.entries(initial).filter(([key]) => !mvuProjectionKeys.some(field => field === key)));
}

export function mvuChatProjection(variables: Record<string, any>): Record<string, any> {
    if (getEffectiveMvuSettings().settings['mvu.update_chat'] !== true) return {};
    return Object.fromEntries(mvuProjectionKeys
        .filter(key => key in variables).map(key => [key, structuredClone(variables[key])]));
}

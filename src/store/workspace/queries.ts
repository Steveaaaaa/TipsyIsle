import { resolveMvuSettings } from '../../pipeline/mvu-settings';
import { schemaRegistryStore } from '../../registry/schema-registry';
import { activePath, branchOptions } from '../chat-tree';
import type { ChatMessageNode } from '../../types';
import { workspaceStore, type WorkspaceState } from './state';
import { getCharacterWorldbooks, getActiveCharacter, getAvailableWorldbooks } from './library';

const authorMessageRevisions = new WeakMap<ChatMessageNode[], symbol>();

export function authorMessageRevision(messages: ChatMessageNode[]): symbol {
    let revision = authorMessageRevisions.get(messages);
    if (!revision) { revision = Symbol(); authorMessageRevisions.set(messages, revision); }
    return revision;
}

export function preserveAuthorMessageRevision(previous: ChatMessageNode[], next: ChatMessageNode[]): void {
    if (previous !== next) authorMessageRevisions.set(next, authorMessageRevision(previous));
}

let mvuSettingsSources: unknown[] = [];

let cachedMvuSettings: ReturnType<typeof resolveMvuSettings>;

export function getEffectiveMvuSettings(state = workspaceStore.getState()) {
    const primary = getCharacterWorldbooks(getActiveCharacter(state), state).primary;
    const book = getAvailableWorldbooks(state).find(book => book.name === primary);
    const settings = schemaRegistryStore.getState().values;
    if (cachedMvuSettings && mvuSettingsSources[0] === settings && mvuSettingsSources[1] === book) return cachedMvuSettings;
    mvuSettingsSources = [settings, book];
    return cachedMvuSettings = resolveMvuSettings(settings, book);
}

let activeMessageSources: unknown[] = [];

let activeMessagesCache: ChatMessageNode[] = [];

export function getActiveChatMessages(state: WorkspaceState = workspaceStore.getState()): ChatMessageNode[] {
    if (activeMessageSources[0] !== state.messages || activeMessageSources[1] !== state.activeLeafId) {
        activeMessageSources = [state.messages, state.activeLeafId];
        activeMessagesCache = activePath(state.messages, state.activeLeafId);
    }
    return activeMessagesCache;
}

export function getChatBranchOptions(state: WorkspaceState = workspaceStore.getState()) {
    return branchOptions(state.messages);
}

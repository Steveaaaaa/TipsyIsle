import { platformStorage } from '../core/platform-bridge';
import { removeRetiredBuiltinWorldbooks } from '../core/builtin-worldbook';
import { removeStarterContinuation } from '../core/retired-starter-content';
import type { ChatMessageNode, LorebookTimedState } from '../types';
import type { TemplatePromptInjection } from '../pipeline/template-injections';
import { activePath } from './chat-tree';
import type { ScopedVariableState } from './scoped-variable-store';

export type ChatSessionKind = 'character' | 'free';
export const freeChatName = '夜灯畅谈';
export interface FreeChatDetails { title?: string; model?: string }

export interface ArchivedChat {
    kind?: ChatSessionKind;
    freeChat?: FreeChatDetails;
    importedFrom?: string;
    deletedMessageIds?: string[];
    id: string; characterId: string; messages: ChatMessageNode[];
    activeLeafId: string | null; timedStates: Record<string, LorebookTimedState>;
    worldbookName?: string | null;
    templateInjections?: TemplatePromptInjection[];
    templateActivations?: Array<{ world: string; uid: string | number; force: boolean }>;
    syncLabel?: string;
    continuation?: {
        portable?: boolean;
        chatMetadata?: Record<string, unknown>;
        nativePluginRoute?: import('../plugins/native/storage').PluginBuckets;
        extensionKeys?: string[];
        variables: Pick<ScopedVariableState, 'global' | 'chat' | 'message'> & Partial<Pick<ScopedVariableState, 'character' | 'preset'>>;
        extensions: Record<string, any>;
        activePresetId: string;
        inUsePreset: any;
        activeLorebookIds: string[];
        userName: string;
        activePersonaId: string | null;
        settings?: Record<string, unknown>;
        worldbooks?: import('../types').NormalizedLorebook[];
        characterBinding?: any;
        character?: import('../types').NormalizedCharacterCard;
        persona?: import('../types').UserPersona;
    };
}
export interface ChatArchiveSummary {
    kind?: ChatSessionKind;
    freeChat?: FreeChatDetails;
    importedFrom?: string;
    id: string; characterId: string; messageCount: number; activeCount: number;
    lastMessage: string; lastDate: ChatMessageNode['sendDate'];
    syncLabel?: string;
}
const indexKey = 'chat_archive_index';
const chatKey = (id: string) => `chat_archive:${id}`;
let writes: Promise<unknown> = Promise.resolve();
export function summarizeChat(chat: ArchivedChat): ChatArchiveSummary {
    return { id: chat.id, kind: chat.kind, freeChat: chat.freeChat, characterId: chat.characterId, importedFrom: chat.importedFrom, syncLabel: chat.syncLabel, messageCount: chat.messages.length,
        activeCount: activePath(chat.messages, chat.activeLeafId).length,
        lastMessage: activePath(chat.messages, chat.activeLeafId).at(-1)?.content ?? '', lastDate: activePath(chat.messages, chat.activeLeafId).at(-1)?.sendDate };
}
export async function listChatArchives(): Promise<ChatArchiveSummary[]> {
    await writes.catch(() => {});
    return platformStorage.loadSnapshot<ChatArchiveSummary[]>(indexKey, []);
}
export async function loadChatArchive(id: string): Promise<ArchivedChat | null> {
    await writes.catch(() => {});
    const chat = await platformStorage.loadSnapshot<ArchivedChat | null>(chatKey(id), null);
    if (!chat?.continuation) return chat;
    const continuation = removeStarterContinuation(removeRetiredBuiltinWorldbooks(chat.continuation));
    return continuation === chat.continuation ? chat : { ...chat, continuation };
}
export function saveChatArchive(chat: ArchivedChat, parked = false): Promise<void> {
    return updateChatArchive(chat.id, () => ({ chat, extras: {}, silent: parked }), false).then(() => {});
}
function cleanArchive(chat: ArchivedChat | null): ArchivedChat | null {
    if (!chat?.continuation) return chat;
    const continuation = removeStarterContinuation(removeRetiredBuiltinWorldbooks(chat.continuation));
    return continuation === chat.continuation ? chat : { ...chat, continuation };
}
export function publishChatArchive(chat: ArchivedChat, extras: Record<string, unknown> = {}): Promise<void> {
    return updateChatArchive(chat.id, () => ({ chat, extras }), false).then(() => {});
}
type ArchiveUpdate<T> = { chat: ArchivedChat; extras: Record<string, unknown>; result?: T; silent?: boolean };
export function deleteChatArchive(id: string, extras: Record<string, unknown> = {}): Promise<void> {
    const job = writes.catch(() => {}).then(async () => {
        const index = await platformStorage.loadSnapshot<ChatArchiveSummary[]>(indexKey, []);
        await platformStorage.saveSnapshots({ ...extras, [indexKey]: index.filter(item => item.id !== id), [chatKey(id)]: null });
    });
    writes = job;
    return job;
}
export function updateChatArchive<T>(id: string, update: (current: ArchivedChat | null) => Promise<ArchiveUpdate<T>> | ArchiveUpdate<T>, read = true): Promise<T | undefined> {
    const job = writes.catch(() => {}).then(async () => {
        const index = await platformStorage.loadSnapshot<ChatArchiveSummary[]>(indexKey, []);
        const { chat, extras, result, silent } = await update(read ? cleanArchive(await platformStorage.loadSnapshot<ArchivedChat | null>(chatKey(id), null)) : null);
        await platformStorage.saveSnapshots({ ...extras, [indexKey]: [...index.filter(item => item.id !== chat.id), summarizeChat(chat)], [chatKey(chat.id)]: chat }, true, undefined, silent ? chat.id : undefined);
        return result;
    });
    writes = job;
    return job;
}
export function deleteCharacterArchives(characterId: string): Promise<void> {
    const job = writes.catch(() => {}).then(async () => {
        const index = await platformStorage.loadSnapshot<ChatArchiveSummary[]>(indexKey, []);
        await platformStorage.saveSnapshots({ [indexKey]: index.filter(item => item.characterId !== characterId),
            ...Object.fromEntries(index.filter(item => item.characterId === characterId).map(item => [chatKey(item.id), null])) });
    });
    writes = job;
    return job;
}

export function clearChatArchives(): Promise<void> {
    const job = writes.catch(() => {}).then(async () => {
        const index = await platformStorage.loadSnapshot<ChatArchiveSummary[]>(indexKey, []);
        for (let offset = 0; offset < index.length; offset += 60) {
            await platformStorage.saveSnapshots(Object.fromEntries(index.slice(offset, offset + 60).map(chat => [chatKey(chat.id), null])));
        }
        await platformStorage.saveSnapshot(indexKey, []);
    });
    writes = job;
    return job;
}

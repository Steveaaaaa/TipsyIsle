import { z } from 'zod';
import type { ChangePage, StoryChange } from '../../../packages/plugin-sdk/index.js';
import { platformStorage, registerLocalSnapshotHook } from '../../core/platform-bridge';
import { SYNC_KEY } from '../../core/sync/protocol';
import type { ChatMessageNode } from '../../types';
import { cursorSchema, limitSchema } from './edits';
import { PluginApiError } from './errors';

const key = 'native_plugin_journal';
const retention = 1024;
interface Journal { epoch: string; end: number; events: StoryChange[]; replyId?: string }
interface PublishedStory {
    activeChatId: string; messages: ChatMessageNode[]; activeLeafId: string | null; nativeStoryPending?: boolean;
    nativeStoryReply?: StoryChange; deletedMessageIds?: string[]; timedStates: object; templateInjections: unknown; templateActivations: unknown; chatMetadata?: object;
}
type Variables = { chat: Record<string, unknown>; message: Record<string, unknown> };
type Assets = { characters?: unknown; lorebooks?: unknown; presets?: unknown };
let journal: Journal | undefined;
let baseline: { story?: PublishedStory; variables?: Variables; assets?: Assets } = {};
let latestStory: PublishedStory | undefined;
let latestVariables: Variables | undefined;
let initializing: Promise<void> | undefined;
const listeners = new Set<(cursor: string) => void>();
const at = (data: Journal, index: number) => `${data.epoch}:${index}`;
export const storyChangeCursor = () => journal && at(journal, journal.end);
export function watchStoryChanges(listener: (cursor: string) => void) { listeners.add(listener); return () => listeners.delete(listener); }

export function initializeStoryChanges(authorRevision: (messages: ChatMessageNode[]) => unknown, seed: Record<string, unknown>) {
    return initializing ??= platformStorage.loadSnapshot<Journal | null>(key, null)
        .then(async value => {
            const stored = value ?? { epoch: crypto.randomUUID(), end: 0, events: [] };
            if (!value) await platformStorage.saveSnapshots({ [key]: stored }, false);
            journal = stored;
            latestStory = seed.workspace_snapshot as PublishedStory | undefined;
            latestVariables = seed.scoped_variables as Variables | undefined;
            baseline = { story: latestStory, variables: latestVariables, assets: seed.workspace_assets as Assets | undefined };
            registerLocalSnapshotHook((snapshots, track, parkedChat) => {
                const current = journal!;
                const story = (snapshots.workspace_snapshot ?? latestStory) as PublishedStory | undefined;
                const variables = (snapshots.scoped_variables ?? latestVariables) as Variables | undefined;
                const assets = (snapshots.workspace_assets ?? baseline.assets) as Assets | undefined;
                const origin = !track && Object.hasOwn(snapshots, SYNC_KEY) ? 'sync' : 'local';
                const events: StoryChange[] = [];
                const seen = new Set<string>();
                const changed = (chatId: string, deleted?: boolean) => {
                    if (!chatId || seen.has(chatId)) return;
                    seen.add(chatId); events.push({ id: crypto.randomUUID(), at: Date.now(), kind: 'story.changed', origin, chatId, ...(deleted && { deleted }) });
                };
                const previous = baseline.story;
                const ready = !!story && !story.nativeStoryPending;
                let replyId = current.replyId;
                for (const [name, value] of Object.entries(snapshots)) if (name.startsWith('chat_archive:')) {
                    const id = name.slice('chat_archive:'.length);
                    if (id !== parkedChat) changed(id, value === null);
                }
                if (ready) {
                    const before = baseline.variables;
                    const messageVariablesChanged = variables?.message !== before?.message && story.messages.some(node =>
                        variables?.message[node.id] !== before?.message[node.id]);
                    if (!previous || story.activeChatId !== previous.activeChatId || story.activeLeafId !== previous.activeLeafId
                        || authorRevision(story.messages) !== authorRevision(previous.messages)
                        || story.timedStates !== previous.timedStates || story.deletedMessageIds !== previous.deletedMessageIds || story.chatMetadata !== previous.chatMetadata
                        || story.templateInjections !== previous.templateInjections || story.templateActivations !== previous.templateActivations
                        || messageVariablesChanged || variables?.chat[story.activeChatId] !== before?.chat[story.activeChatId]) changed(story.activeChatId);
                    const reply = story.nativeStoryReply;
                    if (origin === 'local' && reply && reply.id !== replyId && reply.chatId === story.activeChatId) {
                        events.push(reply); replyId = reply.id;
                    }
                }
                if (assets?.characters !== baseline.assets?.characters || assets?.lorebooks !== baseline.assets?.lorebooks || assets?.presets !== baseline.assets?.presets)
                    events.push({ id: crypto.randomUUID(), at: Date.now(), origin, kind: 'assets.changed' });
                // Save cursors in the same transaction as their story. A failed write leaves them unchanged.
                const next = events.length ? { ...current, replyId, end: current.end + events.length, events: [...current.events, ...events].slice(-retention) } : current;
                if (!events.length && story === latestStory && variables === latestVariables && assets === baseline.assets) return;
                return { values: events.length ? { [key]: next } : {}, committed() {
                    latestStory = story; latestVariables = variables;
                    baseline = { story: ready ? story : previous, variables: ready ? variables : baseline.variables, assets };
                    journal = next;
                    if (events.length) queueMicrotask(() => listeners.forEach(fn => fn(at(next, next.end))));
                } };
            });
        }).catch(error => { initializing = undefined; throw error; });
}
export function readStoryChanges(input: unknown): ChangePage {
    const { cursor, limit = 32 } = z.strictObject({ cursor: cursorSchema, limit: limitSchema }).parse(input);
    if (!journal) throw new PluginApiError('UNAVAILABLE', '当前无法读取本机存档日志');
    const start = journal.end - journal.events.length;
    const after = cursor === undefined ? start : cursor.startsWith(`${journal.epoch}:`) ? Number(cursor.slice(journal.epoch.length + 1)) : NaN;
    if (!Number.isSafeInteger(after) || after < start || after > journal.end) return { items: [], cursor: at(journal, journal.end), more: false, reset: true };
    const items = journal.events.slice(after - start, after - start + limit), next = after + items.length;
    return { items, cursor: at(journal, next), more: next < journal.end, reset: false };
}

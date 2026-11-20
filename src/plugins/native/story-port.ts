import type { MessageRef, RouteAddress, StoryMessage, StoryPage, StoryRef } from '../../../packages/plugin-sdk/index.js';
import type { ChatMessageNode } from '../../types';
import { swipeId } from '../../store/chat-tree';
import { contentHash } from '../../pipeline/content-hash';
import { summaryContentHash } from '../../pipeline/story-summary';
import type { PluginBucket, PluginBuckets } from './storage';
import { PluginApiError } from './errors';

export interface StoryView {
    ref: StoryRef | null;
    path: ChatMessageNode[];
    storage?: PluginBuckets;
    busy: boolean;
    readonly route?: RouteAddress | null;
}
export interface StoryCommit {
    view: StoryView;
    target?: MessageRef;
    pluginId: string;
    route?: { before?: PluginBucket; after: PluginBucket };
    reply?: { before?: PluginBucket; after: PluginBucket };
    check(): void;
    extras?: Record<string, unknown>;
    committed?(): void;
}
interface StoryPort {
    current(): StoryView;
    busy(): boolean;
    subscribe(listener: () => void): () => void;
    commit(input: StoryCommit): Promise<void>;
    buckets(pluginId: string): AsyncIterable<{ scope: 'route' | 'reply'; bucket: PluginBucket }>;
}
let port: StoryPort | undefined;
const noStory: StoryView = { ref: null, path: [], busy: false };
export function installNativeStoryPort(next: StoryPort) { port = next; }
export const liveStory = (): StoryView => port?.current() ?? noStory;
export const nativeStoryBusy = (): boolean => port?.busy() ?? false;
export const watchStory = (listener: () => void) => port?.subscribe(listener) ?? (() => {});
export const commitPluginStory = (input: StoryCommit) => port!.commit(input);
export const storyBucketsForPlugin = (id: string) => port!.buckets(id);

const messageCache = new WeakMap<ChatMessageNode, Map<number, MessageRef>>();
export function candidateRef(node: ChatMessageNode, index: number): MessageRef {
    let refs = messageCache.get(node);
    if (!refs) messageCache.set(node, refs = new Map());
    let ref = refs.get(index);
    if (!ref) {
        const candidate = node.swipes[index];
        const text = typeof candidate === 'string' ? candidate : candidate?.content ?? '';
        ref = { messageId: node.id, swipeId: swipeId(node, index), revision: `${contentHash(text).toString(36)}:${text.length}` };
        refs.set(index, ref);
    }
    return ref;
}
export function messageRef(node: ChatMessageNode): MessageRef {
    return candidateRef(node, node.activeSwipeIndex);
}
export const sameMessageIdentity = (a: MessageRef | null | undefined, b: MessageRef | null | undefined) =>
    a?.messageId === b?.messageId && a?.swipeId === b?.swipeId;
export const sameMessageRef = (a: MessageRef | null | undefined, b: MessageRef | null | undefined) => sameMessageIdentity(a, b) && a?.revision === b?.revision;
export const settled = (node: ChatMessageNode) => !node.extra?.tipsy_generation_incomplete && !node.extra?.tipsy_generation_terminal;
export function makeStoryTracker() {
    let routeId = '', serial = 0, lastChat = '', lastEpoch = 0, lastPath: ChatMessageNode[] = [], lastRef: StoryRef | null = null;
    return (chatId: string, epoch: number, path: ChatMessageNode[], storage: PluginBuckets | undefined, busy: boolean): StoryView => {
        if (lastPath !== path || chatId !== lastChat || epoch !== lastEpoch) {
            const first = path[0], previous = lastPath[0];
            const activation = chatId !== lastChat || epoch !== lastEpoch
                || !!first && (!previous || first.id !== previous.id || swipeId(first) !== swipeId(previous));
            if (activation || !routeId) routeId = crypto.randomUUID();
            if (activation || lastPath.length !== path.length || path.some((node, index) => {
                const prior = lastPath[index];
                return node !== prior && (!prior || !sameMessageRef(messageRef(node), messageRef(prior)) || node.role !== prior.role || node.speakerName !== prior.speakerName
                    || node.isHidden !== prior.isHidden || settled(node) !== settled(prior) || node.storySummaries !== prior.storySummaries);
            })) serial++;
            lastChat = chatId; lastEpoch = epoch; lastPath = path;
            lastRef = chatId ? { chatId, routeId, revision: String(serial), head: path.length ? messageRef(path.at(-1)!) : null } : null;
        }
        return { ref: lastRef, path, storage, busy };
    };
}

export function assertCurrentStory(expected: StoryView, current: StoryView, idle = true) {
    if (expected.ref?.chatId !== current.ref?.chatId || expected.ref?.routeId !== current.ref?.routeId || expected.ref?.revision !== current.ref?.revision) {
        throw new PluginApiError('STALE_ROUTE', '剧情已经改变，请在当前路线重新打开插件操作');
    }
    if (idle && current.busy) throw new PluginApiError('STORY_BUSY', '当前剧情正在生成或结算，稍后再试');
}
export function findStoryMessage(view: StoryView, ref: MessageRef) {
    const node = view.path.find(item => item.id === ref.messageId);
    return node && sameMessageRef(messageRef(node), ref) ? node : undefined;
}
export function replyBuckets(view: StoryView, ref: MessageRef | undefined): PluginBuckets | undefined {
    return ref ? findStoryMessage(view, ref)?.nativePluginReplies?.[ref.swipeId] : undefined;
}

export function toStoryMessage(node: ChatMessageNode): StoryMessage {
    const summary = node.storySummaries?.[swipeId(node)];
    const text = node.content.slice(0, 10_000);
    return { ref: messageRef(node), floor: node.floor, role: node.role, speaker: node.speakerName.slice(0, 100),
        text, truncated: node.content.length > text.length, createdAt: node.createdAt ?? 0, hidden: !!node.isHidden, settled: settled(node),
        summary: summary && summary.contentHash === summaryContentHash(node.content) ? summary.text.slice(0, 800) : undefined };
}
export function storyMessage(view: StoryView, ref: MessageRef): StoryMessage | null {
    const node = findStoryMessage(view, ref);
    return node && settled(node) ? toStoryMessage(node) : null;
}
export function storyPage(view: StoryView, before?: number, limit = 12): StoryPage {
    let end = Math.min(before ?? view.path.length, view.path.length);
    const messages: StoryMessage[] = [];
    while (end && messages.length < limit) {
        const node = view.path[--end];
        if (settled(node)) messages.push(toStoryMessage(node));
    }
    return { messages: messages.reverse(), nextBefore: end || null };
}

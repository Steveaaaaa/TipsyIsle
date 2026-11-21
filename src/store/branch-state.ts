import type { ArchivedChat } from './chat-archives';
import type { ChatMessageNode, LorebookTimedState } from '../types';
import type { TemplatePromptInjection } from '../pipeline/template-injections';
import type { ScopedBucketMap } from './scoped-variable-store';
import { remapRouteMessageData } from './route-message-data';

const pageSize = 32;
const emptyBucket: Record<string, unknown> = Object.freeze({});
const lastPagesByPath = new WeakMap<ChatMessageNode[], ScopedBucketMap[]>();

export function captureVariablePages(path: ChatMessageNode[], values: ScopedBucketMap, parent?: BranchState): ScopedBucketMap[] {
    const previous = lastPagesByPath.get(path) ?? parent?.messageVariablePages ?? [];
    const pages: ScopedBucketMap[] = [];
    for (let start = 0; start < path.length; start += pageSize) {
        const end = Math.min(start + pageSize, path.length);
        const page = previous[pages.length];
        let same = !!page && Object.keys(page).length === end - start;
        for (let index = start; same && index < end; index++) {
            const id = path[index].id;
            same = page[id] === (values[id] ?? emptyBucket);
        }
        if (same) pages.push(page);
        else {
            const entries: ScopedBucketMap = {};
            for (let index = start; index < end; index++) {
                const id = path[index].id;
                entries[id] = values[id] ?? emptyBucket;
            }
            pages.push(entries);
        }
    }
    lastPagesByPath.set(path, pages);
    return pages;
}

export function branchMessageVariables(point: BranchState): ScopedBucketMap {
    return point.messageVariablePages ? Object.assign({}, ...point.messageVariablePages) : point.continuation.variables.message;
}

export function branchMessageVariable(point: BranchState, id: string): Record<string, unknown> | undefined {
    if (!point.messageVariablePages) return point.continuation.variables.message[id];
    for (const page of point.messageVariablePages) if (Object.hasOwn(page, id)) return page[id];
}

export function createBranchVariableRemapper(ids: ReadonlyMap<string, string>) {
    const cache = new WeakMap<ScopedBucketMap, ScopedBucketMap>();
    const remap = (values: ScopedBucketMap) => {
        const cached = cache.get(values);
        if (cached) return cached;
        const result = Object.keys(values).some(id => ids.has(id))
            ? Object.fromEntries(Object.entries(values).map(([id, value]) => [ids.get(id) ?? id, value])) : values;
        cache.set(values, result);
        return result;
    };
    return (point: BranchState): BranchState => ({ ...point, messageVariablePages: point.messageVariablePages?.map(remap),
        continuation: { ...point.continuation, chatMetadata: remapRouteMessageData(point.continuation.chatMetadata, ids),
            variables: point.messageVariablePages ? point.continuation.variables : { ...point.continuation.variables, message: remap(point.continuation.variables.message) } } });
}

/** A settled reply's before-choice state and its latest resumable state. */
export interface BranchState {
    reply?: Pick<ChatMessageNode, 'content' | 'reasoning' | 'extra'> & { swipe: ChatMessageNode['swipes'][number] };
    worldbookName?: string | null;
    continuation: NonNullable<ArchivedChat['continuation']>;
    messageVariablePages?: ScopedBucketMap[];
    timedStates: Record<string, LorebookTimedState>;
    templateInjections: TemplatePromptInjection[];
    templateActivations: Array<{ world: string; uid: string | number; force: boolean }>;
}

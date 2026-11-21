import type { ChatMessageNode } from '../types';
import { routeMessages, routeMessageKey } from '../store/route-message-data';

export const baibaiRouteFields = ['bbs_leaf', 'bbs_hidden', 'bbs_omit', 'bbs_internal_notice'] as const;
export const baibaiRecallStorage = 'bbs_vec_recall_cache';
export const baibaiFallbackDatabase = 'bbs_vec_local';
export const baibaiBundles = 'bbs_bundles';
const notes = /<bbs_(items|vars)>[\s\S]*?<\/bbs_\1>/g;
export const baibaiBody = (text: string) => text.replace(notes, '').trimEnd();
export function isBaibaiNoteEdit(before: string, after: string): boolean {
    return before !== after && baibaiBody(before) === baibaiBody(after);
}

export const baibaiHash = (text: string) => {
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
    return (hash >>> 0).toString(16).padStart(8, '0');
};
type Leaf = { id?: string; swipe?: number; delta?: unknown; text?: string; seed?: boolean; timeStart?: string; timeEnd?: string; timeLabel?: string };
export function baibaiLeaf(extra: Record<string, unknown>, swipe: number): (Leaf & { id: string }) | undefined {
    const leaf = extra.bbs_leaf as Leaf | undefined;
    if (!extra.bbs_omit && leaf?.id && leaf.delta && (typeof leaf.swipe === 'number' ? leaf.swipe : 0) === swipe) return leaf as Leaf & { id: string };
}
export const baibaiForest = (metadata?: Record<string, unknown>) => (metadata?.baibai_book as { summaries?: Array<{ id: string; childIds?: string[] }> } | undefined);
export function baibaiSeedIds(metadata?: Record<string, unknown>) {
    const summaries = baibaiForest(metadata)?.summaries;
    return new Set(Array.isArray(summaries) ? summaries.flatMap(node => node?.id?.startsWith('sum_carry_') ? node.childIds ?? [] : []) : []);
}
export function baibaiBundleIds(metadata?: Record<string, unknown>): string[] {
    const values = metadata?.[baibaiBundles];
    return Array.isArray(values) ? [...new Set(values.filter((id): id is string => typeof id === 'string' && /^[0-9a-f]{32}$/.test(id)))].sort() : [];
}
export interface BaibaiIndexLeaf { docHash: string; payloadHash: string; msgIndex: number }
export function baibaiIndexLeaf(leaf: Leaf, content: string, msgIndex: number): BaibaiIndexLeaf | undefined {
    const text = typeof leaf.text === 'string' ? leaf.text.trim() : '';
    if (!text || leaf.seed) return;
    const trim = (value: unknown) => typeof value === 'string' ? value.trim() : '';
    const start = trim(leaf.timeStart), end = trim(leaf.timeEnd);
    const time = start && end && start !== end ? `${start} - ${end}` : start || end || trim(leaf.timeLabel);
    const body = content.replace(/<think(?:ing)?\b[\s\S]*?<\/think(?:ing)?>/gi, '');
    return { docHash: baibaiHash(text), payloadHash: baibaiHash(JSON.stringify([body, time])), msgIndex };
}

export function routeExtra(node: ChatMessageNode, extra: Record<string, unknown>, metadata?: Record<string, unknown>, swipe = node.activeSwipeIndex) {
    const override = routeMessages(metadata)?.[routeMessageKey(node, swipe)]?.extra;
    if (!override) return extra;
    const result = { ...extra };
    for (const key of baibaiRouteFields) {
        if (Object.hasOwn(override, key)) result[key] = override[key];
        else delete result[key];
    }
    return result;
}

export function pruneBaibaiSummaries(metadata: Record<string, unknown> | undefined, leaves: ReadonlySet<string>) {
    const memory = baibaiForest(metadata);
    if (!Array.isArray(memory?.summaries)) return metadata;
    const summaries = memory.summaries;
    const valid = new Set(leaves), remaining = new Map<string, number>(), parents = new Map<string, string[]>();
    for (const node of summaries) if (node?.childIds?.length && !valid.has(node.id)) {
        remaining.set(node.id, node.childIds.length);
        for (const child of node.childIds) {
            const pending = parents.get(child);
            if (pending) pending.push(node.id); else parents.set(child, [node.id]);
        }
    }
    // Set iteration visits newly validated parents without rescanning the forest.
    for (const id of valid) for (const parent of parents.get(id) ?? []) {
        const count = remaining.get(parent)! - 1;
        remaining.set(parent, count);
        if (!count) valid.add(parent);
    }
    const next = summaries.filter(node => node && valid.has(node.id));
    return summaries.length === next.length ? metadata : { ...metadata, baibai_book: { ...memory, summaries: next } };
}

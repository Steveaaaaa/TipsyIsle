import type { ChatMessageNode } from '../types';
import { swipeId } from './chat-tree';

export const routeMessageDataKey = 'tipsy_host_route_messages';
export interface RouteMessageData {
    extra?: Record<string, unknown>;
    content?: { base: string; value: string };
    memoryBody?: string;
}
type RouteMessageTable = Record<string, RouteMessageData>;

export function routeMessages(metadata?: Record<string, unknown>): RouteMessageTable | undefined {
    return metadata?.[routeMessageDataKey] as RouteMessageTable | undefined;
}
export const routeMessageKey = (node: ChatMessageNode, swipe = node.activeSwipeIndex) => JSON.stringify([node.id, swipeId(node, swipe)]);

export function routeContent(node: ChatMessageNode, metadata?: Record<string, unknown>): string {
    const entry = routeMessages(metadata)?.[routeMessageKey(node)]?.content;
    return entry?.base === node.content ? entry.value : node.content;
}

export function remapRouteMessageData(metadata: Record<string, unknown> | undefined, ids: ReadonlyMap<string, string>, swipes?: ReadonlyMap<string, string>, keepUnmapped = true) {
    const entries = routeMessages(metadata);
    if (!entries || !metadata) return metadata;
    return { ...metadata, [routeMessageDataKey]: Object.fromEntries(Object.entries(entries).flatMap(([key, value]) => {
        let pair: unknown;
        try { pair = JSON.parse(key); } catch { return []; }
        if (!Array.isArray(pair) || pair.length !== 2 || pair.some(part => typeof part !== 'string')) return [];
        const [id, swipe] = pair as [string, string];
        const next = ids.get(id) ?? (keepUnmapped ? id : undefined);
        return next === undefined ? [] : [[JSON.stringify([next, swipes?.get(swipe) ?? swipe]), value]];
    })) };
}

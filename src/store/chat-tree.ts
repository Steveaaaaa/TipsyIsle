import type { ChatMessageNode } from '../types';
import { isDraft } from 'immer';

export const swipeId = (node: ChatMessageNode, index = node.activeSwipeIndex): string => node.swipeIds?.[index] ?? `${node.id}:${index}`;
export const routeKey = (node: ChatMessageNode, index = node.activeSwipeIndex): string => `${node.id}@${swipeId(node, index)}`;
export function withSwipe(node: ChatMessageNode, index: number): ChatMessageNode {
    if (node.activeSwipeIndex === index) return node;
    const swipe = node.swipes[index];
    return { ...node, activeSwipeIndex: index, content: typeof swipe === 'string' ? swipe : swipe?.content ?? '',
        reasoning: typeof swipe === 'string' ? '' : swipe?.reasoning ?? '' };
}
export function branchExcerpt(content: string, limit = 140): string {
    return content.replace(/<(script|style|think|thinking|UpdateVariable)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
        .replace(/```[\s\S]*?```/g, '').replace(/<[^>]+>/g, ' ').replace(/<%[\s\S]*?%>/g, '')
        .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
        .replace(/\s+/g, ' ').trim().slice(0, limit);
}

const nodeIndexes = new WeakMap<ChatMessageNode[], Map<string, ChatMessageNode>>();
function nodeIndex(nodes: ChatMessageNode[]) {
    if (isDraft(nodes)) return new Map(nodes.map(node => [node.id, node]));
    let index = nodeIndexes.get(nodes);
    if (!index) {
        index = new Map(nodes.map(node => [node.id, node]));
        nodeIndexes.set(nodes, index);
    }
    return index;
}

export function activePath(nodes: ChatMessageNode[], leafId: string | null): ChatMessageNode[] {
    if (leafId === null) return [];
    const byId = nodeIndex(nodes);
    const path: ChatMessageNode[] = [];
    const seen = new Set<string>();
    let node = byId.get(leafId);
    while (node && !seen.has(node.id)) {
        seen.add(node.id);
        path.push(node);
        const parent = node.parentId ? byId.get(node.parentId) : undefined;
        const index = parent && parent.floor > 0 && node.parentSwipeId ? parent.swipes.findIndex((_, i) => swipeId(parent, i) === node!.parentSwipeId) : -1;
        node = parent && index >= 0 ? withSwipe(parent, index) : parent;
    }
    return path.reverse().map((node, floor) => node.floor === floor ? node : { ...node, floor });
}

export function branchOptions(nodes: ChatMessageNode[]): Array<{ id: string; label: string; depth: number }> {
    return storyRoutes(nodes).map((route, index) => ({ id: route.key, label: `路线 ${index + 1} · ${route.label}`, depth: route.depth }));
}

export interface StoryRoute { key: string; nodeId: string; swipe: number; label: string; depth: number; path: ChatMessageNode[] }
const routeCache = new WeakMap<ChatMessageNode[], StoryRoute[]>();
const pointCache = new WeakMap<ChatMessageNode[], Map<string, StoryRoute[]>>();
export function storyRoutes(nodes: ChatMessageNode[]): StoryRoute[] {
    const cached = routeCache.get(nodes); if (cached) return cached;
    const byId = nodeIndex(nodes);
    const continued = new Set(nodes.flatMap(node => {
        const parent = node.parentId && byId.get(node.parentId);
        return parent ? [`${parent.id}@${node.parentSwipeId ?? swipeId(parent)}`] : [];
    }));
    const result = nodes.flatMap(node => node.swipes.flatMap((_, index) => {
        if (node.floor === 0) return [];
        const key = routeKey(node, index);
        if (continued.has(key)) return [];
        const path = activePath(nodes, node.id);
        path[path.length - 1] = withSwipe({ ...node, floor: path.length - 1 }, index);
        return [{ key, nodeId: node.id, swipe: index, depth: path.length, path,
            label: node.branchLabel || branchExcerpt(path.at(-1)!.content) || '互动剧情' }];
    }));
    routeCache.set(nodes, result); return result;
}

export function routesAt(nodes: ChatMessageNode[], id: string): StoryRoute[] {
    const node = nodeIndex(nodes).get(id);
    if (!node || node.floor === 0) return [];
    const family = node.branchOrigin ?? node.id;
    let points = pointCache.get(nodes);
    if (!points) {
        points = new Map();
        for (const route of storyRoutes(nodes)) for (const key of new Set(route.path.map(item => item.branchOrigin ?? item.id))) {
            const list = points.get(key) ?? []; list.push(route); points.set(key, list);
        }
        pointCache.set(nodes, points);
    }
    return points.get(family) ?? [];
}

export interface StoryTreeBranch {
    key: string;
    messages: ChatMessageNode[];
    routes: StoryRoute[];
    endpoint?: StoryRoute;
    children: StoryTreeBranch[];
}

/** Display projection only: actions retain the real leaf/candidate identifiers. */
export function storyTree(routes: StoryRoute[]): StoryTreeBranch[] {
    interface Entry { key: string; message: ChatMessageNode; routes: StoryRoute[]; endpoint?: StoryRoute; children: Map<string, Entry> }
    const roots = new Map<string, Entry>();
    for (const route of routes) {
        let siblings = roots;
        for (const message of route.path) {
            const key = routeKey(message);
            let entry = siblings.get(key);
            if (!entry) { entry = { key, message, routes: [], children: new Map() }; siblings.set(key, entry); }
            entry.routes.push(route);
            if (key === route.key) entry.endpoint = route;
            siblings = entry.children;
        }
    }
    const compress = (entry: Entry): StoryTreeBranch => {
        const messages = [entry.message];
        let end = entry;
        while (!end.endpoint && end.children.size === 1) {
            const child = end.children.values().next().value!;
            messages.push(child.message); end = child;
        }
        return { key: entry.key, messages, routes: entry.routes, endpoint: end.endpoint, children: [...end.children.values()].map(compress) };
    };
    return [...roots.values()].map(compress);
}

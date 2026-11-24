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

export function removeChatTreeNode(nodes: ChatMessageNode[], target: ChatMessageNode): ChatMessageNode[] {
    const children = new Map<string, ChatMessageNode[]>();
    for (const node of nodes) {
        if (!node.parentId) continue;
        const siblings = children.get(node.parentId);
        if (siblings) siblings.push(node);
        else children.set(node.parentId, [node]);
    }
    const changed = new Map<string, ChatMessageNode>();
    const descendants: ChatMessageNode[] = (children.get(target.id) ?? []).map(node => ({ ...node, floor: target.floor,
        parentId: target.parentId, parentSwipeId: target.parentSwipeId }));
    for (let index = 0; index < descendants.length; index++) {
        const node = descendants[index];
        changed.set(node.id, node);
        for (const child of children.get(node.id) ?? []) descendants.push({ ...child, floor: node.floor + 1 });
    }
    return nodes.filter(node => node.id !== target.id).map(node => changed.get(node.id) ?? node);
}

export interface RemoveStoryBranchResult {
    nodes: ChatMessageNode[];
    removedNodeIds: string[];
    changed: boolean;
    affectedActive: boolean;
    fallbackRoute?: StoryRoute;
    fallbackLeafId: string | null;
}

const SWIPE_NUMERIC_EXTRA_KEYS = [
    'swipeVariables', 'swipeChatVariables', 'swipeTimedStates', 'swipeTemplateStates',
    'swipeHostMetadata', 'helperSwipeInfo', 'tipsy_template_source', 'tipsy_template_render',
    'tipsy_template_variables_initialized',
] as const;

export function removeStoryBranch(nodes: ChatMessageNode[], branchRootKey: string, currentLeafId: string | null): RemoveStoryBranchResult {
    let targetNode: ChatMessageNode | undefined;
    let targetSwipeIndex = -1;
    for (const node of nodes) {
        const index = node.swipes.findIndex((_, i) => routeKey(node, i) === branchRootKey);
        if (index >= 0) {
            targetNode = node;
            targetSwipeIndex = index;
            break;
        }
    }
    if (!targetNode || targetNode.floor === 0) {
        return { nodes, removedNodeIds: [], changed: false, affectedActive: false, fallbackLeafId: currentLeafId };
    }

    const targetSwipeId = swipeId(targetNode, targetSwipeIndex);
    const oldPath = activePath(nodes, currentLeafId);
    const affectedActive = oldPath.some(item => item.id === targetNode!.id && swipeId(item) === targetSwipeId);

    const removedSet = new Set<string>();
    for (const node of nodes) {
        if (node.parentId === targetNode.id && (node.parentSwipeId ?? swipeId(targetNode)) === targetSwipeId) {
            removedSet.add(node.id);
        }
    }
    for (let grew = true; grew;) {
        grew = false;
        for (const node of nodes) {
            if (node.parentId && removedSet.has(node.parentId) && !removedSet.has(node.id)) {
                removedSet.add(node.id);
                grew = true;
            }
        }
    }

    let nextNodes: ChatMessageNode[];
    if (targetNode.swipes.length <= 1) {
        removedSet.add(targetNode.id);
        nextNodes = nodes.filter(node => !removedSet.has(node.id));
    } else {
        const oldSwipeIds = targetNode.swipes.map((_, index) => swipeId(targetNode!, index));
        const nextSwipes = targetNode.swipes.filter((_, index) => index !== targetSwipeIndex);
        const nextSwipeIds = oldSwipeIds.filter((_, index) => index !== targetSwipeIndex);
        const omitKey = <T,>(record: Record<string, T> | undefined): Record<string, T> | undefined => {
            if (!record || !(targetSwipeId in record)) return record;
            const copy = { ...record };
            delete copy[targetSwipeId];
            return Object.keys(copy).length ? copy : undefined;
        };

        let nextExtra = targetNode.extra ? { ...targetNode.extra } : undefined;
        if (nextExtra) {
            for (const tableKey of SWIPE_NUMERIC_EXTRA_KEYS) {
                const table = nextExtra[tableKey];
                if (!table || typeof table !== 'object' || Array.isArray(table)) continue;
                const shifted: Record<string, unknown> = {};
                for (const [key, value] of Object.entries(table as Record<string, unknown>)) {
                    const num = Number(key);
                    if (Number.isInteger(num) && num >= 0 && String(num) === key) {
                        if (num === targetSwipeIndex) continue;
                        shifted[String(num > targetSwipeIndex ? num - 1 : num)] = value;
                    } else {
                        shifted[key] = value;
                    }
                }
                nextExtra[tableKey] = shifted;
            }
            const illustrations = nextExtra.tipsy_host_illustrations;
            if (illustrations && typeof illustrations === 'object' && !Array.isArray(illustrations) && targetSwipeId in illustrations) {
                const copy = { ...(illustrations as Record<string, unknown>) };
                delete copy[targetSwipeId];
                nextExtra.tipsy_host_illustrations = copy;
            }
        }

        const nextActiveIndex = targetNode.activeSwipeIndex === targetSwipeIndex
            ? Math.max(0, targetSwipeIndex - 1)
            : targetNode.activeSwipeIndex > targetSwipeIndex
                ? targetNode.activeSwipeIndex - 1
                : targetNode.activeSwipeIndex;
        const selectedSwipe = nextSwipes[nextActiveIndex];
        const updatedTarget: ChatMessageNode = {
            ...targetNode,
            swipes: nextSwipes,
            swipeIds: nextSwipeIds,
            activeSwipeIndex: nextActiveIndex,
            content: typeof selectedSwipe === 'string' ? selectedSwipe : selectedSwipe?.content ?? '',
            reasoning: typeof selectedSwipe === 'string' ? '' : selectedSwipe?.reasoning ?? '',
            branchStates: omitKey(targetNode.branchStates),
            branchBases: omitKey(targetNode.branchBases),
            storySummaries: omitKey(targetNode.storySummaries),
            nativePluginReplies: omitKey(targetNode.nativePluginReplies),
            nativeRouteAnchors: omitKey(targetNode.nativeRouteAnchors),
            extra: nextExtra,
        };
        nextNodes = nodes
            .filter(node => !removedSet.has(node.id))
            .map(node => node.id === targetNode!.id ? updatedTarget : node);
    }

    let fallbackRoute: StoryRoute | undefined;
    let fallbackLeafId: string | null = currentLeafId;
    if (affectedActive) {
        const remainingRoutes = storyRoutes(nextNodes);
        fallbackRoute = remainingRoutes.find(route => route.path.some(item => item.id === targetNode!.id))
            ?? remainingRoutes.find(route => route.path.some(item => item.id === targetNode!.parentId))
            ?? remainingRoutes[0];
        fallbackLeafId = fallbackRoute
            ? fallbackRoute.nodeId
            : nextNodes.find(node => node.id === targetNode!.parentId)?.id
                ?? nextNodes.find(node => node.floor === 0)?.id
                ?? nextNodes[0]?.id
                ?? null;
    }

    return {
        nodes: nextNodes,
        removedNodeIds: [...removedSet],
        changed: true,
        affectedActive,
        fallbackRoute,
        fallbackLeafId,
    };
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

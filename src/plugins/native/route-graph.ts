import type { RouteAddress, RouteInfo, StoryTreeRow } from '../../../packages/plugin-sdk/index.js';
import type { ChatMessageNode } from '../../types';
import { branchExcerpt, routeKey, swipeId, withSwipe } from '../../store/chat-tree';
import { messageRef, settled } from './story-port';

export interface RouteVertex {
    key: string;
    node: ChatMessageNode;
    index: number;
    parent?: RouteVertex;
    children: RouteVertex[];
    routeId: string;
    lineage: string;
    floor: number;
    continuation?: RouteVertex;
}
interface RouteGraph { vertices: Map<string, RouteVertex>; tips: Map<string, RouteVertex> }
const graphs = new WeakMap<ChatMessageNode[], RouteGraph>();
const byId = (a: RouteVertex, b: RouteVertex) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
export const routeRootId = (node: ChatMessageNode, index = node.activeSwipeIndex) => `route:${routeKey(node, node.floor === 0 ? 0 : index)}`;

/** Continuations inherit their route; alternate candidates and fork roots start their own. */
export function routeGraph(messages: ChatMessageNode[]): RouteGraph {
    const cached = graphs.get(messages);
    if (cached) return cached;
    const nodes = new Map(messages.map(node => [node.id, node]));
    const vertices = new Map<string, RouteVertex>(), tips = new Map<string, RouteVertex>();
    for (const node of messages) if (settled(node)) for (let index = 0; index < node.swipes.length; index++) {
        if (node.floor === 0 && index !== node.activeSwipeIndex) continue;
        const key = routeKey(node, index);
        vertices.set(key, { key, node, index, children: [], routeId: '', lineage: '', floor: 0 });
    }
    const roots: RouteVertex[] = [];
    for (const v of vertices.values()) {
        let child = v.node, parent = child.parentId ? nodes.get(child.parentId) : undefined;
        while (parent && !settled(parent)) { child = parent; parent = child.parentId ? nodes.get(child.parentId) : undefined; }
        v.parent = parent ? vertices.get(`${parent.id}@${parent.floor > 0 ? child.parentSwipeId ?? swipeId(parent) : swipeId(parent)}`) : undefined;
        if (v.parent) v.parent.children.push(v); else roots.push(v);
    }
    const queue = roots.sort(byId);
    for (let i = 0; i < queue.length; i++) {
        const v = queue[i];
        v.floor = v.parent ? v.parent.floor + 1 : 0;
        const inherited = v.parent?.continuation === v;
        const anchor = v.node.nativeRouteAnchors?.[swipeId(v.node, v.index)];
        v.lineage = anchor ?? (inherited ? v.parent!.lineage : routeRootId(v.node, v.index));
        const proposed = v.parent?.lineage === v.lineage ? v.parent.routeId : v.lineage;
        v.routeId = !tips.has(proposed) || tips.get(proposed) === v.parent ? proposed : `route:fork:${v.key}`;
        tips.set(v.routeId, v);
        v.children.sort(byId);
        v.continuation = v.children.find(child => child.index === 0 && !child.node.branchOrigin && !child.node.nativeRouteAnchors?.[swipeId(child.node, child.index)]);
        queue.push(...v.children);
    }
    const result = { vertices, tips };
    graphs.set(messages, result);
    return result;
}

export const vertexNode = (v: RouteVertex): ChatMessageNode => {
    const node = withSwipe(v.node, v.index);
    return node.floor === v.floor ? node : { ...node, floor: v.floor };
};
export function vertexPath(vertex: RouteVertex): ChatMessageNode[] {
    const path: ChatMessageNode[] = [];
    for (let v: RouteVertex | undefined = vertex; v; v = v.parent) path.push(vertexNode(v));
    return path.reverse();
}
export function activeAddress(chatId: string, messages: ChatMessageNode[], leaf: ChatMessageNode | undefined): RouteAddress | null {
    if (!chatId || !leaf) return null;
    const v = routeGraph(messages).vertices.get(routeKey(leaf));
    return v ? { chatId, routeId: v.routeId } : null;
}

export function continueNativeRoute(messages: ChatMessageNode[], path: ChatMessageNode[], node: ChatMessageNode, replacement?: string) {
    const graph = routeGraph(messages);
    let vertex: RouteVertex | undefined;
    for (let i = path.length - 1; i >= 0 && !vertex; i--) vertex = graph.vertices.get(routeKey(path[i]));
    // If a settled continuation already exists, playing from its ancestor forks.
    const route = replacement ?? (vertex && graph.tips.get(vertex.routeId) === vertex ? vertex.routeId : routeRootId(node));
    node.nativeRouteAnchors = { [swipeId(node)]: route };
    return route;
}
export const routeInfo = (chatId: string, tip: RouteVertex, leaf?: ChatMessageNode): RouteInfo => {
    const node = vertexNode(tip);
    return { chatId, routeId: tip.routeId, head: messageRef(node), depth: tip.floor + 1,
        label: (node.branchLabel ?? branchExcerpt(node.content, 100)) || '剧情路线', active: !!leaf && routeKey(leaf) === tip.key,
        checkpoint: !!node.branchStates?.[swipeId(node)] || node.floor === 0 && !!node.extra?.swipeVariables };
};
export const treeRow = (v: RouteVertex, tips: Map<string, RouteVertex>): StoryTreeRow => {
    const node = vertexNode(v);
    return { reply: messageRef(node), parent: v.parent ? messageRef(vertexNode(v.parent)) : null, floor: v.floor, role: node.role,
        label: node.branchLabel ?? branchExcerpt(node.content, 140), routes: tips.get(v.routeId) === v ? [v.routeId] : [] };
};

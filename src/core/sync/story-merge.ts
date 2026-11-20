import type { ArchivedChat } from '../../store/chat-archives';
import type { ChatMessageNode } from '../../types';
import { contentHash } from '../../pipeline/content-hash';
import { createBranchVariableRemapper } from '../../store/branch-state';
import { swipeId } from '../../store/chat-tree';
import { routeGraph, type RouteVertex } from '../../plugins/native/route-graph';

const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
export function openingPluginConflict(first: ArchivedChat, second: ArchivedChat): boolean {
    const opening = first.messages.length === 1 ? first : second.messages.length === 1 ? second : undefined;
    if (!opening) return false;
    const peer = opening === first ? second : first;
    const node = opening.messages[0], other = peer.messages.find(item => item.id === node.id);
    const key = swipeId(node);
    const route = opening.continuation?.nativePluginRoute ?? node.nativePluginOpeningRoutes?.[key];
    const peerRoute = other?.nativePluginOpeningRoutes?.[key] ?? (peer.messages.length === 1 ? peer.continuation?.nativePluginRoute : undefined);
    return canonical([route ?? {}, node.nativePluginReplies ?? {}]) !== canonical([peerRoute ?? {}, other?.nativePluginReplies ?? {}]);
}

/** Call only after author-visible data is known to match. Keep unchanged nodes
 * and their checkpoints shared with the currently open workspace. */
export function carryNativePluginState(local: ArchivedChat['messages'], remote: ArchivedChat['messages']): ArchivedChat['messages'] {
    let changed = false;
    const points = (a: ChatMessageNode['branchStates'], b: ChatMessageNode['branchStates']) => {
        let next = a;
        for (const [key, point] of Object.entries(a ?? {})) {
            const value = b?.[key]?.continuation.nativePluginRoute;
            if (canonical(point.continuation.nativePluginRoute) === canonical(value)) continue;
            if (next === a) next = { ...a };
            next![key] = { ...point, continuation: { ...point.continuation, nativePluginRoute: value } };
        }
        return next;
    };
    const nodes = local.map((node, index) => {
        const peer = remote[index];
        if (node === peer) return node;
        const branchStates = points(node.branchStates, peer.branchStates), branchBases = points(node.branchBases, peer.branchBases);
        const repliesMatch = canonical(node.nativePluginReplies) === canonical(peer.nativePluginReplies);
        const openingsMatch = canonical(node.nativePluginOpeningRoutes) === canonical(peer.nativePluginOpeningRoutes);
        const anchorsMatch = canonical(node.nativeRouteAnchors) === canonical(peer.nativeRouteAnchors);
        if (branchStates === node.branchStates && branchBases === node.branchBases && repliesMatch && openingsMatch && anchorsMatch) return node;
        changed = true;
        return { ...node, branchStates, branchBases,
            nativeRouteAnchors: anchorsMatch ? node.nativeRouteAnchors : peer.nativeRouteAnchors,
            nativePluginReplies: repliesMatch ? node.nativePluginReplies : peer.nativePluginReplies,
            nativePluginOpeningRoutes: openingsMatch ? node.nativePluginOpeningRoutes : peer.nativePluginOpeningRoutes };
    });
    return changed ? nodes : local;
}
function storyIdentity(node: ChatMessageNode) {
    const { content, reasoning, activeSwipeIndex, updatedAt, floor, tokenCount, extra, swipeIds, nativeRouteAnchors, ...rest } = node;
    const state = { ...extra };
    if (state.swipeChatVariables) delete state.chatVariables;
    if (state.swipeTimedStates) delete state.timedStates;
    if (state.swipeTemplateStates) delete state.templateState;
    return canonical({ ...rest, swipeIds: swipeIds ?? node.swipes.map((_, index) => `${node.id}:${index}`), extra: state });
}
/** Same-run concurrent continuations share unchanged nodes; changed states become siblings. */
export function mergeStoryChats(primary: ArchivedChat, other: ArchivedChat, version: string): ArchivedChat {
    const result = structuredClone(primary);
    const left = new Map(result.messages.map(node => [node.id, node]));
    const remap = new Map<string, string>();
    const suffix = `~route-${contentHash(version).toString(36)}`;
    for (const node of other.messages) {
        const existing = left.get(node.id);
        if (existing && storyIdentity(existing) !== storyIdentity(node)) remap.set(node.id, node.id + suffix);
    }
    const peerLeaf = other.messages.find(node => node.id === other.activeLeafId);
    const localLeaf = left.get(primary.activeLeafId ?? '');
    const comparable = (chat: ArchivedChat) => [chat.continuation?.chatMetadata ?? {}, chat.continuation?.nativePluginRoute ?? {}];
    const alternateMetadata = peerLeaf && localLeaf?.id === peerLeaf.id && swipeId(localLeaf) === swipeId(peerLeaf) && peerLeaf.floor > 0
        && canonical(comparable(primary)) !== canonical(comparable(other));
    if (alternateMetadata) remap.set(peerLeaf.id, peerLeaf.id + suffix);
    // A shared descendant must follow the correct version of its changed ancestor.
    let changed = true;
    while (changed) {
        changed = false;
        for (const node of other.messages) if (node.parentId && remap.has(node.parentId) && left.has(node.id) && !remap.has(node.id)) {
            remap.set(node.id, node.id + suffix); changed = true;
        }
    }
    const incoming = structuredClone(other);
    const mainRoutes = routeGraph(primary.messages), peerRoutes = routeGraph(other.messages);
    const mapped = (v: RouteVertex) => `${remap.get(v.node.id) ?? v.node.id}@${swipeId(v.node, v.index)}`;
    const primaryAnchors = new Map<string, Record<string, string>>();
    const routeIds = new Map<string, string>();
    const path = (end: RouteVertex) => {
        const rows: RouteVertex[] = [];
        for (let v: RouteVertex | undefined = end; v; v = v.parent) rows.push(v);
        return rows.reverse();
    };
    for (const [id, tip] of peerRoutes.tips) {
        const main = mainRoutes.tips.get(id);
        if (!main || main.key === mapped(tip)) continue;
        const mainPath = path(main), peerPath = path(tip);
        let split = 0;
        while (mainPath[split] && peerPath[split] && mainPath[split].key === mapped(peerPath[split])) split++;
        if (split === mainPath.length || split === peerPath.length) continue;
        // Keep a saved address on the shared prefix. Neither device's later
        // continuation may take over an address that both devices already use.
        const mainId = `route:fork:${mainPath[split].key}`;
        routeIds.set(id, `route:fork:${mapped(peerPath[split])}`);
        for (const v of mainPath.slice(split)) if (v.routeId === id) {
            const ids = primaryAnchors.get(v.node.id) ?? {};
            ids[swipeId(v.node, v.index)] = mainId; primaryAnchors.set(v.node.id, ids);
        }
    }
    for (const [nodeId, anchors] of primaryAnchors) {
        const node = left.get(nodeId)!;
        node.nativeRouteAnchors = { ...node.nativeRouteAnchors, ...anchors };
    }
    const anchors = new Map<string, Record<string, string>>();
    for (const vertex of peerRoutes.vertices.values()) if (!mainRoutes.vertices.has(mapped(vertex))) {
        const ids = anchors.get(vertex.node.id) ?? {};
        ids[swipeId(vertex.node, vertex.index)] = routeIds.get(vertex.routeId) ?? vertex.routeId;
        anchors.set(vertex.node.id, ids);
    }
    const remapPoint = createBranchVariableRemapper(remap);
    for (const node of incoming.messages) {
        const previousId = node.id;
        node.id = remap.get(node.id) ?? node.id; node.messageId = node.id;
        if (node.id !== previousId) { node.branchOrigin ??= previousId; node.branchLabel ??= other.syncLabel ?? '另一台设备的路线'; }
        if (node.parentId) {
            const previousParent = node.parentId;
            node.parentId = remap.get(previousParent) ?? previousParent;
            const parent = other.messages.find(item => item.id === previousParent);
            node.parentSwipeId ??= parent?.swipeIds?.[parent.activeSwipeIndex] ?? (parent ? `${parent.id}:${parent.activeSwipeIndex}` : undefined);
        }
        node.swipeIds ??= node.swipes.map((_, index) => `${previousId}:${index}`);
        if (anchors.has(previousId)) node.nativeRouteAnchors = anchors.get(previousId);
        for (const field of ['branchBases', 'branchStates'] as const) if (node[field]) {
            node[field] = Object.fromEntries(Object.entries(node[field]!).map(([key, point]) => [key, remapPoint(point)]));
        }
        if (alternateMetadata && previousId === other.activeLeafId && incoming.continuation) {
            const key = swipeId(node);
            const point = node.branchStates?.[key];
            (node.branchStates ??= {})[key] = point ? { ...point, continuation: { ...point.continuation, chatMetadata: incoming.continuation.chatMetadata,
                nativePluginRoute: incoming.continuation.nativePluginRoute } }
                : remapPoint({ continuation: incoming.continuation, timedStates: incoming.timedStates,
                    templateInjections: incoming.templateInjections ?? [], templateActivations: incoming.templateActivations ?? [] });
        }
        if (!left.has(node.id)) left.set(node.id, node);
    }
    result.deletedMessageIds = [...new Set([...primary.deletedMessageIds ?? [], ...other.deletedMessageIds ?? []])].sort();
    result.messages = [...left.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    if (result.continuation && incoming.continuation) {
        for (const [key, value] of Object.entries(incoming.continuation.variables.message)) {
            const id = remap.get(key) ?? key;
            result.continuation.variables.message[id] ??= value;
        }
    }
    return result;
}

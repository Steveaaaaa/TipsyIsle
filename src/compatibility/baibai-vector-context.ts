import { getActiveChatMessages } from '../store/workspace/queries';
import { workspaceStore, type WorkspaceState } from '../store/workspace/state';
import { routeContent, routeMessageKey, routeMessages } from '../store/route-message-data';
import { settled } from '../plugins/native/story-port';
import { baibaiBody, baibaiBundleIds, baibaiHash, baibaiIndexLeaf, baibaiLeaf, baibaiSeedIds, type BaibaiIndexLeaf } from './baibai-route';
import { messageExtra } from './chat-message-codec';
import { compatibilityRouteAddress, compatibilityRouteIsReplacing } from './route-address';

let cached: { path: ReturnType<typeof getActiveChatMessages>; metadata: WorkspaceState['chatMetadata']; leaves: Record<string, BaibaiIndexLeaf> } | undefined;
function indexView(state: WorkspaceState) {
    const path = getActiveChatMessages(state), metadata = state.chatMetadata;
    if (cached?.path === path && cached.metadata === metadata) return cached;
    const seeds = baibaiSeedIds(metadata), entries = routeMessages(metadata);
    const leaves: Array<[string, BaibaiIndexLeaf]> = [];
    for (const [index, node] of path.entries()) {
        if (!settled(node)) continue;
        const leaf = baibaiLeaf(messageExtra(node, node.activeSwipeIndex, metadata), node.activeSwipeIndex);
        if (!leaf || seeds.has(leaf.id)) continue;
        const content = routeContent(node, metadata), base = entries?.[routeMessageKey(node)]?.memoryBody;
        if (base !== undefined && base !== baibaiHash(baibaiBody(content))) continue;
        const row = baibaiIndexLeaf(leaf, content, index);
        if (row) leaves.push([leaf.id, row]);
    }
    return cached = { path, metadata, leaves: Object.fromEntries(leaves) };
}

export function captureBaibaiVectorContext() {
    const state = workspaceStore.getState(), address = compatibilityRouteAddress(state);
    const view = indexView(state);
    const replacing = compatibilityRouteIsReplacing(address);
    return {
        ...address, characterId: state.activeCharacterId, replacing,
        leaves: view.leaves, bundles: baibaiBundleIds(state.chatMetadata),
        valid: () => {
            const next = workspaceStore.getState(), current = compatibilityRouteAddress(next);
            return !!address.chatId && next.sessionKind !== 'free' && next.activeCharacterId === state.activeCharacterId
                && current.chatId === address.chatId && current.routeId === address.routeId && current.branchEpoch === address.branchEpoch
                && compatibilityRouteIsReplacing(current) === replacing && indexView(next) === view;
        },
    };
}
export type BaibaiVectorContext = ReturnType<typeof captureBaibaiVectorContext>;

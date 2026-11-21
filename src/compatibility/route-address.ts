import { activeAddress } from '../plugins/native/route-graph';
import { settled } from '../plugins/native/story-port';
import { getActiveChatMessages } from '../store/workspace/queries';
import { workspaceStore, type WorkspaceState } from '../store/workspace/state';

export interface CompatibilityRouteAddress { chatId: string; routeId: string; branchEpoch: number }
let replacement: CompatibilityRouteAddress | undefined;

export const compatibilityRouteIsReplacingState = (state: WorkspaceState) =>
    replacement?.chatId === state.activeChatId && replacement.branchEpoch === (state.branchEpoch ?? 0);

export function compatibilityRouteAddress(state: WorkspaceState = workspaceStore.getState()): CompatibilityRouteAddress {
    const chatId = state.activeChatId, branchEpoch = state.branchEpoch ?? 0;
    if (replacement?.chatId === chatId && replacement.branchEpoch === branchEpoch) return replacement;
    const path = getActiveChatMessages(state);
    let tail = path.length - 1;
    while (tail >= 0 && !settled(path[tail])) tail--;
    const route = activeAddress(chatId, state.messages, path[tail]);
    const root = activeAddress(chatId, state.messages, path[0]);
    return { chatId, branchEpoch, routeId: !route || route.routeId === root?.routeId ? 'opening' : route.routeId };
}

export function holdCompatibilityRoute(address: CompatibilityRouteAddress) {
    replacement = address;
    return () => { if (replacement === address) replacement = undefined; };
}

export const compatibilityRouteIsReplacing = (address: CompatibilityRouteAddress) => replacement === address;

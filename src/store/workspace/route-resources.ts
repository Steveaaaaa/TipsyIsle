import { swipeId } from '../chat-tree';
import type { PluginBuckets } from '../../plugins/native/storage';
import type { ChatMessageNode, NormalizedLorebook } from '../../types';
import type { WorkspaceState } from './state';

export function routePluginBucketsAt(path: ChatMessageNode[]): PluginBuckets | undefined {
    for (let index = path.length - 1; index >= 0; index--) {
        const node = path[index], key = swipeId(node);
        const point = node.branchStates?.[key];
        if (point) return point.continuation.nativePluginRoute;
        if (node.floor === 0) return node.nativePluginOpeningRoutes?.[key];
    }
}

export function routeWorldbooks(books: NormalizedLorebook[] | undefined, state: WorkspaceState) {
    const global = new Set(state.activeLorebookIds);
    const library = new Map([...state.characters.flatMap(card => [card.characterBook, card.embeddedLorebook].flatMap(book => book ?? [])),
        ...state.lorebooks].filter(book => global.has(book.id)).map(book => [book.id, book]));
    // Keep the branch's own resources but let today's global books come from the library.
    return books?.filter(book => !library.has(book.id));
}

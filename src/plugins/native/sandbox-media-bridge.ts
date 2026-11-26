import { createReactiveStore } from '../../store/reactive-store';

export interface SandboxFrameMediaEntry {
    messageId: string;
    keys: string[];
}

export const sandboxMediaStore = createReactiveStore<{
    byFrame: Record<string, SandboxFrameMediaEntry>;
}>(() => ({ byFrame: {} }));

export function setSandboxMountedMedia(messageId: string, frameId: string, keys: string[]): void {
    const normalized = [...new Set(keys.filter(Boolean))];
    sandboxMediaStore.setState((draft) => {
        if (!normalized.length) {
            delete draft.byFrame[frameId];
            return;
        }
        draft.byFrame[frameId] = { messageId, keys: normalized };
    });
}

export function clearSandboxMountedMedia(frameId: string): void {
    sandboxMediaStore.setState((draft) => {
        delete draft.byFrame[frameId];
    });
}

export function getSandboxMountedKeys(
    byFrame: Record<string, SandboxFrameMediaEntry>,
    messageId: string,
): Set<string> {
    const mounted = new Set<string>();
    for (const entry of Object.values(byFrame)) {
        if (entry.messageId !== messageId) continue;
        for (const key of entry.keys) mounted.add(key);
    }
    return mounted;
}

// Runtime readiness and human activity are independent of script-driven writes.
let runtimeLoading = true;
let lastInteraction = 0;
let playing = false;
const assetEditors = new Set<symbol>();
export const SYNC_QUIET_MS = 8000;
export function setStoryRuntimeLoading(loading: boolean) {
    const changed = runtimeLoading !== loading;
    runtimeLoading = loading;
    if (changed && !loading) queueMicrotask(() => { if (!runtimeLoading) window.dispatchEvent(new Event('tipsy-sync-runtime-ready')); });
}
export function beginSyncAssetEdit(): () => void {
    const editor = Symbol(); assetEditors.add(editor);
    return () => {
        if (assetEditors.delete(editor) && !assetEditors.size) window.dispatchEvent(new Event('tipsy-sync-edits-finished'));
    };
}
export function syncAssetsEditing() { return assetEditors.size > 0; }
export function noteSyncInteraction() { lastInteraction = Date.now(); playing = true; }
export function beginDeviceVisit() { playing = false; lastInteraction = 0; }
export function syncRuntimeReady() { return !runtimeLoading; }
export function syncIsQuiet() { return !runtimeLoading && (document.hidden || Date.now() - lastInteraction >= SYNC_QUIET_MS); }
export function canResumeRemoteStory() { return !playing; }
export async function waitForSyncQuiet(immediate: () => boolean = () => false) {
    while (!syncRuntimeReady() || !syncIsQuiet() && !immediate()) await new Promise<void>(resolve => setTimeout(resolve, 500));
}
if (typeof window !== 'undefined') {
    for (const event of ['pointerdown', 'keydown', 'input', 'wheel']) window.addEventListener(event, value => {
        if (value.isTrusted) noteSyncInteraction();
    }, { capture: true, passive: true });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) beginDeviceVisit(); });
}

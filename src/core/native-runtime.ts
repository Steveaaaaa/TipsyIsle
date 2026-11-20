/** Installed clients own an embedded author host; web keeps its existing service. */
export let compatibilityOrigin = 'http://127.0.0.1:5181';
export let nativeAppUpdates = false;
let initialization: Promise<void> | undefined;
export function isNativeRuntime(): boolean {
    return typeof window !== 'undefined' && !!window.__TAURI_INTERNALS__?.invoke;
}
export function initializeNativeRuntime(): Promise<void> {
    if (!isNativeRuntime()) return Promise.resolve();
    return initialization ??= window.__TAURI_INTERNALS__!.invoke<{ compatibilityOrigin: string; appUpdates?: boolean }>('tipsy_runtime_info')
        .then(info => { compatibilityOrigin = info.compatibilityOrigin; nativeAppUpdates = info.appUpdates === true; document.documentElement.dataset.native = 'true'; })
        .catch(error => { initialization = undefined; throw error; });
}
/** Keep the existing streaming parser and cancellation semantics across platforms. */
export async function platformFetch(input: string, init?: RequestInit): Promise<Response> {
    if (!isNativeRuntime()) return fetch(input, init);
    const native = await import('@tauri-apps/plugin-http');
    return native.fetch(input, init);
}

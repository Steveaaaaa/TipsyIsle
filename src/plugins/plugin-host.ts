import type { PipelineHookName } from '../types';

export type PipelineHookHandler<T = any> = (payload: T) => T | Promise<T>;

const hooks = new Map<PipelineHookName, Set<PipelineHookHandler>>();

export function registerPluginHook<T = any>(hookName: PipelineHookName, handler: PipelineHookHandler<T>): () => void {
    let set = hooks.get(hookName);
    if (!set) {
        set = new Set();
        hooks.set(hookName, set);
    }
    set.add(handler);
    return () => {
        set?.delete(handler);
    };
}

export async function executePluginHooks<T = any>(hookName: PipelineHookName, initialPayload: T): Promise<T> {
    const set = hooks.get(hookName);
    if (!set || set.size === 0) return initialPayload;
    let current = initialPayload;
    for (const fn of [...set]) {
        try {
            current = await fn(current);
        } catch (err) {
            console.warn(`[TipsyIsle PluginHost] Hook error on ${hookName}:`, err);
        }
    }
    return current;
}

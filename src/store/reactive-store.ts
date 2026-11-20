import { useSyncExternalStore } from 'react';
import { current, Immer, isDraft } from 'immer';

// Preserve the existing mutable-draft API while keeping previous nested snapshots
// intact. Avoid freezing plugin-owned function/configuration objects on insertion.
const immutable = new Immer({ autoFreeze: false });
let batchDepth = 0;
let mutedDepth = 0;
const batchNotifications = new Map<object, () => void>();
/** Build a synchronous candidate without exposing intermediate values to subscribers. */
export function withoutStoreNotifications<T>(run: () => T): T {
    mutedDepth++;
    try { return run(); } finally { mutedDepth--; }
}
/** Synchronous multi-store publication. Subscribers observe complete related state. */
export function batchReactiveUpdates<T>(run: () => T): T {
    batchDepth++;
    try { return run(); }
    finally {
        batchDepth--;
        if (!batchDepth) {
            const notifications = [...batchNotifications.values()]; batchNotifications.clear();
            for (const notify of notifications) notify();
        }
    }
}
export function cloneStateValue<T>(value: T): T { return structuredClone(isDraft(value) ? current(value as any) : value); }

export type StateListener<S> = (state: S, prevState: S) => void;
export type StateUpdater<S> = Partial<S> | ((draft: S) => Partial<S> | void);

export interface ReactiveStore<S extends object> {
    getState: () => S;
    setState: (updater: StateUpdater<S>) => void;
    subscribe: (listener: StateListener<S>) => () => void;
    holdWrites: () => () => () => number;
    useStore: <T = S>(selector?: (state: S) => T) => T;
}

export function createReactiveStore<S extends object>(initialCreator: (set: (updater: StateUpdater<S>) => void, get: () => S) => S): ReactiveStore<S> {
    let state: S;
    const listeners = new Set<StateListener<S>>();
    let heldWrites: StateUpdater<S>[] | undefined;

    const getState = (): S => state;

    const setState = (updater: StateUpdater<S>): void => {
        if (heldWrites) { heldWrites.push(updater); return; }
        const prevState = state;
        let nextState: S;
        if (typeof updater === 'function') {
            nextState = immutable.produce(prevState, draft => {
                const result = updater(draft as S);
                if (result && typeof result === 'object') Object.assign(draft, result);
            });
        } else {
            nextState = { ...prevState, ...updater };
        }
        if (Object.is(nextState, prevState)) {
            return;
        }
        state = nextState;
        if (mutedDepth) return;
        const notify = () => { for (const listener of listeners) listener(state, prevState); };
        if (batchDepth) { if (!batchNotifications.has(listeners)) batchNotifications.set(listeners, notify); }
        else notify();
    };

    state = initialCreator(setState, getState);

    const subscribe = (listener: StateListener<S>): (() => void) => {
        listeners.add(listener);
        return () => {
            listeners.delete(listener);
        };
    };

    const useStore = <T = S>(selector?: (s: S) => T): T => {
        const select = selector ?? ((s: S) => s as unknown as T);
        return useSyncExternalStore(
            subscribe,
            () => select(state),
            () => select(state),
        );
    };

    return {
        holdWrites: () => {
            heldWrites = [];
            return () => { const updates = heldWrites!; heldWrites = undefined; return () => { updates.forEach(setState); return updates.length; }; };
        },
        getState,
        setState,
        subscribe,
        useStore,
    };
}

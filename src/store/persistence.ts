import { platformStorage } from '../core/platform-bridge';

const sources = new Map<string, () => unknown>();
const savedSources = new Map<string, unknown>();
let pending: Promise<void> | undefined;
let suspended = 0;
let dirty = false;
let operationQueue: Promise<unknown> = Promise.resolve();
let replicaCommit: Promise<void> | undefined;
export function waitForReplicaCommit(): Promise<void> { return replicaCommit ?? Promise.resolve(); }
export function holdReplicaCommit(): () => void {
    let release!: () => void;
    replicaCommit = new Promise<void>(resolve => { release = resolve; });
    return () => { replicaCommit = undefined; release(); };
}
interface SaveWaiter { resolve(): void; reject(error: unknown): void }
let activePublication: { publishing: boolean; own: SaveWaiter[]; later: SaveWaiter[] } | undefined;

export function registerSnapshotSource(collection: string, read: () => unknown): void { sources.set(collection, read); }
export function registeredSnapshots(): Record<string, unknown> { return Object.fromEntries([...sources].map(([key, read]) => [key, read()])); }
export function acknowledgeSnapshots(snapshots: Record<string, unknown>): void {
    for (const [key, value] of Object.entries(snapshots)) if (sources.has(key)) savedSources.set(key, value);
}

function changedSnapshots(): Record<string, unknown> {
    return Object.fromEntries([...sources].flatMap(([key, read]) => {
        const value = read();
        const previous = savedSources.get(key);
        const same = value === previous || !!value && !!previous && typeof value === 'object' && typeof previous === 'object'
            && Object.keys(value).length === Object.keys(previous).length
            && Object.entries(value).every(([field, item]) => Object.hasOwn(previous, field) && (previous as Record<string, unknown>)[field] === item);
        return same ? [] : [[key, value]];
    }));
}
async function saveChangedSnapshots(extra: Record<string, unknown> = {}, track = true): Promise<Record<string, unknown>> {
    const snapshots = { ...changedSnapshots(), ...extra };
    await platformStorage.saveSnapshots(snapshots, track);
    for (const [key, value] of Object.entries(snapshots)) savedSources.set(key, value);
    return snapshots;
}

/** Keep dependent durable operations ordered while preserving rejection to callers. */
export function enqueuePersistentOperation<T>(run: () => Promise<T>): Promise<T> {
    const task = operationQueue.then(run);
    operationQueue = task.catch(() => {});
    return task;
}

/** Hold coalesced saves until the operation is durable or its memory rollback is
 * published. Saves requested during IO are sampled again after the outcome. */
export async function persistStateTransaction(publish: () => void, rollback: () => void, replica?: {
    snapshots: Record<string, unknown>; committed: (snapshots: Record<string, unknown>) => void;
}, localExtras?: Record<string, unknown>): Promise<void> {
    if (pending) await pending;
    if (suspended) throw new Error('工作区仍在恢复数据，暂不能提交状态事务');
    const publication = { publishing: true, own: [] as SaveWaiter[], later: [] as SaveWaiter[] };
    activePublication = publication;
    suspended++;
    try {
        publish();
        publication.publishing = false;
        dirty = false;
        const snapshots = await saveChangedSnapshots(replica?.snapshots ?? localExtras, !replica);
        replica?.committed(snapshots);
        publication.own.forEach(waiter => waiter.resolve());
    } catch (error) {
        try { rollback(); } finally { publication.own.forEach(waiter => waiter.reject(error)); }
        throw error;
    } finally {
        suspended--; activePublication = undefined;
        if (!suspended && (dirty || publication.later.length)) {
            dirty = false;
            void persistRegisteredSnapshots().then(() => publication.later.forEach(waiter => waiter.resolve()), error => {
                publication.later.forEach(waiter => waiter.reject(error));
                console.error('后续状态保存失败', error);
                globalThis.dispatchEvent?.(new CustomEvent('tipsy-storage-error', { detail: '后续状态保存失败，请检查存储连接。' }));
            });
        }
    }
}

/** Hydration must finish for every registered collection before a migration can save. */
export function suspendRegisteredPersistence(): (commit: boolean) => Promise<void> {
    suspended++;
    let released = false;
    return async commit => {
        if (released) return;
        released = true; suspended--;
        if (!commit) dirty = false;
        if (!suspended && dirty) { dirty = false; await persistRegisteredSnapshots(); }
    };
}

/** Coalesce synchronous workspace/variable updates; sample all sources together. */
export function persistRegisteredSnapshots(): Promise<void> {
    if (suspended) {
        dirty = true;
        if (activePublication) {
            const list = activePublication.publishing ? activePublication.own : activePublication.later;
            return new Promise<void>((resolve, reject) => list.push({ resolve, reject }));
        }
        return Promise.resolve();
    }
    if (pending) { dirty = true; return pending; }
    const task = Promise.resolve().then(async () => {
        do {
            dirty = false;
            await saveChangedSnapshots();
        } while (dirty);
    }).finally(() => { pending = undefined; });
    pending = task;
    return task;
}

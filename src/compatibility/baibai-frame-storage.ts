import { baibaiBundleIds, baibaiFallbackDatabase, baibaiHash, baibaiIndexLeaf, baibaiLeaf, baibaiRecallStorage } from './baibai-route';

interface MemoryRow { extra?: Record<string, unknown>; swipe_id?: number; mes?: string; is_system?: boolean }
interface View { route: string; rows: MemoryRow[]; metadata: Record<string, unknown>; fallbackBlocked: boolean }
const cacheKey = 'tipsy:bbs:recall:v2';
const limit = 12;
type Cache = Record<string, { revision: string; value: string }>;

function revision(view: View) {
    const leaves = view.rows.flatMap((row, floor) => {
        const extra = row.extra ?? {}, leaf = baibaiLeaf(extra, row.swipe_id ?? 0);
        const index = leaf && baibaiIndexLeaf(leaf, row.mes ?? '', floor);
        return leaf ? [[leaf.id, index?.docHash, index?.payloadHash, floor, !!row.is_system, extra.bbs_hidden, leaf.delta]] : [];
    });
    return baibaiHash(JSON.stringify([leaves, view.rows.flatMap((row, index) => row.is_system || row.extra?.bbs_omit ? [index] : []),
        view.metadata.baibai_book, baibaiBundleIds(view.metadata)]));
}

/** Retain the plugin's original storage APIs, changing only its two known names. */
export function installBaibaiFrameStorage(readView: () => View | undefined, diagnostic: (error: unknown) => void) {
    let address: string | undefined;
    let lastRead: string | undefined;
    let disabled = false;
    let source: 'host' | 'local' | undefined;
    const opened = new Set<IDBDatabase>();
    const block = () => { disabled = true; for (const db of opened) db.close(); opened.clear(); };
    window.addEventListener('pagehide', block, { once: true });
    const current = () => {
        const view = readView();
        return !disabled && view && view.route === address ? view : undefined;
    };
    const versionFor = (view: View) => `${source ?? ''}:${revision(view)}`;
    try {
        const storage = window.localStorage, proto = Storage.prototype;
        const { getItem, setItem, removeItem } = proto;
        const read = (): Cache => JSON.parse(getItem.call(storage, cacheKey) ?? '{}') as Cache;
        proto.getItem = function(key) {
            if (this !== storage || key !== baibaiRecallStorage) return getItem.call(this, key);
            try {
                const view = current();
                lastRead = view && versionFor(view);
                const hit = view && read()[view.route];
                return source && view && hit && (!view.fallbackBlocked || source === 'host') && hit.revision === lastRead ? hit.value : null;
            } catch { return null; }
        };
        proto.setItem = function(key, value) {
            if (this !== storage || key !== baibaiRecallStorage) return setItem.call(this, key, value);
            try {
                const view = current();
                if (!view || !source || value.length > 350_000) return;
                const version = versionFor(view);
                if (lastRead !== version) return;
                const cache = read();
                delete cache[view.route];
                cache[view.route] = { revision: version, value };
                for (const key of Object.keys(cache).slice(0, -limit)) delete cache[key];
                setItem.call(storage, cacheKey, JSON.stringify(cache));
            } catch { /* Recall still works without a persistent cache. */ }
        };
        proto.removeItem = function(key) {
            if (this !== storage || key !== baibaiRecallStorage) return removeItem.call(this, key);
            const view = current();
            if (view) try {
                const cache = read();
                if (Object.hasOwn(cache, view.route)) { delete cache[view.route]; setItem.call(storage, cacheKey, JSON.stringify(cache)); }
            } catch { /* Storage unavailable. */ }
        };
        try { removeItem.call(storage, baibaiRecallStorage); } catch { /* Storage unavailable. */ }
    } catch (error) { diagnostic(error); }
    // Patch open first so even a later hook failure cannot expose the old database.
    try {
        const proto = IDBFactory.prototype, { open, deleteDatabase } = proto;
        const nameFor = () => {
            const view = current();
            if (!view || view.fallbackBlocked) throw new Error('当前剧情状态不使用本地向量索引');
            return `${baibaiFallbackDatabase}:v2:${address}`;
        };
        proto.open = function(name, version) {
            if (name !== baibaiFallbackDatabase) return version === undefined ? open.call(this, name) : open.call(this, name, version);
            const mapped = nameFor();
            const request = version === undefined ? open.call(this, mapped) : open.call(this, mapped, version);
            request.addEventListener('success', () => { if (!current()) request.result.close(); else opened.add(request.result); }, { once: true });
            return request;
        };
        proto.deleteDatabase = function(name) { return deleteDatabase.call(this, name === baibaiFallbackDatabase ? nameFor() : name); };
        const transaction = IDBDatabase.prototype.transaction;
        IDBDatabase.prototype.transaction = function(...args: Parameters<IDBDatabase['transaction']>) {
            if (opened.has(this)) nameFor();
            return transaction.apply(this, args);
        };
    } catch (error) { diagnostic(error); }
    return {
        bind(route: string) { address ??= route; if (route !== address) block(); },
        block,
        probe(available: boolean) {
            const next = available ? 'host' : 'local';
            // The first probe may run inside the recall after its cache miss.
            if (!source && lastRead?.startsWith(':')) lastRead = next + lastRead;
            source = next;
        },
        invalidate() { try { if (!disabled) localStorage.removeItem(baibaiRecallStorage); } catch { /* Storage unavailable. */ } },
    };
}

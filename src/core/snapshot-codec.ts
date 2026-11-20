const format = 'tipsy-snapshot-v2';
const known = new Set<string>();
const hashes = new Map<string, Promise<string>>();
const packedRecords = new WeakMap<object, string>();
const storedRecords = new Map<string, string>();
const pooledRecords = new WeakMap<object, string>();
const storyIndexes = new Map<string, Set<string>>();
let encodeSliceStarted = 0;
async function yieldEncoding() {
    if (performance.now() - encodeSliceStarted < 8) return;
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    encodeSliceStarted = performance.now();
}
async function hash(text: string): Promise<string> {
    let result = hashes.get(text);
    if (!result) {
        result = crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)).then(buffer =>
            [...new Uint8Array(buffer)].map(byte => byte.toString(16).padStart(2, '0')).join(''));
        if (hashes.size >= 64) hashes.delete(hashes.keys().next().value!);
        hashes.set(text, result);
    }
    return result;
}
export function mapSnapshot(value: any, map: (value: any) => any): any {
    const mapped = map(value);
    if (mapped !== value) return mapped;
    if (Array.isArray(value)) return value.map(item => mapSnapshot(item, map));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, mapSnapshot(item, map)]));
    return value;
}
function visitSnapshot(value: any, visit: (value: any) => void): void {
    visit(value);
    if (Array.isArray(value)) { for (const item of value) visitSnapshot(item, visit); }
    else if (value && typeof value === 'object') for (const item of Object.values(value)) visitSnapshot(item, visit);
}
async function pack(value: any, writes: Record<string, any>, wire = false): Promise<any> {
    const seen = new WeakMap<object, any>();
    const pooled = new WeakMap<object, { $tipsyRecord: string }>();
    const images = new Map<string, string>();
    const pool = async (item: any, project: (item: any) => Promise<any> = walk): Promise<any> => {
        if (item == null || typeof item !== 'object') return walk(item);
        const cached = !wire ? pooledRecords.get(item) : undefined;
        if (cached && known.has(cached)) return { $tipsyRecord: cached };
        const previous = pooled.get(item);
        if (previous) return previous;
        const packed = await project(item);
        const key = `snapshot-branch:${await hash(JSON.stringify(packed))}`;
        if (wire || !known.has(key)) writes[key] = packed;
        if (!wire) pooledRecords.set(item, key);
        const reference = { $tipsyRecord: key };
        pooled.set(item, reference);
        return reference;
    };
    const walk = async (item: any): Promise<any> => {
        if (typeof item === 'string' && item.startsWith('data:image/')) {
            let key = images.get(item);
            if (!key) { key = `snapshot-image:${await hash(item)}`; images.set(item, key); }
            if (wire || !known.has(key)) writes[key] = item;
            return { $tipsyImage: key };
        }
        if (!item || typeof item !== 'object') return item;
        if (seen.has(item)) return seen.get(item);
        await yieldEncoding();
        const result: any = Array.isArray(item) ? [] : {};
        seen.set(item, result);
        for (const [key, entry] of Object.entries(item)) {
            if ((key === 'branchBases' || key === 'branchStates') && entry && typeof entry === 'object') {
                result[key] = {};
                for (const [id, checkpoint] of Object.entries(entry)) result[key][id] = await pool(checkpoint);
            } else if (key === 'messageVariablePages' && Array.isArray(entry)) {
                result[key] = [];
                for (const page of entry) result[key].push(await pool(page, async values => {
                    const buckets: Record<string, unknown> = {};
                    for (const [id, bucket] of Object.entries(values)) buckets[id] = await pool(bucket);
                    return buckets;
                }));
            } else if (key === 'messages' && Array.isArray(entry) && typeof item.activeLeafId !== 'undefined' && typeof item.characterId === 'string') {
                result[key] = [];
                for (const message of entry) result[key].push(await pool(message));
            } else if (key === 'continuation' && entry && typeof entry === 'object') {
                const continuation: any = {};
                for (const [field, part] of Object.entries(entry)) {
                    if (field === 'variables' && part && typeof part === 'object') {
                        const variables: Record<string, any> = {};
                        for (const [scope, buckets] of Object.entries(part)) {
                            if (scope === 'global') variables[scope] = await pool(buckets);
                            else {
                                variables[scope] = {};
                                for (const [id, bucket] of Object.entries(buckets as object)) variables[scope][id] = await pool(bucket);
                            }
                        }
                        continuation[field] = variables;
                    } else continuation[field] = await pool(part);
                }
                result[key] = continuation;
            } else result[key] = await walk(entry);
        }
        return result;
    };
    return walk(value);
}
/** A self-contained wire envelope deduplicates images without depending on receiver caches. */
export async function packSyncImages(value: any) {
    const images: Record<string, any> = {};
    const packed = await pack(value, images, true);
    return { $format: 'tipsy-sync-images-v2', value: packed, images };
}
export function unpackSyncImages(value: any) {
    if (!['tipsy-sync-images-v1', 'tipsy-sync-images-v2'].includes(value?.$format)) return value;
    const expanded = new Map<string, any>();
    const expand = (item: any): any => {
        const key = item && typeof item === 'object' && Object.keys(item).length === 1 ? item.$tipsyImage ?? item.$tipsyRecord : undefined;
        if (!key) return item;
        if (!Object.hasOwn(value.images, key)) throw new Error('同步剧情数据不完整');
        if (!expanded.has(key)) expanded.set(key, mapSnapshot(value.images[key], expand));
        return expanded.get(key);
    };
    return mapSnapshot(value.value, expand);
}
async function record(value: any, writes: Record<string, any>, identity: string, reference = value) {
    const cached = reference && typeof reference === 'object' ? packedRecords.get(reference) : undefined;
    const key = `snapshot-record:${identity}`;
    if (cached && storedRecords.get(key) === cached) return { $tipsyRecord: key };
    await yieldEncoding();
    const packed = await pack(value, writes);
    const digest = await hash(JSON.stringify(packed));
    if (storedRecords.get(key) !== digest) writes[key] = packed;
    if (reference && typeof reference === 'object') packedRecords.set(reference, digest);
    return { $tipsyRecord: key };
}

function storyCollection(collection: string): boolean {
    return collection === 'workspace_snapshot' || collection.startsWith('chat_archive:');
}

export function usesImmutableStorySnapshot(collection: string): boolean {
    return storyCollection(collection) || collection === 'scoped_variables';
}

async function storySnapshot(value: any, writes: Record<string, any>, collection: string, keys: Set<string>) {
    const { messages, ...metadata } = value;
    const packed = await pack(metadata, writes);
    packed.messages = [];
    for (const message of messages) {
        const item = await record(message, writes, `story:${JSON.stringify([collection, message.id])}`);
        keys.add(item.$tipsyRecord);
        packed.messages.push(item);
    }
    return packed;
}

async function variableSnapshot(value: any, writes: Record<string, any>, keys: Set<string>) {
    const { message, ...scopes } = value;
    const packed = await pack(scopes, writes);
    packed.message = {};
    for (const [id, bucket] of Object.entries(message ?? {})) {
        const item = await record(bucket, writes, `message-variables:${id}`);
        keys.add(item.$tipsyRecord);
        packed.message[id] = item;
    }
    return packed;
}
/** All references and their new payloads are committed in the same database transaction. */
export async function encodeSnapshots(snapshots: Record<string, any>, references: Record<string, any> = {}) {
    encodeSliceStarted = performance.now();
    const writes: Record<string, any> = {};
    const indexes = new Map<string, Set<string>>();
    for (const [collection, value] of Object.entries(snapshots)) {
        const keys = usesImmutableStorySnapshot(collection) ? new Set<string>() : undefined;
        if (keys) indexes.set(collection, keys);
        if (value == null) { writes[collection] = value; continue; }
        let packed: any;
        if (storyCollection(collection) && Array.isArray(value.messages)) {
            packed = await storySnapshot(value, writes, collection, keys!);
        } else if (collection === 'scoped_variables') {
            packed = await variableSnapshot(value, writes, keys!);
        } else if (collection === 'workspace_assets') {
            packed = {};
            for (const [kind, items] of Object.entries(value)) {
                packed[kind] = [];
                const originals = new Map((references.workspace_assets?.[kind] ?? []).map(item => [item.id, item]));
                for (const item of items as any[]) packed[kind].push(await record(item, writes, `assets:${kind}:${item.id}`, originals.get(item.id) ?? item));
            }
        } else if (collection === 'lan_sync_state') {
            packed = await pack({ ...value, records: undefined, inbox: undefined }, writes);
            packed.inbox = [];
            for (const packet of value.inbox ?? []) {
                await yieldEncoding();
                packed.inbox.push(await pack(packet, writes));
            }
            packed.records = {};
            for (const [id, revision] of Object.entries<any>(value.records)) packed.records[id] = await record(revision, writes, `sync:${id}`, references.lan_sync_state?.records[id] ?? revision);
        } else { await yieldEncoding(); packed = await pack(value, writes); }
        writes[collection] = { $format: format, value: packed };
    }
    for (const [collection, keys] of indexes) for (const key of storyIndexes.get(collection) ?? []) if (!keys.has(key)) writes[key] = null;
    const digests = new Map<string, string>();
    for (const [key, value] of Object.entries(writes)) if (key.startsWith('snapshot-record:')) digests.set(key, await hash(JSON.stringify(value)));
    return { writes, committed() {
        for (const key of Object.keys(writes)) if (key.startsWith('snapshot-image:') || key.startsWith('snapshot-branch:')) known.add(key);
        for (const [key, digest] of digests) {
            if (writes[key] === null) storedRecords.delete(key); else storedRecords.set(key, digest);
        }
        for (const [collection, keys] of indexes) {
            if (keys.size) storyIndexes.set(collection, keys); else storyIndexes.delete(collection);
        }
    } };
}
export async function decodeSnapshot(value: any, read: (key: string) => Promise<any>, readMany?: (keys: string[]) => Promise<Record<string, any>>, collection?: string): Promise<any> {
    if (value?.$format !== format) return value;
    const loaded = new Map<string, any>();
    const reference = (item: any): string | undefined => item && typeof item === 'object' && Object.keys(item).length === 1
        ? item.$tipsyImage ?? item.$tipsyRecord : undefined;
    let roots = [value.value];
    while (roots.length) {
        const missing = new Set<string>();
        for (const root of roots) visitSnapshot(root, item => { const key = reference(item); if (key && !loaded.has(key)) missing.add(key); });
        roots = [];
        const keys = [...missing];
        for (let offset = 0; offset < keys.length; offset += 64) {
            const group = keys.slice(offset, offset + 64);
            const values = readMany ? await readMany(group) : Object.fromEntries(await Promise.all(group.map(async key => [key, await read(key)])));
            const batch = group.map(key => {
                const raw = values[key];
                if (raw == null) throw new Error('保存的资源不完整，请重试读取');
                if (key.startsWith('snapshot-image:') || key.startsWith('snapshot-branch:')) known.add(key);
                loaded.set(key, raw); return raw;
            });
            roots.push(...batch);
        }
    }
    const expanded = new Map<string, any>();
    const expand = (item: any): any => {
        const key = reference(item);
        if (key) {
            if (!expanded.has(key)) {
                const decoded = mapSnapshot(loaded.get(key), expand);
                expanded.set(key, decoded);
                if (decoded && typeof decoded === 'object') {
                    if (key.startsWith('snapshot-branch:')) pooledRecords.set(decoded, key);
                    if (key.startsWith('snapshot-record:')) {
                        const marker = storedRecords.get(key) ?? key;
                        storedRecords.set(key, marker);
                        packedRecords.set(decoded, marker);
                    }
                }
            }
            return expanded.get(key);
        }
        return item;
    };
    const decoded = mapSnapshot(value.value, expand);
    if (collection && usesImmutableStorySnapshot(collection)) {
        const records = storyCollection(collection) ? value.value.messages ?? [] : Object.values(value.value.message ?? {});
        const keys = new Set<string>();
        for (const item of records) {
            const key = reference(item);
            if (key?.startsWith('snapshot-record:')) keys.add(key);
        }
        if (keys.size) storyIndexes.set(collection, keys);
    }
    return decoded;
}

import { backgroundDb, requestResult, transactionDone } from './background-store';
import type { BaibaiIndexLeaf } from '../../compatibility/baibai-route';

type VectorRow = { collection: string; id: string; docHash: string; values: Float32Array; norm: number };
type PayloadRow = { collection: string; id: string; payloadHash: string; document: string; mesFull: string | null; storyTime: string | null; msgIndex: number | null };
type Job = { action: string; collection: string; scopes: Array<{ key: string; label: string }>; leaves: Record<string, BaibaiIndexLeaf>; replacing: boolean; body: Record<string, any> };

const range = (collection: string) => IDBKeyRange.bound([collection], [collection, []]);
function decode(value: string, dim?: number) {
    const bytes = Uint8Array.from(atob(value), c => c.charCodeAt(0));
    if (!bytes.length || bytes.length % 4 || dim !== undefined && dim * 4 !== bytes.length) throw new Error('向量维度不匹配');
    const view = new DataView(bytes.buffer), values = new Float32Array(bytes.length / 4);
    let sum = 0;
    for (let i = 0; i < values.length; i++) { const v = view.getFloat32(i * 4, true); values[i] = v; sum += v * v; }
    if (!Number.isFinite(sum) || sum === 0) throw new Error('无效向量');
    return { values, norm: Math.sqrt(sum) };
}

async function run({ action, collection, scopes, body, leaves, replacing }: Job) {
    const db = await backgroundDb();
    if (action === 'status') return { driver: { available: true } };
    const leafFor = (id: string) => Object.hasOwn(leaves, id) ? leaves[id] : undefined;
    const matching = (item: any) => {
        const leaf = leafFor(item.leafId);
        return leaf && leaf.payloadHash === item.payloadHash && (item.docHash === undefined || leaf.docHash === item.docHash);
    };
    if (replacing && ['vec/clear-scope', 'vec/delete', 'vec/bundle/create'].includes(action)) throw new Error('重新生成期间不能清理或搬运向量索引');
    const readonly = action === 'vec/search' || action === 'vec/stats' || replacing && action === 'vec/reconcile';
    const prepared = action === 'vec/upsert' ? body.items.filter((item: any) => item.docHash && matching(item)).map((item: any) => ({ item, vector: decode(item.vector, item.dim) })) : undefined;
    const queries = action === 'vec/search' ? body.queryVectors.map((value: string) => decode(value)) as ReturnType<typeof decode>[] : [];
    const tx = db.transaction(['memory-vectors', 'memory-payloads', 'memory-snapshots'], readonly ? 'readonly' : 'readwrite');
    const done = transactionDone(tx);
    const vectors = tx.objectStore('memory-vectors'), payloads = tx.objectStore('memory-payloads'), snapshots = tx.objectStore('memory-snapshots');
    const key = (id: string) => [collection, id];
    const remove = (id: string) => { vectors.delete(key(id)); payloads.delete(key(id)); };
    try {
        let result: unknown;
        switch (action) {
            case 'vec/upsert': {
                for (const { item, vector } of prepared) {
                    vectors.put({ collection, id: item.leafId, docHash: item.docHash, ...vector } satisfies VectorRow);
                    payloads.put({ collection, id: item.leafId, payloadHash: item.payloadHash, document: item.document, mesFull: item.mesFull ?? null,
                        storyTime: item.storyTime ?? null, msgIndex: item.msgIndex ?? null } satisfies PayloadRow);
                }
                result = { upserted: prepared.length }; break;
            }
            case 'vec/update-payload': {
                const found = await Promise.all(body.items.map((item: any) => requestResult<PayloadRow | undefined>(payloads.get(key(item.leafId)))));
                let updated = 0;
                for (const [i, row] of found.entries()) if (row && matching(body.items[i])) {
                    const item = body.items[i];
                    payloads.put({ ...row, payloadHash: item.payloadHash, mesFull: item.mesFull ?? null, storyTime: item.storyTime ?? null }); updated++;
                }
                result = { updated }; break;
            }
            case 'vec/delete': {
                const ids = [...new Set<string>(body.leafIds)];
                const found = await Promise.all(ids.map(id => requestResult(vectors.getKey(key(id)))));
                ids.forEach(remove); result = { deleted: found.filter(Boolean).length }; break;
            }
            case 'vec/clear-scope': {
                const deleted = await requestResult(vectors.count(range(collection)));
                vectors.delete(range(collection)); payloads.delete(range(collection)); result = { deleted }; break;
            }
            case 'vec/reconcile': {
                const present = new Map<string, { docHash: string; payloadHash: string }>(body.present.filter((item: any) => item.docHash && matching(item)).map((item: any) => [item.leafId, item]));
                const [existing, docs] = await Promise.all([requestResult<VectorRow[]>(vectors.getAll(range(collection))), requestResult<PayloadRow[]>(payloads.getAll(range(collection)))]);
                const hashes = new Map(docs.map(row => [row.id, row.payloadHash]));
                let deleted = 0; const missing: string[] = [], stalePayload: string[] = [];
                for (const row of existing) {
                    const item = present.get(row.id);
                    if (!item) { if (!replacing && !leafFor(row.id)) { remove(row.id); deleted++; } continue; }
                    if (row.docHash !== item.docHash || !hashes.has(row.id)) missing.push(row.id);
                    else if (hashes.get(row.id) !== item.payloadHash) stalePayload.push(row.id);
                    present.delete(row.id);
                }
                missing.push(...present.keys()); result = { deleted, missing, stalePayload }; break;
            }
            case 'vec/stats': {
                const counts = await Promise.all(scopes.map(scope => requestResult(vectors.count(range(scope.key)))));
                result = { stats: Object.fromEntries(scopes.map((scope, i) => [scope.label, counts[i]])) }; break;
            }
            case 'vec/search': {
                const excluded = new Set<string>(body.excludeLeafIds ?? []);
                const all = await Promise.all(scopes.map(scope => requestResult<VectorRow[]>(vectors.getAll(range(scope.key)))));
                const activeIndex = scopes.findIndex(scope => scope.key === collection);
                const payloadRows = activeIndex >= 0 && all[activeIndex].length ? await requestResult<PayloadRow[]>(payloads.getAll(range(collection))) : [];
                const activePayloads = new Map(payloadRows.map(row => [row.id, row]));
                const best = new Map<string, { row: VectorRow; scope: string; similarity: number; queryIndex: number }>();
                for (const [i, rows] of all.entries()) for (const row of rows) {
                    if (excluded.has(row.id)) continue;
                    if (row.collection === collection) {
                        const leaf = leafFor(row.id);
                        if (!leaf || row.docHash !== leaf.docHash || activePayloads.get(row.id)?.payloadHash !== leaf.payloadHash) continue;
                    }
                    let similarity = -Infinity, queryIndex = -1;
                    for (const [j, q] of queries.entries()) {
                        if (q.values.length !== row.values.length) continue;
                        let dot = 0;
                        for (let k = 0; k < row.values.length; k++) dot += q.values[k] * row.values[k];
                        const score = Math.max(-1, Math.min(1, dot / (q.norm * row.norm)));
                        if (score > similarity) { similarity = score; queryIndex = j; }
                    }
                    if (queryIndex >= 0 && similarity > (best.get(row.id)?.similarity ?? -Infinity)) best.set(row.id, { row, scope: scopes[i].label, similarity, queryIndex });
                }
                const hits = [...best.values()].sort((a, b) => b.similarity - a.similarity || a.row.id.localeCompare(b.row.id))
                    .slice(0, Math.min(500, Math.max(1, Number(body.topK) || 10)));
                const docs = await Promise.all(hits.map(({ row }) => requestResult<PayloadRow | undefined>(payloads.get([row.collection, row.id]))));
                result = { results: hits.flatMap(({ row, scope, similarity, queryIndex }, i) => {
                    const doc = docs[i];
                    return doc ? [{ leafId: row.id, scope, similarity, queryIndex, document: doc.document, mesFull: doc.mesFull, storyTime: doc.storyTime, msgIndex: row.collection === collection ? leafFor(row.id)?.msgIndex : doc.msgIndex }] : [];
                }) }; break;
            }
            case 'vec/bundle/create': {
                const [stored, payloadRows] = await Promise.all([requestResult<VectorRow[]>(vectors.getAll(range(collection))), requestResult<PayloadRow[]>(payloads.getAll(range(collection)))]);
                const current = new Map(payloadRows.map(row => [row.id, row]));
                const rows = stored.filter(row => {
                    const leaf = leafFor(row.id);
                    return leaf && leaf.docHash === row.docHash && leaf.payloadHash === current.get(row.id)?.payloadHash;
                });
                const docs = rows.map(row => ({ ...current.get(row.id)!, msgIndex: leafFor(row.id)!.msgIndex }));
                // Calculate a stable revision inside the transaction without awaiting external work.
                const fingerprint = JSON.stringify([collection, rows.map(row => [row.id, row.docHash]), docs.map(row => [row.id, row.payloadHash, row.msgIndex])]);
                const previous = await requestResult<string | undefined>(snapshots.get(fingerprint));
                const hash = previous ?? crypto.randomUUID().replaceAll('-', '');
                const scope = `bundle:${hash}`, bundle = `${body.namespace}/${scope}`;
                if (!previous) {
                    for (const row of rows) vectors.put({ ...row, collection: bundle });
                    for (const row of docs) payloads.put({ ...row, collection: bundle });
                    snapshots.put(hash, fingerprint);
                }
                result = { hash, scope, copied: rows.length, reused: !!previous }; break;
            }
            default: throw new Error('未知的向量索引操作');
        }
        await done;
        return result;
    } catch (error) {
        try { tx.abort(); } catch { /* Already closed. */ }
        await done.catch(() => {});
        throw error;
    }
}

const worker = self as unknown as DedicatedWorkerGlobalScope;
worker.onmessage = ({ data }: MessageEvent<{ id: number; job: Job }>) => {
    void run(data.job).then(result => worker.postMessage({ id: data.id, result }), error => worker.postMessage({ id: data.id, error: String(error?.message ?? error) }));
};

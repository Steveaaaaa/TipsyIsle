import type { IndexDocument, IndexHit } from '../../../packages/plugin-sdk/index.js';
import { backgroundDb, requestResult, transactionDone } from './background-store';
import { PluginApiError } from './errors';

export type IndexJob = { owner: string; collection: string } & ({ kind: 'put'; documents: IndexDocument[] }
    | { kind: 'remove'; ids: string[] } | { kind: 'search'; text?: string; vector?: number[]; limit: number });
type Row = IndexDocument & { owner: string; collection: string; terms: Record<string, number>; norm: number };
const split = (text: string) => [...text.normalize('NFKC').toLowerCase().matchAll(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]|[\p{L}\p{N}_]+/gu)].map(match => match[0]);
const terms = (text: string) => {
    const tokens = split(text);
    const out: Record<string, number> = Object.create(null);
    for (const token of tokens) out[token] = (out[token] ?? 0) + 1;
    return out;
};
const norm = (vector?: number[]) => vector ? Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) : 0;
async function run(job: IndexJob) {
    const db = await backgroundDb(), key = (id: string) => [job.owner, job.collection, id];
    if (job.kind === 'search') {
        const range = IDBKeyRange.bound(key(''), key('\uffff'));
        const rows: Row[] = await requestResult(db.transaction('index').objectStore('index').getAll(range));
        const query = [...new Set(split(job.text ?? ''))], normQ = norm(job.vector);
        const hits: IndexHit[] = [];
        for (const row of rows) {
            let score = 0;
            if (query.length) {
                const count = query.reduce((sum, term) => sum + Math.min(Object.hasOwn(row.terms, term) ? row.terms[term] : 0, 3), 0);
                score += count / (3 * query.length);
            }
            const q = job.vector, v = row.vector;
            if (q && v && q.length === v.length && normQ && row.norm) score += Math.max(0, q.reduce((sum, value, i) => sum + value * v[i], 0) / (normQ * row.norm));
            if (score > 0) hits.push({ id: row.id, score, excerpt: row.text.slice(0, 400), value: row.value });
        }
        return hits.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, job.limit);
    }
    const tx = db.transaction('index', 'readwrite'), done = transactionDone(tx), store = tx.objectStore('index');
    if (job.kind === 'remove') { for (const id of job.ids) store.delete(key(id)); }
    else {
        const all = await requestResult(store.getAllKeys(IDBKeyRange.bound([job.owner], [job.owner, []])));
        const newIds = new Set(job.documents.map(row => row.id));
        for (const [, collection, id] of all as string[][]) if (collection === job.collection) newIds.delete(id);
        if (all.length + newIds.size > 5000) { await done; throw new PluginApiError('QUOTA_EXCEEDED', '该插件的索引已满'); }
        for (const row of job.documents) store.put({ ...row, owner: job.owner, collection: job.collection, terms: terms(row.text), norm: norm(row.vector) });
    }
    await done;
}
const host = self as unknown as DedicatedWorkerGlobalScope;
host.onmessage = ({ data }: MessageEvent<{ id: number; job: IndexJob }>) => {
    void run(data.job).then(result => host.postMessage({ id: data.id, result }), error => host.postMessage({ id: data.id,
        error: { code: error instanceof PluginApiError ? error.code : 'UNAVAILABLE', message: error?.message ?? '无法访问插件索引' } }));
};

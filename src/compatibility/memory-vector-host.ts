import type { BaibaiVectorContext } from './baibai-vector-context';

let worker: Worker | undefined;
let sequence = 0;
const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
function request(job: object) {
    if (!worker) {
        worker = new Worker(new URL('../plugins/native/memory-index.worker.ts', import.meta.url), { type: 'module' });
        worker.onmessage = ({ data }) => {
            const entry = pending.get(data.id);
            if (!entry) return;
            pending.delete(data.id);
            if (data.error) entry.reject(new Error(data.error)); else entry.resolve(data.result);
        };
        worker.onerror = () => {
            worker?.terminate(); worker = undefined;
            for (const entry of pending.values()) entry.reject(new Error('本地向量索引不可用'));
            pending.clear();
        };
    }
    const id = ++sequence;
    return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        try { worker!.postMessage({ id, job }); }
        catch (error) { pending.delete(id); reject(error); }
    });
}

const actions = new Set(['vec/upsert', 'vec/update-payload', 'vec/search', 'vec/delete', 'vec/clear-scope', 'vec/reconcile', 'vec/stats', 'vec/bundle/create']);
export async function handleMemoryVectorRequest(action: string, body: Record<string, any> = {}, binding?: BaibaiVectorContext) {
    try {
        if (action === 'status') return { status: 200, body: { ok: true, data: await request({ action }) } };
        if (!actions.has(action) || !/^[a-z0-9][a-z0-9._-]{0,79}$/.test(body.database)) throw new Error('无效的向量操作或库名');
        if (!binding?.valid()) throw new Error('向量请求所属路线或记忆已改变');
        const session = binding.chatId;
        const namespace = JSON.stringify([binding.characterId, body.database]);
        const activeScope = `chat:${session}`;
        const activeCollection = `${namespace}/${JSON.stringify([session, binding.routeId])}`;
        if (action === 'vec/bundle/create' && body.sourceChatId !== session) throw new Error('只能从当前剧情创建记忆快照');
        if (body.scope !== undefined && body.scope !== activeScope) throw new Error('只能写入当前剧情的向量索引');
        const scopes = Array.isArray(body.scopes) ? [...new Set<string>(body.scopes)].map(label => {
            if (label === activeScope) return { label, key: activeCollection };
            if (typeof label === 'string' && /^bundle:[0-9a-f]{32}$/.test(label)) return binding.bundles.includes(label.slice(7)) ? { label, key: `${namespace}/${label}` } : undefined;
            throw new Error('向量查询范围无效');
        }).filter(Boolean) : [];
        const data = await request({ action, collection: activeCollection, scopes, leaves: binding.leaves, replacing: binding.replacing, body: { ...body, namespace } });
        if (!binding.valid()) throw new Error('向量请求所属路线或记忆已改变');
        return { status: 200, body: { ok: true, data } };
    } catch (error) {
        if (action === 'status') return { status: 200, body: { ok: true, data: { driver: { available: false } } } };
        return { status: 400, body: { ok: false, error: { code: 'VECTOR_REQUEST_FAILED', message: error instanceof Error ? error.message : String(error) } } };
    }
}

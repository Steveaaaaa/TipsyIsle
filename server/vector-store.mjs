import { createHash } from 'node:crypto';

const hash = text => createHash('sha256').update(text).digest('hex');
const normalize = vector => {
  if (!Array.isArray(vector) || !vector.length || vector.some(value => typeof value !== 'number' || !Number.isFinite(value))) throw new Error('嵌入服务未返回有效向量');
  const length = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (!length) throw new Error('嵌入服务返回了零向量');
  return vector.map(value => value / length);
};

/** Persistent text cache, scoped by endpoint/model. No credentials enter the cache. */
export function createVectorStore(db) {
  db.exec('CREATE TABLE IF NOT EXISTS vector_cache (id TEXT PRIMARY KEY, vector TEXT NOT NULL, used_at INTEGER NOT NULL)');
  const read = db.prepare('SELECT vector FROM vector_cache WHERE id = ?');
  const write = db.prepare('INSERT OR REPLACE INTO vector_cache (id, vector, used_at) VALUES (?, ?, ?)');
  return async function queryWorldbooks(payload, signal) {
    if (!payload.query?.trim() || !payload.entries?.length) return { matches: [] };
    const base = String(payload.baseUrl).replace(/\/+$/, '');
    const endpoint = new URL(base.endsWith('/embeddings') ? base : `${base}/embeddings`);
    if (!['https:', 'http:'].includes(endpoint.protocol) || !payload.model) throw new Error('请配置有效的嵌入模型连接');
    const chunkSize = Math.max(256, Number(payload.chunkSize) || 4000);
    const chunks = new Map();
    for (const entry of payload.entries) {
      const text = String(entry.content);
      const ids = [];
      for (let start = 0; start < text.length; start += chunkSize) {
        const chunk = text.slice(start, start + chunkSize), id = hash(`${endpoint}\n${payload.model}\n${chunk}`);
        ids.push(id); if (!chunks.has(id)) chunks.set(id, { text: chunk, vector: undefined });
      }
      entry.chunkIds = ids;
    }
    const queryId = hash(`${endpoint}\n${payload.model}\n${payload.query}`);
    chunks.set(queryId, { text: payload.query, vector: undefined });
    for (const [id, item] of chunks) { const cached = read.get(id); if (cached) item.vector = JSON.parse(cached.vector); }
    const missing = [...chunks].filter(([, item]) => !item.vector);
    for (let start = 0; start < missing.length; start += 32) {
      signal.throwIfAborted();
      const batch = missing.slice(start, start + 32);
      const response = await fetch(endpoint, { method: 'POST', signal, headers: { 'Content-Type': 'application/json',
        ...(payload.apiKey ? { Authorization: `Bearer ${payload.apiKey}` } : {}) },
        body: JSON.stringify({ model: payload.model, input: batch.map(([, item]) => item.text), encoding_format: 'float' }) });
      if (!response.ok) throw new Error(`嵌入请求失败 (${response.status})：${(await response.text()).slice(0, 200)}`);
      const result = await response.json();
      if (!Array.isArray(result.data) || result.data.length !== batch.length) throw new Error('嵌入响应条数与请求不一致');
      const indexed = new Map(result.data.map((item, index) => [item.index ?? index, item.embedding]));
      for (const [index, [id, item]] of batch.entries()) {
        item.vector = normalize(indexed.get(index)); write.run(id, JSON.stringify(item.vector), Date.now());
      }
    }
    const query = chunks.get(queryId).vector;
    const groups = new Map();
    for (const entry of payload.entries) {
      let score = -1;
      for (const id of entry.chunkIds) {
        const vector = chunks.get(id).vector;
        if (vector.length !== query.length) throw new Error('嵌入模型的向量维度已变化，请使用新的模型标识或清除向量缓存');
        score = Math.max(score, vector.reduce((sum, value, index) => sum + value * query[index], 0));
      }
      if (score < Number(payload.threshold ?? 0.25)) continue;
      const group = groups.get(entry.world) ?? []; group.push({ world: entry.world, uid: entry.uid, score }); groups.set(entry.world, group);
    }
    const limit = Math.max(1, Math.floor(Number(payload.maxEntries) || 5));
    return { matches: [...groups.values()].flatMap(group => group.sort((a, b) => b.score - a.score).slice(0, limit)) };
  };
}

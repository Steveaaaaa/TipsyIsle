import { randomUUID } from 'node:crypto';

/** Provider credentials stay in the local DB; the browser receives status and login prompts only. */
export function createModelAuth(db) {
  db.exec('CREATE TABLE IF NOT EXISTS model_credentials (provider TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const read = db.prepare('SELECT value FROM model_credentials WHERE provider = ?');
  const write = db.prepare('INSERT OR REPLACE INTO model_credentials (provider,value) VALUES (?,?)');
  const remove = db.prepare('DELETE FROM model_credentials WHERE provider = ?');
  const chains = new Map(), jobs = new Map();
  const enqueue = (id, run) => {
    const next = (chains.get(id) ?? Promise.resolve()).catch(() => {}).then(run);
    chains.set(id, next); return next;
  };
  const credentials = {
    read: async id => { const row = read.get(id); return row ? JSON.parse(row.value) : undefined; },
    list: async () => db.prepare('SELECT provider,value FROM model_credentials').all().map(row => ({ providerId: row.provider, type: JSON.parse(row.value).type })),
    modify: (id, fn, options) => enqueue(id, async () => {
      options?.signal?.throwIfAborted(); const current = await credentials.read(id), next = await fn(current);
      options?.signal?.throwIfAborted(); if (next) write.run(id, JSON.stringify(next)); return next ?? current;
    }),
    delete: id => enqueue(id, async () => { remove.run(id); }),
  };
  let modelsPromise;
  const models = () => modelsPromise ??= import('@earendil-works/pi-ai/providers/all').then(module => module.builtinModels({ credentials }));
  const view = job => ({ id: job.id, provider: job.provider, status: job.status, events: job.events, prompt: job.prompt, error: job.error });
  const cancel = job => {
    if (job.status !== 'pending') return;
    job.controller.abort(new DOMException('授权已取消', 'AbortError')); job.status = 'cancelled';
    job.reject?.(job.controller.signal.reason); job.prompt = undefined; clearTimeout(job.timer);
  };
  return {
    async resolve(provider, signal) {
      const runtime = await models();
      const saved = await credentials.read(provider);
      if (saved?.type !== 'oauth') throw new Error(`请先授权 Pi 服务商：${provider}`);
      signal.throwIfAborted(); const result = await runtime.getAuth(provider); signal.throwIfAborted();
      if (!result) throw new Error(`无法取得 ${provider} 的授权凭据`);
      return result;
    },
    async handle(action, payload = {}) {
      const runtime = await models();
      if (action === 'status') return { providers: runtime.getProviders().map(provider => ({ id: provider.id, name: provider.name, oauth: !!provider.auth.oauth })),
        credentials: await credentials.list() };
      if (action === 'start') {
        const provider = runtime.getProvider(payload.provider);
        if (!provider?.auth.oauth) throw new Error('该服务商未提供 OAuth 登录');
        for (const job of jobs.values()) if (job.provider === provider.id) { cancel(job); jobs.delete(job.id); }
        const job = { id: randomUUID(), provider: provider.id, controller: new AbortController(), status: 'pending', events: [], prompt: undefined };
        jobs.set(job.id, job); job.timer = setTimeout(() => cancel(job), 600000); job.timer.unref();
        void runtime.login(provider.id, 'oauth', {
          signal: job.controller.signal,
          notify: event => { job.events.push(event); if (job.events.length > 30) job.events.shift(); },
          prompt: prompt => new Promise((resolve, reject) => {
            const { signal, ...description } = prompt;
            const active = signal ? AbortSignal.any([signal, job.controller.signal]) : job.controller.signal;
            active.throwIfAborted();
            const id = randomUUID(); job.prompt = { ...description, id };
            const clear = () => { active.removeEventListener('abort', aborted); if (job.prompt?.id === id) job.prompt = undefined; job.answer = undefined; job.reject = undefined; };
            const aborted = () => { clear(); reject(active.reason); };
            job.answer = value => { clear(); resolve(String(value)); }; job.reject = reason => { clear(); reject(reason); };
            active.addEventListener('abort', aborted, { once: true });
          }),
        }, { agentName: 'TipsyIsle' }).then(() => { job.status = 'complete'; }, error => {
          if (!job.controller.signal.aborted) { job.status = 'failed'; job.error = error.message ?? String(error); }
        }).finally(() => { job.prompt = undefined; clearTimeout(job.timer); });
        return view(job);
      }
      if (action === 'logout') { await runtime.logout(payload.provider); return { ok: true }; }
      const job = jobs.get(payload.id);
      if (!job) throw new Error('登录流程已结束或不存在，请重新开始');
      if (action === 'poll') return view(job);
      if (action === 'cancel') { cancel(job); return view(job); }
      if (action === 'answer') {
        if (job.status !== 'pending' || job.prompt?.id !== payload.promptId) throw new Error('此授权步骤已经结束，请等待新的提示');
        job.answer(payload.value); return view(job);
      }
      throw new Error('未知的模型授权操作');
    },
    close() { for (const job of jobs.values()) cancel(job); },
  };
}

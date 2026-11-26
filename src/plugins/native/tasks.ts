import { z } from 'zod';
import type { ModelRequest, Permission, TaskResult, TaskView } from '../../../packages/plugin-sdk/index.js';
import { imageRequest } from './image-protocol';
import { generateImage } from './image-adapter';
import { detectRuntimeFlavor, streamLlmCompletion } from '../../core/platform-bridge';
import { isNativeRuntime, platformFetch, compatibilityOrigin } from '../../core/native-runtime';
import { authorizedConnection, httpEndpoint } from './connections';
import { fromBase64, readLimited } from './bytes';
import { mediaLimit, saveMedia, transcodeToWebP } from './media';
import { idSchema, jsonObject, missing, roleSchema, sliceInt } from './edits';
import { PluginApiError } from './errors';

type Phase = TaskView['state'];
type Completed = Exclude<TaskResult, { kind: 'embedding' }> | { kind: 'embedding'; vectors: number[][] };
interface Task {
    id: string; owner: string; readers: Set<string>; controller: AbortController; state: Phase; progress?: number;
    text: string; reasoning: string; deltas: { cursor: number; text: string; reasoning: string }[]; cursor: number;
    result?: Completed; error?: TaskView['error']; listeners: Set<() => void>; run: (context: Progress) => Promise<Completed>;
    finished?: number; wake?: ReturnType<typeof setTimeout>;
}
interface Progress { signal: AbortSignal; append(text: string, reasoning?: string): void; progress(fraction: number): void }
const all = new Map<string, Task>();
const queue: Task[] = [];
let running = 0;
const terminal = (state: Phase) => state === 'done' || state === 'cancelled' || state === 'failed';
const byOwner = (owner: string, id: string, own = false) => {
    const item = all.get(id);
    if (!item || item.owner !== owner && (own || !item.readers.has(owner))) throw missing('后台任务');
    return item;
};
function update(task: Task, flush = false) {
    if (flush) { clearTimeout(task.wake); task.wake = undefined; for (const fire of [...task.listeners]) fire(); }
    else task.wake ??= setTimeout(() => update(task, true), 40);
}
function finish(task: Task, state: Phase) {
    task.state = state; task.finished = Date.now(); update(task, true);
}
function drain() {
    while (running < 3 && queue.length) {
        const task = queue.shift()!;
        if (terminal(task.state)) continue;
        running++; task.state = 'running'; update(task);
        const timer = setTimeout(() => task.controller.abort(new PluginApiError('TIMEOUT', '后台任务超时')), 300_000);
        void (async () => {
            try {
                const result = await task.run({ signal: task.controller.signal,
                    progress(fraction) { task.progress = fraction; update(task); },
                    append(text, reasoning = '') {
                        task.text += text; task.reasoning += reasoning;
                        if (task.text.length + task.reasoning.length > 180_000) throw new PluginApiError('QUOTA_EXCEEDED', '模型输出超过任务上限');
                        if (!text && !reasoning) return;
                        task.deltas.push({ cursor: ++task.cursor, text, reasoning });
                        update(task);
                    },
                });
                task.controller.signal.throwIfAborted();
                task.result = result; task.progress = 1; finish(task, 'done');
            } catch (error) {
                const fault = task.controller.signal.aborted ? task.controller.signal.reason : error;
                task.error = fault instanceof PluginApiError ? { code: fault.code, message: fault.message } : { code: 'NETWORK_ERROR', message: '外部任务失败，请检查连接或服务状态' };
                finish(task, task.error.code === 'CANCELLED' ? 'cancelled' : 'failed');
            } finally { clearTimeout(timer); running--; drain(); }
        })();
    }
}
function start(owner: string, run: Task['run']) {
    for (const [id, item] of all) if (item.finished && Date.now() - item.finished > 30 * 60_000) all.delete(id);
    const owned = [...all.values()].filter(task => task.owner === owner);
    if (owned.filter(task => !terminal(task.state)).length >= 4 || queue.length >= 32) throw new PluginApiError('QUOTA_EXCEEDED', '后台任务过多');
    while (owned.length >= 24) {
        const i = owned.findIndex(task => terminal(task.state)); if (i < 0) break;
        all.delete(owned.splice(i, 1)[0].id);
    }
    const id = crypto.randomUUID();
    const task: Task = { id, owner, readers: new Set(), controller: new AbortController(), state: 'queued', text: '', reasoning: '', deltas: [], cursor: 0, listeners: new Set(), run };
    all.set(id, task); queue.push(task); drain();
    return id;
}
export function cancelTask(owner: string, id: string) {
    const task = byOwner(owner, id);
    if (terminal(task.state)) return;
    task.controller.abort(new PluginApiError('CANCELLED', '任务已取消'));
    if (task.state === 'queued') { task.error = { code: 'CANCELLED', message: '任务已取消' }; finish(task, 'cancelled'); drain(); }
}
export function cancelPluginTasks(owner: string) {
    for (const task of all.values()) if (task.owner === owner && !terminal(task.state)) cancelTask(owner, task.id);
}
export function shareTasks(owner: string, recipient: string, ids: string[]) {
    const tasks = ids.map(id => byOwner(owner, id, true));
    for (const task of tasks) task.readers.add(recipient);
}
export function taskView(owner: string, id: string, after?: number): TaskView {
    const task = byOwner(owner, id);
    const deltas = after === undefined ? [] : task.deltas.filter(item => item.cursor > after);
    const output = task.result;
    const result: TaskResult | undefined = output?.kind === 'embedding' ? { kind: 'embedding', count: output.vectors.length,
        dimensions: output.vectors[0].length, ...(output.vectors.length <= 4 && { vectors: output.vectors }) } : output;
    return { id, state: task.state, cursor: task.cursor, delta: after === undefined ? task.text : deltas.map(item => item.text).join(''),
        reasoning: after === undefined ? task.reasoning : deltas.map(item => item.reasoning).join(''), progress: task.progress, result, error: task.error };
}
export function taskEmbeddings(owner: string, args: unknown) {
    const { id, offset = 0, limit = 4 } = z.strictObject({ id: idSchema, offset: sliceInt.optional(), limit: sliceInt.min(1).max(4).optional() }).parse(args);
    const task = byOwner(owner, id);
    if (task.result?.kind !== 'embedding') throw new PluginApiError('UNAVAILABLE', '此任务没有可读取的嵌入结果');
    const vectors = task.result.vectors;
    return { vectors: vectors.slice(offset, offset + limit), next: offset + limit < vectors.length ? offset + limit : null };
}
export function subscribeTask(owner: string, id: string, update: () => void) {
    const task = byOwner(owner, id); task.listeners.add(update);
    return () => { task.listeners.delete(update); };
}
export async function awaitTask(owner: string, args: unknown, signal: AbortSignal) {
    const task = byOwner(owner, idSchema.parse(args));
    signal.throwIfAborted();
    if (!terminal(task.state)) await new Promise<void>(resolve => {
        const wake = () => {
            if (!signal.aborted && !terminal(task.state)) return;
            task.listeners.delete(wake); signal.removeEventListener('abort', wake); resolve();
        };
        task.listeners.add(wake); signal.addEventListener('abort', wake, { once: true }); wake();
    });
    signal.throwIfAborted(); return taskView(owner, task.id);
}
export async function readTask(owner: string, args: unknown, signal: AbortSignal) {
    const { id, after, waitMs = 0 } = z.strictObject({ id: idSchema, after: sliceInt.optional(), waitMs: sliceInt.max(1500).optional() }).parse(args);
    const task = byOwner(owner, id);
    if (waitMs && after === task.cursor && !terminal(task.state)) await new Promise<void>(resolve => {
        const done = () => { clearTimeout(timer); task.listeners.delete(done); signal.removeEventListener('abort', done); resolve(); };
        const timer = setTimeout(done, waitMs); task.listeners.add(done); signal.addEventListener('abort', done, { once: true });
        if (signal.aborted) done();
    });
    signal.throwIfAborted();
    return taskView(owner, id, after);
}

const model = z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('chat'), connection: idSchema, messages: z.array(z.strictObject({ role: roleSchema, content: z.string().max(150_000) })).min(1).max(256),
        maxTokens: z.number().int().min(1).max(24_000).optional(), temperature: z.number().min(0).max(2).optional(), stream: z.boolean().optional(), schema: z.unknown().optional(), cacheKey:idSchema.optional() }),
    imageRequest,
    z.strictObject({ kind: z.literal('speech'), connection: idSchema, text: z.string().min(1).max(20_000), voice: z.string().min(1).max(80) }),
    z.strictObject({ kind: z.literal('embedding'), connection: idSchema, texts: z.array(z.string().min(1).max(20_000)).min(1).max(16) }),
]);
export async function startModel(owner: string, args: unknown, grants: string[], signal: AbortSignal, permissions:Permission[]=[]) {
    const data = model.parse(args) as ModelRequest;
    const connection = await authorizedConnection(data.connection, data.kind, grants);
    if (data.kind === 'chat' && data.schema) jsonObject(data.schema);
    signal.throwIfAborted();
    return start(owner, async task => {
        if (data.kind === 'chat') {
            const response = await streamLlmCompletion({ ...connection, signal: task.signal, stream: data.stream ?? true, onToken: task.append,
                messages: data.messages.map(row => ({ ...row, tokens: 0, sourceId: 'plugin-task', sourceLabel: '插件模型任务' })),
                includeHeaders: connection.headers, parameters: { max_tokens: data.maxTokens ?? 4096, temperature: data.temperature ?? .7,
                    ...(data.schema && { response_format: { type: 'json_schema', json_schema: { name: 'plugin_response', schema: data.schema } } }) } });
            return { kind: 'chat', text: response.content, reasoning: response.reasoning };
        }
        if (data.kind === 'image') {
            const {blob,seed}=await generateImage(connection,data,owner,permissions,task.signal);
            return {kind:'image',seed,media:await saveMedia(owner,'生成图像',connection.preservePng?blob:await transcodeToWebP(blob),task.signal)};
        }
        const path = data.kind === 'speech' ? 'audio/speech' : 'embeddings';
        const endpoint = new URL(httpEndpoint(connection.baseUrl));
        if (!endpoint.pathname.endsWith('/' + path)) endpoint.pathname = endpoint.pathname.replace(/\/(?:chat\/completions|images\/generations|audio\/speech|embeddings)\/?$/, '').replace(/\/$/, '') + '/' + path;
        const body = { model: connection.model, ...(data.kind === 'speech' ? { input: data.text, voice: data.voice } : { input: data.texts }) };
        const headers = { 'Content-Type': 'application/json', ...(connection.apiKey && { Authorization: `Bearer ${connection.apiKey}` }) };
        const gateway = await detectRuntimeFlavor() === 'local-gateway';
        const response = await (gateway ? fetch('/api/tipsy-isle/llm/artifact', { method: 'POST', signal: task.signal, headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: endpoint.href, body, key: connection.apiKey }) })
            : noRedirect(endpoint.href, { method: 'POST', signal: task.signal, headers, body: JSON.stringify(body) }));
        if (!response.ok) { await response.body?.cancel(); throw new PluginApiError('NETWORK_ERROR', `模型服务请求失败 (${response.status})`); }
        if (data.kind === 'speech') return { kind: 'speech', media: await saveMedia(owner, '语音', await readLimited(response, mediaLimit, task.signal, task.progress), task.signal) };
        const payload = JSON.parse(await (await readLimited(response, data.kind === 'embedding' ? 2 * 1024 * 1024 : mediaLimit * 2, task.signal, task.progress)).text());
        if (data.kind === 'embedding') {
            const values = z.array(z.object({ index: z.number().int(), embedding: z.array(z.number().finite()).min(1).max(3072) }))
                .length(data.texts.length).parse(payload.data).sort((a, b) => a.index - b.index);
            if (values.some((row, index) => row.index !== index || row.embedding.length !== values[0].embedding.length)) {
                throw new PluginApiError('NETWORK_ERROR', '模型返回的嵌入结果与输入不匹配');
            }
            return { kind: 'embedding', vectors: values.map(row => row.embedding) };
        }
        throw new PluginApiError('INVALID_ARGUMENT','未知模型任务');
    });
}

const networkSchema = z.strictObject({ url: z.string().max(4096), method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).default('GET'),
    headers: z.record(z.string(), z.string().max(2048)).optional(), body: z.unknown().optional() });
const checkExternal = (url: URL) => {
    if (url.origin === location.origin || url.origin === compatibilityOrigin || ['tauri.localhost', 'localhost', '127.0.0.1', '[::1]', '0.0.0.0'].includes(url.hostname)
        && ['5180', '5181', '5179'].includes(url.port) || /^\/(?:api\/tipsy-isle|api\/backends|__tauri)(?:\/|$)/i.test(url.pathname)) {
        throw new PluginApiError('PERMISSION_DENIED', '插件不能请求应用内部接口');
    }
    return url;
};
function noRedirect(url: string, init: RequestInit) {
    return platformFetch(url, { ...init, redirect: 'error', ...(isNativeRuntime() && { maxRedirections: 0 }) } as RequestInit);
}
export function pluginNetwork(owner: string, method: string, args: unknown, origins: string[], signal: AbortSignal) {
    const input = (method === 'download' ? networkSchema.extend({ name: z.string().max(160).optional() }) : networkSchema).parse(args) as z.infer<typeof networkSchema> & { name?: string };
    const url = checkExternal(httpEndpoint(input.url));
    if (!origins.includes(url.origin)) throw new PluginApiError('PERMISSION_DENIED', `未授权此地址：${url.origin}`);
    const headers = new Headers(input.headers);
    for (const key of headers.keys()) if (/^(?:cookie|host|origin|referer|proxy-|sec-|forwarded|x-forwarded-)/i.test(key)) throw new PluginApiError('INVALID_ARGUMENT', '不能覆盖宿主网络请求头');
    if (input.body !== undefined) headers.set('Content-Type', 'application/json');
    const fetchIt = (signal: AbortSignal) => noRedirect(url.href, { method: input.method, headers, body: input.body === undefined ? undefined : JSON.stringify(input.body), signal,
        credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer' });
    if (method === 'download') {
        signal.throwIfAborted();
        return start(owner, async task => {
            const response = await fetchIt(task.signal);
            if (!response.ok) { await response.body?.cancel(); throw new PluginApiError('NETWORK_ERROR', `下载失败 (${response.status})`); }
            return { kind: 'download', media: await saveMedia(owner, input.name ?? '下载文件', await readLimited(response, mediaLimit, task.signal, task.progress), task.signal) };
        });
    }
    return (async () => {
        try {
            const response = await fetchIt(signal);
            const body = await readLimited(response, 240_000, signal);
            return { status: response.status, contentType: body.type, text: await body.text() };
        } catch (error) { if (error instanceof PluginApiError || signal.aborted) throw error; throw new PluginApiError('NETWORK_ERROR', '请求失败，请检查目标地址、证书或网页跨域授权'); }
    })();
}

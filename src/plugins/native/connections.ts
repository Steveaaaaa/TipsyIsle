import { z } from 'zod';
import type { ModelConnection, ModelKind } from '../../../packages/plugin-sdk/index.js';
import { detectRuntimeFlavor, platformStorage, type StreamCompletionRequest } from '../../core/platform-bridge';
import { resolveMvuConnection } from '../../compatibility/mvu-connection';
import { getSchemaValues } from '../../registry/schema-registry';
import { enqueuePersistentOperation } from '../../store/persistence';
import { createReactiveStore } from '../../store/reactive-store';
import { PluginApiError } from './errors';

const key = 'native_plugin_model_connections';
interface Connection extends ModelConnection { baseUrl: string; apiKey: string; source: string; provider?: StreamCompletionRequest['provider']; headers?: Record<string, string> }
const modelKind = z.enum(['chat', 'image', 'speech', 'embedding']);
const customSchema = z.strictObject({ label: z.string().trim().min(1).max(80), model: z.string().trim().min(1).max(300),
    baseUrl: z.url(), apiKey: z.string().max(4000), kind: modelKind });
export type ConnectionInput = z.infer<typeof customSchema>;
export const connectionStore = createReactiveStore<{ items: Connection[] }>(() => ({ items: [] }));
let loading: Promise<void> | undefined;
export function loadConnections() {
    return loading ??= platformStorage.loadSnapshot<Connection[]>(key, []).then(items => connectionStore.setState({ items })).catch(error => { loading = undefined; throw error; });
}
export function httpEndpoint(value: string) {
    let url: URL;
    try { url = new URL(value); } catch { throw new PluginApiError('INVALID_ARGUMENT', '请填写有效的 HTTP(S) 地址'); }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash) throw new PluginApiError('INVALID_ARGUMENT', '地址必须是 HTTP(S)，且不能包含登录信息');
    return url;
}
export const connectionSummary = ({ id, label, model, kinds }: Connection): ModelConnection => ({ id, label, model, kinds });
export function saveConnection(input: ConnectionInput, id?: string) {
    return enqueuePersistentOperation(async () => {
        await loadConnections();
        const { kind, ...config } = customSchema.parse(input);
        httpEndpoint(config.baseUrl);
        const entry: Connection = { ...config, id: id ?? crypto.randomUUID(), kinds: [kind], source: 'openai' };
        const items = [...connectionStore.getState().items.filter(item => item.id !== entry.id), entry];
        await platformStorage.saveSnapshots({ [key]: items }, false); connectionStore.setState({ items });
    });
}
export function removeConnection(id: string) {
    return enqueuePersistentOperation(async () => {
        await loadConnections();
        const items = connectionStore.getState().items.filter(c => c.id !== id);
        await platformStorage.saveSnapshots({ [key]: items }, false); connectionStore.setState({ items });
    });
}
const fromMvu = (id: string, label: string, settings: Record<string, unknown>): Connection | undefined => {
    try {
        const { api, provider } = resolveMvuConnection(settings);
        if (!api.model || !api.apiurl && !provider) return;
        return { id, label, model: api.model, kinds: ['chat'], baseUrl: api.apiurl ?? '', apiKey: api.key ?? '', source: api.source ?? 'openai', provider, headers: api.custom_include_headers };
    } catch { return; }
};
async function availableConnections(): Promise<Connection[]> {
    await loadConnections();
    const s = getSchemaValues(), value = (key: string) => String(s[key] ?? '').trim();
    const items = [...connectionStore.getState().items];
    if (value('api.custom_url') && value('api.model')) items.push({ id: 'current-chat', label: '当前聊天连接', model: value('api.model'), kinds: ['chat'],
        baseUrl: value('api.custom_url'), apiKey: value('api.key'), source: value('api.chat_completion_source') || 'openai' });
    if (value('vectors.url') && value('vectors.model')) items.push({ id: 'worldbook-embedding', label: '世界书嵌入连接', model: value('vectors.model'), kinds: ['embedding'],
        baseUrl: value('vectors.url'), apiKey: value('vectors.key'), source: 'openai' });
    const live = fromMvu('current-mvu', '当前 MVU 连接', s); if (live) items.push(live);
    try {
        const profiles = JSON.parse(value('mvu.profiles') || '[]') as { 名称: string }[];
        for (const p of profiles) {
            const item = fromMvu(`mvu:${p.名称}`, p.名称, { ...s, 'mvu.profile': p.名称 });
            if (item) items.push(item);
        }
    } catch { /* Incomplete settings do not remove the other connections. */ }
    const flavor = await detectRuntimeFlavor();
    return items.filter(item => flavor === 'local-gateway' || !item.provider && !['claude', 'anthropic', 'makersuite', 'gemini', 'vertexai', 'openai-responses'].includes(item.source));
}
export async function connectionChoices() { return (await availableConnections()).map(connectionSummary); }
export async function authorizedConnection(id: string, kind: ModelKind, grants: string[]) {
    if (!grants.includes(id)) throw new PluginApiError('PERMISSION_DENIED', '请在插件权限中选择允许使用的模型连接');
    const connection = (await availableConnections()).find(item => item.id === id && item.kinds.includes(kind));
    if (!connection) throw new PluginApiError('UNAVAILABLE', '这条模型连接不可用或不支持此任务');
    return connection;
}

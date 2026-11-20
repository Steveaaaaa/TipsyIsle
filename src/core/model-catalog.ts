import { platformFetch } from './native-runtime';
import { detectRuntimeFlavor, platformStorage } from './platform-bridge';

export interface ModelListConnection {
    baseUrl: string;
    apiKey?: string;
    source?: string;
    includeHeaders?: Record<string, string>;
    catalogProvider?: string;
}
export interface CatalogModel { id: string; api?: string; contextWindow?: number }

export function modelCatalogIdentity(connection: ModelListConnection): string {
    return JSON.stringify([connection.baseUrl.trim().replace(/\/+$/, '').replace(/\/(?:chat\/completions|messages|responses|embeddings|models)$/, ''),
        connection.apiKey ?? '', connection.source ?? 'openai', connection.catalogProvider ?? '',
        Object.entries(connection.includeHeaders ?? {}).sort(([a], [b]) => a.localeCompare(b))]);
}
async function catalogCacheKey(connection: ModelListConnection) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(modelCatalogIdentity(connection)));
    return `model_catalog:${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')}`;
}
export async function readModelCatalogCache(connection: ModelListConnection): Promise<CatalogModel[] | null> {
    return platformStorage.loadSnapshot<CatalogModel[] | null>(await catalogCacheKey(connection), null);
}
export async function saveModelCatalogCache(connection: ModelListConnection, models: CatalogModel[]) {
    // Cache only the model metadata; credentials are represented by a one-way digest.
    await platformStorage.saveSnapshots({ [await catalogCacheKey(connection)]: models }, false);
}

export function modelListConnection(fieldId: string, settings: Record<string, unknown>): ModelListConnection {
    if (fieldId === 'api.model') return { baseUrl: String(settings['api.custom_url'] ?? ''), apiKey: String(settings['api.key'] ?? ''), source: String(settings['api.chat_completion_source'] ?? 'openai') };
    if (fieldId === 'vectors.model') return { baseUrl: String(settings['vectors.url'] ?? ''), apiKey: String(settings['vectors.key'] ?? ''), source: 'openai' };
    if (settings['mvu.source'] === '与插头相同') return modelListConnection('api.model', settings);
    const provider = String(settings['mvu.provider'] ?? 'openai');
    const baseUrl = String(settings['mvu.url'] ?? '').trim();
    const more = settings['mvu.source'] === '更多';
    const protocol = String(settings['mvu.provider_api'] ?? '');
    const source = more ? protocol === 'anthropic-messages' || !protocol && provider === 'anthropic' ? 'claude'
        : protocol === 'google-generative-ai' || !protocol && provider === 'google' ? 'makersuite' : 'openai'
        : String(settings['mvu.protocol'] ?? 'openai');
    const rawHeaders = settings['mvu.headers'];
    const includeHeaders = typeof rawHeaders === 'string' ? JSON.parse(rawHeaders.trim() || '{}') : rawHeaders ?? {};
    if (!includeHeaders || typeof includeHeaders !== 'object' || Array.isArray(includeHeaders) || Object.values(includeHeaders).some(value => typeof value !== 'string')) throw new Error('自定义解析请求头需要是 JSON 字符串键值对象。');
    return { baseUrl, apiKey: String(settings['mvu.key'] ?? ''), source, includeHeaders: includeHeaders as Record<string, string>,
        ...(more && (!baseUrl || settings['mvu.auth_type'] === 'oauth') ? { catalogProvider: provider } : {}) };
}

/** The settings UI and author API share one transport on web and installed clients. */
export async function fetchModelCatalog(connection: ModelListConnection, signal?: AbortSignal): Promise<CatalogModel[]> {
    const gateway = await detectRuntimeFlavor() === 'local-gateway';
    const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000);
    let response: Response;
    if (connection.catalogProvider) {
        if (!gateway) throw new Error('服务商内置目录需要本机网页网关；安装版请填写 API 地址后获取模型列表。');
        response = await fetch(`/api/tipsy-isle/llm/catalog?provider=${encodeURIComponent(connection.catalogProvider)}`, { signal: requestSignal });
    } else {
        if (!connection.baseUrl.trim()) throw new Error('请先填写 API 地址，再获取模型列表。');
        const base = connection.baseUrl.trim().replace(/\/+$/, '').replace(/\/(?:chat\/completions|messages|responses|embeddings|models)$/, '');
        const headers: Record<string, string> = {};
        let endpointBase = base;
        if (['claude', 'anthropic'].includes(connection.source ?? '')) {
            if (!endpointBase.endsWith('/v1')) endpointBase += '/v1';
            headers['x-api-key'] = connection.apiKey ?? '';
            headers['anthropic-version'] = '2023-06-01';
        } else if (['makersuite', 'gemini'].includes(connection.source ?? '')) headers['x-goog-api-key'] = connection.apiKey ?? '';
        else if (connection.apiKey) headers.Authorization = `Bearer ${connection.apiKey}`;
        Object.assign(headers, connection.includeHeaders);
        const endpoint = new URL(`${endpointBase}/models`);
        if (!['http:', 'https:'].includes(endpoint.protocol)) throw new Error('API 地址需要以 http:// 或 https:// 开头。');
        response = gateway ? await fetch('/api/tipsy-isle/llm/models', { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ baseUrl: base, apiKey: connection.apiKey, source: connection.source, includeHeaders: connection.includeHeaders }), signal: requestSignal })
            : await platformFetch(endpoint.href, { headers, signal: requestSignal });
    }
    if (!response.ok) {
        const detail = gateway ? await response.json().catch(() => ({})) : {};
        throw new Error(response.status === 401 || response.status === 403 || /\b(?:401|403)\b/.test(String(detail.error ?? ''))
            ? '无法读取模型列表，请检查 API Key 和访问权限。'
            : `读取模型列表失败（${response.status}），请检查 API 地址；服务商也可能未提供模型列表接口。`);
    }
    const payload = await response.json();
    if (payload.error) throw new Error('服务商返回了模型列表错误，请检查连接设置。');
    const entries = Array.isArray(payload) ? payload : payload.data ?? payload.models;
    if (!Array.isArray(entries)) throw new Error('接口未返回可识别的模型列表，仍可手动填写模型名称。');
    const models = new Map<string, CatalogModel>();
    for (const entry of entries) {
        const id = String(typeof entry === 'string' ? entry : entry?.id ?? entry?.name ?? '').trim().replace(/^models\//, '');
        if (id) models.set(id, { id, ...(typeof entry?.api === 'string' ? { api: entry.api } : {}), ...(typeof entry?.contextWindow === 'number' ? { contextWindow: entry.contextWindow } : {}) });
    }
    return [...models.values()].sort((a, b) => a.id.localeCompare(b.id));
}

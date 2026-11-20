import { detectRuntimeFlavor } from '../core/platform-bridge';
import { compatibilityOrigin, platformFetch } from '../core/native-runtime';
import { excludeRequestFields } from '../core/request-fields';
import { getSchemaValues } from '../registry/schema-registry';
import { requestComfy } from './comfy-http';

const active = new Map<string, { controller: AbortController; reader?: ReadableStreamDefaultReader<Uint8Array> }>();
const parse = (value: any) => typeof value === 'string' ? JSON.parse(value || '{}') : value ?? {};

/** Relay the provider's original JSON or SSE; plugin requests bypass the story pipeline. */
export async function openTavernCompletion(id: string, path: string, body: Record<string, any>, useCurrent = false) {
    if (path === '/api/sd/comfy/ping' || path === '/api/sd/comfy/generate') {
        const controller = new AbortController();
        active.set(id, { controller });
        try {
            const result = await requestComfy(path, { url: body.url, prompt: body.prompt }, controller.signal);
            controller.signal.throwIfAborted();
            const response = new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } });
            active.set(id, { controller, reader: response.body!.getReader() });
            return { status: 200, statusText: 'OK', contentType: 'application/json', hasBody: true };
        } catch (error) { active.delete(id); throw error; }
    }
    const status = path.endsWith('/status');
    const { chat_completion_source: source = 'openai', reverse_proxy, proxy_password, custom_url, custom_include_headers, custom_include_body,
        custom_exclude_body, messages, model, stream, ...parameters } = body;
    for (const key of ['use_sysprompt', 'custom_prompt_post_processing', 'show_thoughts', 'include_reasoning', 'request_type']) delete parameters[key];
    if (!useCurrent && !['openai', 'custom'].includes(source)) throw new Error(`暂未接入该扩展模型协议：${source}`);
    const settings = useCurrent ? getSchemaValues() : {};
    const baseUrl = String(useCurrent ? settings['api.custom_url'] ?? '' : custom_url || reverse_proxy || '').trim().replace(/\/+$/, '');
    const endpoint = new URL(baseUrl);
    if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash ||
        [location.origin, compatibilityOrigin].includes(endpoint.origin)) throw new Error('扩展模型地址无效');
    const apiKey = useCurrent ? String(settings['api.key'] ?? '') : String(proxy_password ?? '');
    const actualSource = useCurrent ? String(settings['api.chat_completion_source'] ?? 'openai') : source;
    const actualModel = useCurrent ? String(settings['api.model'] ?? '') : model;
    const includeHeaders = useCurrent ? {} : parse(custom_include_headers) as Record<string, string>;
    const includeBody = useCurrent ? {} : parse(custom_include_body) as Record<string, unknown>;
    const excludeBody: string[] = Array.isArray(custom_exclude_body) ? custom_exclude_body : String(custom_exclude_body ?? '').split(/[,\n]/).map(value => value.trim()).filter(Boolean);
    const controller = new AbortController();
    active.set(id, { controller });
    try {
        const gateway = await detectRuntimeFlavor() === 'local-gateway';
        if (!gateway && !['openai', 'custom', 'deepseek'].includes(actualSource)) throw new Error('当前模型协议需要本地网关');
        const headers = { 'Content-Type': 'application/json' };
        const nativeHeaders = { ...headers, ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}), ...includeHeaders };
        const signal = controller.signal;
        let response: Response;
        if (status) {
            response = gateway ? await fetch('/api/tipsy-isle/llm/models', { method: 'POST', headers, signal,
                body: JSON.stringify({ baseUrl, apiKey, source: actualSource, includeHeaders }) })
                : await platformFetch(`${baseUrl.replace(/\/(?:chat\/completions|models)$/, '')}/models`, { headers: nativeHeaders, signal });
            if (!response.ok) {
                await response.body?.cancel();
                response = Response.json({ error: true, data: { data: [] } });
            }
        } else if (gateway) {
            response = await fetch('/api/tipsy-isle/llm/stream', { method: 'POST', headers, signal,
                body: JSON.stringify({ source: actualSource, baseUrl, apiKey, model: actualModel, messages, parameters, stream: !!stream, includeHeaders, includeBody, excludeBody }) });
        } else {
            const payload = { ...parameters, model: actualModel, messages, stream: !!stream, ...includeBody };
            excludeRequestFields(payload, excludeBody);
            response = await platformFetch(baseUrl.endsWith('/chat/completions') ? baseUrl : `${baseUrl}/chat/completions`, {
                method: 'POST', headers: nativeHeaders, signal, body: JSON.stringify(payload),
            });
        }
        const reader = response.body?.getReader();
        if (reader) {
            const pending = active.get(id);
            if (pending) pending.reader = reader;
            else { await reader.cancel(); signal.throwIfAborted(); }
        } else active.delete(id);
        return { status: response.status, statusText: response.statusText, contentType: response.headers.get('Content-Type'), hasBody: !!reader };
    } catch (error) { active.delete(id); throw error; }
}

export async function readTavernCompletion(id: string) {
    const reader = active.get(id)?.reader;
    if (!reader) return null;
    try {
        const { done, value } = await reader.read();
        if (done) active.delete(id);
        return value ?? null;
    } catch (error) { active.delete(id); throw error; }
}

export function cancelTavernCompletion(id?: string) {
    for (const [key, task] of active) if (!id || key === id) { active.delete(key); task.controller.abort(); }
}

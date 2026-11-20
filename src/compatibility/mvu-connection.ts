import type { StreamCompletionRequest } from '../core/platform-bridge';
import type { HelperGenerationConfig } from './contracts';
import { DEFAULT_MVU_RESPONSE_TOKENS } from '../core/generation-defaults';

function json(value: unknown, fallback: unknown) { return typeof value === 'string' ? JSON.parse(value.trim() || JSON.stringify(fallback)) : value ?? fallback; }
export function resolveMvuConnection(input: Record<string, unknown>) {
    const settings = { ...input };
    const selected = String(settings['mvu.profile'] ?? '').trim();
    if (selected) {
        const profiles = json(settings['mvu.profiles'], []);
        if (!Array.isArray(profiles)) throw new Error('MVU 连接方案必须是 JSON 数组');
        const profile = profiles.find(profile => profile.名称 === selected);
        if (!profile) throw new Error(`MVU 连接方案不存在：${selected}`);
        settings['mvu.source'] = profile.backend === 'pi' ? '更多' : '自定义';
        const fields: Record<string, string> = { api地址: 'url', 密钥: 'key', 模型名称: 'model', 破限方案: 'prompt_strategy', 其他预设名称: 'preset', 随机头部: 'random_header', 应答格式: 'format', 关闭thinking: 'disable_thinking', 兼容假流式: 'pseudo_stream' };
        for (const [key, id] of Object.entries(fields)) if (profile[key] !== undefined) settings[`mvu.${id}`] = profile[key];
        for (const key of ['protocol', 'temperature', 'frequency_penalty', 'presence_penalty', 'top_p', 'top_k', 'max_tokens', 'headers', 'include_body', 'exclude_body']) {
            if (profile.request?.[key] !== undefined) settings[`mvu.${key}`] = profile.request[key];
        }
        if (profile.backend === 'pi') {
            if (!profile.pi) throw new Error('Pi 方案缺少连接设置');
            settings['mvu.auth_type'] = profile.pi.authType ?? 'api_key';
            for (const [key, id] of Object.entries({ provider: 'provider', api: 'provider_api', endpoint: 'url', model: 'model', contextWindow: 'context_window', thinkingLevel: 'thinking', customHeaders: 'headers', customIncludeBody: 'include_body', customExcludeBody: 'exclude_body' })) {
                if (profile.pi[key] !== undefined) settings[`mvu.${id}`] = profile.pi[key];
            }
        }
    }
    const independent = settings['mvu.source'] !== '与插头相同';
    const api: NonNullable<HelperGenerationConfig['custom_api']> = {
        apiurl: String(settings[independent ? 'mvu.url' : 'api.custom_url'] ?? ''), key: String(settings[independent ? 'mvu.key' : 'api.key'] ?? ''),
        model: String(settings[independent ? 'mvu.model' : 'api.model'] ?? ''),
        source: String(settings[independent ? 'mvu.protocol' : 'api.chat_completion_source'] ?? 'openai'),
        max_tokens: Number(settings['mvu.max_tokens'] ?? DEFAULT_MVU_RESPONSE_TOKENS),
    };
    if (independent) {
        for (const key of ['temperature', 'frequency_penalty', 'presence_penalty', 'top_p', 'top_k'] as const) api[key] = Number(settings[`mvu.${key}`]);
        api.custom_include_body = json(settings['mvu.include_body'], {});
        api.custom_exclude_body = json(settings['mvu.exclude_body'], []);
        api.custom_include_headers = json(settings['mvu.headers'], {});
        if (!api.custom_include_body || typeof api.custom_include_body !== 'object' || Array.isArray(api.custom_include_body)) throw new Error('MVU 请求体覆盖必须为 JSON 对象');
        if (!Array.isArray(api.custom_exclude_body) || api.custom_exclude_body.some(key => typeof key !== 'string')) throw new Error('MVU 排除字段必须为字符串数组');
        if (!api.custom_include_headers || typeof api.custom_include_headers !== 'object' || Array.isArray(api.custom_include_headers) || Object.values(api.custom_include_headers).some(value => typeof value !== 'string')) throw new Error('MVU 请求头必须为字符串键值对象');
    }
    if (settings['mvu.disable_thinking']) api.custom_include_body = { ...api.custom_include_body, thinking: { type: 'disabled' } };
    const provider: StreamCompletionRequest['provider'] = settings['mvu.source'] === '更多' ? {
        provider: String(settings['mvu.provider']), api: String(settings['mvu.provider_api'] || ''),
        authType: settings['mvu.auth_type'] === 'oauth' ? 'oauth' : 'api_key',
        thinkingLevel: settings['mvu.disable_thinking'] ? 'off' : String(settings['mvu.thinking'] ?? 'default'), contextWindow: Number(settings['mvu.context_window'] ?? 0),
    } : undefined;
    if (provider) api.source = 'pi';
    return { settings, api, provider };
}

import { defaultParametersForSource, parseConnectionProfiles } from '../core/model-profiles';

export interface ResolvedProxyPreset {
    name: string;
    url: string;
    password: string;
    source?: string;
    model?: string;
}

export interface ExtraProxyConnection {
    name: string;
    baseUrl: string;
    apiKey?: string;
    source?: string;
    model?: string;
    kinds?: readonly string[];
}

export const CURRENT_CONNECTION_PROXY_PRESET = '当前连接';
export const AUXILIARY_CONNECTION_PROXY_PRESET = '额外模型连接';

function isHttpUrl(value: unknown): value is string {
    return typeof value === 'string' && /^https?:\/\//i.test(value.trim());
}

function resolveUrl(rawUrl: unknown, source?: string): string {
    const trimmed = typeof rawUrl === 'string' ? rawUrl.trim() : '';
    if (trimmed) return isHttpUrl(trimmed) ? trimmed : '';
    if (source) {
        const fallback = defaultParametersForSource(source).baseUrl;
        if (isHttpUrl(fallback)) return fallback.trim();
    }
    return '';
}

function parseJsonArray(value: unknown): unknown[] {
    if (Array.isArray(value)) return value;
    if (typeof value === 'string' && value.trim()) {
        try {
            const parsed = JSON.parse(value);
            return Array.isArray(parsed) ? parsed : [];
        } catch {
            return [];
        }
    }
    return [];
}

/**
 * Resolve named proxy presets for TavernHelper / SillyTavern extensions from explicit
 * `api.proxy_presets`, saved story connection profiles, MVU profiles, plugin connections,
 * and the active connection.
 */
export function resolveProxyPresets(
    settings: Record<string, unknown>,
    extraConnections: readonly ExtraProxyConnection[] = [],
): ResolvedProxyPreset[] {
    const result: ResolvedProxyPreset[] = [];
    const seen = new Set<string>();
    const add = (entry: ResolvedProxyPreset) => {
        const name = entry.name.trim();
        const url = entry.url.trim();
        if (!name || !isHttpUrl(url) || seen.has(name)) return;
        seen.add(name);
        result.push({
            name,
            url,
            password: entry.password ?? '',
            ...(entry.source ? { source: entry.source } : {}),
            ...(entry.model ? { model: entry.model } : {}),
        });
    };

    const explicit = settings['api.proxy_presets'];
    if (Array.isArray(explicit)) {
        for (const item of explicit) {
            if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
            const raw = item as Record<string, unknown>;
            if (typeof raw.name !== 'string' || !isHttpUrl(raw.url)) continue;
            add({
                name: raw.name,
                url: raw.url,
                password: typeof raw.password === 'string' ? raw.password : '',
                source: typeof raw.source === 'string' && raw.source.trim() ? raw.source.trim() : undefined,
                model: typeof raw.model === 'string' && raw.model.trim() ? raw.model.trim() : undefined,
            });
        }
    }

    for (const profile of parseConnectionProfiles(settings['api.connection_profiles'])) {
        const url = resolveUrl(profile.baseUrl, profile.source);
        if (!url) continue;
        add({
            name: profile.name,
            url,
            password: profile.apiKey,
            source: profile.source,
            model: profile.model,
        });
    }

    for (const entry of parseJsonArray(settings['mvu.profiles'])) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
        const item = entry as Record<string, any>;
        if (item.backend === 'pi' && !isHttpUrl(item.pi?.endpoint) && !isHttpUrl(item.api地址)) continue;
        const name = String(item.名称 ?? '').trim();
        const source = String(item.request?.protocol ?? 'openai').trim() || 'openai';
        const url = resolveUrl(item.api地址 ?? item.pi?.endpoint, source);
        if (!name || !url) continue;
        const model = String(item.模型名称 ?? item.pi?.model ?? '').trim();
        add({
            name,
            url,
            password: String(item.密钥 ?? ''),
            source,
            ...(model ? { model } : {}),
        });
    }

    if (settings['mvu.source'] === '自定义') {
        const mvuSource = String(settings['mvu.protocol'] ?? 'openai').trim() || 'openai';
        const mvuUrl = resolveUrl(settings['mvu.url'], mvuSource);
        if (mvuUrl) {
            const mvuModel = String(settings['mvu.model'] ?? '').trim();
            add({
                name: AUXILIARY_CONNECTION_PROXY_PRESET,
                url: mvuUrl,
                password: String(settings['mvu.key'] ?? ''),
                source: mvuSource,
                ...(mvuModel ? { model: mvuModel } : {}),
            });
        }
    }

    for (const connection of extraConnections) {
        if (connection.kinds && !connection.kinds.includes('chat')) continue;
        const source = connection.source?.trim() || undefined;
        const url = resolveUrl(connection.baseUrl, source);
        if (!url) continue;
        add({
            name: connection.name,
            url,
            password: connection.apiKey ?? '',
            ...(source ? { source } : {}),
            ...(connection.model?.trim() ? { model: connection.model.trim() } : {}),
        });
    }

    const currentSourceRaw = typeof settings['api.chat_completion_source'] === 'string'
        ? settings['api.chat_completion_source'].trim()
        : '';
    const currentSource = currentSourceRaw || 'openai';
    const currentUrl = resolveUrl(settings['api.custom_url'], currentSourceRaw || undefined);
    if (currentUrl) {
        const currentModel = String(settings['api.model'] ?? '').trim();
        add({
            name: CURRENT_CONNECTION_PROXY_PRESET,
            url: currentUrl,
            password: String(settings['api.key'] ?? ''),
            source: currentSource,
            ...(currentModel ? { model: currentModel } : {}),
        });
    }

    return result;
}

export function findProxyPreset(
    settings: Record<string, unknown>,
    name: string,
    extraConnections: readonly ExtraProxyConnection[] = [],
): ResolvedProxyPreset | undefined {
    const presets = resolveProxyPresets(settings, extraConnections);
    const trimmed = name.trim();
    return presets.find(item => item.name === name) ?? presets.find(item => item.name === trimmed);
}

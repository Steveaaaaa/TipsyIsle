export function isGeminiSource(source?: string): boolean {
    return source === 'makersuite' || source === 'gemini';
}

export function geminiEndpoint(baseUrl: string, resource: string): URL {
    if (!baseUrl.trim()) throw new Error('请填写 Gemini API 地址。');
    const endpoint = new URL(baseUrl.trim());
    if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
        throw new Error('请填写不含密钥或查询参数的 Gemini API 基础地址。');
    }
    const path = endpoint.pathname.replace(/\/+$/, '').replace(/\/models$/, '');
    endpoint.pathname = `${path || (endpoint.hostname === 'generativelanguage.googleapis.com' ? '/v1beta' : '')}/${resource}`;
    return endpoint;
}

export function geminiHeaders(apiKey: string, overrides?: Record<string, string>): Headers {
    const headers = new Headers(overrides);
    if (apiKey && !headers.has('x-goog-api-key')) headers.set('x-goog-api-key', apiKey);
    return headers;
}

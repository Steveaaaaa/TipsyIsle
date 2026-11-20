const routes = new Set(['/api/characters/get', '/api/characters/merge-attributes', '/api/settings/get', '/api/worldinfo/get']);
const completions = new Set(['/api/backends/chat-completions/generate', '/api/backends/chat-completions/status']);
const mediaRoute = /^\/api\/(images\/(?:upload|folders|list(?:\/[^/]+)?|delete)|files\/(?:upload|delete|verify))$/;
const comfyRoute = /^\/api\/sd\/comfy\/(ping|generate)$/;
type HostRequest = (method: string, params: any, timeout?: number) => Promise<any>;

export async function tavernCompletionResponse(win: Window & typeof globalThis, request: HostRequest, path: string, body: unknown, signal?: AbortSignal, useCurrent = false): Promise<Response> {
    signal?.throwIfAborted();
    const id = crypto.randomUUID();
    const dispose = () => signal?.removeEventListener('abort', cancel);
    const cancel = () => { dispose(); void request('extension.completion.cancel', { id }).catch(() => {}); };
    signal?.addEventListener('abort', cancel, { once: true });
    try {
        const result = await request('extension.completion.open', { id, path, body, useCurrent }, 600000);
        signal?.throwIfAborted();
        if (!result.hasBody) dispose();
        const stream = result.hasBody ? new win.ReadableStream<Uint8Array>({
            async pull(controller) {
                try {
                    signal?.throwIfAborted();
                    const value = await request('extension.completion.read', { id }, 600000);
                    signal?.throwIfAborted();
                    if (value) controller.enqueue(value); else { dispose(); controller.close(); }
                } catch (error) { cancel(); controller.error(error); }
            },
            cancel,
        }) : null;
        return new win.Response(stream, { status: result.status, statusText: result.statusText,
            headers: result.contentType ? { 'Content-Type': result.contentType } : undefined });
    } catch (error) { cancel(); throw error; }
}

/** Original-host resource requests use RPC; other URLs retain browser fetch semantics. */
export function installHostFetch(win: Window & typeof globalThis, request: HostRequest): void {
    const nativeFetch = win.fetch.bind(win);
    win.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const base = win.document.baseURI;
        const url = new URL(typeof input === 'string' ? input : 'url' in input ? input.url : input.href, base);
        const media = mediaRoute.test(url.pathname), comfy = comfyRoute.test(url.pathname);
        if (url.origin !== new URL(base).origin || !routes.has(url.pathname) && !completions.has(url.pathname) && !media && !comfy) return nativeFetch(input, init);
        const req = new win.Request(url, { ...(typeof input === 'object' && 'url' in input ? {
            method: input.method, headers: input.headers, signal: input.signal,
            body: ['GET', 'HEAD'].includes(input.method) ? undefined : await input.clone().text(),
        } : {}), ...init });
        req.signal.throwIfAborted();
        const response = (value: unknown, status = 200) => new win.Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
        if (req.method !== 'POST') return response({ error: 'Method not allowed' }, 405);
        let body: unknown;
        try { body = JSON.parse(await req.text()); } catch { return response({ error: 'Invalid JSON' }, 400); }
        try {
            if (completions.has(url.pathname) || comfy) return await tavernCompletionResponse(win, request, url.pathname, body, req.signal);
            if (media) {
                const result = await request('extension.media', { path: url.pathname, body }, 60000);
                req.signal.throwIfAborted();
                return response(result.body, result.status);
            }
            const result = await request('host.http', { path: url.pathname, body });
            req.signal.throwIfAborted();
            return response(result);
        } catch (error) {
            req.signal.throwIfAborted();
            if (url.pathname.endsWith('/status')) return response({ error: true });
            return response({ error: error instanceof Error ? error.message : String(error) }, 400);
        }
    };
}

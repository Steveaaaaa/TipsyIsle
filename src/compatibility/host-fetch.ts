const routes = new Set([
    '/api/characters/get',
    '/api/characters/merge-attributes',
    '/api/settings/get',
    '/api/worldinfo/get',
    '/api/worldinfo/edit',
    '/api/worldinfo/delete',
    '/api/worldinfo/list',
]);
const completions = new Set(['/api/backends/chat-completions/generate', '/api/backends/chat-completions/status']);
const mediaRoute = /^\/api\/(images\/(?:upload|folders|list(?:\/[^/]+)?|delete)|files\/(?:upload|delete|verify))$/;
const comfyRoute = /^\/api\/sd\/comfy\/(ping|generate)$/;
const memoryVectorRoute = '/api/plugins/baibaoku/v1/';
const csrfRoute = '/csrf-token';
type HostRequest = (method: string, params: any, timeout?: number) => Promise<any>;
type HostMemoryHooks = {
    revision(): string | undefined;
    beforeVector?(action: string): Promise<unknown> | undefined;
    vectorResult(action: string, body: any): void;
    onWorldInfoEdited?(name: string, data: unknown): void;
};

interface MatchedHostRoute {
    url: URL;
    media: boolean;
    comfy: boolean;
    vectorAction?: string;
    csrf: boolean;
}

function resolveBaseUri(win: Window & typeof globalThis): string {
    const base = win.document?.baseURI;
    if (base && base !== 'about:blank' && base !== 'about:srcdoc') return base;
    const parentBase = win.parent && win.parent !== win ? (() => { try { return win.parent.document?.baseURI; } catch { return ''; } })() : '';
    if (parentBase && parentBase !== 'about:blank' && parentBase !== 'about:srcdoc') return parentBase;
    return win.location?.href || 'http://127.0.0.1/';
}

function matchHostRoute(win: Window & typeof globalThis, rawUrl: string): MatchedHostRoute | null {
    const base = resolveBaseUri(win);
    const url = new URL(rawUrl, base);
    if (url.origin !== new URL(base).origin) return null;
    const media = mediaRoute.test(url.pathname), comfy = comfyRoute.test(url.pathname), vector = url.pathname.startsWith(memoryVectorRoute), csrf = url.pathname === csrfRoute;
    if (!routes.has(url.pathname) && !completions.has(url.pathname) && !media && !comfy && !vector && !csrf) return null;
    return { url, media, comfy, csrf, vectorAction: vector ? url.pathname.slice(memoryVectorRoute.length) : undefined };
}

function parseRequestBody(rawText: string, contentType: string | null): unknown {
    if (!rawText.trim()) return {};
    if (contentType?.toLowerCase().includes('application/x-www-form-urlencoded')) {
        return Object.fromEntries(new URLSearchParams(rawText));
    }
    return JSON.parse(rawText);
}

async function dispatchHostRequest(
    win: Window & typeof globalThis,
    request: HostRequest,
    matched: MatchedHostRoute,
    method: string,
    rawBody: string,
    contentType: string | null,
    signal: AbortSignal,
    memory?: HostMemoryHooks,
): Promise<Response> {
    const { url, media, comfy, vectorAction, csrf } = matched;
    const revision = vectorAction ? memory?.revision() : undefined;
    signal.throwIfAborted();
    const response = (value: unknown, status = 200) => new win.Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
    const expectedMethod = vectorAction === 'status' || csrf ? 'GET' : 'POST';
    if (method.toUpperCase() !== expectedMethod) return response({ error: 'Method not allowed' }, 405);
    if (csrf) return response({ token: 'tipsy-isle-csrf-token' });
    let body: unknown = {};
    if (method.toUpperCase() === 'POST') {
        try { body = parseRequestBody(rawBody, contentType); } catch { return response({ error: 'Invalid JSON' }, 400); }
    }
    try {
        if (vectorAction) {
            if (revision !== memory?.revision()) throw new Error('向量请求所属剧情已切换');
            const prepare = memory?.beforeVector?.(vectorAction);
            if (prepare) await prepare;
            if (revision !== memory?.revision()) throw new Error('向量请求所属剧情已切换');
            const result = await request('extension.memoryVector', { action: vectorAction, body }, 60000);
            signal.throwIfAborted();
            if (revision !== memory?.revision()) throw new Error('向量请求所属剧情已切换');
            memory?.vectorResult(vectorAction, result.body);
            return response(result.body, result.status);
        }
        if (completions.has(url.pathname) || comfy) return await tavernCompletionResponse(win, request, url.pathname, body, signal);
        if (media) {
            const result = await request('extension.media', { path: url.pathname, body }, 60000);
            signal.throwIfAborted();
            return response(result.body, result.status);
        }
        const result = await request('host.http', { path: url.pathname, body });
        signal.throwIfAborted();
        if (url.pathname === '/api/worldinfo/edit' && body && typeof body === 'object' && 'name' in body && 'data' in body) {
            memory?.onWorldInfoEdited?.(String((body as Record<string, unknown>).name), (body as Record<string, unknown>).data);
        }
        return response(result);
    } catch (error) {
        signal.throwIfAborted();
        if (url.pathname.endsWith('/status')) return response({ error: true });
        return response({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
}

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

/** Original-host resource requests use RPC; other URLs retain browser fetch and XHR semantics. */
export function installHostFetch(win: Window & typeof globalThis, request: HostRequest, memory?: HostMemoryHooks): void {
    const nativeFetch = win.fetch.bind(win);
    win.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const rawUrl = typeof input === 'string' ? input : 'url' in input ? input.url : input.href;
        const matched = matchHostRoute(win, rawUrl);
        if (!matched) return nativeFetch(input, init);
        const req = new win.Request(matched.url, { ...(typeof input === 'object' && 'url' in input ? {
            method: input.method, headers: input.headers, signal: input.signal,
            body: ['GET', 'HEAD'].includes(input.method) ? undefined : await input.clone().text(),
        } : {}), ...init });
        const rawBody = ['GET', 'HEAD'].includes(req.method.toUpperCase()) ? '' : await req.text();
        return dispatchHostRequest(win, request, matched, req.method, rawBody, req.headers.get('content-type'), req.signal, memory);
    };

    const NativeXHR = win.XMLHttpRequest;
    if (typeof NativeXHR !== 'function') return;
    interface InterceptedXHRState {
        matched: MatchedHostRoute;
        method: string;
        headers: Headers;
        controller: AbortController;
        readyState: number;
        status: number;
        statusText: string;
        responseText: string;
        responseType: XMLHttpRequestResponseType;
        responseHeaders: Map<string, string>;
        aborted: boolean;
    }
    const states = new WeakMap<XMLHttpRequest, InterceptedXHRState>();
    const shadowedKeys = ['readyState', 'status', 'statusText', 'responseText', 'response', 'responseURL', 'responseType'] as const;
    const ensureAccessors = (target: CompatXMLHttpRequest) => {
        for (const key of shadowedKeys) {
            if (!Object.hasOwn(target, key)) continue;
            const desc = Object.getOwnPropertyDescriptor(CompatXMLHttpRequest.prototype, key);
            if (desc) Object.defineProperty(target, key, desc);
        }
    };
    const emitEvent = (target: XMLHttpRequest, type: string, progress = false) => {
        const Ctor = progress && win.ProgressEvent ? win.ProgressEvent : win.Event;
        const evt = new Ctor(type);
        target.dispatchEvent(evt);
        if (!(`on${type}` in NativeXHR.prototype)) {
            const handler = (target as any)[`on${type}`];
            if (typeof handler === 'function') handler.call(target, evt);
        }
    };
    class CompatXMLHttpRequest extends NativeXHR {
        override get readyState() { return states.get(this)?.readyState ?? super.readyState; }
        override get status() { return states.get(this)?.status ?? super.status; }
        override get statusText() { return states.get(this)?.statusText ?? super.statusText; }
        override get responseText() { return states.get(this)?.responseText ?? super.responseText; }
        override get responseURL() { return states.get(this)?.matched.url.href ?? super.responseURL; }
        override get responseType() { return states.get(this)?.responseType ?? super.responseType; }
        override set responseType(value: XMLHttpRequestResponseType) {
            const state = states.get(this);
            if (state) state.responseType = value;
            else super.responseType = value;
        }
        override get response() {
            const state = states.get(this);
            if (!state) return super.response;
            if (state.responseType === 'json') { try { return JSON.parse(state.responseText); } catch { return null; } }
            return state.responseText;
        }
        override open(method: string, url: string | URL, async = true, username?: string | null, password?: string | null) {
            states.delete(this);
            const matched = async !== false ? matchHostRoute(win, String(url)) : null;
            if (!matched) { super.open(method, url as string, async, username ?? null, password ?? null); return; }
            ensureAccessors(this);
            states.set(this, {
                matched,
                method: String(method || 'GET').toUpperCase(),
                headers: new (win.Headers ?? Headers)(),
                controller: new AbortController(),
                readyState: 1,
                status: 0,
                statusText: '',
                responseText: '',
                responseType: '',
                responseHeaders: new Map(),
                aborted: false,
            });
            emitEvent(this, 'readystatechange');
        }
        override setRequestHeader(name: string, value: string) {
            const state = states.get(this);
            if (state) { state.headers.set(name, value); return; }
            super.setRequestHeader(name, value);
        }
        override getResponseHeader(name: string) {
            const state = states.get(this);
            if (!state) return super.getResponseHeader(name);
            return state.responseHeaders.get(name.toLowerCase()) ?? null;
        }
        override getAllResponseHeaders() {
            const state = states.get(this);
            if (!state) return super.getAllResponseHeaders();
            return [...state.responseHeaders.entries()].map(([k, v]) => `${k}: ${v}\r\n`).join('');
        }
        override abort() {
            const state = states.get(this);
            if (!state) { super.abort(); return; }
            if (state.aborted) return;
            state.aborted = true;
            state.controller.abort();
            state.readyState = 4;
            state.status = 0;
            emitEvent(this, 'readystatechange');
            emitEvent(this, 'abort', true);
            emitEvent(this, 'loadend', true);
        }
        override send(body?: Document | XMLHttpRequestBodyInit | null) {
            const state = states.get(this);
            if (!state) { super.send(body); return; }
            const rawBody = typeof body === 'string' ? body : body instanceof URLSearchParams ? body.toString() : '';
            const contentType = state.headers.get('content-type') ?? (body instanceof URLSearchParams ? 'application/x-www-form-urlencoded' : null);
            void (async () => {
                try {
                    const res = await dispatchHostRequest(win, request, state.matched, state.method, rawBody, contentType, state.controller.signal, memory);
                    const text = await res.text();
                    if (state.aborted) return;
                    state.readyState = 4;
                    state.status = res.status;
                    state.statusText = res.statusText || (res.ok ? 'OK' : '');
                    state.responseText = text;
                    res.headers.forEach((v, k) => state.responseHeaders.set(k.toLowerCase(), v));
                    emitEvent(this, 'readystatechange');
                    emitEvent(this, 'load', true);
                    emitEvent(this, 'loadend', true);
                } catch {
                    if (state.aborted) return;
                    state.readyState = 4;
                    state.status = 0;
                    emitEvent(this, 'readystatechange');
                    emitEvent(this, 'error', true);
                    emitEvent(this, 'loadend', true);
                }
            })();
        }
    }
    win.XMLHttpRequest = CompatXMLHttpRequest as typeof XMLHttpRequest;
}

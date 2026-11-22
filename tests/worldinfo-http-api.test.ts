import { describe, it, expect, beforeEach } from 'vitest';
import { installHostFetch } from '../src/compatibility/host-fetch';
import { requestNativeResource } from '../src/compatibility/native-resource-host';
import { workspaceStore } from '../src/store/workspace-store';
import type { NormalizedLorebook } from '../src/types';

function installMemoryLocalStorage() {
    const store = new Map<string, string>();
    Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        value: {
            getItem: (key: string) => store.get(key) ?? null,
            setItem: (key: string, value: string) => { store.set(key, String(value)); },
            removeItem: (key: string) => { store.delete(key); },
            clear: () => { store.clear(); },
            key: (index: number) => [...store.keys()][index] ?? null,
            get length() { return store.size; },
        },
    });
}

function createFakeXHRClass() {
    return class FakeXMLHttpRequest extends EventTarget {
        readyState = 0;
        status = 0;
        statusText = '';
        responseText = '';
        response: unknown = '';
        responseURL = '';
        responseType: XMLHttpRequestResponseType = '';
        nativeOpened: { method: string; url: string } | null = null;
        nativeSent = false;
        open(method: string, url: string | URL) {
            this.nativeOpened = { method, url: String(url) };
            this.readyState = 1;
        }
        setRequestHeader() {}
        getResponseHeader() { return null; }
        getAllResponseHeaders() { return ''; }
        abort() { this.readyState = 4; }
        send() {
            this.nativeSent = true;
            this.readyState = 4;
            this.status = 405;
        }
    };
}

function createSampleWorldbook(): NormalizedLorebook {
    return {
        id: 'wb_dbz_test',
        name: '龙珠',
        entries: [
            {
                uid: 0,
                world: '龙珠',
                comment: '条目A',
                content: '内容A',
                keys: ['悟空'],
                secondaryKeys: [],
                selectiveLogic: 'AND_ANY',
                selective: true,
                constant: false,
                disabled: false,
                order: 100,
                position: 'at_depth',
                depth: 4,
                role: 'system',
                probability: 100,
                useProbability: true,
                rawData: { uid: 0, displayIndex: 0, disable: false, extensions: { position: 4 } },
            },
            {
                uid: 1,
                world: '龙珠',
                comment: '条目B',
                content: '内容B',
                keys: ['布尔玛'],
                secondaryKeys: [],
                selectiveLogic: 'AND_ANY',
                selective: true,
                constant: false,
                disabled: true,
                order: 90,
                position: 'before_char',
                depth: 0,
                role: 'system',
                probability: 100,
                useProbability: true,
                rawData: { uid: 1, displayIndex: 1, disable: true, extensions: { position: 0 } },
            },
        ],
    };
}

describe('SillyTavern /api/worldinfo/* compatibility endpoints', () => {
    beforeEach(() => {
        installMemoryLocalStorage();
        const book = createSampleWorldbook();
        workspaceStore.setState({
            activeChatId: 'chat_wi_test',
            branchEpoch: 1,
            lorebooks: [book],
            storyWorldbooks: undefined,
            characters: [],
            presets: [],
            personas: [],
        });
    });

    it('supports list, get (including allowDummy), edit toggling disable state, create, and delete', async () => {
        const listBefore = await requestNativeResource('/api/worldinfo/list', {}) as Array<{ name: string; file_id: string }>;
        expect(listBefore.map(item => item.name)).toContain('龙珠');

        const missing = await requestNativeResource('/api/worldinfo/get', { name: '不存在的世界书' }) as { entries: Record<string, unknown> };
        expect(missing).toEqual({ entries: {} });

        const loaded = await requestNativeResource('/api/worldinfo/get', { name: '龙珠' }) as { entries: Record<string, any> };
        expect(loaded.entries['0'].disable).toBe(false);
        expect(loaded.entries['1'].disable).toBe(true);

        // Toggle entry 0 disabled (SillyTavern `disable`), and toggle entry 1 enabled via `disabled` fallback.
        loaded.entries['0'].disable = true;
        loaded.entries['1'].disabled = false;
        const editRes = await requestNativeResource('/api/worldinfo/edit', { name: '龙珠', data: loaded });
        expect(editRes).toEqual({ ok: true });

        const reloaded = await requestNativeResource('/api/worldinfo/get', { name: '龙珠' }) as { entries: Record<string, any> };
        expect(reloaded.entries['0'].disable).toBe(true);
        expect(reloaded.entries['1'].disable).toBe(false);
        expect(reloaded.entries['0'].position).toBe(4);

        const storedBook = workspaceStore.getState().lorebooks.find(book => book.name === '龙珠')!;
        expect(storedBook.entries.find(e => e.uid === 0)?.disabled).toBe(true);
        expect(storedBook.entries.find(e => e.uid === 1)?.disabled).toBe(false);

        // Creating a new worldbook via /api/worldinfo/edit works just like SillyTavern.
        await expect(requestNativeResource('/api/worldinfo/edit', {
            name: '新世界书',
            data: { entries: { '0': { uid: 0, key: ['k'], content: 'c', disable: false, position: 0 } } },
        })).resolves.toEqual({ ok: true });

        const settings = await requestNativeResource('/api/settings/get', {}) as { world_names: string[] };
        expect(settings.world_names).toEqual(expect.arrayContaining(['龙珠', '新世界书']));

        // Deleting removes it cleanly, and deleting a missing book throws.
        await expect(requestNativeResource('/api/worldinfo/delete', { name: '新世界书' })).resolves.toEqual({ ok: true });
        await expect(requestNativeResource('/api/worldinfo/delete', { name: '新世界书' })).rejects.toThrow();

        // Validation errors mirror SillyTavern 400 conditions.
        await expect(requestNativeResource('/api/worldinfo/edit', { name: '', data: { entries: {} } })).rejects.toThrow('World file must have a name');
        await expect(requestNativeResource('/api/worldinfo/edit', { name: '龙珠', data: {} })).rejects.toThrow('Is not a valid world info file');
    });

    it('intercepts /api/worldinfo/* and /csrf-token over both fetch and XMLHttpRequest without hitting native 405', async () => {
        let externalFetchCalls = 0;
        const FakeXHR = createFakeXHRClass();
        const win = {
            document: { baseURI: 'http://127.0.0.1:5181/compat.html' },
            location: { href: 'http://127.0.0.1:5181/compat.html' },
            Request,
            Response,
            ReadableStream,
            Headers,
            Event,
            XMLHttpRequest: FakeXHR,
            fetch: async () => {
                externalFetchCalls++;
                return new Response('Method Not Allowed', { status: 405 });
            },
        } as unknown as Window & typeof globalThis;

        installHostFetch(win, async (method, params) => {
            if (method === 'host.http') return requestNativeResource(params.path, params.body);
            throw new Error(`Unexpected RPC ${method}`);
        });

        // GET /csrf-token works; POST /csrf-token returns 405.
        const csrfOk = await win.fetch('/csrf-token');
        expect(csrfOk.status).toBe(200);
        expect(await csrfOk.json()).toEqual({ token: expect.any(String) });
        const csrfMethodErr = await win.fetch('/csrf-token', { method: 'POST' });
        expect(csrfMethodErr.status).toBe(405);

        // POST /api/worldinfo/list with empty body succeeds.
        const listRes = await win.fetch('/api/worldinfo/list', { method: 'POST' });
        expect(listRes.status).toBe(200);
        expect((await listRes.json()).map((b: any) => b.name)).toContain('龙珠');

        // Fetch POST /api/worldinfo/edit succeeds cleanly.
        const loaded = await (await win.fetch('/api/worldinfo/get', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: '龙珠' }),
        })).json();
        loaded.entries['0'].disable = true;

        const editRes = await win.fetch('/api/worldinfo/edit', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: '龙珠', data: loaded }),
        });
        expect(editRes.status).toBe(200);
        expect(await editRes.json()).toEqual({ ok: true });
        expect(externalFetchCalls).toBe(0);

        // XHR (used by jQuery $.post / $.ajax) also intercepts /api/worldinfo/edit and succeeds cleanly.
        const xhrResult = await new Promise<{ status: number; body: any; nativeSent: boolean }>((resolve) => {
            const xhr = new win.XMLHttpRequest() as InstanceType<ReturnType<typeof createFakeXHRClass>>;
            xhr.open('POST', '/api/worldinfo/edit', true);
            xhr.setRequestHeader('Content-Type', 'application/json');
            xhr.addEventListener('load', () => {
                resolve({ status: xhr.status, body: JSON.parse(xhr.responseText), nativeSent: xhr.nativeSent });
            });
            loaded.entries['0'].disable = false;
            xhr.send(JSON.stringify({ name: '龙珠', data: loaded }));
        });
        expect(xhrResult.status).toBe(200);
        expect(xhrResult.body).toEqual({ ok: true });
        expect(xhrResult.nativeSent).toBe(false);

        const afterXhr = workspaceStore.getState().lorebooks.find(book => book.name === '龙珠')!;
        expect(afterXhr.entries.find(e => e.uid === 0)?.disabled).toBe(false);

        // External URL still delegates to native fetch / native XHR.
        const extRes = await win.fetch('https://example.com/api/worldinfo/edit', { method: 'POST' });
        expect(extRes.status).toBe(405);
        expect(externalFetchCalls).toBe(1);
    });
});

import { describe, it, expect, beforeEach } from 'vitest';
import {
    createWorldInfoCache,
    createWorldInfoEntry,
    deleteWIOriginalDataValue,
    originalWIDataKeyMap,
    setWIOriginalDataValue,
} from '../src/compatibility/world-info-helpers';
import { installHostFetch } from '../src/compatibility/host-fetch';
import { requestWorldbook } from '../src/compatibility/worldbook-host';
import { workspaceStore } from '../src/store/workspace-store';
import { extensionModule } from '../server/extension-modules.mjs';
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

describe('third-party SillyTavern extension compatibility (RUBY / world-info / openai)', () => {
    beforeEach(() => {
        installMemoryLocalStorage();
        const book: NormalizedLorebook = {
            id: 'wb_ruby_test',
            name: 'ruby-测试·剧情分析',
            entries: [
                {
                    uid: 0,
                    world: 'ruby-测试·剧情分析',
                    comment: '初始条目',
                    content: '初始内容',
                    keys: ['主角'],
                    secondaryKeys: [],
                    selectiveLogic: 'AND_ANY',
                    selective: true,
                    constant: false,
                    disabled: false,
                    order: 100,
                    position: 'before_char',
                    depth: 4,
                    role: 'system',
                    probability: 100,
                    useProbability: true,
                },
            ],
        };
        workspaceStore.setState({
            activeChatId: 'chat_ruby_test',
            branchEpoch: 1,
            lorebooks: [book],
            storyWorldbooks: undefined,
            characters: [],
            presets: [],
            personas: [],
        });
    });

    it('provides SillyTavern world-info helper primitives (cache clone, createEntry, originalData sync)', () => {
        const cache = createWorldInfoCache();
        const data: Record<string, any> = {
            entries: { '0': { uid: 0, key: ['a'] } },
            originalData: { entries: [{ uid: 0, keys: ['a'], enabled: true, extensions: { depth: 4 } }] },
        };
        cache.set('bookA', data);
        const snap = cache.get('bookA');
        snap.entries['0'].key.push('mutated');
        expect(cache.get('bookA').entries['0'].key).toEqual(['a']);

        const created = createWorldInfoEntry('bookA', data)!;
        expect(created.uid).toBe(1);
        expect(data.entries[1]).toBe(created);
        expect(created.selective).toBe(true);
        expect(created.disable).toBe(false);

        setWIOriginalDataValue(data, 0, originalWIDataKeyMap.depth, 6);
        setWIOriginalDataValue(data, 0, originalWIDataKeyMap.key, ['a', 'b']);
        expect(data.originalData.entries[0].extensions.depth).toBe(6);
        expect(data.originalData.entries[0].keys).toEqual(['a', 'b']);

        deleteWIOriginalDataValue(data, '0');
        expect(data.originalData.entries).toHaveLength(0);
    });

    it('exposes /scripts/world-info.js helpers and /scripts/openai.js adapter from extension-modules', () => {
        const wiMod = extensionModule('/scripts/world-info.js')!;
        for (const sym of ['worldInfoCache', 'createWorldInfoEntry', 'originalWIDataKeyMap', 'setWIOriginalDataValue', 'deleteWIOriginalDataValue', 'updateWorldInfoList']) {
            expect(wiMod).toContain(`export const ${sym}`);
        }
        const oaiMod = extensionModule('/scripts/openai.js')!;
        expect(oaiMod).toContain('export let oai_settings');
        expect(oaiMod).toContain('export const getChatCompletionModel');
    });

    it('invokes onWorldInfoEdited hook when /api/worldinfo/edit succeeds', async () => {
        const edited: Array<{ name: string; data: unknown }> = [];
        const win = {
            document: { baseURI: 'http://127.0.0.1:5181/compat.html' },
            location: { href: 'http://127.0.0.1:5181/compat.html' },
            Request,
            Response,
            ReadableStream,
            Headers,
            Event,
            fetch: async () => new Response('Not Found', { status: 404 }),
        } as unknown as Window & typeof globalThis;

        installHostFetch(win, async () => ({ ok: true }), {
            revision: () => 'rev1',
            vectorResult: () => {},
            onWorldInfoEdited: (name, data) => edited.push({ name, data }),
        });

        const payload = { entries: { '0': { uid: 0, content: 'updated' } } };
        const res = await win.fetch('/api/worldinfo/edit', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'ruby-测试·剧情分析', data: payload }),
        });
        expect(res.status).toBe(200);
        expect(edited).toEqual([{ name: 'ruby-测试·剧情分析', data: payload }]);
    });

    it('updates entry fields via worldbook.native.field (/setentryfield) consistently', async () => {
        await requestWorldbook('worldbook.native.field', { name: 'ruby-测试·剧情分析', uid: '0', field: 'keysecondary', value: '配角A, 配角B' });
        await requestWorldbook('worldbook.native.field', { name: 'ruby-测试·剧情分析', uid: '0', field: 'disable', value: '1' });
        await requestWorldbook('worldbook.native.field', { name: 'ruby-测试·剧情分析', uid: '0', field: 'position', value: '4' });
        await requestWorldbook('worldbook.native.field', { name: 'ruby-测试·剧情分析', uid: '0', field: 'depth', value: '2' });

        const book = workspaceStore.getState().lorebooks.find(b => b.name === 'ruby-测试·剧情分析')!;
        const entry = book.entries.find(e => e.uid === 0)!;
        expect(entry.secondaryKeys).toEqual(['配角A', '配角B']);
        expect(entry.disabled).toBe(true);
        expect(entry.position).toBe('at_depth');
        expect(entry.depth).toBe(2);
    });
});

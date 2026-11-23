import { describe, it, expect } from 'vitest';
import { compileAuthorTemplate } from '../src/pipeline/template-compiler';
import { TemplateRuntime } from '../src/pipeline/template-runtime';
import { adaptAuthorHtml, adaptAuthorWindow, unwrapAuthorScript } from '../src/compatibility/author-window';
import { saveLegacyChat } from '../src/store/workspace/message-edits';
import { workspaceStore } from '../src/store/workspace-store';
import type { NormalizedCharacterCard, NormalizedPreset } from '../src/types';

describe('EJS template error reporting & cross-origin parent isolation', () => {
    it('preserves real DOMException details instead of throwing getter-only message assignment error', async () => {
        const template = [
            'line1',
            '<% throw new DOMException("blocked storage", "SecurityError"); %>',
            'line3',
        ].join('\n');
        const fn = await compileAuthorTemplate(template);
        await expect(fn({})).rejects.toThrow(/ejs:2[\s\S]*SecurityError: blocked storage/);
    });

    it('resolves window.parent to the compatibility host window instead of throwing cross-origin SecurityError', async () => {
        const crossOriginParent = new Proxy({}, {
            get(_t, prop) {
                throw new DOMException(`Blocked reading '${String(prop)}' from cross-origin frame`, 'SecurityError');
            },
        });
        const fakeWin: Record<string, any> = {
            parent: crossOriginParent,
            top: crossOriginParent,
            大凉清明判日: () => 1,
        };
        const prevWin = (globalThis as any).window;
        (globalThis as any).window = fakeWin;
        try {
            const card: NormalizedCharacterCard = {
                id: 'c1', name: '测试', avatar: '', description: '', personality: '', scenario: '',
                firstMessage: '', alternateGreetings: [], mesExample: '', systemPrompt: '',
                postHistoryInstructions: '', creatorNotes: '', tags: [], regexScripts: [],
            };
            const preset: NormalizedPreset = {
                id: 'p1', name: '预设', prompts: [], promptOrder: [],
                maxContextTokens: 4096, maxResponseTokens: 512, regexScripts: [],
            };
            const runtime = new TemplateRuntime({
                character: card, preset, lorebooks: [], messages: [], userName: '用户', chatId: 'chat1',
            });
            const tpl = `<%_ { const _host = typeof window !== 'undefined' ? (window.parent || window) : globalThis; if (typeof _host.大凉清明判日 === 'function' && _host.大凉清明判日() > 0) { _%>清明<%_ } } _%>`;
            const out = await runtime.render(tpl, 'world-info:test:306');
            expect(out).toBe('清明');
        } finally {
            (globalThis as any).window = prevWin;
        }
    });

    it('rewrites static and dynamic top/parent window traversals in inline scripts and clamps cross-origin ancestors at runtime', async () => {
        const html = `<div>window.top</div><script>
            <!-- legacy comment -->
            window.top.addEventListener('resize', fn);
            top.addEventListener('message', fn);
            const t = top || window;
            t.addEventListener('click', fn);
            let w = window;
            while (w.parent && w.parent !== w) w = w.parent;
            w.addEventListener('scroll', fn);
            window.parent.parent.addEventListener('hashchange', fn);
            el.style.top = '10px';
            const y = rect.top.toFixed(1);
        </script>`;
        const adapted = await adaptAuthorHtml(html);
        expect(adapted).toContain('<div>window.top</div>');
        expect(adapted).toContain("el.style.top = '10px';");
        const scriptBody = adapted.match(/<script>([\s\S]*)<\/script>/)![1]!;

        // Execute adapted script against a simulated child -> compatHost -> crossOriginOuter chain.
        const events: string[] = [];
        const crossOriginOuter = new Proxy({}, {
            get(_t, prop) { throw new DOMException(`Blocked reading '${String(prop)}'`, 'SecurityError'); },
        });
        const compatHost: Record<string, any> = {
            parent: crossOriginOuter,
            top: crossOriginOuter,
            addEventListener: (ev: string) => events.push(ev),
        };
        const childWin: Record<string, any> = {
            parent: compatHost,
            top: crossOriginOuter,
            __tipsyHostWindow: compatHost,
            __tipsySafeWindow: (v: unknown) => v === crossOriginOuter ? compatHost : v,
        };
        const el = { style: { top: '' } };
        const rect = { top: 42 };
        const prevHost = (globalThis as any).__tipsyHostWindow;
        const prevSafe = (globalThis as any).__tipsySafeWindow;
        (globalThis as any).__tipsyHostWindow = compatHost;
        (globalThis as any).__tipsySafeWindow = childWin.__tipsySafeWindow;
        try {
            const run = new Function('window', 'top', 'parent', 'fn', 'el', 'rect', scriptBody);
            run(childWin, crossOriginOuter, compatHost, () => {}, el, rect);
            expect(events).toEqual(['resize', 'message', 'click', 'scroll', 'hashchange']);
            expect(el.style.top).toBe('10px');

            // Optional chain short-circuiting must stay intact for a?.parent.foo and a?.parent['foo'] when a is nullish.
            const optCode = await adaptAuthorWindow(`return [a?.parent.foo, a?.parent['foo'], b?.parent.foo];`);
            const optRun = new Function('a', 'b', optCode);
            expect(optRun(null, { parent: { foo: 7 } })).toEqual([undefined, undefined, 7]);
        } finally {
            (globalThis as any).__tipsyHostWindow = prevHost;
            (globalThis as any).__tipsySafeWindow = prevSafe;
        }

        const shadowed = await adaptAuthorWindow('function f(top) { return top.toFixed(1); }');
        expect(shadowed).toBe('function f(top) { return top.toFixed(1); }');
    });

    it('unwraps Markdown code fences around card scripts so template literals do not trigger Unexpected identifier', () => {
        const fencedDollar = '```js\nconst s = `${x}`;\n```';
        const fencedHtml = '```javascript\r\nconst s = `html<div></div>`;\r\n```';
        expect(unwrapAuthorScript(fencedDollar)).toBe('const s = `${x}`;');
        expect(unwrapAuthorScript(fencedHtml)).toBe('const s = `html<div></div>`;');
        expect(() => new Function('x', unwrapAuthorScript(fencedDollar))).not.toThrow();
        expect(() => new Function(unwrapAuthorScript(fencedHtml))).not.toThrow();
    });

    it('allows legacy variable/extra and idempotent mes saves while preserving conflict checks on stale mes overwrites', () => {
        workspaceStore.setState({
            activeChatId: 'chat_legacy_save',
            activeLeafId: 'msg_0',
            chatMetadata: {},
            messages: [{
                id: 'msg_0',
                parentId: null,
                childrenIds: [],
                role: 'assistant',
                content: 'updated text',
                swipes: ['updated text'],
                activeSwipeIndex: 0,
                timestamp: 1,
                floor: 0,
            }],
        });

        // Variables-only write with stale baseline content succeeds without spurious conflict.
        expect(saveLegacyChat([{ id: 'msg_0', swipe: 0, content: 'older text', variables: { hp: 99 } }])).toBe(true);
        // Idempotent mes write matching current visible content also succeeds.
        expect(saveLegacyChat([{ id: 'msg_0', swipe: 0, content: 'older text', mes: 'updated text', extra: { flag: 1 } }])).toBe(true);
        // Overwriting mes with different text from stale content still throws conflict.
        expect(() => saveLegacyChat([{ id: 'msg_0', swipe: 0, content: 'older text', mes: 'conflicting text' }])).toThrow('插件保存的消息已改变，请重试');
    });
});

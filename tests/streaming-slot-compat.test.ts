import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('dompurify', () => ({
    default: {
        sanitize: (html: string) => html,
    },
}));

import { createStreamPlan, StreamProjector } from '../src/pipeline/streaming-message';
import { extractHtmlSandboxBlocks, isEmptySlotPlaceholder } from '../src/pipeline/macro-regex-engine';
import { renderMessageMarkdown } from '../src/pipeline/message-markdown';
import { StreamingView } from '../src/shell/streaming-view';
import type { RegexScriptRule } from '../src/types';

const DOULUO_CONTENT_RULE: RegexScriptRule = {
    id: 'dl-content-slot',
    scriptName: '斗罗正文区（占位）',
    findRegex: '/^[ \\t]*<content>(?:(?!^[ \\t]*<content>)[\\s\\S])*?(?:<\\/content>|(?![\\s\\S]))/gim',
    replaceString: '<div data-dl-content="1"></div>',
    placement: ['render'],
    markdownOnly: true,
    disabled: false,
};

const DOULUO_UPDATE_RULE: RegexScriptRule = {
    id: 'dl-upd-slot',
    scriptName: '斗罗正文区（更新块占位）',
    findRegex: '/^[ \\t]*<UpdateVariable>(?:(?!^[ \\t]*<UpdateVariable>)[\\s\\S])*?(?:<\\/UpdateVariable>|(?![\\s\\S]))/gim',
    replaceString: '<div data-dl-upd="1"></div>',
    placement: ['render'],
    markdownOnly: true,
    disabled: false,
};

function installMinimalStreamingDom() {
    class FakeClassList {
        private set = new Set<string>();
        setFromString(value: string) {
            this.set = new Set(value.split(/\s+/).filter(Boolean));
        }
        toString() { return [...this.set].join(' '); }
        add(...tokens: string[]) { tokens.forEach(t => this.set.add(t)); }
        remove(...tokens: string[]) { tokens.forEach(t => this.set.delete(t)); }
        contains(token: string) { return this.set.has(token); }
        toggle(token: string, force?: boolean) {
            if (force === undefined ? !this.set.has(token) : force) this.set.add(token);
            else this.set.delete(token);
        }
    }

    class FakeElement {
        children: FakeElement[] = [];
        parentNode: FakeElement | null = null;
        dataset: Record<string, string> = {};
        attributes = new Map<string, string>();
        style: Record<string, string> & { setProperty: (k: string, v: string) => void } = {
            setProperty(k: string, v: string) { this[k] = v; },
        };
        classList = new FakeClassList();
        hidden = false;
        title = '';
        src = '';
        alt = '';
        textContent = '';
        isConnected = true;
        clientWidth = 640;
        content = { childNodes: [] as unknown[] };
        private _innerHTML = '';

        constructor(public tagName: string) {}
        get className() { return this.classList.toString(); }
        set className(v: string) { this.classList.setFromString(v); }
        get innerHTML() { return this._innerHTML; }
        set innerHTML(v: string) { this._innerHTML = v; }
        get firstElementChild(): FakeElement | null { return this.children[0] ?? null; }
        get nextElementSibling(): FakeElement | null {
            if (!this.parentNode) return null;
            const idx = this.parentNode.children.indexOf(this);
            return idx >= 0 ? this.parentNode.children[idx + 1] ?? null : null;
        }
        setAttribute(k: string, v: string) { this.attributes.set(k, String(v)); }
        getAttribute(k: string) { return this.attributes.get(k) ?? null; }
        matches() { return false; }
        remove() {
            if (!this.parentNode) return;
            const idx = this.parentNode.children.indexOf(this);
            if (idx >= 0) this.parentNode.children.splice(idx, 1);
            this.parentNode = null;
        }
        append(...nodes: FakeElement[]) {
            for (const n of nodes) {
                n.remove();
                n.parentNode = this;
                this.children.push(n);
            }
        }
        replaceChildren(...nodes: FakeElement[]) {
            for (const old of [...this.children]) old.parentNode = null;
            this.children = [];
            this.append(...nodes);
        }
        insertBefore(newNode: FakeElement, refNode: FakeElement | null) {
            if (refNode === null) { this.append(newNode); return newNode; }
            const idx = this.children.indexOf(refNode);
            if (idx < 0) throw new DOMException('The node before which the new node is to be inserted is not a child of this node.', 'NotFoundError');
            newNode.remove();
            newNode.parentNode = this;
            const nextIdx = this.children.indexOf(refNode);
            this.children.splice(nextIdx, 0, newNode);
            return newNode;
        }
        querySelector(selector: string): FakeElement | null {
            const tag = selector.toLowerCase();
            for (const child of this.children) {
                if (child.tagName.toLowerCase() === tag || (selector.startsWith('.') && child.classList.contains(selector.slice(1)))) return child;
                const nested = child.querySelector(selector);
                if (nested) return nested;
            }
            return null;
        }
        querySelectorAll(selector: string): FakeElement[] {
            const found: FakeElement[] = [];
            for (const child of this.children) {
                if (child.tagName.toLowerCase() === selector.toLowerCase() || (selector.startsWith('.') && child.classList.contains(selector.slice(1)))) found.push(child);
                found.push(...child.querySelectorAll(selector));
            }
            return found;
        }
    }

    const prevDoc = globalThis.document;
    const prevIO = globalThis.IntersectionObserver;
    const prevRO = globalThis.ResizeObserver;
    const prevRAF = globalThis.requestAnimationFrame;
    const prevCAF = globalThis.cancelAnimationFrame;

    (globalThis as any).document = {
        createElement: (tag: string) => new FakeElement(tag),
        createElementNS: (_ns: string, tag: string) => new FakeElement(tag),
    };
    (globalThis as any).IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
    (globalThis as any).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
    (globalThis as any).requestAnimationFrame = () => 1;
    (globalThis as any).cancelAnimationFrame = () => {};

    return {
        FakeElement,
        restore() {
            (globalThis as any).document = prevDoc;
            (globalThis as any).IntersectionObserver = prevIO;
            (globalThis as any).ResizeObserver = prevRO;
            (globalThis as any).requestAnimationFrame = prevRAF;
            (globalThis as any).cancelAnimationFrame = prevCAF;
        },
    };
}

describe('narrative empty slot placeholders and streaming resilience', () => {
    let cleanupDom: (() => void) | undefined;

    beforeEach(() => { cleanupDom = undefined; });
    afterEach(() => { cleanupDom?.(); });

    it('streams story prose inside <content> instead of trapping it behind an empty placeholder card', () => {
        const plan = createStreamPlan([DOULUO_CONTENT_RULE, DOULUO_UPDATE_RULE], 'douluo:preset', '玩家', '斗罗宇宙', 'auto');
        expect(plan.tags.has('content')).toBe(false);
        expect(plan.tags.has('updatevariable')).toBe(true);

        const projector = new StreamProjector(plan);

        // Unclosed <content> streams prose immediately
        const openPreview = projector.update('<content>\n史莱克学院的晨钟敲响了。');
        expect(openPreview.parts.some(p => p.type === 'waiting')).toBe(false);
        expect(openPreview.source).toContain('史莱克学院的晨钟敲响了。');

        // Preamble before <content> + <content> continues streaming seamlessly
        const preambleProjector = new StreamProjector(plan);
        const midPreview = preambleProjector.update('（序章）\n<content>\n唐三睁开了眼睛。');
        expect(midPreview.parts.some(p => p.type === 'waiting')).toBe(false);
        expect(midPreview.source).toContain('（序章）');
        expect(midPreview.source).toContain('唐三睁开了眼睛。');

        // Closed </content> followed by <UpdateVariable> keeps prose visible and hides variable block
        const latePreview = preambleProjector.update('（序章）\n<content>\n唐三睁开了眼睛。\n</content>\n<UpdateVariable>\n_.set("hp", 100);');
        expect(latePreview.parts.some(p => p.type === 'waiting' || p.type === 'component')).toBe(false);
        expect(latePreview.source).toContain('唐三睁开了眼睛。');
        expect(latePreview.source).not.toContain('UpdateVariable');
    });

    it('still treats styled or content-bearing component replacements on narrative tags as components', () => {
        const styledRule: RegexScriptRule = {
            id: 'styled-card',
            scriptName: '正文美化卡',
            findRegex: '/<content>([\\s\\S]*?)<\\/content>/gi',
            replaceString: '<div class="story-card" style="height:120px">$1</div>',
            placement: ['render'],
            markdownOnly: true,
            disabled: false,
        };
        const fullDocRule: RegexScriptRule = {
            id: 'doc-card',
            scriptName: '整页文档',
            findRegex: '/<content>([\\s\\S]*?)<\\/content>/gi',
            replaceString: '<!doctype html><html><body><div>$1</div></body></html>',
            placement: ['render'],
            markdownOnly: true,
            disabled: false,
        };
        expect(createStreamPlan([styledRule], 'c:p', 'u', 'c', 'auto').tags.has('content')).toBe(true);
        expect(createStreamPlan([fullDocRule], 'c:p', 'u', 'c', 'auto').tags.has('content')).toBe(true);
    });

    it('keeps empty unstyled slot placeholders in markdown blocks instead of isolating them in child iframes', () => {
        expect(isEmptySlotPlaceholder('<div data-dl-content="1"></div>\n<div data-dl-upd="1"></div>')).toBe(true);
        expect(isEmptySlotPlaceholder('<section data-slot="story"> <!-- waiting --> </section>')).toBe(true);
        expect(isEmptySlotPlaceholder('<div style="height:80px"></div>')).toBe(false);
        expect(isEmptySlotPlaceholder('<div>真实内容</div>')).toBe(false);
        expect(isEmptySlotPlaceholder('<div></div><script>alert(1)</script>')).toBe(false);

        const slotOnly = extractHtmlSandboxBlocks('<div data-dl-content="1"></div>\n<div data-dl-upd="1"></div>');
        expect(slotOnly).toHaveLength(1);
        expect(slotOnly[0].type).toBe('markdown');

        const mixedSlotsAndProse = extractHtmlSandboxBlocks('前言\n<div data-dl-content="1"></div>\n<div data-dl-upd="1"></div>');
        expect(mixedSlotsAndProse).toHaveLength(1);
        expect(mixedSlotsAndProse[0].type).toBe('markdown');

        const realWidget = extractHtmlSandboxBlocks('<div>实际文本</div>');
        expect(realWidget).toHaveLength(1);
        expect(realWidget[0].type).toBe('mixed');

        const styledWidget = extractHtmlSandboxBlocks('<div style="height:40px"></div>');
        expect(styledWidget).toHaveLength(1);
        expect(styledWidget[0].type).toBe('mixed');

        const scriptedWidget = extractHtmlSandboxBlocks('<div id="app"></div><script>window.x=1</script>');
        expect(scriptedWidget).toHaveLength(1);
        expect(scriptedWidget[0].type).toBe('mixed');

        const siblingThinkingAndSlots = extractHtmlSandboxBlocks('<details><summary>思考</summary>ok</details>\n<div data-dl-content="1"></div>\n<div data-dl-upd="1"></div>');
        expect(siblingThinkingAndSlots).toEqual([
            { type: 'mixed', content: '<details><summary>思考</summary>ok</details>' },
            { type: 'markdown', content: '<div data-dl-content="1"></div>\n<div data-dl-upd="1"></div>' },
        ]);

        const nestedEmptyInsideCard = extractHtmlSandboxBlocks('<div class="card"><div class="empty"></div>body</div>');
        expect(nestedEmptyInsideCard).toHaveLength(1);
        expect(nestedEmptyInsideCard[0].type).toBe('mixed');

        const unfencedDocAndSlots = extractHtmlSandboxBlocks('<!doctype html><html><body><div>晴 / 朝 09:30</div></body></html>\n<div data-dl-content="1"></div>\n<div data-dl-upd="1"></div>');
        expect(unfencedDocAndSlots).toEqual([
            { type: 'html', content: '<!doctype html><html><body><div>晴 / 朝 09:30</div></body></html>' },
            { type: 'markdown', content: '<div data-dl-content="1"></div>\n<div data-dl-upd="1"></div>' },
        ]);

        const siblingScriptWidgetAndSlots = extractHtmlSandboxBlocks('<div class="weather">09:30</div><script>initWeather()</script>\n<div data-dl-content="1"></div>\n<div data-dl-upd="1"></div>');
        expect(siblingScriptWidgetAndSlots).toEqual([
            { type: 'mixed', content: '<div class="weather">09:30</div><script>initWeather()</script>' },
            { type: 'markdown', content: '<div data-dl-content="1"></div>\n<div data-dl-upd="1"></div>' },
        ]);

        const referencedAppSlot = extractHtmlSandboxBlocks('<div id="app"></div><script>document.getElementById("app").textContent="ok"</script>');
        expect(referencedAppSlot).toHaveLength(1);
        expect(referencedAppSlot[0].type).toBe('mixed');

        const bareScriptSlot = extractHtmlSandboxBlocks('<div></div><script>document.querySelector("div").textContent="ok"</script>');
        expect(bareScriptSlot).toHaveLength(1);
        expect(bareScriptSlot[0].type).toBe('mixed');
    });

    it('preserves data-* slot attributes in renderMessageMarkdown', () => {
        const { restore } = installMinimalStreamingDom();
        cleanupDom = restore;
        const rendered = renderMessageMarkdown('<div data-dl-content="1"></div>\n<div data-dl-upd="1"></div>');
        expect(rendered).toContain('data-dl-content="1"');
        expect(rendered).toContain('data-dl-upd="1"');
    });

    it('keeps StreamingView.update working after external DOM clearing inside its container', () => {
        const { FakeElement, restore } = installMinimalStreamingDom();
        cleanupDom = restore;
        const root = new FakeElement('div') as unknown as HTMLElement;
        const view = new StreamingView(root, () => '');
        const plan = createStreamPlan([DOULUO_CONTENT_RULE, DOULUO_UPDATE_RULE], 'douluo:preset', '玩家', '斗罗宇宙', 'auto');
        const projector = new StreamProjector(plan);

        view.update(projector.update('<content>\n第一句。'));
        expect((root as unknown as { querySelector: (s: string) => any }).querySelector('.tipsy-stream-status')).not.toBeNull();

        // Simulate a third-party MutationObserver wiping root children
        root.replaceChildren();

        expect(() => {
            view.update(projector.update('<content>\n第一句。第二句。'));
        }).not.toThrow();

        const proseEl = (root as unknown as { querySelector: (s: string) => any }).querySelector('.tipsy-reader-prose');
        const statusEl = (root as unknown as { querySelector: (s: string) => any }).querySelector('.tipsy-stream-status');
        expect(proseEl).not.toBeNull();
        expect(proseEl.innerHTML).toContain('第二句。');
        expect(statusEl).not.toBeNull();
        view.dispose();
    });
});

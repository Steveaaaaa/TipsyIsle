import type { StoryGallery } from '../core/gallery-types';

type Resolver = (value: string) => string;
let resolve: Resolver = value => value;
let boundStory = '';
let hasGallery = false;
const installed = new WeakSet<Window>();

export async function loadGallery(storyId: string): Promise<void> {
    boundStory = storyId;
    const response = await fetch(`/local-gallery/${encodeURIComponent(storyId)}/manifest.json`, { cache: 'no-store' });
    if (boundStory !== storyId) return;
    if (response.status === 404) { hasGallery = false; resolve = value => value; return; }
    if (!response.ok) throw new Error(`读取故事图库失败 (${response.status})`);
    const gallery = await response.json() as StoryGallery;
    if (boundStory !== storyId) return;
    hasGallery = true;
    const suffixes = new Map<string, string | null>();
    for (const file of gallery.files) {
        const parts = file.split('/');
        for (let i = 0; i < parts.length; i++) {
            const suffix = parts.slice(i).join('/').toLocaleLowerCase();
            suffixes.set(suffix, suffixes.has(suffix) ? null : file);
        }
    }
    const prefix = `${location.origin}/local-gallery/${encodeURIComponent(storyId)}/${gallery.version}/`;
    resolve = value => {
        if (!value || /^(?:data:|blob:|#)/i.test(value)) return value;
        let url: URL;
        try { url = new URL(value, location.href); } catch { return value; }
        if (url.origin !== location.origin) return value;
        let path: string;
        try { path = decodeURIComponent(url.pathname); } catch { return value; }
        const parts = path.split('/').filter(Boolean);
        for (let i = 0; i < parts.length; i++) {
            const file = suffixes.get(parts.slice(i).join('/').toLocaleLowerCase());
            if (file) return prefix + file.split('/').map(encodeURIComponent).join('/') + url.search + url.hash;
        }
        return value;
    };
    const visit = (win: Window) => {
        try {
            installGallery(win); refresh(win.document);
            for (let index = 0; index < win.frames.length; index++) visit(win.frames[index]);
        } catch { /* Remote or opaque author frames retain their own asset loading. */ }
    };
    visit(window);
}

const css = (value: string) => !hasGallery ? value : value.replace(/url\(\s*(['"]?)([^)'"]+)\1\s*\)/gi, (match, _quote, url: string) => { const mapped = resolve(url.trim()); return mapped === url.trim() ? match : `url("${mapped}")`; });
const srcset = (value: string) => value.startsWith('data:') ? value : value.split(',').map(part => { const [url, ...size] = part.trim().split(/\s+/); return [resolve(url), ...size].join(' '); }).join(', ');
const attribute = (name: string, value: string) => name === 'style' ? css(value) : name === 'srcset' ? srcset(value) : resolve(value);

export function galleryMarkup(html: string): string {
    if (!hasGallery) return html;
    return html.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>|<style\b[^>]*>[\s\S]*?<\/style\s*>|<[^>]+>/gi, tag => {
        if (/^<script\b/i.test(tag)) return tag;
        if (/^<style\b/i.test(tag)) return css(tag);
        return tag.replace(/\b(src|srcset|poster|background|style)\s*=\s*(["'])([\s\S]*?)\2/gi, (match, name: string, quote: string, value: string) => {
            const mapped = attribute(name.toLowerCase(), value);
            return mapped === value ? match : `${name}=${quote}${mapped.replaceAll(quote, quote === '"' ? '&quot;' : '&#39;')}${quote}`;
        });
    });
}

function refresh(root: ParentNode): void {
    if (!hasGallery) return;
    const selector = '[src],[srcset],[poster],[background],[style],style';
    const elements = [...root.querySelectorAll<HTMLElement>(selector)];
    if ('matches' in root && (root as Element).matches(selector)) elements.unshift(root as HTMLElement);
    for (const element of elements) {
        for (const name of ['src', 'srcset', 'poster', 'background', 'style']) {
            const old = element.getAttribute(name);
            if (old) { const value = attribute(name, old); if (old !== value) element.setAttribute(name, value); }
        }
        if (element.tagName === 'STYLE') { const old = element.textContent || '', value = css(old); if (value !== old) element.textContent = value; }
    }
}

/** Install once per author realm. No image bytes or catalogs enter RPC snapshots. */
export function installGallery(win: any): void {
    if (!hasGallery || installed.has(win)) return;
    installed.add(win);
    const patch = (prototype: any, name: string, transform: (value: string) => string) => {
        const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
        if (descriptor?.set) Object.defineProperty(prototype, name, { ...descriptor, set(value: string) { descriptor.set!.call(this, transform.call(this, String(value))); } });
    };
    const setAttribute = win.Element.prototype.setAttribute;
    win.Element.prototype.setAttribute = function(name: string, value: string) {
        const key = name.toLowerCase();
        return setAttribute.call(this, name, ['src', 'srcset', 'poster', 'background', 'style'].includes(key) ? attribute(key, String(value)) : value);
    };
    for (const ctor of [win.HTMLImageElement, win.HTMLSourceElement]) { patch(ctor.prototype, 'src', value => resolve(value)); patch(ctor.prototype, 'srcset', srcset); }
    patch(win.HTMLVideoElement.prototype, 'poster', value => resolve(value));
    patch(win.Element.prototype, 'innerHTML', galleryMarkup);
    patch(win.Element.prototype, 'outerHTML', galleryMarkup);
    patch(win.CSSStyleDeclaration.prototype, 'cssText', css);
    for (const key of ['background', 'backgroundImage', 'borderImage', 'borderImageSource', 'listStyle', 'listStyleImage', 'cursor', 'maskImage']) patch(win.CSSStyleDeclaration.prototype, key, css);
    const setProperty = win.CSSStyleDeclaration.prototype.setProperty;
    win.CSSStyleDeclaration.prototype.setProperty = function(name: string, value: string, priority?: string) { return setProperty.call(this, name, typeof value === 'string' ? css(value) : value, priority); };
    const insert = win.Element.prototype.insertAdjacentHTML;
    win.Element.prototype.insertAdjacentHTML = function(position: string, html: string) { return insert.call(this, position, galleryMarkup(html)); };
    const fetch = win.fetch.bind(win);
    win.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
        if (typeof input === 'string' || input instanceof win.URL) return fetch(resolve(String(input)), init);
        const url = resolve((input as Request).url);
        return fetch(url === (input as Request).url ? input : new win.Request(url, input), init);
    };
    win.__tipsyInstallGallery = installGallery;
    patch(win.HTMLIFrameElement.prototype, 'srcdoc', function(this: HTMLIFrameElement, value: string) {
        const markup = galleryMarkup(value), boot = '<script>parent.__tipsyInstallGallery(window);<\/script>';
        if (this.hasAttribute('sandbox') && !this.sandbox.contains('allow-same-origin')) return markup;
        if (/<head\b[^>]*>/i.test(markup)) return markup.replace(/<head\b[^>]*>/i, head => head + boot);
        if (/^\s*<!doctype[^>]*>/i.test(markup)) return markup.replace(/^(\s*<!doctype[^>]*>)/i, '$1' + boot);
        return boot + markup;
    });
    const observer = new win.MutationObserver((records: MutationRecord[]) => {
        if (!hasGallery) return;
        for (const record of records) if (record.type === 'childList') for (const node of record.addedNodes) {
            if (node.nodeType === 1) refresh(node as Element);
            else if (node.parentElement?.tagName === 'STYLE') refresh(node.parentElement);
        }
    });
    observer.observe(win.document, { childList: true, subtree: true });
    win.addEventListener('pagehide', () => observer.disconnect(), { once: true });
}

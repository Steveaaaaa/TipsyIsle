export interface SandboxAnchorSpec {
    kind: string;
    index?: number;
    excerpt?: string;
    token?: string;
}

export interface SandboxMediaPayload {
    key: string;
    slotId: string;
    status: 'developing' | 'ready' | 'failed';
    label: string;
    aspectRatio?: string;
    palette?: [string, string];
    presentation?: 'editorial' | 'bookmark' | 'polaroid';
    anchor?: SandboxAnchorSpec;
    takeIndex: number;
    takeCount: number;
    canStage: boolean;
    mediaId?: string;
    blob?: Blob;
}

const INTERACTIVE_CONTROL_SELECTOR =
    'button, input, select, textarea, audio, video, [role="tab"], [role="button"], [onclick], [class*="btn"], [class*="toggle"], [class*="tab-"]';
const WIDGET_SHELL_SELECTOR =
    '[data-v-app], .tabs, .tab-bar, .status-bar, .scene-card, .scene-cover, [class*="cover-layer"], [class*="lightbox"], [class*="modal"], [class*="scene-card"], [class*="music-player"]';
const HOSTILE_CONTAINER_SELECTOR =
    'button, [role="tab"], [role="tabpanel"], [role="dialog"], nav, header, footer, table, form, details:not([open]), .tipsy-reader-widget, [class*="cover-layer"], [class*="lightbox"], [class*="modal"]';
const INTERACTIVE_TAG_NAMES = new Set(['button', 'input', 'select', 'textarea', 'audio', 'video']);
const PROSE_TAG_NAMES = new Set(['p', 'blockquote', 'div', 'article', 'section', 'li']);
const NARRATIVE_PUNCT_RE = /[。！？.!?…—]/;

export function isInteractiveWidgetDocument(doc: Document): boolean {
    const body = doc?.body;
    if (!body) return true;
    if (typeof (body as { querySelector?: (selector: string) => Element | null }).querySelector === 'function') {
        if (body.querySelector('.stthink-root, .stthink, .modern-dark-log')) return true;
        const mixedProse = body.querySelector('.tipsy-reader-prose');
        if (mixedProse && (mixedProse.textContent ?? '').trim().length > 0) return false;
    }
    const bodyHead = (body.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
    if (/^(?:思维链|THOUGHT PROCESS|变量更新|UpdateVariable)/i.test(bodyHead)) return true;
    if (typeof (body as { querySelectorAll?: (selector: string) => NodeListOf<Element> }).querySelectorAll !== 'function') return false;

    const rawInteractive = Array.from(body.querySelectorAll(INTERACTIVE_CONTROL_SELECTOR));
    let interactiveCount = 0;
    for (const el of rawInteractive) {
        const tag = typeof (el as { tagName?: string }).tagName === 'string' ? el.tagName.toLowerCase() : '';
        if (!tag) continue;
        if (typeof (el as { closest?: (s: string) => Element | null }).closest === 'function' && el.closest('.ti-sbx-media-slot, .compat-native-media-slot')) continue;
        const role = typeof el.getAttribute === 'function' ? el.getAttribute('role') : null;
        const cls = typeof el.getAttribute === 'function' ? el.getAttribute('class') ?? '' : '';
        const hasInteractiveClass = /\b(?:[a-z-]+-)?(?:btn|toggle|tab)(?:-[a-z-]+)?\b/i.test(cls);
        if (
            INTERACTIVE_TAG_NAMES.has(tag) ||
            role === 'tab' ||
            role === 'button' ||
            (typeof el.hasAttribute === 'function' && el.hasAttribute('onclick')) ||
            hasInteractiveClass
        ) {
            interactiveCount++;
        }
    }

    const rawProse = Array.from(body.querySelectorAll('p, blockquote, article > div, section > div, div'));
    const narrativeBlocks: Element[] = [];
    for (const el of rawProse) {
        const tag = typeof (el as { tagName?: string }).tagName === 'string' ? el.tagName.toLowerCase() : '';
        if (tag && !PROSE_TAG_NAMES.has(tag)) continue;
        if ((el as HTMLElement).hidden) continue;
        if (typeof el.getAttribute === 'function' && /display\s*:\s*none/i.test(el.getAttribute('style') ?? '')) continue;
        if (typeof (el as { closest?: (s: string) => Element | null }).closest === 'function') {
            if (el.closest(`${HOSTILE_CONTAINER_SELECTOR}, .ti-sbx-media-slot, .compat-native-media-slot`)) continue;
        }
        const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
        if (text.length < 40 || !NARRATIVE_PUNCT_RE.test(text)) continue;
        if (tag) narrativeBlocks.push(el);
    }
    const leafNarrative = narrativeBlocks.filter(
        (el) => !narrativeBlocks.some((other) => other !== el && typeof el.contains === 'function' && el.contains(other)),
    );
    const totalNarrativeChars = leafNarrative.reduce((sum, el) => sum + (el.textContent ?? '').replace(/\s+/g, ' ').trim().length, 0);

    if (interactiveCount >= 2 && (leafNarrative.length < 2 || totalNarrativeChars < 160)) return true;

    const hasWidgetShell =
        typeof (body as { querySelector?: (selector: string) => Element | null }).querySelector === 'function' &&
        Boolean(body.querySelector(WIDGET_SHELL_SELECTOR));
    if (hasWidgetShell && leafNarrative.length < 2) {
        const shellEl = body.querySelector(WIDGET_SHELL_SELECTOR);
        if (shellEl && typeof (shellEl as { tagName?: string }).tagName === 'string') return true;
    }

    return false;
}

export function findSandboxParagraphAnchor(
    doc: Document,
    anchor?: SandboxAnchorSpec,
    options?: { allowIndexFallback?: boolean },
): Element | null {
    // Keep this function 100% self-contained: tavern-shim-source embeds findSandboxParagraphAnchor.toString() into srcdoc iframes.
    const body = doc ? doc.body : null;
    if (!body) return null;

    const norm = function (value: string) {
        return value.replace(/\s+/g, ' ').trim();
    };
    const loose = function (value: string) {
        return value
            .replace(/\{[^}]{1,16}\}/g, '')
            .replace(/\*\*/g, '')
            .replace(/[\s「」『』"'“”‘’【】()（）]/g, '');
    };
    const hasClassToken = function (el: Element, re: RegExp) {
        if (typeof el.getAttribute !== 'function') return false;
        const cls = el.getAttribute('class') || '';
        return re.test(cls);
    };

    const hostileContainerSelector =
        'button, [role="tab"], [role="tabpanel"], [role="dialog"], nav, header, footer, table, form, details:not([open]), .tipsy-reader-widget, [class*="cover-layer"], [class*="lightbox"], [class*="modal"]';
    const interactiveControlSelector =
        'button, input, select, textarea, audio, video, [role="tab"], [role="button"], [onclick], [class*="btn"], [class*="toggle"], [class*="tab-"]';
    const widgetShellSelector =
        '[data-v-app], .tabs, .tab-bar, .status-bar, .scene-card, .scene-cover, [class*="cover-layer"], [class*="lightbox"], [class*="modal"], [class*="scene-card"], [class*="music-player"]';
    const interactiveTagNames: Record<string, boolean> = {
        button: true,
        input: true,
        select: true,
        textarea: true,
        audio: true,
        video: true,
    };
    const proseTagNames: Record<string, boolean> = {
        p: true,
        blockquote: true,
        div: true,
        article: true,
        section: true,
        li: true,
    };
    const narrativePunctRe = /[。！？.!?…—]/;

    const isHostile = function (el: Element): boolean {
        if (!el) return true;
        if ((el as HTMLElement).hidden) return true;
        if (typeof el.getAttribute === 'function') {
            const inlineStyle = el.getAttribute('style') || '';
            if (/display\s*:\s*none/i.test(inlineStyle)) return true;
        }
        if (typeof (el as { closest?: (selector: string) => Element | null }).closest === 'function') {
            if (el.closest(hostileContainerSelector)) return true;
        }
        let current: Element | null = el;
        let steps = 0;
        while (current && current !== body && steps < 16) {
            steps++;
            if (typeof (current as { matches?: (selector: string) => boolean }).matches === 'function') {
                if (current.matches(hostileContainerSelector)) return true;
            }
            if (typeof getComputedStyle === 'function') {
                try {
                    const style = getComputedStyle(current);
                    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return true;
                    if (current !== el && style.pointerEvents === 'none' && (style.opacity === '0' || style.visibility === 'hidden')) return true;
                    if (current !== el && (style.position === 'fixed' || style.position === 'absolute')) return true;
                    if (current !== el && (style.overflowY === 'hidden' || style.overflowY === 'clip')) {
                        const hasExplicitCap =
                            (!!style.maxHeight && style.maxHeight !== 'none') ||
                            (!!style.height && style.height !== 'auto' && style.height !== '0px' && !style.height.endsWith('%'));
                        if (hasExplicitCap) return true;
                    }
                } catch {
                    // Ignore style lookup errors in detached/test nodes
                }
            }
            current = current.parentElement;
        }
        return false;
    };

    const isWidgetDoc = function (): boolean {
        if (typeof (body as { querySelector?: (selector: string) => Element | null }).querySelector === 'function') {
            if (body.querySelector('.stthink-root, .stthink, .modern-dark-log')) return true;
            const mixed = body.querySelector('.tipsy-reader-prose');
            if (mixed && (mixed.textContent || '').trim().length > 0) return false;
        }
        const headText = norm(body.textContent || '').slice(0, 60);
        if (/^(?:思维链|THOUGHT PROCESS|变量更新|UpdateVariable)/i.test(headText)) return true;
        if (typeof (body as { querySelectorAll?: (selector: string) => NodeListOf<Element> }).querySelectorAll !== 'function') return false;

        const rawInteractive = Array.from(body.querySelectorAll(interactiveControlSelector));
        let interactiveCount = 0;
        for (let i = 0; i < rawInteractive.length; i++) {
            const el = rawInteractive[i];
            const tag = typeof (el as { tagName?: string }).tagName === 'string' ? el.tagName.toLowerCase() : '';
            if (!tag) continue;
            if (typeof (el as { closest?: (s: string) => Element | null }).closest === 'function') {
                if (el.closest('.ti-sbx-media-slot, .compat-native-media-slot')) continue;
            }
            const role = typeof el.getAttribute === 'function' ? el.getAttribute('role') : null;
            const isClickAttr = typeof el.hasAttribute === 'function' && el.hasAttribute('onclick');
            if (interactiveTagNames[tag] || role === 'tab' || role === 'button' || isClickAttr || hasClassToken(el, /\b(?:[a-z-]+-)?(?:btn|toggle|tab)(?:-[a-z-]+)?\b/i)) {
                interactiveCount++;
            }
        }

        const rawProse = Array.from(body.querySelectorAll('p, blockquote, article > div, section > div, div'));
        const narrativeBlocks: Element[] = [];
        for (let i = 0; i < rawProse.length; i++) {
            const el = rawProse[i];
            const tag = typeof (el as { tagName?: string }).tagName === 'string' ? el.tagName.toLowerCase() : '';
            if (tag && !proseTagNames[tag]) continue;
            if ((el as HTMLElement).hidden) continue;
            if (typeof el.getAttribute === 'function' && /display\s*:\s*none/i.test(el.getAttribute('style') || '')) continue;
            if (typeof (el as { closest?: (s: string) => Element | null }).closest === 'function') {
                if (el.closest(hostileContainerSelector + ', .ti-sbx-media-slot, .compat-native-media-slot')) continue;
            }
            const t = norm(el.textContent || '');
            if (t.length < 40 || !narrativePunctRe.test(t)) continue;
            if (tag) narrativeBlocks.push(el);
        }
        const leafNarrative: Element[] = [];
        let totalNarrativeChars = 0;
        for (let i = 0; i < narrativeBlocks.length; i++) {
            const el = narrativeBlocks[i];
            let nested = false;
            for (let j = 0; j < narrativeBlocks.length; j++) {
                if (i !== j && typeof el.contains === 'function' && el.contains(narrativeBlocks[j])) {
                    nested = true;
                    break;
                }
            }
            if (!nested) {
                leafNarrative.push(el);
                totalNarrativeChars += norm(el.textContent || '').length;
            }
        }

        if (interactiveCount >= 2 && (leafNarrative.length < 2 || totalNarrativeChars < 160)) return true;

        if (typeof (body as { querySelector?: (selector: string) => Element | null }).querySelector === 'function') {
            const shellEl = body.querySelector(widgetShellSelector);
            if (shellEl && typeof (shellEl as { tagName?: string }).tagName === 'string' && leafNarrative.length < 2) return true;
        }
        return false;
    };

    if (isWidgetDoc()) return null;

    const ignoredSelector =
        'script, style, template, noscript, svg, header, nav, footer, dialog, details:not([open]), .ti-sbx-media-slot, .compat-native-media-slot, .cg-container, .image-content, .image-modal, .settings-panel, .settings-drawer, .stthink-root, .stthink, .modern-dark-log, .reasoning, [data-reasoning], .tipsy-reader-widget, [class*="cover-layer"], [class*="lightbox"], [class*="modal"]';

    const bodyHeight = typeof (body as { getBoundingClientRect?: () => { height: number } }).getBoundingClientRect === 'function'
        ? body.getBoundingClientRect().height
        : 0;
    const blockSelector = 'p, blockquote, li, div, article, section, h1, h2, h3, h4, h5, h6';
    const proseContainers = typeof (body as { querySelectorAll?: (selector: string) => NodeListOf<Element> }).querySelectorAll === 'function'
        ? Array.from(body.querySelectorAll('.tipsy-reader-prose'))
        : [];
    const allBlocks: Element[] = [];
    if (proseContainers.length > 0) {
        for (let i = 0; i < proseContainers.length; i++) {
            const container = proseContainers[i];
            if (typeof container.querySelectorAll === 'function') {
                const inner = Array.from(container.querySelectorAll(blockSelector));
                for (let j = 0; j < inner.length; j++) allBlocks.push(inner[j]);
            }
        }
    }
    if (allBlocks.length === 0) {
        const fallbackBlocks = Array.from(body.querySelectorAll(blockSelector));
        for (let i = 0; i < fallbackBlocks.length; i++) allBlocks.push(fallbackBlocks[i]);
    }

    const candidates: Element[] = [];
    for (let i = 0; i < allBlocks.length; i++) {
        const el = allBlocks[i];
        if ((el as HTMLElement).hidden) continue;
        if (typeof (el as { closest?: (s: string) => Element | null }).closest === 'function') {
            if (el.closest(ignoredSelector)) continue;
        }
        if (isHostile(el)) continue;
        if (bodyHeight > 0 && typeof el.getBoundingClientRect === 'function') {
            try {
                const rect = el.getBoundingClientRect();
                if (rect.height <= 0 || rect.width <= 0) continue;
            } catch {
                // Ignore in detached nodes
            }
        }
        if (norm(el.textContent || '').length > 0) candidates.push(el);
    }
    if (!candidates.length) return null;

    const liftOutOfHorizontalFlex = function (el: Element): Element {
        if (typeof getComputedStyle !== 'function') return el;
        let current: Element = el;
        const parent = current.parentElement;
        if (parent && parent !== body) {
            try {
                const style = getComputedStyle(parent);
                if (
                    (style.display === 'flex' || style.display === 'inline-flex') &&
                    !style.flexDirection.startsWith('column')
                ) {
                    current = parent;
                }
            } catch {
                // Keep original element
            }
        }
        return current;
    };

    const pickShortest = function (matches: Element[]): Element | null {
        let best: Element | null = null;
        let bestLen = Infinity;
        for (let i = 0; i < matches.length; i++) {
            const el = matches[i];
            const len = norm(el.textContent || '').length;
            if (len > 0 && len < bestLen) {
                bestLen = len;
                best = el;
            }
        }
        return best ? liftOutOfHorizontalFlex(best) : null;
    };

    if (anchor && anchor.kind === 'marker' && anchor.token) {
        const tokenNorm = norm(anchor.token);
        const tokenLoose = loose(anchor.token);
        const matches: Element[] = [];
        for (let i = 0; i < candidates.length; i++) {
            const el = candidates[i];
            const raw = el.textContent || '';
            if (norm(raw).indexOf(tokenNorm) !== -1 || (!!tokenLoose && loose(raw).indexOf(tokenLoose) !== -1)) {
                matches.push(el);
            }
        }
        const hit = pickShortest(matches);
        if (hit) return hit;
    }

    if (anchor && anchor.kind === 'paragraph') {
        const exNorm = anchor.excerpt ? norm(anchor.excerpt) : '';
        const exLoose = anchor.excerpt ? loose(anchor.excerpt) : '';
        if (exNorm.length >= 6 || exLoose.length >= 6) {
            const head = exLoose.length >= 16 ? exLoose.slice(0, 14) : '';
            const tail = exLoose.length >= 16 ? exLoose.slice(-14) : '';
            const exactMatches: Element[] = [];
            const partialMatches: Element[] = [];
            for (let i = 0; i < candidates.length; i++) {
                const el = candidates[i];
                const raw = el.textContent || '';
                const tNorm = norm(raw);
                const tLoose = loose(raw);
                if ((exNorm && tNorm.indexOf(exNorm) !== -1) || (exLoose && tLoose.indexOf(exLoose) !== -1)) {
                    exactMatches.push(el);
                } else if ((head && tLoose.indexOf(head) !== -1) || (tail && tLoose.indexOf(tail) !== -1)) {
                    partialMatches.push(el);
                }
            }
            const hit = pickShortest(exactMatches) || pickShortest(partialMatches);
            if (hit) return hit;
        }
    }

    if (options && options.allowIndexFallback === false) return null;
    if (typeof (body as { querySelector?: (s: string) => Element | null }).querySelector === 'function') {
        if (body.querySelector('.stthink-root, .stthink, .modern-dark-log')) return null;
    }
    const bodyHead = norm(body.textContent || '').slice(0, 60);
    if (/^(?:思维链|THOUGHT PROCESS|变量更新|UpdateVariable)/i.test(bodyHead)) return null;

    const leafProseBlocks: Element[] = [];
    for (let i = 0; i < candidates.length; i++) {
        const el = candidates[i];
        if (norm(el.textContent || '').length < 16) continue;
        let hasChildProse = false;
        for (let j = 0; j < candidates.length; j++) {
            const other = candidates[j];
            if (other !== el && typeof el.contains === 'function' && el.contains(other) && norm(other.textContent || '').length >= 16) {
                hasChildProse = true;
                break;
            }
        }
        if (!hasChildProse) leafProseBlocks.push(el);
    }
    const totalProseChars = norm(body.textContent || '').length;
    if (leafProseBlocks.length >= 3 && totalProseChars >= 180) {
        if (anchor && anchor.kind === 'paragraph') {
            const idx = typeof anchor.index === 'number' && anchor.index >= 0 ? anchor.index : 0;
            return liftOutOfHorizontalFlex(leafProseBlocks[idx] || leafProseBlocks[leafProseBlocks.length - 1]);
        }
        return liftOutOfHorizontalFlex(leafProseBlocks[leafProseBlocks.length - 1]);
    }

    return null;
}

export function installSandboxMediaBridge(
    findAnchor: typeof findSandboxParagraphAnchor,
    reportMounted: (keys: string[]) => void,
    invokeAction: (key: string, action: string) => Promise<unknown>,
    reportHeight: () => void,
) {
    type SlotNode = {
        slot: SandboxMediaPayload;
        wrapper: HTMLElement;
    };

    const blobUrls = new Map<string, { mediaId: string; url: string }>();
    const activeNodes = new Map<string, SlotNode>();
    let latestSlots: SandboxMediaPayload[] = [];
    let pendingSlots: SandboxMediaPayload[] | null = null;
    let lastMountedSig = '';
    let observerInstalled = false;
    let styleInstalled = false;
    let pendingActions = new Set<string>();
    const openToolKeys = new Set<string>();

    const ensureStyle = () => {
        if (styleInstalled) return;
        const head = document.head || document.documentElement;
        if (!head) return;
        styleInstalled = true;
        const style = document.createElement('style');
        style.setAttribute('data-tipsy-media-style', '1');
        style.textContent = `
.ti-sbx-media-slot { display: block; width: 100%; max-width: 100%; margin: 0.75em 0; text-indent: 0; box-sizing: border-box; font: 500 13.5px/1.35 system-ui, -apple-system, sans-serif; }
.ti-sbx-darkroom { position: relative; isolation: isolate; width: 100%; margin: 0; overflow: hidden; background-color: #1c1713; color: #faf3e3; border-radius: 12px; border: 1px solid rgba(232, 184, 109, 0.22); box-shadow: 0 14px 36px -16px rgba(0, 0, 0, 0.58), inset 0 1px 0 rgba(255, 228, 174, 0.1); }
.ti-sbx-corners { position: absolute; inset: 7px; pointer-events: none; z-index: 1; opacity: 0.6; background: linear-gradient(#e8b86d, #e8b86d) 0 0 / 10px 1.25px no-repeat, linear-gradient(#e8b86d, #e8b86d) 0 0 / 1.25px 10px no-repeat, linear-gradient(#e8b86d, #e8b86d) 100% 0 / 10px 1.25px no-repeat, linear-gradient(#e8b86d, #e8b86d) 100% 0 / 1.25px 10px no-repeat, linear-gradient(#e8b86d, #e8b86d) 0 100% / 10px 1.25px no-repeat, linear-gradient(#e8b86d, #e8b86d) 0 100% / 1.25px 10px no-repeat, linear-gradient(#e8b86d, #e8b86d) 100% 100% / 10px 1.25px no-repeat, linear-gradient(#e8b86d, #e8b86d) 100% 100% / 1.25px 10px no-repeat; }
.ti-sbx-darkroom img { position: absolute; inset: 0; width: 100%; height: 100%; max-width: 100%; object-fit: contain; opacity: 0; filter: blur(8px); transform: scale(1.015); transition: opacity 0.44s ease-out, filter 0.44s ease-out, transform 0.44s ease-out; }
.ti-sbx-darkroom img.is-loaded { opacity: 1; filter: blur(0); transform: scale(1); }
.ti-sbx-shimmer { position: absolute; inset: 0; pointer-events: none; background: radial-gradient(circle at 50% 45%, rgba(232, 168, 92, 0.2), transparent 62%), linear-gradient(110deg, transparent 18%, rgba(246, 212, 148, 0.2) 48%, transparent 78%); background-size: 100% 100%, 220% 100%; animation: ti-sbx-shimmer 2.1s ease-in-out infinite; }
@keyframes ti-sbx-shimmer { 0% { background-position: 0 0, 180% 0; } 100% { background-position: 0 0, -80% 0; } }
.ti-sbx-caption { position: absolute; left: 0; right: 0; bottom: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; background: linear-gradient(180deg, transparent 0%, rgba(16, 13, 10, 0.62) 52%, rgba(12, 10, 8, 0.88) 100%); color: #fff8e7; padding: 1.45em 0.8rem 0.55rem; text-shadow: 0 1px 4px rgba(0, 0, 0, 0.65); pointer-events: none; z-index: 1; font-size: 12.5px; }
.ti-sbx-caption.is-developing { color: #f4d69c; }
.ti-sbx-dock { position: absolute; top: 8px; right: 8px; max-width: calc(100% - 16px); display: flex; flex-direction: column; align-items: flex-end; gap: 6px; z-index: 3; }
.ti-sbx-dock-toggle { display: inline-flex; align-items: center; gap: 5px; min-height: 30px; padding: 0 9px; border: 1px solid rgba(232, 184, 109, 0.38); border-radius: 999px; background: rgba(18, 14, 11, 0.78); color: #f3d293; font: 600 12px/1 system-ui, sans-serif; backdrop-filter: blur(10px); box-shadow: 0 6px 18px rgba(0, 0, 0, 0.42); cursor: pointer; }
.ti-sbx-dock-toggle:hover, .ti-sbx-dock-toggle.is-open { background: rgba(34, 26, 18, 0.94); border-color: rgba(232, 184, 109, 0.72); color: #fff3d4; }
.ti-sbx-ring { width: 11px; height: 11px; border-radius: 50%; border: 1.5px solid currentColor; box-shadow: inset 0 0 0 2px rgba(232, 184, 109, 0.35); display: inline-block; }
.ti-sbx-tools { display: flex; align-items: center; justify-content: flex-end; flex-wrap: wrap; gap: 3px; padding: 4px 6px; background: rgba(18, 15, 12, 0.9); border: 1px solid rgba(232, 184, 109, 0.28); border-radius: 10px; backdrop-filter: blur(12px); box-shadow: 0 14px 32px rgba(0, 0, 0, 0.56); transform-origin: top right; transition: opacity 0.18s cubic-bezier(.16,1,.3,1), transform 0.18s cubic-bezier(.16,1,.3,1), visibility 0.18s; }
.ti-sbx-tools[data-open="false"] { opacity: 0; visibility: hidden; pointer-events: none; transform: translateY(-4px) scale(0.95); }
.ti-sbx-tools[data-open="true"] { opacity: 1; visibility: visible; pointer-events: auto; transform: translateY(0) scale(1); }
.ti-sbx-tools button, .ti-sbx-bookmark button { border: 0; background: transparent; color: inherit; font: inherit; padding: 0 7px; min-height: 30px; border-radius: 6px; cursor: pointer; }
.ti-sbx-tools button:hover, .ti-sbx-tools button:focus-visible { background: rgba(232, 184, 109, 0.2); color: #fff6df; }
.ti-sbx-tools button:disabled, .ti-sbx-bookmark button:disabled { opacity: 0.55; cursor: default; }
.ti-sbx-tools span { font-variant-numeric: tabular-nums; padding: 0 4px; color: #e8b86d; }
.ti-sbx-bookmark { display: flex; justify-content: flex-end; margin: 0.25em 0; }
.ti-sbx-bookmark button { display: inline-flex; align-items: center; gap: 5px; max-width: 16rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 3px 10px; min-height: 28px; font-size: 12px; font-weight: 600; background: linear-gradient(135deg, #f3cf8d, #d89b46); color: #2c1d0a; border: 1px solid rgba(255, 240, 200, 0.45); border-radius: 999px; box-shadow: 0 6px 16px rgba(0, 0, 0, 0.35); }
`;
        head.appendChild(style);
    };

    const resolveUrl = (slot: SandboxMediaPayload): string => {
        const cached = blobUrls.get(slot.key);
        if (!slot.blob || !slot.mediaId) {
            if (cached) {
                URL.revokeObjectURL(cached.url);
                blobUrls.delete(slot.key);
            }
            return '';
        }
        if (cached && cached.mediaId === slot.mediaId) return cached.url;
        if (cached) URL.revokeObjectURL(cached.url);
        const url = URL.createObjectURL(slot.blob);
        blobUrls.set(slot.key, { mediaId: slot.mediaId, url });
        return url;
    };

    const renderSlot = (slot: SandboxMediaPayload, existing?: HTMLElement): HTMLElement => {
        const wrapper = existing || document.createElement('div');
        wrapper.className = 'ti-sbx-media-slot';
        wrapper.setAttribute('data-slot-key', slot.key);
        while (wrapper.firstChild) wrapper.removeChild(wrapper.firstChild);

        const isBusy = pendingActions.has(slot.key);
        const imgUrl = resolveUrl(slot);

        const trigger = (action: string) => {
            if (pendingActions.has(slot.key)) return;
            openToolKeys.delete(slot.key);
            pendingActions.add(slot.key);
            renderSlot(slot, wrapper);
            void invokeAction(slot.key, action)
                .catch(() => {})
                .finally(() => {
                    pendingActions.delete(slot.key);
                    const cur = activeNodes.get(slot.key);
                    if (cur) renderSlot(cur.slot, cur.wrapper);
                });
        };

        if (slot.presentation === 'bookmark') {
            openToolKeys.delete(slot.key);
            const box = document.createElement('div');
            box.className = 'ti-sbx-bookmark';
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.disabled = isBusy;
            btn.title = `${slot.label} · 展开画卷`;
            btn.textContent = `✦ ${slot.label}`;
            btn.addEventListener('click', () => trigger('bookmark'));
            box.appendChild(btn);
            wrapper.appendChild(box);
            return wrapper;
        }

        const figure = document.createElement('figure');
        figure.className = 'ti-sbx-darkroom';
        figure.style.aspectRatio = (slot.aspectRatio || '3:2').replace(':', ' / ');
        const p0 = slot.palette?.[0] || '#221c17';
        const p1 = slot.palette?.[1] || '#3b2e23';
        figure.style.backgroundImage = `linear-gradient(135deg, ${p0}, ${p1})`;

        if (slot.status === 'developing') {
            const shimmer = document.createElement('div');
            shimmer.className = 'ti-sbx-shimmer';
            shimmer.setAttribute('aria-hidden', 'true');
            figure.appendChild(shimmer);
        }

        const corners = document.createElement('span');
        corners.className = 'ti-sbx-corners';
        corners.setAttribute('aria-hidden', 'true');
        figure.appendChild(corners);

        if (imgUrl) {
            const img = document.createElement('img');
            img.src = imgUrl;
            img.alt = slot.label;
            img.addEventListener('load', () => {
                img.classList.add('is-loaded');
                reportHeight();
            });
            img.addEventListener('click', () => {
                if (openToolKeys.has(slot.key)) {
                    openToolKeys.delete(slot.key);
                    syncDock();
                }
            });
            figure.appendChild(img);
        }

        const caption = document.createElement('figcaption');
        caption.className = slot.status === 'developing' ? 'ti-sbx-caption is-developing' : 'ti-sbx-caption';
        caption.textContent =
            slot.status === 'failed' ? '显影失败，可换一镜' : slot.status === 'developing' ? '暗房显影中…' : slot.label;
        figure.appendChild(caption);

        const dock = document.createElement('div');
        dock.className = 'ti-sbx-dock';
        const dockToggle = document.createElement('button');
        dockToggle.type = 'button';
        dockToggle.className = 'ti-sbx-dock-toggle';
        const tools = document.createElement('div');
        tools.className = 'ti-sbx-tools';

        const syncDock = () => {
            const isOpen = openToolKeys.has(slot.key);
            tools.setAttribute('data-open', isOpen ? 'true' : 'false');
            dockToggle.className = isOpen ? 'ti-sbx-dock-toggle is-open' : 'ti-sbx-dock-toggle';
            dockToggle.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
            dockToggle.setAttribute('aria-label', isOpen ? '收起胶片操作栏' : '展开胶片操作栏');
            dockToggle.title = isOpen ? '收起操作' : '浮光暗房工具';
            while (dockToggle.firstChild) dockToggle.removeChild(dockToggle.firstChild);
            if (isOpen) {
                const closeMark = document.createElement('span');
                closeMark.textContent = '✕';
                dockToggle.appendChild(closeMark);
            } else {
                const ring = document.createElement('span');
                ring.className = 'ti-sbx-ring';
                ring.setAttribute('aria-hidden', 'true');
                dockToggle.appendChild(ring);
            }
            if (slot.takeCount > 1) {
                const badge = document.createElement('span');
                badge.textContent = `${slot.takeIndex + 1}/${slot.takeCount}`;
                dockToggle.appendChild(badge);
            }
        };

        dockToggle.addEventListener('click', () => {
            if (openToolKeys.has(slot.key)) openToolKeys.delete(slot.key);
            else openToolKeys.add(slot.key);
            syncDock();
        });

        const addBtn = (text: string, title: string, action: string) => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.disabled = isBusy;
            btn.title = title;
            btn.setAttribute('aria-label', title);
            btn.textContent = text;
            btn.addEventListener('click', () => trigger(action));
            tools.appendChild(btn);
        };
        if (slot.takeCount > 1) {
            addBtn('‹', '上一帧', 'previous');
            const counter = document.createElement('span');
            counter.textContent = `${slot.takeIndex + 1}/${slot.takeCount}`;
            tools.appendChild(counter);
            addBtn('›', '下一帧', 'next');
        }
        addBtn('↻ 换一镜', '重新生成一帧并保留旧帧', 'reroll');
        addBtn('收为书签', '折叠为页边琥珀胶片签', 'bookmark');
        if (slot.canStage) addBtn('设为舞台', '将此帧设为本幕背景舞台', 'stage');
        if (slot.blob) addBtn('保存', '保存原图', 'save');

        syncDock();
        dock.appendChild(dockToggle);
        dock.appendChild(tools);
        figure.appendChild(dock);
        wrapper.appendChild(figure);
        return wrapper;
    };

    const syncMount = () => {
        if (!document.body) return;
        const mountedKeys: string[] = [];
        for (let i = latestSlots.length - 1; i >= 0; i--) {
            const slot = latestSlots[i];
            const entry = activeNodes.get(slot.key);
            if (!entry) continue;
            const after = findAnchor(document, slot.anchor);
            if (after && after.parentNode) {
                if (!entry.wrapper.isConnected || after.nextElementSibling !== entry.wrapper) {
                    after.after(entry.wrapper);
                }
                mountedKeys.unshift(slot.key);
            } else if (entry.wrapper.isConnected) {
                entry.wrapper.remove();
            }
        }
        const sig = mountedKeys.join('|');
        if (sig !== lastMountedSig) {
            lastMountedSig = sig;
            reportMounted(mountedKeys);
        }
        reportHeight();
    };

    const installObserver = () => {
        if (observerInstalled || !document.body || typeof MutationObserver === 'undefined') return;
        observerInstalled = true;
        let raf = 0;
        const observer = new MutationObserver((records) => {
            if (!latestSlots.length) return;
            const relevant = records.some((record) => {
                const target = record.target as HTMLElement | null;
                return target && !target.closest?.('.ti-sbx-media-slot') && !target.hasAttribute?.('data-tipsy-media-style');
            });
            if (!relevant || raf) return;
            raf = requestAnimationFrame(() => {
                raf = 0;
                syncMount();
            });
        });
        observer.observe(document.body, { childList: true, subtree: true });
    };

    const applyMedia = (slots: SandboxMediaPayload[]) => {
        if (!document.body) {
            pendingSlots = slots;
            return;
        }
        ensureStyle();
        installObserver();
        latestSlots = slots;

        const nextKeys = new Set(slots.map((s) => s.key));
        for (const [key, entry] of activeNodes.entries()) {
            if (!nextKeys.has(key)) {
                entry.wrapper.remove();
                activeNodes.delete(key);
                const cached = blobUrls.get(key);
                if (cached) {
                    URL.revokeObjectURL(cached.url);
                    blobUrls.delete(key);
                }
            }
        }

        for (const slot of slots) {
            const prev = activeNodes.get(slot.key);
            const wrapper = renderSlot(slot, prev?.wrapper);
            activeNodes.set(slot.key, { slot, wrapper });
        }
        syncMount();
    };

    window.addEventListener(
        'DOMContentLoaded',
        () => {
            installObserver();
            if (pendingSlots) {
                const next = pendingSlots;
                pendingSlots = null;
                applyMedia(next);
            }
        },
        { once: true },
    );

    return applyMedia;
}

import type { ProseAnchorSpec } from '../../packages/plugin-sdk/index.js';
import { mountMediaSlot } from '../plugins/native/prose-anchor';
import { findSandboxParagraphAnchor } from '../sandbox/sandbox-media-shim';

export interface CompatFilmSurfaceAction {
    id: string;
    label: string;
    title?: string;
    kind?: 'action' | 'command';
    commandId?: string;
}

export interface CompatFilmSlot {
    key: string;
    message: string;
    swipe: string;
    anchor?: ProseAnchorSpec;
    status: 'developing' | 'ready' | 'failed';
    label: string;
    subtitle?: string;
    ratio: string;
    palette?: [string, string];
    presentation?: 'editorial' | 'bookmark' | 'polaroid';
    takeIndex: number;
    takeCount: number;
    canStage: boolean;
    mediaId?: string;
    commandId?: string;
    actions?: CompatFilmSurfaceAction[];
    busy?: boolean;
    fault?: string;
}

export interface CompatFilmActionRequest {
    key: string;
    action: 'previous' | 'next' | 'reroll' | 'bookmark' | 'stage' | 'save' | 'lightbox' | 'command' | 'custom';
    commandId?: string;
    customId?: string;
    mediaId?: string;
}

const FILM_SHADOW_CSS = `
:host {
    all: initial !important;
    display: block !important;
    width: 100% !important;
    max-width: 100% !important;
    min-height: 0 !important;
    margin: 0.75em 0 !important;
    padding: 0 !important;
    border: 0 !important;
    background: transparent !important;
    text-indent: 0 !important;
    box-sizing: border-box !important;
    font: 500 13.5px/1.35 system-ui, -apple-system, BlinkMacSystemFont, sans-serif !important;
    color: #faf6e9 !important;
    contain: layout style !important;
}
:host([data-folded="1"]) {
    height: 0 !important;
    min-height: 0 !important;
    margin: 0 !important;
    overflow: visible !important;
    contain: none !important;
}
*, *::before, *::after {
    box-sizing: border-box;
}
.ti-darkroom {
    position: relative;
    isolation: isolate;
    width: 100%;
    margin: 0;
    overflow: hidden;
    background-color: #25221f;
    color: #faf6e9;
    border-radius: 10px;
    box-shadow: 0 8px 26px -12px rgba(0, 0, 0, 0.45);
}
.ti-darkroom.ti-polaroid {
    max-width: 22rem;
    border: 6px solid #f4eee1;
    box-shadow: 0 10px 24px rgba(0, 0, 0, 0.35);
}
.ti-darkroom[aria-busy="true"]::after {
    content: '';
    pointer-events: none;
    position: absolute;
    inset: 0;
    border: 1.5px solid rgba(239, 199, 128, 0.45);
    border-radius: inherit;
}
.ti-darkroom img {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    max-width: 100%;
    object-fit: contain;
    opacity: 0;
    filter: blur(8px);
    transform: scale(1.015);
    transition: opacity 0.42s ease-out, filter 0.42s ease-out, transform 0.42s ease-out;
    cursor: zoom-in;
}
.ti-darkroom img.is-loaded {
    opacity: 1;
    filter: blur(0);
    transform: scale(1);
}
.ti-darkroom-shimmer {
    position: absolute;
    inset: 0;
    pointer-events: none;
    background: linear-gradient(110deg, transparent 20%, rgba(239, 199, 128, 0.14) 48%, transparent 76%);
    background-size: 220% 100%;
    animation: ti-darkroom-shimmer 2.1s ease-in-out infinite;
}
@keyframes ti-darkroom-shimmer {
    0% { background-position: 180% 0; }
    100% { background-position: -80% 0; }
}
figcaption {
    position: absolute;
    left: 0.6rem;
    bottom: 0.55rem;
    max-width: calc(100% - 1.2rem);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    background: rgba(28, 24, 20, 0.84);
    color: #fff9e8;
    padding: 0.24em 0.6em;
    border-radius: 0.35em;
    backdrop-filter: blur(6px);
    z-index: 1;
}
figcaption.is-developing {
    border: 1px solid rgba(239, 199, 128, 0.4);
    color: #f4d69c;
}
.ti-darkroom-subtitle {
    display: block;
    font-size: 0.72rem;
    opacity: 0.78;
    overflow: hidden;
    text-overflow: ellipsis;
}
.ti-film-tools {
    position: absolute;
    right: 0.5em;
    top: 0.5em;
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.2em;
    max-width: calc(100% - 1em);
    padding: 0.22em 0.3em;
    background: rgba(24, 21, 18, 0.86);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 0.55em;
    backdrop-filter: blur(8px);
    z-index: 2;
    transition: opacity 0.16s ease-out;
}
@media (hover: hover) {
    .ti-darkroom:not(:hover):not(:focus-within) .ti-film-tools {
        opacity: 0;
    }
}
.ti-film-tools button,
.ti-margin-tab button {
    border: 0;
    background: transparent;
    color: inherit;
    font: inherit;
    padding: 0 0.48em;
    min-height: 30px;
    border-radius: 0.35em;
    cursor: pointer;
    touch-action: manipulation;
}
.ti-film-tools button:hover,
.ti-film-tools button:focus-visible {
    background: rgba(255, 255, 255, 0.16);
}
.ti-film-tools button:disabled,
.ti-margin-tab button:disabled {
    opacity: 0.55;
    cursor: default;
}
.ti-film-tools span {
    font-variant-numeric: tabular-nums;
    padding: 0 0.25em;
}
.ti-margin-tab {
    position: relative;
    height: 0;
    z-index: 3;
    text-align: end;
}
.ti-margin-tab button {
    position: relative;
    display: inline-flex;
    align-items: center;
    gap: 0.35em;
    max-width: 14rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    padding: 0.15em 0.6em;
    min-height: 26px;
    font-size: 0.78rem;
    background: linear-gradient(135deg, #f3cf8d, #dda858);
    color: #35250f;
    border-radius: 0.4em;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.28);
}
.ti-margin-preview {
    position: absolute;
    right: 0;
    top: 30px;
    width: 210px;
    padding: 6px;
    border-radius: 8px;
    background: rgba(24, 21, 18, 0.94);
    color: #faf6e9;
    border: 1px solid rgba(239, 199, 128, 0.3);
    box-shadow: 0 14px 32px rgba(0, 0, 0, 0.48);
    opacity: 0;
    pointer-events: none;
    transform: translateY(-4px);
    transition: opacity 0.18s ease, transform 0.18s ease;
    text-align: start;
}
.ti-margin-preview img {
    display: block;
    width: 100%;
    height: auto;
    max-height: 150px;
    object-fit: cover;
    border-radius: 5px;
}
.ti-margin-preview span {
    display: block;
    margin-top: 4px;
    font-size: 0.74rem;
    opacity: 0.88;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.ti-margin-tab:hover .ti-margin-preview,
.ti-margin-tab:focus-within .ti-margin-preview {
    opacity: 1;
    transform: translateY(0);
}
.ti-margin-fault {
    display: block;
    font-size: 0.75rem;
    color: #ffb4a2;
}
@media (prefers-reduced-motion: reduce) {
    .ti-darkroom-shimmer { animation: none; }
    .ti-darkroom img, .ti-film-tools, .ti-margin-preview { transition: none; }
}
`;

interface MediaEntry {
    mediaId: string;
    blob: Blob;
    url: string;
    name: string;
}

interface MountedSurface {
    slot: CompatFilmSlot;
    token: string;
    host: HTMLElement;
    container: ParentNode;
    doc: Document;
    hostFrame?: HTMLIFrameElement;
    mode?: 'bookmark' | 'darkroom';
    figure?: HTMLElement;
    shimmer?: HTMLElement;
    img?: HTMLImageElement;
    imgUrl?: string;
    imgFallbackUrl?: string;
    figcaption?: HTMLElement;
    tools?: HTMLElement;
    bookmarkPreviewImg?: HTMLImageElement;
}

function attachClosedShadow(
    host: HTMLElement,
    doc: Document,
    nativeAttachShadow?: (init: ShadowRootInit) => ShadowRoot,
): ParentNode {
    const createRoot = (): ShadowRoot | null => {
        if (nativeAttachShadow) {
            try {
                return nativeAttachShadow.call(host, { mode: 'closed' });
            } catch {
                // Fall back to element's own attachShadow when crossing realm or mock wrappers.
            }
        }
        if (typeof host.attachShadow === 'function') {
            try {
                return host.attachShadow({ mode: 'closed' });
            } catch {
                return null;
            }
        }
        return null;
    };
    const shadow = createRoot();
    if (!shadow) return host;
    const style = doc.createElement('style');
    style.textContent = FILM_SHADOW_CSS;
    const container = doc.createElement('div');
    shadow.appendChild(style);
    shadow.appendChild(container);
    return container;
}

function listenTrusted(
    el: EventTarget,
    handler: (event: Event) => void,
    nativeAddEventListener?: EventTarget['addEventListener'],
) {
    const wrapped = (event: Event) => {
        if (!event.isTrusted) {
            event.stopImmediatePropagation?.();
            return;
        }
        handler(event);
    };
    if (nativeAddEventListener) {
        try {
            nativeAddEventListener.call(el, 'click', wrapped, { capture: true });
            return;
        } catch {
            // Fall back to element's own addEventListener in mock or isolated environments.
        }
    }
    if (typeof el.addEventListener === 'function') {
        el.addEventListener('click', wrapped, { capture: true });
    }
}

export function createFilmSurface({
    row,
    onAction,
    onMediaNeed,
    onVisibleChange,
}: {
    row: (id: string) => HTMLElement | undefined;
    onAction: (request: CompatFilmActionRequest, token: string) => void;
    onMediaNeed?: (mediaIds: string[]) => void;
    onVisibleChange?: (visible: string | undefined) => void;
}) {
    // Capture native DOM & Blob URL primitives at surface creation (before any author script loads).
    const nativeAttachShadow = typeof Element !== 'undefined' ? Element.prototype.attachShadow : undefined;
    const nativeAddEventListener = typeof EventTarget !== 'undefined' ? EventTarget.prototype.addEventListener : undefined;
    const nativeCreateObjectURL = typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function' ? URL.createObjectURL.bind(URL) : undefined;
    const nativeRevokeObjectURL = typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function' ? URL.revokeObjectURL.bind(URL) : undefined;
    const surfaces = new Map<string, MountedSurface>();
    const mediaCache = new Map<string, MediaEntry>();
    const observedDocs = new WeakMap<Document, MutationObserver>();
    let slots: CompatFilmSlot[] = [];
    let currentToken = '';
    let visibleRaf = 0;
    let syncRaf = 0;
    let lastVisible: string | undefined = '__init__';
    let disposed = false;

    const reportVisible = () => {
        visibleRaf = 0;
        if (disposed || !onVisibleChange || typeof document.elementFromPoint !== 'function') return;
        const probe = document.elementFromPoint(innerWidth * 0.5, innerHeight * 0.35);
        const visible = probe?.closest<HTMLElement>('[data-message-id]')?.dataset.messageId;
        if (visible !== lastVisible) {
            lastVisible = visible;
            onVisibleChange(visible);
        }
    };

    const scheduleVisible = () => {
        if (!disposed && !visibleRaf && onVisibleChange) {
            visibleRaf = requestAnimationFrame(reportVisible);
        }
    };

    const scheduleSync = () => {
        if (!disposed && !syncRaf && slots.length) {
            syncRaf = requestAnimationFrame(() => {
                syncRaf = 0;
                if (!disposed) sync();
            });
        }
    };

    const onScroll = () => scheduleVisible();
    const onResize = () => scheduleVisible();
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
        window.addEventListener('scroll', onScroll, { passive: true });
        window.addEventListener('resize', onResize);
    }

    const watchChildDoc = (doc: Document) => {
        if (observedDocs.has(doc) || !doc.body || typeof MutationObserver === 'undefined') return;
        const observer = new MutationObserver((records) => {
            if (disposed || !slots.length) return;
            const relevant = records.some((record) => {
                const target = record.target as HTMLElement | null;
                return target && !target.closest?.('.compat-native-media-slot') && !target.hasAttribute?.('data-tipsy-film');
            });
            if (relevant) scheduleSync();
        });
        observer.observe(doc.body, { childList: true, subtree: true });
        observedDocs.set(doc, observer);
    };

    const findBestChildFrameMatch = (
        body: HTMLElement,
        spec: CompatFilmSlot,
    ): { frame: HTMLIFrameElement; doc: Document; after: Element } | null => {
        if (body.querySelector(':scope > .message-markdown, :scope > .tipsy-stream-parts > .message-markdown')) return null;
        const loadedFrames: { frame: HTMLIFrameElement; doc: Document }[] = [];
        for (const frame of Array.from(body.querySelectorAll<HTMLIFrameElement>('iframe.compat-message-frame'))) {
            let doc: Document | null = null;
            try { doc = frame.contentDocument; } catch { doc = null; }
            if (!doc?.body) continue;
            watchChildDoc(doc);
            loadedFrames.push({ frame, doc });
        }
        if (!loadedFrames.length) return null;

        for (const { frame, doc } of loadedFrames) {
            const after = findSandboxParagraphAnchor(doc, spec.anchor, { allowIndexFallback: false });
            if (after && after.parentNode) return { frame, doc, after };
        }

        const byHeight = [...loadedFrames].sort((a, b) => {
            const ha = typeof a.frame.getBoundingClientRect === 'function' ? a.frame.getBoundingClientRect().height : 0;
            const hb = typeof b.frame.getBoundingClientRect === 'function' ? b.frame.getBoundingClientRect().height : 0;
            return hb - ha;
        });
        for (const { frame, doc } of byHeight) {
            const after = findSandboxParagraphAnchor(doc, spec.anchor, { allowIndexFallback: true });
            if (after && after.parentNode) return { frame, doc, after };
        }
        return null;
    };

    const makeButton = (
        doc: Document,
        text: string,
        title: string,
        disabled: boolean,
        onClick: () => void,
    ) => {
        const btn = doc.createElement('button');
        btn.type = 'button';
        btn.disabled = disabled;
        btn.title = title;
        btn.setAttribute('aria-label', title);
        btn.textContent = text;
        listenTrusted(btn, onClick, nativeAddEventListener);
        return btn;
    };

    const emitAction = (surface: MountedSurface, req: Omit<CompatFilmActionRequest, 'key'>) => {
        onAction({ key: surface.slot.key, ...req }, surface.token);
    };

    const renderSurface = (surface: MountedSurface) => {
        const { slot, doc, container, host } = surface;
        const folded = slot.presentation === 'bookmark';
        const media = slot.mediaId ? mediaCache.get(slot.mediaId) : undefined;
        const busy = !!slot.busy;

        if (folded) host.setAttribute('data-folded', '1');
        else host.removeAttribute?.('data-folded');

        if (folded) {
            if (surface.mode !== 'bookmark') {
                while (container.firstChild) container.removeChild(container.firstChild);
                surface.figure = undefined;
                surface.shimmer = undefined;
                surface.img = undefined;
                surface.imgUrl = undefined;
                surface.figcaption = undefined;
                surface.tools = undefined;
                surface.bookmarkPreviewImg = undefined;
                surface.mode = 'bookmark';
            }
            while (container.firstChild) container.removeChild(container.firstChild);
            const tab = doc.createElement('div');
            tab.className = 'ti-margin-tab';
            const toggleBtn = makeButton(doc, `🔖 ${slot.label}`, `${slot.label} · 展开画卷`, busy, () =>
                emitAction(surface, { action: 'bookmark' }),
            );
            tab.appendChild(toggleBtn);
            if (media) {
                const preview = doc.createElement('div');
                preview.className = 'ti-margin-preview';
                preview.setAttribute('aria-hidden', 'true');
                const img = doc.createElement('img');
                img.src = media.url;
                img.alt = '';
                const cap = doc.createElement('span');
                cap.textContent = slot.label;
                preview.appendChild(img);
                preview.appendChild(cap);
                tab.appendChild(preview);
                surface.bookmarkPreviewImg = img;
            }
            if (slot.fault) {
                const err = doc.createElement('span');
                err.className = 'ti-margin-fault';
                err.setAttribute('role', 'alert');
                err.textContent = slot.fault;
                tab.appendChild(err);
            }
            container.appendChild(tab);
            return;
        }

        if (surface.mode !== 'darkroom' || !surface.figure) {
            while (container.firstChild) container.removeChild(container.firstChild);
            surface.bookmarkPreviewImg = undefined;
            surface.mode = 'darkroom';

            const figure = doc.createElement('figure');
            figure.className = 'ti-darkroom';
            const figcaption = doc.createElement('figcaption');
            const tools = doc.createElement('div');
            tools.className = 'ti-film-tools';
            figure.appendChild(figcaption);
            figure.appendChild(tools);
            container.appendChild(figure);

            surface.figure = figure;
            surface.figcaption = figcaption;
            surface.tools = tools;
            surface.shimmer = undefined;
            surface.img = undefined;
            surface.imgUrl = undefined;
        }

        const figure = surface.figure!;
        const developing = slot.status === 'developing';
        const paletteA = slot.palette?.[0] ?? '#25221f';
        const paletteB = slot.palette?.[1] ?? '#3a3128';
        figure.className = `ti-darkroom${slot.presentation === 'polaroid' ? ' ti-polaroid' : ''}`;
        figure.setAttribute('aria-busy', developing ? 'true' : 'false');
        figure.style.aspectRatio = (slot.ratio || '3:2').replace(':', ' / ');
        figure.style.backgroundImage = `linear-gradient(135deg, ${paletteA}, ${paletteB})`;

        if (developing && !surface.shimmer) {
            const shimmer = doc.createElement('div');
            shimmer.className = 'ti-darkroom-shimmer';
            shimmer.setAttribute('aria-hidden', 'true');
            figure.insertBefore(shimmer, surface.figcaption ?? null);
            surface.shimmer = shimmer;
        } else if (!developing && surface.shimmer) {
            surface.shimmer.remove();
            surface.shimmer = undefined;
        }

        if (media) {
            if (!surface.img) {
                const img = doc.createElement('img');
                listenTrusted(img, () => emitAction(surface, { action: 'lightbox', mediaId: slot.mediaId }), nativeAddEventListener);
                img.addEventListener?.('load', () => {
                    img.classList.add('is-loaded');
                });
                img.addEventListener?.('error', () => {
                    const current = surface.slot.mediaId ? mediaCache.get(surface.slot.mediaId) : undefined;
                    if (!current || surface.imgFallbackUrl === current.url || typeof FileReader !== 'function') return;
                    surface.imgFallbackUrl = current.url;
                    const reader = new FileReader();
                    reader.onload = () => {
                        if (disposed || typeof reader.result !== 'string') return;
                        if (surface.slot.mediaId === current.mediaId && surface.img === img) {
                            img.src = reader.result;
                            if (img.complete && img.naturalWidth > 0) {
                                img.classList.add('is-loaded');
                            }
                        }
                    };
                    reader.readAsDataURL(current.blob);
                });
                figure.insertBefore(img, surface.figcaption ?? null);
                surface.img = img;
            }
            surface.img.alt = slot.label;
            if (surface.imgUrl !== media.url) {
                surface.img.classList.remove('is-loaded');
                surface.imgFallbackUrl = undefined;
                surface.img.src = media.url;
                surface.imgUrl = media.url;
                if (surface.img.complete && surface.img.naturalWidth > 0) {
                    surface.img.classList.add('is-loaded');
                }
            }
        } else if (surface.img) {
            surface.img.remove();
            surface.img = undefined;
            surface.imgUrl = undefined;
            surface.imgFallbackUrl = undefined;
        }

        const caption = surface.figcaption!;
        caption.className = developing ? 'is-developing' : '';
        while (caption.firstChild) caption.removeChild(caption.firstChild);
        caption.textContent = slot.fault || (slot.status === 'failed' ? '显影失败，可换一镜' : developing ? '暗房显影中…' : slot.label);
        if (!slot.fault && slot.subtitle) {
            const sub = doc.createElement('span');
            sub.className = 'ti-darkroom-subtitle';
            sub.textContent = slot.subtitle;
            caption.appendChild(sub);
        }

        const tools = surface.tools!;
        while (tools.firstChild) tools.removeChild(tools.firstChild);
        if (slot.takeCount > 1) {
            tools.appendChild(makeButton(doc, '‹', '上一帧', busy, () => emitAction(surface, { action: 'previous' })));
            const counter = doc.createElement('span');
            counter.textContent = `${slot.takeIndex + 1}/${slot.takeCount}`;
            tools.appendChild(counter);
            tools.appendChild(makeButton(doc, '›', '下一帧', busy, () => emitAction(surface, { action: 'next' })));
        }
        tools.appendChild(makeButton(doc, '↻ 换一镜', '重新生成一帧并保留旧帧', busy, () => emitAction(surface, { action: 'reroll' })));
        if (slot.commandId) {
            const commandId = slot.commandId;
            tools.appendChild(makeButton(doc, '精修', '打开暗房精修台', busy, () => emitAction(surface, { action: 'command', commandId })));
        }
        for (const act of slot.actions ?? []) {
            tools.appendChild(
                makeButton(doc, act.label, act.title || act.label, busy, () => {
                    if (act.kind === 'command' && act.commandId) {
                        emitAction(surface, { action: 'command', commandId: act.commandId });
                    } else {
                        emitAction(surface, { action: 'custom', customId: act.id });
                    }
                }),
            );
        }
        tools.appendChild(makeButton(doc, '收为书签', '折叠为页边琥珀胶片签', busy, () => emitAction(surface, { action: 'bookmark' })));
        if (slot.canStage) {
            tools.appendChild(makeButton(doc, '设为舞台', '将此帧设为本幕背景舞台', busy, () => emitAction(surface, { action: 'stage' })));
        }
        if (media) {
            tools.appendChild(makeButton(doc, '放大', '查看大图', busy, () => emitAction(surface, { action: 'lightbox', mediaId: slot.mediaId })));
            tools.appendChild(makeButton(doc, '保存', '保存原图', busy, () => emitAction(surface, { action: 'save', mediaId: slot.mediaId })));
        }
    };

    const gcMedia = () => {
        const neededIds = new Set(slots.map((s) => s.mediaId).filter((id): id is string => !!id));
        for (const [mediaId, entry] of mediaCache) {
            if (!neededIds.has(mediaId)) {
                nativeRevokeObjectURL?.(entry.url);
                mediaCache.delete(mediaId);
            }
        }
    };

    function sync(next = slots, token = currentToken) {
        if (disposed) return;
        slots = next;
        if (token) currentToken = token;
        const keep = new Set<string>();

        for (const spec of next) {
            const article = row(spec.message);
            if (!article || article.dataset.readingSwipe !== spec.swipe) continue;
            const body = article.querySelector<HTMLElement>(':scope > .mes_text,:scope > .compat-stream-body');
            if (!body) continue;

            keep.add(spec.key);
            const old = surfaces.get(spec.key);
            const bestMatch = findBestChildFrameMatch(body, spec);
            const targetDoc = bestMatch ? bestMatch.doc : document;

            if (bestMatch) {
                const canReuse = old && old.hostFrame === bestMatch.frame && old.doc === bestMatch.doc;
                if (!canReuse && old) old.host.remove();
                const surface: MountedSurface = canReuse
                    ? old!
                    : (() => {
                        const host = targetDoc.createElement('div');
                        host.className = 'compat-native-media-slot';
                        host.setAttribute('data-tipsy-film', '1');
                        const container = attachClosedShadow(host, targetDoc, nativeAttachShadow);
                        return { slot: spec, token: currentToken, host, container, doc: targetDoc, hostFrame: bestMatch.frame };
                    })();
                surface.slot = spec;
                surface.token = currentToken;
                surface.hostFrame = bestMatch.frame;
                if (!surface.host.isConnected || bestMatch.after.nextElementSibling !== surface.host) {
                    bestMatch.after.after(surface.host);
                }
                renderSurface(surface);
                surfaces.set(spec.key, surface);
            } else {
                const canReuse = old && !old.hostFrame && old.doc === document;
                if (!canReuse && old) old.host.remove();
                const surface: MountedSurface = canReuse
                    ? old!
                    : (() => {
                        const host = document.createElement('div');
                        host.className = 'compat-native-media-slot';
                        host.setAttribute('data-tipsy-film', '1');
                        const container = attachClosedShadow(host, document, nativeAttachShadow);
                        return { slot: spec, token: currentToken, host, container, doc: document };
                    })();
                surface.slot = spec;
                surface.token = currentToken;
                mountMediaSlot(body, surface.host, spec.anchor);
                renderSurface(surface);
                surfaces.set(spec.key, surface);
            }
        }

        for (const [key, entry] of surfaces) {
            if (!keep.has(key)) {
                entry.host.remove();
                surfaces.delete(key);
            }
        }
        gcMedia();
        const missingMediaIds = [
            ...new Set(
                next
                    .map((s) => s.mediaId)
                    .filter((id): id is string => !!id && !mediaCache.has(id)),
            ),
        ];
        if (missingMediaIds.length && onMediaNeed) {
            onMediaNeed(missingMediaIds);
        }
        scheduleVisible();
    }

    function receiveMedia(mediaId: string, blob: Blob, name = '') {
        if (disposed || !mediaId || !blob || !/^image\/(?:png|jpeg|webp)$/.test(blob.type) || !nativeCreateObjectURL) return;
        const existing = mediaCache.get(mediaId);
        if (!existing || existing.blob !== blob) {
            if (existing) nativeRevokeObjectURL?.(existing.url);
            const url = nativeCreateObjectURL(blob);
            mediaCache.set(mediaId, { mediaId, blob, url, name });
        }
        let updated = false;
        for (const surface of surfaces.values()) {
            if (surface.slot.mediaId === mediaId) {
                renderSurface(surface);
                updated = true;
            }
        }
        if (!updated && slots.some((s) => s.mediaId === mediaId)) {
            scheduleSync();
        }
    }

    function dispose() {
        if (disposed) return;
        disposed = true;
        if (visibleRaf) cancelAnimationFrame(visibleRaf);
        if (syncRaf) cancelAnimationFrame(syncRaf);
        if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
            window.removeEventListener('scroll', onScroll);
            window.removeEventListener('resize', onResize);
        }
        for (const entry of surfaces.values()) entry.host.remove();
        surfaces.clear();
        for (const entry of mediaCache.values()) nativeRevokeObjectURL?.(entry.url);
        mediaCache.clear();
    }

    return { sync, receiveMedia, schedule: scheduleVisible, dispose };
}

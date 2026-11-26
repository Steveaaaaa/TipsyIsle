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

export function findSandboxParagraphAnchor(
    doc: Document,
    anchor?: SandboxAnchorSpec,
    options?: { allowIndexFallback?: boolean },
): Element | null {
    const body = doc?.body;
    if (!body) return null;

    const norm = (value: string) => value.replace(/\s+/g, ' ').trim();
    const loose = (value: string) =>
        value
            .replace(/\{[^}]{1,16}\}/g, '')
            .replace(/\*\*/g, '')
            .replace(/[\s「」『』"'“”‘’【】()（）]/g, '');

    const ignoredSelector =
        'script, style, template, noscript, svg, header, nav, footer, dialog, details:not([open]), .ti-sbx-media-slot, .compat-native-media-slot, .cg-container, .image-content, .image-modal, .settings-panel, .settings-drawer, .stthink-root, .stthink, .modern-dark-log, .reasoning, [data-reasoning]';

    const bodyHeight = typeof (body as { getBoundingClientRect?: () => { height: number } }).getBoundingClientRect === 'function'
        ? body.getBoundingClientRect().height
        : 0;
    const allBlocks = Array.from(
        body.querySelectorAll('p, blockquote, li, div, article, section, h1, h2, h3, h4, h5, h6'),
    );
    const candidates = allBlocks.filter((el) => {
        if ((el as HTMLElement).hidden) return false;
        if (typeof (el as { closest?: (s: string) => Element | null }).closest === 'function') {
            if (el.closest(ignoredSelector)) return false;
        }
        if (typeof getComputedStyle === 'function') {
            try {
                if (getComputedStyle(el).display === 'none') return false;
            } catch {
                // Ignore style lookup errors in detached/test nodes
            }
        }
        if (bodyHeight > 0 && typeof el.getBoundingClientRect === 'function') {
            try {
                const rect = el.getBoundingClientRect();
                if (rect.height <= 0 || rect.width <= 0) return false;
            } catch {
                // Ignore in detached nodes
            }
        }
        return norm(el.textContent ?? '').length > 0;
    });
    if (!candidates.length) return null;

    const liftOutOfHorizontalFlex = (el: Element): Element => {
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

    const pickShortest = (matches: Element[]): Element | null => {
        let best: Element | null = null;
        let bestLen = Infinity;
        for (const el of matches) {
            const len = norm(el.textContent ?? '').length;
            if (len > 0 && len < bestLen) {
                bestLen = len;
                best = el;
            }
        }
        return best ? liftOutOfHorizontalFlex(best) : null;
    };

    if (anchor?.kind === 'marker' && anchor.token) {
        const tokenNorm = norm(anchor.token);
        const tokenLoose = loose(anchor.token);
        const matches = candidates.filter((el) => {
            const raw = el.textContent ?? '';
            return norm(raw).includes(tokenNorm) || (!!tokenLoose && loose(raw).includes(tokenLoose));
        });
        const hit = pickShortest(matches);
        if (hit) return hit;
    }

    if (anchor?.kind === 'paragraph') {
        const exNorm = anchor.excerpt ? norm(anchor.excerpt) : '';
        const exLoose = anchor.excerpt ? loose(anchor.excerpt) : '';
        if (exNorm.length >= 6 || exLoose.length >= 6) {
            const head = exLoose.length >= 16 ? exLoose.slice(0, 14) : '';
            const tail = exLoose.length >= 16 ? exLoose.slice(-14) : '';
            const exactMatches: Element[] = [];
            const partialMatches: Element[] = [];
            for (const el of candidates) {
                const raw = el.textContent ?? '';
                const tNorm = norm(raw);
                const tLoose = loose(raw);
                if ((exNorm && tNorm.includes(exNorm)) || (exLoose && tLoose.includes(exLoose))) {
                    exactMatches.push(el);
                } else if ((head && tLoose.includes(head)) || (tail && tLoose.includes(tail))) {
                    partialMatches.push(el);
                }
            }
            const hit = pickShortest(exactMatches) ?? pickShortest(partialMatches);
            if (hit) return hit;
        }
    }

    if (options?.allowIndexFallback === false) return null;
    if (typeof (body as { querySelector?: (s: string) => Element | null }).querySelector === 'function') {
        if (body.querySelector('.stthink-root, .stthink, .modern-dark-log')) return null;
    }
    const bodyHead = norm(body.textContent ?? '').slice(0, 60);
    if (/^(?:思维链|THOUGHT PROCESS|变量更新|UpdateVariable)/i.test(bodyHead)) return null;

    const leafProseBlocks = candidates.filter((el) => {
        if (norm(el.textContent ?? '').length < 16) return false;
        return !candidates.some(
            (other) => other !== el && typeof el.contains === 'function' && el.contains(other) && norm(other.textContent ?? '').length >= 16,
        );
    });
    const totalProseChars = norm(body.textContent ?? '').length;
    if (leafProseBlocks.length >= 3 && totalProseChars >= 180) {
        if (anchor?.kind === 'paragraph') {
            const idx = typeof anchor.index === 'number' && anchor.index >= 0 ? anchor.index : 0;
            return liftOutOfHorizontalFlex(leafProseBlocks[idx] ?? leafProseBlocks[leafProseBlocks.length - 1]);
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

    const ensureStyle = () => {
        if (styleInstalled) return;
        const head = document.head || document.documentElement;
        if (!head) return;
        styleInstalled = true;
        const style = document.createElement('style');
        style.setAttribute('data-tipsy-media-style', '1');
        style.textContent = `
.ti-sbx-media-slot { display: block; width: 100%; max-width: 100%; margin: 0.75em 0; text-indent: 0; box-sizing: border-box; font: 500 13.5px/1.35 system-ui, -apple-system, sans-serif; }
.ti-sbx-darkroom { position: relative; isolation: isolate; width: 100%; margin: 0; overflow: hidden; background-color: #25221f; color: #faf6e9; border-radius: 10px; box-shadow: 0 8px 24px -12px rgba(0, 0, 0, 0.45); }
.ti-sbx-darkroom img { position: absolute; inset: 0; width: 100%; height: 100%; max-width: 100%; object-fit: contain; opacity: 0; filter: blur(8px); transform: scale(1.015); transition: opacity 0.42s ease-out, filter 0.42s ease-out, transform 0.42s ease-out; }
.ti-sbx-darkroom img.is-loaded { opacity: 1; filter: blur(0); transform: scale(1); }
.ti-sbx-shimmer { position: absolute; inset: 0; pointer-events: none; background: linear-gradient(110deg, transparent 20%, rgba(239, 199, 128, 0.14) 48%, transparent 76%); background-size: 220% 100%; animation: ti-sbx-shimmer 2.1s ease-in-out infinite; }
@keyframes ti-sbx-shimmer { 0% { background-position: 180% 0; } 100% { background-position: -80% 0; } }
.ti-sbx-caption { position: absolute; left: 0.6rem; bottom: 0.55rem; max-width: calc(100% - 1.2rem); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; background: rgba(28, 24, 20, 0.84); color: #fff9e8; padding: 0.24em 0.6em; border-radius: 0.35em; z-index: 1; }
.ti-sbx-caption.is-developing { border: 1px solid rgba(239, 199, 128, 0.4); color: #f4d69c; }
.ti-sbx-tools { position: absolute; right: 0.5em; top: 0.5em; display: flex; align-items: center; flex-wrap: wrap; gap: 0.2em; padding: 0.22em 0.3em; background: rgba(24, 21, 18, 0.86); border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 0.55em; z-index: 2; }
.ti-sbx-tools button, .ti-sbx-bookmark button { border: 0; background: transparent; color: inherit; font: inherit; padding: 0 0.45em; min-height: 28px; border-radius: 0.35em; cursor: pointer; }
.ti-sbx-tools button:hover, .ti-sbx-tools button:focus-visible { background: rgba(255, 255, 255, 0.16); }
.ti-sbx-tools button:disabled, .ti-sbx-bookmark button:disabled { opacity: 0.55; cursor: default; }
.ti-sbx-tools span { font-variant-numeric: tabular-nums; padding: 0 0.25em; }
.ti-sbx-bookmark { display: flex; justify-content: flex-end; margin: 0.25em 0; }
.ti-sbx-bookmark button { display: inline-flex; align-items: center; gap: 0.35em; max-width: 16rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 0.2em 0.65em; min-height: 26px; font-size: 0.8rem; background: linear-gradient(135deg, #f3cf8d, #dda858); color: #35250f; border-radius: 0.4em; box-shadow: 0 4px 12px rgba(0, 0, 0, 0.28); }
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
            const box = document.createElement('div');
            box.className = 'ti-sbx-bookmark';
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.disabled = isBusy;
            btn.title = `${slot.label} · 展开画卷`;
            btn.textContent = `🔖 ${slot.label}`;
            btn.addEventListener('click', () => trigger('bookmark'));
            box.appendChild(btn);
            wrapper.appendChild(box);
            return wrapper;
        }

        const figure = document.createElement('figure');
        figure.className = 'ti-sbx-darkroom';
        figure.style.aspectRatio = (slot.aspectRatio || '3:2').replace(':', ' / ');
        const p0 = slot.palette?.[0] || '#25221f';
        const p1 = slot.palette?.[1] || '#3a3128';
        figure.style.backgroundImage = `linear-gradient(135deg, ${p0}, ${p1})`;

        if (slot.status === 'developing') {
            const shimmer = document.createElement('div');
            shimmer.className = 'ti-sbx-shimmer';
            shimmer.setAttribute('aria-hidden', 'true');
            figure.appendChild(shimmer);
        }

        if (imgUrl) {
            const img = document.createElement('img');
            img.src = imgUrl;
            img.alt = slot.label;
            img.addEventListener('load', () => {
                img.classList.add('is-loaded');
                reportHeight();
            });
            figure.appendChild(img);
        }

        const caption = document.createElement('figcaption');
        caption.className = slot.status === 'developing' ? 'ti-sbx-caption is-developing' : 'ti-sbx-caption';
        caption.textContent =
            slot.status === 'failed' ? '显影失败，可换一镜' : slot.status === 'developing' ? '暗房显影中…' : slot.label;
        figure.appendChild(caption);

        const tools = document.createElement('div');
        tools.className = 'ti-sbx-tools';
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

        figure.appendChild(tools);
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

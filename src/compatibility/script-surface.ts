import { installFloatingGestures } from './floating-gestures';

/** Moving a live script iframe to an overlay must not restart its document or pointer gesture. */
export function preserveScriptFrameMoves(win: Window & typeof globalThis): void {
    type MoveTarget = Element & { moveBefore?: (node: Node, before: Node | null) => void };
    if (!(win.Element.prototype as MoveTarget).moveBefore) return;
    const { appendChild, insertBefore } = win.Node.prototype;
    const move = (target: Node, child: Node, before: Node | null) => {
        if (!(target instanceof win.Element) || !(child instanceof win.HTMLIFrameElement) ||
            !child.matches('iframe[data-compat-child].compat-script') || !child.isConnected || !target.isConnected ||
            child.getRootNode() !== target.getRootNode() || before && before.parentNode !== target) return false;
        (target as MoveTarget).moveBefore!(child, before);
        return true;
    };
    win.Node.prototype.appendChild = function<T extends Node>(child: T): T {
        return move(this, child, null) ? child : appendChild.call(this, child) as T;
    };
    win.Node.prototype.insertBefore = function<T extends Node>(child: T, before: Node | null): T {
        return move(this, child, before) ? child : insertBefore.call(this, child, before) as T;
    };
}

function shadowOutset(shadow: string) {
    let left = 0, top = 0, right = 0, bottom = 0;
    // Computed shadows use px lengths and may contain commas inside colors.
    for (const layer of shadow.replace(/\([^()]*\)/g, '').split(',')) {
        if (/\binset\b/.test(layer)) continue;
        const [x, y, blur = 0, spread = 0] = [...layer.matchAll(/(-?(?:\d*\.)?\d+)px/g)].map(match => Number(match[1]));
        if (x === undefined || y === undefined) continue;
        const extent = Math.max(0, blur * 1.5 + spread);
        left = Math.max(left, extent - x); right = Math.max(right, extent + x);
        top = Math.max(top, extent - y); bottom = Math.max(bottom, extent + y);
    }
    return { left, top, right, bottom };
}

export function exposeScriptSurface(frame: HTMLIFrameElement): () => void {
    const win = frame.contentWindow as (Window & typeof globalThis) | null;
    const doc = frame.contentDocument;
    if (!win || !doc) return () => {};
    const gestures = installFloatingGestures(frame, win);
    let stopped = false;
    let timer = 0;
    const clipProperty = '--tipsy-script-clip';
    let clipping = 'inset(50%)';
    const applyClipping = () => {
        if (frame.style.getPropertyValue(clipProperty) !== clipping) frame.style.setProperty(clipProperty, clipping);
    };
    const update = () => {
        timer = 0;
        if (stopped) return;
        if (frame.matches(':fullscreen') || doc.fullscreenElement) {
            frame.inert = false;
            return;
        }
        const regions: string[] = [];
        const width = frame.clientWidth, height = frame.clientHeight;
        let fullSurface = false;
        for (const element of doc.body?.querySelectorAll('*') ?? []) {
            if (['SCRIPT', 'STYLE', 'LINK', 'META'].includes(element.tagName)) continue;
            const style = win.getComputedStyle(element);
            const parentIgnoresPointer = element.parentElement && win.getComputedStyle(element.parentElement).pointerEvents === 'none';
            if (element.parentElement !== doc.body && !['fixed', 'absolute'].includes(style.position) && !parentIgnoresPointer) continue;
            if (style.pointerEvents === 'none' || style.display === 'none' || style.visibility !== 'visible' || Number(style.opacity) === 0) continue;
            if (element.checkVisibility && !element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) continue;
            const rect = element.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0 || rect.right <= 0 || rect.bottom <= 0 || rect.left >= width || rect.top >= height) continue;
            if (rect.left <= 0 && rect.top <= 0 && rect.right >= width && rect.bottom >= height) {
                // A fitted iframe already limits the hit area. A redundant clip cuts off its own shadow.
                fullSurface = true;
                break;
            }
            const shadow = shadowOutset(style.boxShadow);
            const scaleX = element instanceof win.HTMLElement && element.offsetWidth ? rect.width / element.offsetWidth : 1;
            const scaleY = element instanceof win.HTMLElement && element.offsetHeight ? rect.height / element.offsetHeight : 1;
            const left = Math.max(0, rect.left - shadow.left * scaleX), top = Math.max(0, rect.top - shadow.top * scaleY);
            const right = Math.min(width, rect.right + shadow.right * scaleX), bottom = Math.min(height, rect.bottom + shadow.bottom * scaleY);
            regions.push(`M${left} ${top}H${right}V${bottom}H${left}Z`);
        }
        clipping = fullSurface ? 'none' : regions.length ? `path('${regions.join('')}')` : 'inset(50%)';
        applyClipping();
        frame.inert = !fullSurface && !regions.length;
    };
    const schedule = () => { if (!stopped && !timer) timer = window.setTimeout(update, 32); };
    const observer = new MutationObserver(schedule);
    observer.observe(doc.documentElement, { childList: true, subtree: true, attributes: true,
        attributeFilter: ['style', 'class', 'hidden', 'open'] });
    // Some floating apps replace their iframe's entire inline style on scroll or drag.
    // Restore our clip before paint even when the visible regions have not changed.
    const frameStyles = new MutationObserver(() => { applyClipping(); gestures.refresh(); });
    frameStyles.observe(frame, { attributes: true, attributeFilter: ['style'] });
    const refresh = () => { gestures.refresh(); schedule(); };
    const resize = new ResizeObserver(refresh);
    resize.observe(doc.documentElement);
    resize.observe(frame);
    frame.ownerDocument.addEventListener('fullscreenchange', refresh);
    doc.addEventListener('fullscreenchange', refresh);
    for (const event of ['resize', 'scroll', 'transitionend', 'animationend']) win.addEventListener(event, schedule, true);
    gestures.refresh();
    update();
    return () => {
        stopped = true; window.clearTimeout(timer); observer.disconnect(); frameStyles.disconnect(); resize.disconnect();
        frame.ownerDocument.removeEventListener('fullscreenchange', refresh);
        doc.removeEventListener('fullscreenchange', refresh);
        gestures.dispose();
        for (const event of ['resize', 'scroll', 'transitionend', 'animationend']) win.removeEventListener(event, schedule, true);
    };
}

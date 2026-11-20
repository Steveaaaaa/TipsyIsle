export interface ReadingNavigationProps {
    replyId?: string;
    jumpRequest: number;
    onReadingActivity: (kind?: 'scroll' | 'tap') => void;
    onReplyPosition: (awayFromStart: boolean) => void;
}

/** Observe reader gestures, never streaming or programmatic scroll changes. */
export function observeReadingActivity(target: Window | HTMLElement, notify: (kind?: 'scroll' | 'tap') => void): () => void {
    let last = 0;
    const isInteractive = (event: Event) => event.composedPath().some(node => {
        const element = node as HTMLElement;
        if (typeof element.matches !== 'function') return false;
        if (element.matches('button, a[href], area[href], label, input, textarea, select, summary, dialog, [role="button"], [role="link"], [role="tab"], [role="checkbox"], [role="switch"], [role="menuitem"], [role="option"], [role="slider"], [onclick], [ontouchstart], [onpointerup], [data-action], [tabindex]:not([tabindex="-1"]), [contenteditable]:not([contenteditable="false"]), audio[controls], video[controls]')) return true;
        return typeof element.onclick === 'function' || element.ownerDocument.defaultView?.getComputedStyle(element).cursor === 'pointer';
    });
    let tapAt = 0;
    let tapTimer: ReturnType<typeof setTimeout> | undefined;
    let touch: { id: number; x: number; y: number; started: number; moved: boolean; interactive: boolean } | undefined;
    const onTouchStart = (event: Event) => {
        tapAt = 0;
        const points = (event as TouchEvent).touches;
        const element = event.target as HTMLElement | null;
        if (points.length !== 1 || element?.closest?.('input, textarea, select, [contenteditable="true"], dialog')) { touch = undefined; return; }
        const point = points[0];
        touch = { id: point.identifier, x: point.clientX, y: point.clientY, started: Date.now(), moved: false, interactive: isInteractive(event) };
    };
    const onTouchMove = (event: Event) => {
        if (!touch) return;
        const points = (event as TouchEvent).touches;
        const point = points[0];
        if (points.length !== 1 || point.identifier !== touch.id) { touch = undefined; return; }
        if (Math.hypot(point.clientX - touch.x, point.clientY - touch.y) > 10) touch.moved = true;
        if (touch.moved) onInput(event);
    };
    const onTouchEnd = (event: Event) => {
        const start = touch; touch = undefined;
        if (!start || start.moved || start.interactive || Date.now() - start.started > 450) return;
        const point = Array.from((event as TouchEvent).changedTouches).find(item => item.identifier === start.id);
        if (point && Math.hypot(point.clientX - start.x, point.clientY - start.y) <= 10) tapAt = Date.now();
    };
    const onTouchCancel = () => { touch = undefined; tapAt = 0; };
    const onClick = (event: Event) => {
        if (!tapAt || Date.now() - tapAt > 700) return;
        tapAt = 0;
        if (isInteractive(event)) return;
        // Let character buttons receive their click before the reading layout moves.
        clearTimeout(tapTimer);
        const doc = (event.target as Node).ownerDocument;
        tapTimer = setTimeout(() => {
            if (!event.defaultPrevented && !doc?.getSelection()?.toString()) notify('tap');
        }, 0);
    };
    const onInput = (event: Event) => {
        const element = event.target as HTMLElement | null;
        if (element?.closest?.('input, textarea, select, [contenteditable="true"]')) return;
        if (event.type === 'wheel' && Math.abs((event as WheelEvent).deltaY) < 2) return;
        if (event.type === 'keydown' && !['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End', ' '].includes((event as KeyboardEvent).key)) return;
        const now = Date.now();
        if (now - last < 100) return;
        last = now;
        notify();
    };
    const listeners: Array<[string, (event: Event) => void]> = [['wheel', onInput], ['keydown', onInput], ['touchstart', onTouchStart], ['touchmove', onTouchMove], ['touchend', onTouchEnd], ['touchcancel', onTouchCancel], ['click', onClick]];
    for (const [name, listener] of listeners) target.addEventListener(name, listener, { passive: true, capture: true });
    return () => { clearTimeout(tapTimer); for (const [name, listener] of listeners) target.removeEventListener(name, listener, true); };
}

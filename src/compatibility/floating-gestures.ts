type AuthorWindow = Window & typeof globalThis;

/** Let authors handle single-pointer controls; two fingers zoom and pan the fitted iframe. */
export function installFloatingGestures(frame: HTMLIFrameElement, win: AuthorWindow) {
    const doc = win.document, host = frame.ownerDocument.defaultView!;
    const style = doc.createElement('style');
    style.textContent = ':where(html[data-tipsy-floating]) { touch-action: pan-x pan-y; }';
    doc.head.append(style);
    let fitted = false, zoom = 1, x = 0, y = 0;
    let lastWidth = 0, lastHeight = 0;
    let pinching = false;
    let pinch: { ids: number[]; distance: number; zoom: number; anchorX: number; anchorY: number } | undefined;
    const fullscreen = () => !!(doc.fullscreenElement || frame.ownerDocument.fullscreenElement);
    const set = (key: string, value: string) => {
        if (frame.style.getPropertyValue(key) !== value) frame.style.setProperty(key, value);
    };
    const apply = () => {
        const active = fitted && (zoom !== 1 || x !== 0 || y !== 0);
        frame.toggleAttribute('data-tipsy-floating-zoom', active);
        if (active) {
            set('--tipsy-floating-scale', String(zoom));
            set('--tipsy-floating-translate', `${x}px ${y}px`);
        }
    };
    const refresh = () => {
        const css = host.getComputedStyle(frame);
        const width = frame.clientWidth, height = frame.clientHeight;
        // A viewport-wide iframe is the script's canvas, not a window to zoom.
        if (!fullscreen()) {
            const sizedByAuthor = frame.style.width.endsWith('px') && frame.style.height.endsWith('px');
            const next = css.position === 'fixed' && css.pointerEvents !== 'none' && width > 0 && height > 0 &&
                (width < host.innerWidth - 1 || height < host.innerHeight - 1 || sizedByAuthor &&
                    (width > host.innerWidth + 1 || height > host.innerHeight + 1));
            if (next !== fitted || width !== lastWidth || height !== lastHeight) {
                if (!pinching) { zoom = 1; x = y = 0; }
                fitted = next;
                lastWidth = width; lastHeight = height;
            }
        }
        doc.documentElement.toggleAttribute('data-tipsy-floating', fitted && !fullscreen());
        apply();
    };
    const points = (list: TouchList) => Array.from(list).map(touch => ({ id: touch.identifier, x: touch.clientX, y: touch.clientY }));
    const pair = (touches: ReturnType<typeof points>, rect: DOMRect) => {
        const sx = rect.width / frame.clientWidth, sy = rect.height / frame.clientHeight;
        const [a, b] = touches;
        return { x: rect.left + (a.x + b.x) * sx / 2, y: rect.top + (a.y + b.y) * sy / 2,
            distance: Math.hypot((a.x - b.x) * sx, (a.y - b.y) * sy) };
    };
    const start = (event: TouchEvent) => {
        if (event.defaultPrevented || pinching || !fitted || fullscreen() || event.touches.length !== 2) return;
        const rect = frame.getBoundingClientRect(), touches = points(event.touches), at = pair(touches, rect);
        if (at.distance < 8 || !rect.width || !rect.height) return;
        event.preventDefault();
        pinching = true;
        pinch = { ids: touches.map(touch => touch.id), distance: at.distance, zoom,
            anchorX: (at.x - rect.left) / rect.width, anchorY: (at.y - rect.top) / rect.height };
    };
    const move = (event: TouchEvent) => {
        if (!pinching) return;
        event.preventDefault();
        if (!pinch || fullscreen()) return;
        const touches = points(event.touches).filter(touch => pinch!.ids.includes(touch.id));
        if (touches.length !== 2) return;
        const rect = frame.getBoundingClientRect();
        const at = pair(touches, rect);
        const nextZoom = Math.max(.4, Math.min(2.5, pinch.zoom * at.distance / pinch.distance));
        const width = rect.width * nextZoom / zoom, height = rect.height * nextZoom / zoom;
        zoom = nextZoom;
        // Keep a reachable strip on screen even when the author window is larger than the viewport.
        const clamp = (position: number, size: number, viewport: number) => {
            const edge = Math.min(32, size / 2, viewport / 2);
            return Math.max(edge - size, Math.min(viewport - edge, position));
        };
        x += clamp(at.x - width * pinch.anchorX, width, host.innerWidth) - rect.left;
        y += clamp(at.y - height * pinch.anchorY, height, host.innerHeight) - rect.top;
        apply();
    };
    const finish = (event: TouchEvent) => {
        if (!pinching) return;
        event.preventDefault();
        if (event.touches.length < 2) pinch = undefined;
        if (!event.touches.length || event.type === 'touchcancel') pinching = false;
    };
    const captureHandle = (event: PointerEvent) => {
        if (event.pointerType === 'mouse' || pinching || fullscreen() || !fitted || !(event.target instanceof win.Element)) return;
        const target = event.target;
        // Touch browsers implicitly capture on many elements; explicitly retain custom drag handles
        // while their iframe moves beneath the finger and the host recomputes the clip.
        for (let element: Element | null = target; element && element !== doc.body; element = element.parentElement) {
            if (win.getComputedStyle(element).touchAction !== 'none') continue;
            if (!target.hasPointerCapture(event.pointerId)) target.setPointerCapture(event.pointerId);
            break;
        }
    };
    const holdAuthorDrag = (event: PointerEvent) => { if (pinching && event.pointerType === 'touch') event.stopPropagation(); };
    const touchEvents = { touchstart: start, touchmove: move, touchend: finish, touchcancel: finish };
    for (const [name, listener] of Object.entries(touchEvents)) win.addEventListener(name as keyof typeof touchEvents, listener, { passive: false });
    win.addEventListener('pointerdown', captureHandle, true);
    win.addEventListener('pointermove', holdAuthorDrag, true);
    return { refresh, dispose() {
        for (const [name, listener] of Object.entries(touchEvents)) win.removeEventListener(name as keyof typeof touchEvents, listener);
        win.removeEventListener('pointerdown', captureHandle, true);
        win.removeEventListener('pointermove', holdAuthorDrag, true);
        frame.removeAttribute('data-tipsy-floating-zoom');
        doc.documentElement.removeAttribute('data-tipsy-floating');
        style.remove();
    } };
}

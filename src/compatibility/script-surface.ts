export function exposeScriptSurface(frame: HTMLIFrameElement): () => void {
    const win = frame.contentWindow;
    const doc = frame.contentDocument;
    if (!win || !doc) return () => {};
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
        const regions: string[] = [];
        const width = frame.clientWidth, height = frame.clientHeight;
        for (const element of doc.body?.querySelectorAll('*') ?? []) {
            if (['SCRIPT', 'STYLE', 'LINK', 'META'].includes(element.tagName)) continue;
            const style = win.getComputedStyle(element);
            const parentIgnoresPointer = element.parentElement && win.getComputedStyle(element.parentElement).pointerEvents === 'none';
            if (element.parentElement !== doc.body && !['fixed', 'absolute'].includes(style.position) && !parentIgnoresPointer) continue;
            if (style.pointerEvents === 'none' || style.display === 'none' || style.visibility !== 'visible' || Number(style.opacity) === 0) continue;
            if (!element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) continue;
            const rect = element.getBoundingClientRect();
            const left = Math.max(0, rect.left), top = Math.max(0, rect.top);
            const right = Math.min(width, rect.right), bottom = Math.min(height, rect.bottom);
            if (right > left && bottom > top) regions.push(`M${left} ${top}H${right}V${bottom}H${left}Z`);
        }
        clipping = regions.length ? `path('${regions.join('')}')` : 'inset(50%)';
        applyClipping();
        frame.inert = !regions.length;
    };
    const schedule = () => { if (!stopped && !timer) timer = window.setTimeout(update, 32); };
    const observer = new MutationObserver(schedule);
    observer.observe(doc.documentElement, { childList: true, subtree: true, attributes: true,
        attributeFilter: ['style', 'class', 'hidden', 'open'] });
    // Some floating apps replace their iframe's entire inline style on scroll or drag.
    // Restore our clip before paint even when the visible regions have not changed.
    const frameStyles = new MutationObserver(applyClipping);
    frameStyles.observe(frame, { attributes: true, attributeFilter: ['style'] });
    const resize = new ResizeObserver(schedule);
    resize.observe(doc.documentElement);
    resize.observe(frame);
    for (const event of ['resize', 'scroll', 'transitionend', 'animationend']) win.addEventListener(event, schedule, true);
    update();
    return () => {
        stopped = true; window.clearTimeout(timer); observer.disconnect(); frameStyles.disconnect(); resize.disconnect();
        for (const event of ['resize', 'scroll', 'transitionend', 'animationend']) win.removeEventListener(event, schedule, true);
    };
}

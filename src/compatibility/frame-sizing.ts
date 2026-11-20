/** Runs inside author documents; defer layout writes out of ResizeObserver delivery. */
export function observeFrameHeight(report: (height: number) => void, viewport: Window = window): void {
    let scheduled = 0;
    let previous = -1;
    let fitDirty = true;
    let previousWidth = window.innerWidth;
    let textMeasure: CanvasRenderingContext2D | null | undefined;
    // Only mixed-message widgets receive this host-owned canvas. Full-page
    // author UIs and ordinary prose keep their own responsive layout.
    const fitWidgets = () => {
        const canvases = [...document.querySelectorAll<HTMLElement>('.tipsy-reader-widget-canvas')];
        if (!canvases.length) return;
        textMeasure ??= document.createElement('canvas').getContext('2d');
        for (const canvas of canvases) { canvas.style.removeProperty('width'); canvas.style.removeProperty('zoom'); }
        const sizes = canvases.map(canvas => {
            const available = canvas.clientWidth;
            let required = available;
            if (!available || !textMeasure) return { canvas, available, required };
            // Fixed seals/buttons beside a flexible title can squeeze CJK text
            // into a vertical column without producing horizontal overflow.
            for (const row of canvas.querySelectorAll<HTMLElement>('summary, header')) {
                const style = getComputedStyle(row);
                if (!['flex', 'inline-flex'].includes(style.display) || !style.flexDirection.startsWith('row') || style.flexWrap !== 'nowrap') continue;
                const cells = [...row.children].filter((child): child is HTMLElement => child instanceof HTMLElement && child.offsetWidth > 0);
                if (!cells.some(child => getComputedStyle(child).flexShrink === '0')) continue;
                let missing = 0;
                for (const cell of cells) {
                    const cellStyle = getComputedStyle(cell);
                    if (Number(cellStyle.flexGrow) <= 0 || cellStyle.writingMode !== 'horizontal-tb') continue;
                    let natural = 0;
                    const texts = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
                    while (texts.nextNode()) {
                        const text = texts.currentNode.textContent?.trim();
                        const element = texts.currentNode.parentElement!;
                        if (!text || !element.getClientRects().length) continue;
                        const font = getComputedStyle(element);
                        textMeasure.font = `${font.fontStyle} ${font.fontWeight} ${font.fontSize} ${font.fontFamily}`;
                        const spacing = parseFloat(font.letterSpacing) || 0;
                        // Longer descriptions may wrap; compact labels keep
                        // their natural composition, measured in the author's font.
                        const width = textMeasure.measureText(text).width + spacing * Math.max(0, Array.from(text).length - 1);
                        natural = Math.max(natural, Math.min(width, parseFloat(font.fontSize) * 20));
                    }
                    const padding = (parseFloat(cellStyle.paddingLeft) || 0) + (parseFloat(cellStyle.paddingRight) || 0);
                    missing += Math.max(0, natural + padding - cell.clientWidth);
                }
                required = Math.max(required, available + missing);
            }
            return { canvas, available, required: Math.ceil(required) };
        });
        for (const { canvas, available, required } of sizes) {
            if (required <= available + 1) continue;
            canvas.style.width = `${required}px`;
            // Zoom participates in layout: expanded details reserve their scaled
            // height, without transforms leaving a tall invisible scroll area.
            canvas.style.setProperty('zoom', String(available / required));
        }
    };
    // Full-screen card UIs position their screens outside normal flow. Clearing
    // their root height collapses the containing block and clips those screens.
    const children = [...document.body.children].map(element => ({
        style: getComputedStyle(element), bounds: element.getBoundingClientRect(),
    })).filter(({ style, bounds }) => style.display !== 'none' && bounds.height > 0);
    const viewportLayout = children.length > 0 && children.every(({ style }) => ['absolute', 'fixed'].includes(style.position));
    // Flowing messages expand into the reading surface; viewport UIs retain
    // their own coordinate system and internal panels retain their scrolling.
    for (const root of [document.documentElement, document.body]) {
        if (!viewportLayout) {
            root.style.setProperty('height', 'auto', 'important');
            root.style.setProperty('min-height', '0', 'important');
            root.style.setProperty('max-height', 'none', 'important');
        }
        root.style.setProperty('overflow-y', 'hidden', 'important');
    }
    const measure = () => {
        scheduled = 0;
        const body = document.body;
        if (!body) return;
        if (fitDirty) { fitDirty = false; fitWidgets(); }
        const bounds = body.getBoundingClientRect();
        // A first child's collapsed margin can offset the body from the viewport.
        // Measure that offset as well, without using the viewport's own minimum height.
        const top = Math.max(0, bounds.top + window.scrollY);
        const bottomMargin = Math.max(0, parseFloat(getComputedStyle(body).marginBottom) || 0);
        // An out-of-flow viewport UI must not grow its iframe from its own vh
        // units, transforms or animated decoration: that creates resize feedback.
        const height = Math.ceil(viewportLayout ? viewport.innerHeight : top + Math.max(body.scrollHeight, bounds.height) + bottomMargin);
        if (height === previous) return;
        previous = height;
        report(height);
    };
    const schedule = () => { if (!scheduled) scheduled = requestAnimationFrame(measure); };
    const reflow = () => { fitDirty = true; schedule(); };
    const resize = () => {
        if (window.innerWidth !== previousWidth) { previousWidth = window.innerWidth; fitDirty = true; }
        schedule();
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(document.body);
    const mutations = new MutationObserver(records => {
        // Our own width/zoom writes must not trigger a sizing feedback loop.
        if (records.some(record => {
            const target = record.target instanceof Element ? record.target : record.target.parentElement;
            if (record.type === 'attributes' && record.attributeName === 'style' && target?.classList.contains('tipsy-reader-widget-canvas')) return false;
            return !!target?.closest('.tipsy-reader-widget-canvas') || record.type === 'childList'
                && [...record.addedNodes].some(node => node instanceof Element && (node.matches('.tipsy-reader-widget-canvas') || node.querySelector('.tipsy-reader-widget-canvas')));
        })) fitDirty = true;
        schedule();
    });
    mutations.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true });
    document.addEventListener('load', reflow, true);
    window.addEventListener('resize', resize);
    if (viewportLayout && viewport !== window) viewport.addEventListener('resize', schedule);
    document.fonts.addEventListener('loadingdone', reflow);
    window.addEventListener('pagehide', () => {
        observer.disconnect(); mutations.disconnect(); document.removeEventListener('load', reflow, true);
        window.removeEventListener('resize', resize); document.fonts.removeEventListener('loadingdone', reflow); cancelAnimationFrame(scheduled);
        if (viewportLayout && viewport !== window) viewport.removeEventListener('resize', schedule);
    }, { once: true });
    schedule();
}

export function setFrameHeight(frame: HTMLIFrameElement, height: number, min: number, max = Infinity): void {
    if (!Number.isFinite(height)) return;
    const value = `${Math.max(min, Math.min(max, Math.ceil(height)))}px`;
    if (frame.style.height !== value) frame.style.height = value;
}

import type { StreamPart } from '../pipeline/streaming-message';

const sizes = new Map<string, number>();
const bucket = (width: number) => Math.round(width / 48) * 48;
export function rememberComponentSize(key: string, width: number, height: number) {
    if (!key || width <= 0 || !Number.isFinite(height) || height <= 0) return;
    const id = `${key}@${bucket(width)}`;
    sizes.delete(id); sizes.set(id, Math.ceil(height));
    if (sizes.size > 192) sizes.delete(sizes.keys().next().value!);
}
export function componentHeight(part: StreamPart, width: number): number {
    return sizes.get(`${part.key}@${bucket(width)}`) ?? part.height ?? 112;
}
export function preserveReadingAnchor(element: HTMLElement): () => void {
    let scroller: HTMLElement | null = element.parentElement;
    while (scroller && !/auto|scroll/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
    scroller ??= document.scrollingElement as HTMLElement;
    const root = scroller === document.scrollingElement;
    const top = root ? 0 : scroller.getBoundingClientRect().top;
    const viewportHeight = root ? innerHeight : scroller.clientHeight;
    const anchor = [...scroller.querySelectorAll<HTMLElement>('[data-stream-part], .ttm-msg-card, .mes')]
        .find(item => item !== element && !element.contains(item) && !item.contains(element) && !!(element.compareDocumentPosition(item) & Node.DOCUMENT_POSITION_FOLLOWING) && item.getBoundingClientRect().top >= top && item.getBoundingClientRect().top < top + viewportHeight);
    const before = anchor?.getBoundingClientRect().top;
    return () => {
        if (anchor?.isConnected && before !== undefined) scroller!.scrollTop += anchor.getBoundingClientRect().top - before;
    };
}

/** Runs inside an author iframe. Returns measurements, never modifies widgets. */
export function observeComponentSizes(items: Array<{ key: string; selector: string }>, report: (values: Array<{ key: string; width: number; height: number }>) => void) {
    let queued = 0;
    const observed = new WeakSet<Element>();
    const previous = new Map<string, { width: number; height: number }>();
    const measure = () => {
        queued = 0;
        const values: Array<{ key: string; width: number; height: number }> = [];
        for (const item of items) for (const element of document.querySelectorAll<HTMLElement>(item.selector)) {
            if (!observed.has(element)) { resize.observe(element); observed.add(element); }
            const rect = element.getBoundingClientRect();
            if (rect.height > 0) values.push({ key: item.key, width: document.documentElement.clientWidth, height: rect.height });
        }
        const latest = new Map(values.map(value => [value.key, value]));
        const changes = [...latest.values()].filter(value => {
            const old = previous.get(value.key);
            if (old?.width === value.width && old.height === value.height) return false;
            previous.set(value.key, value); return true;
        });
        if (changes.length) report(changes);
    };
    const schedule = () => { if (!queued) queued = requestAnimationFrame(measure); };
    const resize = new ResizeObserver(schedule);
    const mutations = new MutationObserver(schedule);
    mutations.observe(document.body, { childList: true, subtree: true });
    window.addEventListener('resize', schedule);
    window.addEventListener('pagehide', () => { resize.disconnect(); mutations.disconnect(); cancelAnimationFrame(queued); window.removeEventListener('resize', schedule); }, { once: true });
    schedule();
}

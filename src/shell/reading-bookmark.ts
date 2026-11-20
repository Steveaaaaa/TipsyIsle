export interface ReadingBookmark {
    messageId: string;
    swipeId: string;
    offset: number;
}

const storageKey = (chatId: string) => `tipsy:reading-bookmark:${chatId}`;

export function readReadingBookmark(chatId: string): ReadingBookmark | undefined {
    try {
        const value = JSON.parse(localStorage.getItem(storageKey(chatId)) ?? 'null');
        return isReadingBookmark(value) ? value : undefined;
    } catch { return undefined; }
}

export function isReadingBookmark(value: unknown): value is ReadingBookmark {
    const mark = value as Partial<ReadingBookmark> | undefined;
    return !!mark && typeof mark.messageId === 'string' && typeof mark.swipeId === 'string' && Number.isFinite(mark.offset);
}

export function writeReadingBookmark(chatId: string, bookmark: ReadingBookmark) {
    try { localStorage.setItem(storageKey(chatId), JSON.stringify(bookmark)); } catch { /* Reading can continue without local storage. */ }
}

export function readingSwipeId(node: { swipeIds?: string[]; activeSwipeIndex: number }) {
    return node.swipeIds?.[node.activeSwipeIndex] ?? String(node.activeSwipeIndex);
}

export function captureReadingBookmark(top: number, count: number, rowAt: (index: number) => HTMLElement | undefined): ReadingBookmark | undefined {
    // Search by the row bottom so a long reply remains the anchor when its header leaves the viewport.
    let lo = 0, hi = count;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        const row = rowAt(mid);
        if (row && row.getBoundingClientRect().bottom <= top) lo = mid + 1;
        else hi = mid;
    }
    const row = rowAt(Math.min(lo, count - 1));
    const messageId = row?.dataset.messageId, swipeId = row?.dataset.readingSwipe;
    if (row && messageId && swipeId !== undefined) return { messageId, swipeId, offset: Math.round(top - row.getBoundingClientRect().top) };
}

export function readingBookmarkAdjustment(bookmark: ReadingBookmark, row: HTMLElement, top: number) {
    const bounds = row.getBoundingClientRect();
    return bounds.top - top + Math.min(bookmark.offset, Math.max(0, bounds.height - 1));
}

export function trackReadingBookmark(target: Window | HTMLElement, capture: () => ReadingBookmark | undefined, save: (bookmark: ReadingBookmark) => void) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let nextSample = 0;
    let lastSaved: ReadingBookmark | undefined;
    const flush = () => {
        if (timer !== undefined) { clearTimeout(timer); timer = undefined; }
        nextSample = Date.now() + 160;
        const mark = capture();
        if (!mark || (lastSaved?.messageId === mark.messageId && lastSaved.swipeId === mark.swipeId && lastSaved.offset === mark.offset)) return;
        lastSaved = mark;
        save(mark);
    };
    const scroll = () => {
        if (timer !== undefined) return;
        const delay = nextSample - Date.now();
        if (delay <= 0) flush(); else timer = setTimeout(flush, delay);
    };
    const flushPending = () => { if (timer !== undefined) flush(); };
    const onVisibility = () => { if (document.hidden) flushPending(); };
    target.addEventListener('scroll', scroll, { passive: true });
    window.addEventListener('pagehide', flushPending);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
        flushPending();
        target.removeEventListener('scroll', scroll);
        window.removeEventListener('pagehide', flushPending);
        document.removeEventListener('visibilitychange', onVisibility);
    };
}

/**
 * Copy text to system clipboard with a fallback textarea selection path
 * for mobile WebViews and insecure/non-HTTPS LAN contexts.
 */
export async function copyTextToClipboard(text: string): Promise<boolean> {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        try {
            await navigator.clipboard.writeText(text);
            return true;
        } catch {
            // Fall back to execCommand when clipboard API is blocked or denied.
        }
    }
    if (typeof document === 'undefined' || !document.body) return false;
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const area = document.createElement('textarea');
    area.value = text;
    area.readOnly = true;
    area.setAttribute('aria-hidden', 'true');
    Object.assign(area.style, {
        position: 'fixed',
        top: '-9999px',
        left: '-9999px',
        fontSize: '16px',
        opacity: '0',
        pointerEvents: 'none',
    });
    document.body.appendChild(area);
    try {
        area.focus({ preventScroll: true });
        area.select();
        area.setSelectionRange(0, text.length);
        return typeof document.execCommand === 'function' ? document.execCommand('copy') : false;
    } catch {
        return false;
    } finally {
        area.remove();
        if (active && active.isConnected) active.focus({ preventScroll: true });
    }
}

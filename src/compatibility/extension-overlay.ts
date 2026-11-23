export interface OverlayCheckStyle {
    position: string;
    display: string;
    visibility: string;
    opacity: string;
    pointerEvents: string;
    zIndex: string;
    backgroundColor: string;
    backgroundImage?: string;
    backdropFilter?: string;
}

export interface OverlayCheckRect {
    width: number;
    height: number;
}

export interface OverlayCheckElement {
    tagName: string;
    hidden?: boolean;
    role?: string | null;
    ariaModal?: string | null;
}

const NON_MODAL_TAGS = new Set([
    'IFRAME', 'DIALOG', 'CANVAS', 'SVG', 'VIDEO', 'AUDIO', 'IMG', 'SCRIPT', 'STYLE', 'LINK', 'TEMPLATE',
]);

function hasVisibleBackgroundColor(color: string): boolean {
    const normalized = color.trim().toLowerCase();
    if (!normalized || normalized === 'transparent') return false;
    const slashAlpha = /\/\s*([0-9.]+)(%?)\s*\)$/.exec(normalized);
    if (slashAlpha) {
        return Number.parseFloat(slashAlpha[1]) > 0;
    }
    const commaAlpha = /^(?:rgba|hsla)\([^,]+,[^,]+,[^,]+,\s*([0-9.]+)(%?)\s*\)$/.exec(normalized);
    if (commaAlpha) {
        return Number.parseFloat(commaAlpha[1]) > 0;
    }
    return true;
}

function hasVisibleBackdrop(style: OverlayCheckStyle): boolean {
    if (hasVisibleBackgroundColor(style.backgroundColor)) return true;
    if (style.backgroundImage && style.backgroundImage !== 'none') return true;
    if (style.backdropFilter && style.backdropFilter !== 'none') return true;
    return false;
}

/**
 * Distinguishes real full-screen blocking extension modals (e.g. RUBY settings)
 * from card floating buttons, 0x0 hidden-iframe layouts, pointer-events:none HUDs,
 * ambient canvases, and low z-index wallpapers.
 */
export function isBlockingExtensionOverlay(
    el: OverlayCheckElement,
    style: OverlayCheckStyle,
    rect: OverlayCheckRect,
    viewport: OverlayCheckRect,
): boolean {
    if (viewport.width < 100 || viewport.height < 100) return false;
    if (el.hidden || NON_MODAL_TAGS.has(el.tagName.toUpperCase())) return false;
    if (style.position !== 'fixed' || style.display === 'none' || style.visibility !== 'visible') return false;
    if (!(Number.parseFloat(style.opacity) > 0)) return false;
    if (style.pointerEvents === 'none') return false;

    const minW = viewport.width * 0.7;
    const minH = viewport.height * 0.6;
    if (!(rect.width >= minW && rect.height >= minH)) return false;

    const isDialogRole = el.role === 'dialog' || el.ariaModal === 'true';
    const zIndex = Number(style.zIndex);
    const hasModalStacking = isDialogRole || (Number.isFinite(zIndex) && zIndex >= 100);
    if (!hasModalStacking) return false;

    return isDialogRole || hasVisibleBackdrop(style);
}

import type { ProseAnchorSpec } from '../../../packages/plugin-sdk/index.js';

const normalizeText = (value: string) => value.replace(/\s+/g, ' ').trim();
const looseText = (value: string) => value.replace(/[\s「」『』"'“”‘’【】()（）]/g, '');

function frameWrappers(body: HTMLElement): HTMLElement[] {
    return Array.from(body?.children ?? []).filter((el): el is HTMLElement => {
        if (typeof (el as { classList?: DOMTokenList }).classList === 'undefined') return false;
        if (el.classList.contains('ti-inline-media-slot') || el.classList.contains('compat-native-media-slot')) return false;
        return el.classList.contains('ttm-sandbox-container')
            || el.classList.contains('compat-message-frame')
            || Boolean(el.querySelector?.(':scope > iframe.compat-message-frame, :scope > .compat-message-frame'));
    });
}

function isMixedWrapper(el: HTMLElement): boolean {
    if (el.dataset?.blockType === 'mixed') return true;
    return Boolean(el.querySelector?.(':scope > iframe[data-block-type="mixed"]'));
}

function outerMarkdownBlocks(body: HTMLElement): HTMLElement[] {
    if (!body || typeof body.querySelectorAll !== 'function') return [];
    return Array.from(
        body.querySelectorAll<HTMLElement>(':scope > .message-markdown, :scope > .tipsy-stream-parts > .message-markdown'),
    );
}

function outerParagraphs(blocks: HTMLElement[]): HTMLElement[] {
    return blocks.flatMap((block) =>
        typeof block.querySelectorAll === 'function'
            ? Array.from(block.querySelectorAll<HTMLElement>('p,blockquote,ul,ol,h1,h2,h3,h4,h5,h6,pre,table'))
            : [],
    );
}

export function hasSubstantialOuterProse(body: HTMLElement, anchor?: ProseAnchorSpec): boolean {
    const blocks = outerMarkdownBlocks(body);
    if (!blocks.length) return false;
    const paragraphs = outerParagraphs(blocks);
    if (anchor?.kind === 'marker' && anchor.token) {
        const token = normalizeText(anchor.token);
        if (paragraphs.some((node) => normalizeText(node.textContent ?? '').includes(token))) return true;
    }
    if (anchor?.kind === 'paragraph' && anchor.excerpt) {
        const exNorm = normalizeText(anchor.excerpt);
        const exLoose = looseText(anchor.excerpt);
        if (exNorm.length >= 6 || exLoose.length >= 6) {
            const hit = paragraphs.some((node) => {
                const raw = node.textContent ?? '';
                return (exNorm && normalizeText(raw).includes(exNorm)) || (exLoose && looseText(raw).includes(exLoose));
            });
            if (hit) return true;
        }
    }
    const totalLen = blocks.reduce((sum, block) => sum + normalizeText(block.textContent ?? '').length, 0);
    if (totalLen >= 80) return true;
    const substantiveParagraphs = paragraphs.filter((node) => normalizeText(node.textContent ?? '').length >= 20);
    return substantiveParagraphs.length >= 2;
}

export function locateAnchor(body: HTMLElement, anchor?: ProseAnchorSpec) {
    const blocks = outerMarkdownBlocks(body);
    if (!blocks.length || !hasSubstantialOuterProse(body, anchor)) {
        const wrappers = frameWrappers(body);
        const lastMixed = [...wrappers].reverse().find(isMixedWrapper);
        if (lastMixed) return lastMixed;
        if (!blocks.length) return undefined;
    }
    const paragraphs = outerParagraphs(blocks);
    if (anchor?.kind === 'marker') {
        const token = normalizeText(anchor.token);
        return paragraphs.find((node) => normalizeText(node.textContent ?? '').includes(token)) ?? blocks.at(-1);
    }
    if (anchor?.kind === 'paragraph') {
        const excerpt = anchor.excerpt ? normalizeText(anchor.excerpt) : '';
        return (
            (excerpt && paragraphs.find((node) => normalizeText(node.textContent ?? '').includes(excerpt))) ||
            paragraphs[anchor.index] ||
            blocks.at(-1)
        );
    }
    return blocks.at(-1);
}

export function mountMediaSlot(body: HTMLElement, slot: HTMLElement, anchor?: ProseAnchorSpec) {
    const after = locateAnchor(body, anchor);
    if (after) {
        if (!slot.isConnected || after.nextElementSibling !== slot) after.after(slot);
        return;
    }
    const firstTrailingWidget = frameWrappers(body)[0];
    if (firstTrailingWidget && (!slot.isConnected || firstTrailingWidget.previousElementSibling !== slot)) {
        firstTrailingWidget.before(slot);
        return;
    }
    if (!slot.isConnected || slot.parentElement !== body) {
        body.append(slot);
    }
}

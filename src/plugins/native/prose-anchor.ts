import type { ProseAnchorSpec } from '../../../packages/plugin-sdk/index.js';

const normalizeText = (value: string) => value.replace(/\s+/g, ' ').trim();

export function locateAnchor(body: HTMLElement, anchor?: ProseAnchorSpec) {
    const blocks = Array.from(
        body.querySelectorAll<HTMLElement>(':scope > .message-markdown, :scope > .tipsy-stream-parts > .message-markdown'),
    );
    if (!blocks.length) {
        const containers = Array.from(body.querySelectorAll<HTMLElement>(':scope > .ttm-sandbox-container'));
        if (containers.length >= 2) return containers[containers.length - 2];
        return undefined;
    }
    const paragraphs = blocks.flatMap((block) =>
        Array.from(block.querySelectorAll<HTMLElement>('p,blockquote,ul,ol,h1,h2,h3,h4,h5,h6,pre,table')),
    );
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
    } else if (!slot.isConnected || slot.parentElement !== body) {
        body.append(slot);
    }
}

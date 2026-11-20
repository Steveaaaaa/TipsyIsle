import showdown from 'showdown';
import DOMPurify from 'dompurify';
import { formatTemplateMarkdown } from './template-formatting';
import messageStyles from '../message-markdown.css?raw';
import '../message-markdown.css';

const markdown = new showdown.Converter({ tables: true, strikethrough: true, simpleLineBreaks: true,
    literalMidWordUnderscores: true, underline: true, disableForced4SpacesIndentedSublists: true,
    parseImgDimensions: true, simplifiedAutoLink: true, openLinksInNewWindow: true });

/** Ordinary message prose is rendered after regex replacement. Interactive HTML
 * remains in the existing author iframe path, never in the application document. */
export function renderMessageMarkdown(source: string): string {
    return DOMPurify.sanitize(markdown.makeHtml(source), {
        USE_PROFILES: { html: true }, FORBID_TAGS: ['style'], SANITIZE_NAMED_PROPS: true,
    });
}

/** Parse mixed content without executing it. Ordinary prose gets reader spacing;
 * authored widgets retain their markup and execute later in the author iframe. */
export function renderMixedMessage(source: string): string {
    const template = document.createElement('template');
    // The template pipeline has already formatted this wrapper. Re-running
    // Markdown can change author markup, disclosure structure and script data.
    const formatted = /^\s*<div\s+class=["']tipsy-template-message["'](?:\s[^>]*)?>/i.test(source);
    template.innerHTML = formatted ? source : formatTemplateMarkdown(source);
    const groupProse = (container: ParentNode) => {
        let prose: HTMLElement | undefined;
        for (const node of [...container.childNodes]) {
            const element = node.nodeType === Node.ELEMENT_NODE ? node as HTMLElement : undefined;
            if (element?.matches('.tipsy-template-message, .tipsy-template-code')) { groupProse(element); prose = undefined; continue; }
            if (element && !element.matches('style, script, link, meta, .tipsy-template-html') && !/^(P|H[1-6]|BLOCKQUOTE|UL|OL|TABLE|PRE|HR)$/.test(element.tagName) && !element.hasAttribute('hidden')) {
                const inset = document.createElement('div'); inset.className = 'tipsy-reader-widget';
                const canvas = document.createElement('div'); canvas.className = 'tipsy-reader-widget-canvas';
                container.insertBefore(inset, element); inset.append(canvas); canvas.append(element); prose = undefined; continue;
            }
            const plain = element ? /^(P|H[1-6]|BLOCKQUOTE|UL|OL|TABLE|PRE|HR)$/.test(element.tagName) && !element.className && !element.id && !element.hasAttribute('style')
                : node.nodeType === Node.TEXT_NODE && !!node.textContent?.trim();
            if (plain) {
                if (!prose) {
                    prose = document.createElement('div'); prose.className = 'tipsy-reader-prose message-markdown';
                    container.insertBefore(prose, node);
                }
                prose.append(node);
            } else if (node.nodeType === Node.TEXT_NODE && !node.textContent?.trim()) {
                prose?.append(node);
            } else { prose = undefined; }
        }
    };
    groupProse(template.content);
    // Reader spacing is a fallback. Unlayered author CSS must retain priority
    // even when it uses simple body/p selectors or zero-specificity :where().
    return `<style>@layer tipsy-reader {${messageStyles}}</style>${template.innerHTML}`;
}

import showdown from 'showdown';
import DOMPurify from 'dompurify';
import { formatTemplateMarkdown } from './template-formatting';
import messageStyles from '../message-markdown.css?raw';
import '../message-markdown.css';

const markdown = new showdown.Converter({ tables: true, strikethrough: true, simpleLineBreaks: true,
    literalMidWordUnderscores: true, underline: true, disableForced4SpacesIndentedSublists: true,
    parseImgDimensions: true, simplifiedAutoLink: true, openLinksInNewWindow: true });

const proseBlock = /^(P|H[1-6]|BLOCKQUOTE|UL|OL|LI|TABLE|THEAD|TBODY|TFOOT|TR|TH|TD)$/;
const proseInline = /^(B|STRONG|EM|I|U|S|DEL|INS|SPAN|BR)$/;
const hasAuthorStyle = (element: Element) => element.matches('[class], [id], [style], [hidden]');

function highlightDialogue(root: ParentNode): void {
    let run: Text[] = [];
    const paint = () => {
        const nodes = run;
        run = [];
        const text = nodes.map(node => node.data).join('');
        const quotes = text.matchAll(/\u201c[^\u201c\u201d]+\u201d|\u300c[^\u300c\u300d]+\u300d|(?<![A-Za-z0-9])"[^"\s](?:[^"\n]*[^"\s])?"(?![A-Za-z0-9])/g);
        let quote = quotes.next().value;
        let offset = 0;
        for (const node of nodes) {
            if (!quote) break;
            const end = offset + node.length;
            let cursor = 0;
            const fragment = node.ownerDocument.createDocumentFragment();
            while (quote && quote.index < end) {
                const start = Math.max(0, quote.index - offset);
                const stop = Math.min(node.length, quote.index + quote[0].length - offset);
                if (cursor < start) fragment.append(node.data.slice(cursor, start));
                const span = node.ownerDocument.createElement('span');
                span.className = 'tipsy-reader-dialogue';
                span.textContent = node.data.slice(start, stop);
                fragment.append(span);
                cursor = stop;
                if (quote.index + quote[0].length > end) break;
                quote = quotes.next().value;
            }
            if (cursor) {
                fragment.append(node.data.slice(cursor));
                node.replaceWith(fragment);
            }
            offset = end;
        }
    };
    const visit = (container: ParentNode) => {
        for (const node of [...container.childNodes]) {
            if (node instanceof Text && node.length) run.push(node);
            else if (node instanceof Element) {
                // Markdown emphasis can split a line of dialogue across several text nodes.
                if (!hasAuthorStyle(node) && proseInline.test(node.tagName)) visit(node);
                else {
                    paint();
                    if (!hasAuthorStyle(node) && proseBlock.test(node.tagName)) {
                        visit(node);
                        paint();
                    }
                }
            }
        }
    };
    visit(root);
    paint();
}

/** Ordinary message prose is rendered after regex replacement. Interactive HTML
 * remains in the existing author iframe path, never in the application document. */
export function renderMessageMarkdown(source: string): string {
    const html = DOMPurify.sanitize(markdown.makeHtml(source), {
        USE_PROFILES: { html: true }, FORBID_TAGS: ['style'], SANITIZE_NAMED_PROPS: true,
    });
    if (!/["\u201c\u300c]|&(?:quot|ldquo|#(?:0*(?:34|8220|12300)|x0*(?:22|201c|300c)));/i.test(source)) return html;
    const template = document.createElement('template');
    template.innerHTML = html;
    highlightDialogue(template.content);
    return template.innerHTML;
}

/** Parse mixed content without executing it. Ordinary prose gets reader spacing;
 * authored widgets retain their markup and execute later in the author iframe. */
export function renderMixedMessage(source: string): string {
    const template = document.createElement('template');
    // The template pipeline has already formatted this wrapper. Re-running
    // Markdown can change author markup, disclosure structure and script data.
    const formatted = /^\s*<div\s+class=["']tipsy-template-message["'](?:\s[^>]*)?>/i.test(source);
    template.innerHTML = formatted ? source : formatTemplateMarkdown(source);
    const proseSections: HTMLElement[] = [];
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
                    proseSections.push(prose);
                }
                prose.append(node);
            } else if (node.nodeType === Node.TEXT_NODE && !node.textContent?.trim()) {
                prose?.append(node);
            } else { prose = undefined; }
        }
    };
    groupProse(template.content);
    for (const prose of proseSections) highlightDialogue(prose);
    // Reader spacing is a fallback. Unlayered author CSS must retain priority
    // even when it uses simple body/p selectors or zero-specificity :where().
    return `<style>@layer tipsy-reader {${messageStyles}}</style>${template.innerHTML}`;
}

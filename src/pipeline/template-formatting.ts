import showdown from 'showdown';
import { observeFrameHeight } from '../compatibility/frame-sizing';
import { authorBrowserRuntime } from '../compatibility/author-browser-runtime';
import { messageCodeBlocks } from './message-code-blocks';

const markdown = new showdown.Converter({ tables: true, strikethrough: true, simpleLineBreaks: true,
    literalMidWordUnderscores: true, disableForced4SpacesIndentedSublists: true,
    parseImgDimensions: true, simplifiedAutoLink: true, openLinksInNewWindow: true });
const escapeAttribute = (text: string) => text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function fragments() {
    const prefix = `TIPSYTEMPLATE${crypto.randomUUID().replace(/-/g, '')}BLOCK`;
    const values: string[] = [];
    return {
        hide: (value: string) => `${prefix}${values.push(value) - 1}END`,
        restore: (text: string) => {
            const pattern = new RegExp(`${prefix}(\\d+)END`, 'g');
            for (let round = 0; round <= values.length; round++) {
                const next = text.replace(pattern, (_all, index: string) => values[Number(index)] ?? '');
                if (next === text) break;
                text = next;
            }
            return text;
        },
    };
}

/** Escape markup and reasoning blocks never execute EJS, including nested tags. */
export function protectTemplateBlocks(source: string, codeBlocks = false) {
    const stored = fragments();
    const stack: Array<{ tag: string; start: number }> = [];
    const ranges: Array<{ start: number; end: number }> = [];
    const tags = /<\/?(escape-ejs|thinking|think|reasoning)(?:\s[^>]*?)?>/gi;
    for (const match of source.matchAll(tags)) {
        const tag = match[1].toLowerCase();
        if (!match[0].startsWith('</')) stack.push({ tag, start: match.index! });
        else if (stack.at(-1)?.tag === tag) {
            const open = stack.pop()!;
            if (!stack.length) ranges.push({ start: open.start, end: match.index! + match[0].length });
        }
    }
    let text = source;
    for (const range of ranges.reverse()) text = text.slice(0, range.start) + stored.hide(text.slice(range.start, range.end)) + text.slice(range.end);
    if (codeBlocks) text = text.replace(/<pre\b[^>]*>[\s\S]*?<\/pre>/gi, stored.hide);
    return { source: text, restore: stored.restore };
}

/** Keep EJS source intact through Markdown punctuation/entity processing. The
 * returned HTML is only displayed in the existing compatibility origin. */
export function formatTemplateMarkdown(source: string): string {
    if (!source) return '';
    const code = fragments();
    // Share the display renderer's classification before Markdown escapes an
    // author document. Ordinary code stays opaque to the HTML protection below.
    let protectedSource = '';
    let offset = 0;
    for (const block of messageCodeBlocks(source)) {
        protectedSource += source.slice(offset, block.start);
        protectedSource += block.isHtml
            ? `\n\n<div class="tipsy-template-html">${code.hide(block.content)}</div>\n\n`
            : `\n\n<div class="tipsy-template-code">${code.hide(markdown.makeHtml(block.source.replace(/<%[\s\S]*?%>/g, code.hide)))}</div>\n\n`;
        offset = block.end;
    }
    protectedSource += source.slice(offset);
    protectedSource = protectedSource.replace(/<%[\s\S]*?%>/g, code.hide)
        .replace(/(<(script|style|pre)\b[^>]*>)([\s\S]*?)(<\/\2\s*>)/gi,
            (_all, opening: string, _tag: string, body: string, closing: string) => opening + code.hide(body) + closing);
    // Showdown 2 does not recognize details as a block element. Keep nested
    // disclosure markup intact instead of inserting paragraphs inside it.
    protectedSource = showdown.helper.replaceRecursiveRegExp(protectedSource,
        (html: string) => `\n\n<div class="tipsy-template-disclosure">${code.hide(html)}</div>\n\n`,
        '<details\\b[^>]*>', '</details\\s*>', 'gi');
    const html = markdown.makeHtml(protectedSource);
    return code.restore(html);
}

export function renderTemplateFrame(html: string, title: string, id: string, attributes: Record<string, string>): string {
    const resize = `<script>(()=>{window.addEventListener('DOMContentLoaded',()=>{(${observeFrameHeight.toString()})(height=>parent.postMessage({type:'tipsy-template-resize',id:${JSON.stringify(id)},height},'*'))},{once:true});})();<\/script>`;
    const runtimeHtml = /<head\b[^>]*>/i.test(html) ? html.replace(/<head\b[^>]*>/i, head => head + authorBrowserRuntime) : authorBrowserRuntime + html;
    const content = /<\/body\s*>/i.test(runtimeHtml) ? runtimeHtml.replace(/<\/body\s*>/i, `${resize}</body>`) : runtimeHtml + resize;
    const attrs = Object.entries(attributes).map(([key, value]) => ` ${key}="${escapeAttribute(value)}"`).join('');
    const iframe = `<iframe id="${escapeAttribute(id)}" title="${escapeAttribute(title)}" srcdoc="${escapeAttribute(content)}" style="width:100%;height:300px;border:0" loading="lazy"${attrs}></iframe>`;
    return title ? `<details><summary>${escapeAttribute(title)}</summary>${iframe}</details>` : iframe;
}

import { applyRegexScripts, isEmptySlotPlaceholder, type ApplyRegexOptions } from './macro-regex-engine';
import { messageCodeBlocks } from './message-code-blocks';
import { generationPresentation, type GenerationPhase } from '../theme/generation-presentation';
import type { RegexScriptRule } from '../types';

export type StreamDisplayMode = 'auto' | 'segmented' | 'document';
export interface StreamPart {
    id: string; type: 'prose' | 'waiting' | 'component' | 'reasoning'; content: string;
    key?: string; selector?: string; label?: string; height?: number; complete?: boolean;
}
export interface MessageStreamPreview { source: string; status: string; phase: GenerationPhase; parts: StreamPart[]; document: boolean; scope: string; errorDetail?: string; }
interface ComponentRule { key: string; selector?: string; label: string; height?: number; document: boolean; dynamic: boolean; }
export interface StreamPlan { rules: RegexScriptRule[]; tags: Map<string, ComponentRule>; whole: boolean; scope: string; user: string; character: string; mode: StreamDisplayMode; options: Pick<ApplyRegexOptions, 'role' | 'depth'>; }
const narrativeTags = new Set(['now_plot', 'story', 'content', 'text', 'plot', 'narrative', 'maintext', 'main_text', 'response', 'message', 'start']);
const proseTags = new Set(['p', 'br', 'b', 'strong', 'em', 'i', 'u', 's', 'span', 'blockquote', 'h1', 'h2', 'h3', 'ul', 'ol', 'li']);
const reasoningTags = new Set(['think', 'thinking', 'reasoning', 'analysis', 'logic_check']);
const dataTags = new Set(['updatevariable', 'updatevariablevariable', 'update', 'jsonpatch', 'statusplaceholderimpl']);
const hiddenBlock = (block: PendingBlock) => ['comment', 'script', 'style', 'template'].includes(block.tag)
    || dataTags.has(block.tag) && !(block.tag === 'statusplaceholderimpl' && block.info);
const voidTags = new Set(['img', 'input', 'hr', 'meta', 'link', 'br', 'source', 'wbr']);

/** Source classification only; author scripts are never evaluated here. */
export function staticStreamMarkup(html: string): boolean {
    return !/<(?:script|iframe|object|embed|form|input|button|select|textarea)\b|\son[a-z]+\s*=|<%|\{\{|\[RENDER:|(?:javascript|data:text\/html)\s*:/i.test(html);
}
function componentShape(html: string) {
    const clean = html.replace(/<(style|script|head)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '').replace(/<!--[\s\S]*?-->/g, '');
    const root = [...clean.matchAll(/<([a-z][\w-]*)\b([^>]*)>/gi)].find(m => !['html', 'body', 'meta', 'link', 'span'].includes(m[1].toLowerCase()) && !/\bhidden\b/.test(m[2]));
    const className = root?.[2].match(/\bclass\s*=\s*["']([a-zA-Z_][\w-]*)/)?.[1];
    const id = root?.[2].match(/\bid\s*=\s*["']([a-zA-Z_][\w-]*)["']/)?.[1];
    const selector = id ? `#${id}` : className ? `${root![1]}.${className}` : undefined;
    const inline = root?.[2].match(/\bstyle\s*=\s*["']([^"']+)/)?.[1] ?? '';
    const css = className ? html.match(new RegExp(`\\.${className}\\s*\\{([^}]+)\\}`))?.[1] ?? '' : '';
    const fixed = /(?:^|[;\s])height\s*:\s*(\d+(?:\.\d+)?)px\b/i.exec(inline + ';' + css);
    return { selector, height: fixed && Number(fixed[1]) > 0 ? Number(fixed[1]) : undefined };
}
export function createStreamPlan(rules: RegexScriptRule[], scope: string, user: string, character: string, mode: StreamDisplayMode, templateDocument = false, options: Pick<ApplyRegexOptions, 'role' | 'depth'> = {}): StreamPlan {
    const tags = new Map<string, ComponentRule>();
    let whole = mode === 'document' || mode === 'auto' && templateDocument;
    for (const rule of rules) {
        const replacement = rule.replaceString ?? '';
        const document = /<!doctype\s+html\b|<html\b|<body\b/i.test(replacement);
        const tag = /<([a-zA-Z_][\w:-]*)\b/.exec(rule.findRegex)?.[1].toLowerCase();
        const html = /<[a-z][\w-]*\b/i.test(replacement);
        // A whole-message capture may end in a component tag. That marker does
        // not make the replacement safe to split into generic prose and widgets.
        const pattern = rule.findRegex.replace(/^\//, '');
        const page = /<!doctype\s+html\b|<html\b|<body\b/i.test(replacement);
        const capturesMessage = (pattern.includes('[\\s\\S]') || pattern.includes('.*')) && (!tag || page && pattern.startsWith('^'));
        if (mode === 'auto' && capturesMessage && (document || /<(?:main|article|section|div)\b/i.test(replacement))) whole = true;
        if (!tag || !html && !dataTags.has(tag) && replacement !== '') continue;
        if (narrativeTags.has(tag) && isEmptySlotPlaceholder(replacement) && !/\$(?:[0-9&'`]|<[^>]+>)|\{\{match\}\}/i.test(replacement)) continue;
        tags.set(tag, { key: `${scope}:${rule.id}`, label: rule.scriptName || '互动内容', document,
            dynamic: !staticStreamMarkup(replacement) || /\{\{|<%/.test(rule.findRegex), ...componentShape(replacement) });
    }
    return { rules, tags, whole, scope, user, character, mode, options };
}
interface PendingBlock { start: number; scan: number; tag: string; level: number; fence?: string; language?: string; endToken?: string; info?: ComponentRule; reasoning?: boolean; opaqueEnd?: string; }

/** Closed segments stay cached. Only new input and an unfinished boundary are
 * scanned; an author rewrite starts a fresh projection. */
export class StreamProjector {
    private text = '';
    private cursor = 0;
    private parts: StreamPart[] = [];
    private pending?: PendingBlock;
    private whole = false;
    private serial = 0;
    constructor(readonly plan: StreamPlan) { this.whole = plan.whole; }
    private expand(text: string) { return text.replace(/\{\{user\}\}/gi, () => this.plan.user).replace(/\{\{char\}\}/gi, () => this.plan.character); }
    private prose(text: string) {
        if (!text) return;
        const last = this.parts.at(-1);
        if (last?.type === 'prose') last.content += text;
        else this.parts.push({ id: `s${this.serial++}`, type: 'prose', content: text });
    }
    private finishBlock(block: PendingBlock, end: number) {
        const raw = this.text.slice(block.start, end);
        const key = block.info?.key ?? `${this.plan.scope}:${block.fence ? 'code' : block.tag}`;
        if (hiddenBlock(block)) {
            // HTML comments do not occupy space in the final message.
        } else if (block.fence && block.language !== 'html' && !/^\s*\[\s*\{\s*"op"\s*:/.test(raw.slice(raw.indexOf('\n') + 1)) && !/^(?:<!doctype\s+html\b|<html\b)/i.test(raw.slice(raw.indexOf('\n') + 1).trimStart())) {
            this.prose(raw);
        } else if (block.reasoning) {
            this.parts.push({ id: `s${this.serial++}`, type: 'reasoning', content: raw.replace(/^<[^>]+>|<\/[^>]+>$/g, ''), complete: true });
        } else {
            let html = raw;
            if (block.fence) html = raw.slice(raw.indexOf('\n') + 1).replace(/(?:\r?\n)[ \t]*[`~]{3,}[ \t]*$/, '');
            else if (!block.info?.dynamic) html = applyRegexScripts(raw, this.plan.rules, { stage: 'render', ...this.plan.options });
            html = this.expand(html);
            const transformed = html !== this.expand(raw);
            const fenced = [...messageCodeBlocks(html)];
            if (fenced.length === 1 && fenced[0].isHtml && !html.slice(0, fenced[0].start).trim() && !html.slice(fenced[0].end).trim()) html = fenced[0].content;
            if (!html.trim()) { this.cursor = end; this.pending = undefined; return; }
            const canDisplay = !block.info?.dynamic && (!block.info || transformed) && staticStreamMarkup(html) && !/<!doctype\s+html\b|<html\b|<body\b/i.test(html) && /<[a-z][\w-]*\b/i.test(html) && !dataTags.has(block.tag)
                && (block.info || ['div', 'section', 'article', 'details', 'table', 'aside', 'figure'].includes(block.tag) || block.fence);
            this.parts.push({ id: `s${this.serial++}`, type: canDisplay ? 'component' : 'waiting', content: canDisplay ? html : '', key,
                selector: block.info?.selector, height: block.info?.height, label: block.info?.label ?? (dataTags.has(block.tag) ? '状态更新' : '互动内容'), complete: true });
        }
        this.cursor = end; this.pending = undefined;
    }
    private scanBlock(): boolean {
        const block = this.pending!;
        if (block.fence) {
            const body = this.text.slice(this.text.indexOf('\n', block.start) + 1).trimStart();
            if (this.plan.mode === 'auto' && /^(?:<!doctype\s+html\b|<html\b)/i.test(body)) { this.whole = true; return false; }
            const close = new RegExp(`^[ \\t]{0,3}${block.fence[0]}{${block.fence.length},}[ \\t]*\\r?$`, 'gm');
            close.lastIndex = block.scan; const match = close.exec(this.text);
            if (match) { this.finishBlock(block, close.lastIndex); return true; }
            block.scan = Math.max(block.scan, this.text.lastIndexOf('\n') + 1); return false;
        }
        if (block.endToken) {
            const end = this.text.indexOf(block.endToken, block.scan);
            if (end >= 0) { this.finishBlock(block, end + block.endToken.length); return true; }
            block.scan = Math.max(block.scan, this.text.length - block.endToken.length); return false;
        }
        const opaque = block.reasoning || ['script', 'style', 'pre', ...dataTags].includes(block.tag);
        const token = new RegExp(`<!--|<(script|style)\\b[^>]*>|<(/?)${block.tag}\\b[^>]*>`, 'gi');
        if (block.opaqueEnd) {
            const end = this.text.toLowerCase().indexOf(block.opaqueEnd, block.scan);
            if (end < 0) { block.scan = Math.max(block.scan, this.text.length - block.opaqueEnd.length); return false; }
            block.scan = end + block.opaqueEnd.length; block.opaqueEnd = undefined;
        }
        token.lastIndex = block.scan;
        for (let match; (match = token.exec(this.text));) {
            if (!opaque && (match[0] === '<!--' || match[1])) {
                const endToken = match[0] === '<!--' ? '-->' : `</${match[1].toLowerCase()}>`;
                const end = this.text.toLowerCase().indexOf(endToken, token.lastIndex);
                if (end < 0) { block.opaqueEnd = endToken; block.scan = token.lastIndex; return false; }
                token.lastIndex = end + endToken.length; block.scan = token.lastIndex; continue;
            }
            if (match[2]) block.level--; else if (!opaque && !/\/>$/.test(match[0])) block.level++;
            if (block.level === 0) { this.finishBlock(block, token.lastIndex); return true; }
            block.scan = token.lastIndex;
        }
        const lastOpen = this.text.lastIndexOf('<');
        block.scan = Math.max(block.scan, lastOpen > this.text.lastIndexOf('>') ? lastOpen : this.text.length);
        return false;
    }
    update(text: string, finishing = false, thinking = false): MessageStreamPreview {
        if (!text.startsWith(this.text)) { this.cursor = 0; this.parts = []; this.pending = undefined; this.whole = this.plan.whole; this.serial = 0; }
        this.text = text;
        while (!this.whole && this.cursor < text.length) {
            if (this.pending) { if (!this.scanBlock()) break; continue; }
            const special = /<|^[ \t]{0,3}(?:`{3,}|~{3,})|^[ \t]*\[\s*\{\s*"op"\s*:/gm;
            special.lastIndex = this.cursor; const match = special.exec(text);
            if (!match) {
                const tail = text.slice(this.cursor); const partial = /(?:^|\n)[ \t]*(?:[`~]{1,2}|\[\s*(?:\{\s*(?:"(?:o(?:p(?:"\s*)?)?)?)?)?)$/.exec(tail);
                const end = partial ? this.cursor + partial.index : text.length;
                this.prose(text.slice(this.cursor, end)); this.cursor = end; break;
            }
            this.prose(text.slice(this.cursor, match.index)); this.cursor = match.index;
            if (match[0] !== '<') {
                if (match[0].trim().startsWith('[')) { this.pending = { start: this.cursor, scan: text.length, tag: 'jsonpatch', level: 1, endToken: '\u0000' }; break; }
                const end = text.indexOf('\n', special.lastIndex); if (end < 0) break;
                this.pending = { start: this.cursor, scan: end + 1, tag: 'code', level: 1, fence: match[0].trim(), language: text.slice(special.lastIndex, end).trim().toLowerCase() }; continue;
            }
            if (this.plan.mode !== 'segmented' && /^(?:<!doctype\s+html\b|<html\b)/i.test(text.slice(this.cursor))) { this.whole = true; break; }
            if (text.startsWith('<!--', this.cursor) || text.startsWith('<%', this.cursor)) {
                const endToken = text.startsWith('<!--', this.cursor) ? '-->' : '%>';
                this.pending = { start: this.cursor, scan: this.cursor + 2, tag: endToken === '-->' ? 'comment' : 'template', level: 1, endToken }; continue;
            }
            const tagMatch = /^<(\/?)([a-zA-Z_][\w:-]*)(?:\s[^>]*?)?\s*(\/?)>/.exec(text.slice(this.cursor));
            if (!tagMatch) {
                if (!text.slice(this.cursor).includes('>') && /^<(?:[\/!?%a-zA-Z_]|$)/.test(text.slice(this.cursor))) break;
                this.prose('<'); this.cursor++; continue;
            }
            const tag = tagMatch[2].toLowerCase(); const end = this.cursor + tagMatch[0].length;
            const info = this.plan.tags.get(tag);
            if (tagMatch[1]) { if (proseTags.has(tag)) this.prose(tagMatch[0]); this.cursor = end; continue; }
            if (info?.document && narrativeTags.has(tag) && this.plan.mode === 'auto') { this.whole = true; break; }
            if (!info && (narrativeTags.has(tag) || proseTags.has(tag))) {
                if (proseTags.has(tag)) this.prose(tagMatch[0]); this.cursor = end; continue;
            }
            const block: PendingBlock = { start: this.cursor, scan: end, tag, level: 1, info, reasoning: reasoningTags.has(tag) };
            if (tagMatch[3] || voidTags.has(tag)) this.finishBlock(block, end); else this.pending = block;
        }
        const parts = this.whole ? [] : this.parts.map(part => ({ ...part, content: part.type === 'prose' ? this.expand(part.content) : part.content }));
        if (!this.whole && this.pending && !hiddenBlock(this.pending)) {
            const block = this.pending;
            const raw = text.slice(block.start);
            const component = block.info || ['div', 'section', 'article', 'details', 'table', 'aside', 'figure', 'iframe', 'body'].includes(block.tag)
                || block.fence && (block.language === 'html' || /^(?:<!doctype\s+html\b|<html\b)/i.test(raw.slice(raw.indexOf('\n') + 1).trimStart()));
            if (block.reasoning || component) parts.push({ id: `s${this.serial}`, type: block.reasoning ? 'reasoning' : 'waiting', content: block.reasoning ? raw.replace(/^<[^>]+>/, '') : '',
                key: block.info?.key ?? `${this.plan.scope}:${block.fence ? 'code' : block.tag}`, selector: block.info?.selector, height: block.info?.height, label: block.info?.label ?? '互动内容' });
            else if (block.fence) parts.push({ id: `s${this.serial}`, type: 'prose', content: raw });
        }
        const phase: GenerationPhase = finishing ? 'layout' : this.pending?.reasoning || thinking ? 'thinking' : this.whole ? 'page' : text.trim() ? 'writing' : 'waiting';
        return { source: parts.filter(part => part.type === 'prose').map(part => part.content).join(''), status: generationPresentation[phase].text, phase, parts, document: this.whole, scope: this.plan.scope };
    }
}

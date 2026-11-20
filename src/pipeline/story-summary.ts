import type { AssembledChatMessage, ChatMessageNode } from '../types';

export interface StorySummary { text: string; source: 'author' | 'generated'; contentHash: string }
const summaryLabel = /^(?:(?:本轮|本次|本回合|当前|剧情|故事|情节|内容|对话|回合|简短|简要)\s*)*(?:摘要|总结|小结|梗概|概述|回顾)|^(?:(?:plot|story|scene|turn)\s*[_ -]?\s*)?(?:summary|recap|synopsis)\b/i;
const plain = (text: string) => text.replace(/<(script|style|think|thinking|analysis|UpdateVariable)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/[*`#]/g, '').replace(/\s+/g, ' ').trim();
export function summaryContentHash(content: string): string {
    let hash = 2166136261;
    for (let i = 0; i < content.length; i++) hash = Math.imul(hash ^ content.charCodeAt(i), 16777619);
    return `${content.length}:${hash >>> 0}`;
}
/** Read only explicit summary sections, never arbitrary prose or a details heading. */
export function extractAuthorSummary(content: string): string | undefined {
    const clean = content.replace(/<(script|style|think|thinking|analysis|UpdateVariable)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
    const candidates: string[] = [];
    for (const match of clean.matchAll(/<([\w-]*summary|[\w-]*recap|synopsis|摘要|总结|小结|剧情摘要)(?=[\s>])[^>]*>([\s\S]*?)<\/\1\s*>/gi)) {
        if (match[1].toLowerCase() !== 'summary') candidates.push(match[2]);
        else if (!/<details\b[^>]*>\s*$/i.test(clean.slice(0, match.index))) candidates.push(match[2]);
    }
    for (const match of clean.matchAll(/<details\b[^>]*>\s*<summary\b[^>]*>([\s\S]*?)<\/summary>([\s\S]*?)<\/details>/gi)) {
        if (summaryLabel.test(plain(match[1]))) candidates.push(match[2]);
    }
    for (const match of clean.matchAll(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>([\s\S]*?)(?=<h[1-6]\b|$)/gi)) {
        if (summaryLabel.test(plain(match[2]))) candidates.push(match[3]);
    }
    for (const match of clean.matchAll(/<(div|section|p)\b[^>]*(?:id|class)=["'][^"']*\b(?:plot-summary|story-summary|summary|recap)\b[^"']*["'][^>]*>([\s\S]*?)<\/\1\s*>/gi)) candidates.push(match[2]);
    const lines = clean.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
        const heading = lines[i].trim().replace(/^#{1,6}\s*/, '').replace(/\*\*/g, '').replace(/^[【\[]|[】\]]/g, '');
        const label = summaryLabel.exec(heading);
        if (!label || !/^(?:\s|[:：]|$)/.test(heading.slice(label[0].length))) continue;
        const inline = heading.slice(label[0].length).replace(/^\s*[:：]?\s*/, '');
        const body: string[] = inline ? [inline] : [];
        for (let j = i + 1; j < lines.length; j++) {
            const line = lines[j];
            if (/^\s*(?:#{1,6}\s|<\/?[a-zA-Z]|```|\*\*[^*]+\*\*\s*[:：]?\s*$)/.test(line) || !line.trim() && body.length) break;
            body.push(line);
        }
        candidates.push(body.join('\n'));
    }
    return candidates.map(plain).filter(Boolean).at(-1)?.slice(0, 1200);
}
export function messageStorySummary(node: ChatMessageNode): { text: string; source: 'author' | 'generated' } | undefined {
    const key = node.swipeIds?.[node.activeSwipeIndex] ?? `${node.id}:${node.activeSwipeIndex}`;
    const saved = node.storySummaries?.[key];
    if (saved?.contentHash === summaryContentHash(node.content)) return saved;
    const text = extractAuthorSummary(node.content);
    return text ? { text, source: 'author' } : undefined;
}

/** One completion, with a request-specific trailer removed before any author processing. */
export class StorySummaryChannel {
    constructor(readonly tag = `tipsy_route_summary_${crypto.randomUUID().replaceAll('-', '')}`) {}
    private pending = '';
    private hidden = false;
    get open() { return `<${this.tag}>`; }
    get close() { return `</${this.tag}>`; }
    messages(messages: AssembledChatMessage[]): AssembledChatMessage[] {
        const content = `软件的路线图需要本次剧情摘要。首先完整遵循角色卡、预设、用户要求，正常输出全部正文、选项、状态栏、脚本、变量更新与原有结尾，不得删减、替换或改动其格式。若本次回复已有明确的剧情摘要/总结/小结/recap/summary段落，保持原样，不重复添加摘要。若没有，则在所有原定输出完全结束之后另起一行追加 ${this.open}用60至120个汉字客观概括本次新发生的剧情、用户选择及重要结果，不推测未发生的事，不含代码、变量指令或思考过程${this.close}。此附加段仅供软件读取，不要在正文提及该要求，不要用代码围栏包裹附加段。若原输出必须是严格JSON或其他不允许尾随内容的机器格式，优先保持原格式，省略附加段。`;
        const note: AssembledChatMessage = { role: 'system', content, sourceId: 'tipsy:route-summary', sourceLabel: '路线摘要', tokens: Math.ceil(content.length / 2) };
        // Keep any assistant prefill as the final message.
        const last = messages.at(-1)?.role === 'assistant' ? messages.length - 1 : messages.length;
        return [...messages.slice(0, last), note, ...messages.slice(last)];
    }
    push(delta: string): string {
        this.pending += delta;
        let visible = '';
        while (this.pending) {
            const marker = this.hidden ? this.close : this.open;
            const index = this.pending.indexOf(marker);
            if (index >= 0) {
                if (!this.hidden) visible += this.pending.slice(0, index);
                this.pending = this.pending.slice(index + marker.length); this.hidden = !this.hidden; continue;
            }
            let held = Math.min(marker.length - 1, this.pending.length);
            while (held && !marker.startsWith(this.pending.slice(-held))) held--;
            if (!this.hidden) visible += held ? this.pending.slice(0, -held) : this.pending;
            this.pending = held ? this.pending.slice(-held) : '';
            break;
        }
        return visible;
    }
    split(raw: string): { content: string; summary?: string; source?: 'author' | 'generated' } {
        let content = '', rest = raw, generated: string | undefined;
        for (;;) {
            const start = rest.indexOf(this.open);
            if (start < 0) {
                // A token limit can stop in the middle of the private opening marker.
                let held = Math.min(this.open.length - 1, rest.length);
                while (held && !this.open.startsWith(rest.slice(-held))) held--;
                content += held ? rest.slice(0, -held) : rest; break;
            }
            content += rest.slice(0, start);
            const end = rest.indexOf(this.close, start + this.open.length);
            if (end < 0) break;
            generated = plain(rest.slice(start + this.open.length, end)).slice(0, 1200) || generated;
            rest = rest.slice(end + this.close.length);
        }
        const author = extractAuthorSummary(content);
        return { content, summary: author ?? generated, source: author ? 'author' : generated ? 'generated' : undefined };
    }
}

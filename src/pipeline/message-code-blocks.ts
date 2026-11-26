export function isHtmlCodeBlock(language: string, content: string): boolean {
    const lang = language.trim().toLowerCase();
    if (lang === 'html' || lang === 'htm' || /^html?\s/.test(lang)) return true;
    if (lang && !['text', 'txt', 'xml'].includes(lang)) return false;
    const trimmed = content.trim().replace(/^(?:<!--[\s\S]*?-->\s*)+/, '');
    if (/^(?:<!doctype\s+html\b|<html\b)/i.test(trimmed)) return true;
    if (!/^<[a-z!]/i.test(trimmed)) return false;
    if (/<(?:head|body)\b[^>]*>/i.test(trimmed) && /<\/(?:head|body)\s*>/i.test(trimmed)) return true;
    return /<(?:style|script)\b[^>]*>[\s\S]*?<\/(?:style|script)\s*>/i.test(trimmed)
        && /<(?:div|section|main|article|header|footer|nav|aside|details|table|form|button|canvas|svg|iframe|p|ul|ol)\b[^>]*>/i.test(trimmed);
}

/** Author pages may label a complete HTML document as `text` or omit a
 * language. Classify the source before Markdown escapes the document. */
export function* messageCodeBlocks(source: string) {
    const fences = /^[ \t]{0,3}(`{3,}|~{3,})[ \t]*([^\r\n]*)\r?\n([\s\S]*?)^[ \t]{0,3}\1[ \t]*(?=\r?$)/gm;
    for (const match of source.matchAll(fences)) {
        const language = match[2].trim().toLowerCase();
        const content = match[3].trim();
        yield {
            start: match.index!, end: match.index! + match[0].length,
            source: match[0], content,
            isHtml: isHtmlCodeBlock(language, content),
        };
    }
}

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
            isHtml: language === 'html' || /^(?:<!doctype\s+html\b|<html\b)/i.test(content),
        };
    }
}

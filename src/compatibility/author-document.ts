type Span = { start: number; end: number };

const RAW_TEXT_TAGS = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes']);

function scanTagEnd(source: string, from: number): number {
    let quote = '';
    for (let i = from; i < source.length; i++) {
        const ch = source[i]!;
        if (quote) {
            if (ch === quote) quote = '';
            continue;
        }
        if (ch === '"' || ch === "'") quote = ch;
        else if (ch === '>') return i + 1;
    }
    return -1;
}

function skipRawTextElement(source: string, from: number, lowerName: string): number {
    const closePattern = new RegExp(`</${lowerName}(?=[\\t\\n\\f\\r />])`, 'ig');
    closePattern.lastIndex = from;
    const match = closePattern.exec(source);
    if (!match) return source.length;
    const gt = source.indexOf('>', match.index + 2 + lowerName.length);
    return gt === -1 ? source.length : gt + 1;
}

function scanDocumentStructure(source: string) {
    let openHtml: Span | undefined;
    let openHead: Span | undefined;
    let openBody: Span | undefined;
    let closeBody: Span | undefined;
    let closeHtml: Span | undefined;
    let templateDepth = 0;
    let hasLeadingContent = false;

    for (let i = 0; i < source.length;) {
        const ch = source[i]!;
        if (ch !== '<') {
            if (templateDepth === 0 && !hasLeadingContent && !/\s/.test(ch)) hasLeadingContent = true;
            i++;
            continue;
        }
        if (source.startsWith('<!--', i)) {
            const end = source.indexOf('-->', i + 4);
            i = end === -1 ? source.length : end + 3;
            continue;
        }
        const next = source[i + 1] ?? '';
        if (next === '!' || next === '?') {
            const gt = source.indexOf('>', i + 2);
            i = gt === -1 ? source.length : gt + 1;
            continue;
        }
        const tagMatch = /^<\/?([a-zA-Z][a-zA-Z0-9-]*)/.exec(source.slice(i, i + 64));
        if (!tagMatch) {
            if (templateDepth === 0 && !hasLeadingContent) hasLeadingContent = true;
            i++;
            continue;
        }
        const isClosing = next === '/';
        const lowerName = tagMatch[1]!.toLowerCase();
        const tagEnd = scanTagEnd(source, i + tagMatch[0].length);
        if (tagEnd === -1) break;

        if (isClosing) {
            if (lowerName === 'template' && templateDepth > 0) templateDepth--;
            else if (templateDepth === 0) {
                if (lowerName === 'body') closeBody = { start: i, end: tagEnd };
                else if (lowerName === 'html') closeHtml = { start: i, end: tagEnd };
            }
            i = tagEnd;
            continue;
        }

        if (lowerName === 'template') {
            if (templateDepth === 0 && !hasLeadingContent) hasLeadingContent = true;
            templateDepth++;
            i = tagEnd;
            continue;
        }
        if (RAW_TEXT_TAGS.has(lowerName)) {
            if (templateDepth === 0 && !hasLeadingContent) hasLeadingContent = true;
            i = skipRawTextElement(source, tagEnd, lowerName);
            continue;
        }
        if (templateDepth === 0) {
            if (lowerName === 'html') {
                if (!hasLeadingContent && !openHtml) openHtml = { start: i, end: tagEnd };
                hasLeadingContent = true;
            } else {
                hasLeadingContent = true;
                if (lowerName === 'head' && !openHead) openHead = { start: i, end: tagEnd };
                else if (lowerName === 'body' && !openBody) openBody = { start: i, end: tagEnd };
            }
        }
        i = tagEnd;
    }

    return { openHtml, openHead, openBody, closeBody, closeHtml };
}

function spliceRightToLeft(source: string, edits: Array<{ pos: number; insert: string }>): string {
    let result = source;
    const ordered = [...edits].sort((a, b) => b.pos - a.pos);
    for (const edit of ordered) {
        result = result.slice(0, edit.pos) + edit.insert + result.slice(edit.pos);
    }
    return result;
}

function isHeadCompatible(fragment: string): boolean {
    const stripped = fragment
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<(style|script|title|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
        .replace(/<(?:meta|link|base)\b[^>]*>/gi, '');
    return stripped.trim().length === 0;
}

/** Add host support without nesting an author's complete or partial document in a body. */
export function authorDocument(source: string, head: string, tail: string): string {
    const { openHtml, openHead, openBody, closeBody, closeHtml } = scanDocumentStructure(source);
    if (openHtml) {
        const edits: Array<{ pos: number; insert: string }> = [
            openHead ? { pos: openHead.end, insert: head } : { pos: openHtml.end, insert: `<head>${head}</head>` },
            { pos: closeBody ? closeBody.start : closeHtml ? closeHtml.start : source.length, insert: tail },
        ];
        return spliceRightToLeft(source, edits);
    }
    if (openHead) {
        const assembled = spliceRightToLeft(source, [
            { pos: openHead.end, insert: head },
            { pos: closeBody ? closeBody.start : source.length, insert: tail },
        ]);
        return `<!doctype html><html>${assembled}</html>`;
    }
    const beforeBody = openBody ? source.slice(0, openBody.start) : '';
    if (openBody && isHeadCompatible(beforeBody)) {
        const fromBody = source.slice(openBody.start);
        const bodyWithTail = closeBody && closeBody.start >= openBody.end
            ? spliceRightToLeft(fromBody, [{ pos: closeBody.start - openBody.start, insert: tail }])
            : `${fromBody}${tail}`;
        return `<!doctype html><html><head>${head}${beforeBody}</head>${bodyWithTail}</html>`;
    }
    return `<!doctype html><html><head>${head}</head><body>${source}${tail}</body></html>`;
}

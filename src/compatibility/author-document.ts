/** Add host support without nesting an author's complete document in a body. */
export function authorDocument(source: string, head: string, tail: string): string {
    if (!/^\s*(?:<!doctype\s+html\b[^>]*>\s*)?<html\b/i.test(source)) {
        return `<!doctype html><html><head>${head}</head><body>${source}${tail}</body></html>`;
    }
    let document = source;
    if (/<head\b[^>]*>/i.test(document)) document = document.replace(/<head\b[^>]*>/i, opening => opening + head);
    else document = document.replace(/<html\b[^>]*>/i, opening => `${opening}<head>${head}</head>`);
    if (/<\/body\s*>/i.test(document)) return document.replace(/<\/body\s*>/i, () => tail + '</body>');
    return document.replace(/<\/html\s*>/i, () => tail + '</html>');
}

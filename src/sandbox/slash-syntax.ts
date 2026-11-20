/** Parse before macro expansion: a variable containing `|` must remain data. */
export function splitSlashPipeline(source: string): string[] {
    const stages: string[] = [], brackets: string[] = [];
    let start = 0, quote = '', escaped = false, comment = false;
    for (let i = 0; i < source.length; i++) {
        const char = source[i];
        if (comment) { if (source.slice(i, i + 2) === '*|') { comment = false; start = i + 2; i++; } continue; }
        if (escaped) { escaped = false; continue; }
        if (char === '\\') { escaped = true; continue; }
        if (quote) { if (char === quote) quote = ''; continue; }
        if (!brackets.length && source.slice(start, i).trim() === '' && source.slice(i, i + 2) === '/*') { comment = true; i++; continue; }
        if ((char === '"' || char === "'") && (i === 0 || /[\s=\[{,:]/.test(source[i - 1]))) { quote = char; continue; }
        if (char === '{' || char === '[') brackets.push(char);
        else if (char === '}' && brackets.at(-1) === '{' || char === ']' && brackets.at(-1) === '[') brackets.pop();
        else if (char === '|' && !brackets.length) { stages.push(source.slice(start, i).trim()); start = i + 1; }
    }
    if (quote || brackets.length || comment) throw new Error('Slash 命令的引号、括号或注释未闭合');
    stages.push(source.slice(start).trim());
    return stages.filter(Boolean);
}

/** One quoted, bracketed, closure or bare argument, preserving source text. */
export function takeSlashToken(source: string): { token: string; rest: string } {
    source = source.trimStart();
    const brackets: string[] = [];
    let quote = '', escaped = false, end = source.length;
    for (let i = 0; i < source.length; i++) {
        const char = source[i];
        if (escaped) { escaped = false; continue; }
        if (char === '\\') { escaped = true; continue; }
        if (quote) { if (char === quote) quote = ''; continue; }
        if ((char === '"' || char === "'") && (i === 0 || /[\s=\[{,:]/.test(source[i - 1]))) { quote = char; continue; }
        if (char === '{' || char === '[') brackets.push(char);
        else if (char === '}' && brackets.at(-1) === '{' || char === ']' && brackets.at(-1) === '[') brackets.pop();
        else if (/\s/.test(char) && !brackets.length) { end = i; break; }
    }
    return { token: source.slice(0, end), rest: source.slice(end).trimStart() };
}

export function parseSlashArguments(source: string): { named: Record<string, string>; text: string; hasText: boolean } {
    const named: Record<string, string> = Object.create(null);
    let rest = source.trim();
    while (true) {
        const match = /^([\w-]+)=/.exec(rest);
        if (!match) break;
        const after = rest.slice(match[0].length);
        const item = !after || /^\s/.test(after) ? { token: '', rest: after.trimStart() } : takeSlashToken(after);
        named[match[1]] = item.token; rest = item.rest;
    }
    return { named, text: rest, hasText: rest.length > 0 };
}

export function unquoteSlash(value: string): string {
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    return value.replace(/\\([\\|"'{}])/g, '$1');
}

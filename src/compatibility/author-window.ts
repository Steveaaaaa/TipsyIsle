const frameAccessPattern = /\b(?:top|parent)\b/;

/** Strip outer Markdown code fences (e.g. ```js ... ```), matching JS-Slash-Runner's script loader. */
export function unwrapAuthorScript(source: string): string {
    return source.match(/^\s*```[^\r\n]*\r?\n([\s\S]*?)\r?\n[ \t]*```\s*$/)?.[1] ?? source;
}

export function needsAuthorWindowAdapt(source: string): boolean {
    return frameAccessPattern.test(source);
}

function memberKey(node: any): string | undefined {
    if (!['MemberExpression', 'OptionalMemberExpression'].includes(node?.type)) return undefined;
    return node.computed ? (node.property?.type === 'StringLiteral' ? node.property.value : undefined) : node.property?.name;
}

function isNonReadPosition(parent: any, parentKey: string | undefined, node: any): boolean {
    if (!parent || !parentKey) return false;
    if (parent.type === 'AssignmentExpression' && parentKey === 'left') return true;
    if (parent.type === 'UpdateExpression' && parentKey === 'argument') return true;
    if (parent.type === 'UnaryExpression' && parent.operator === 'delete' && parentKey === 'argument') return true;
    if ((parent.type === 'ForInStatement' || parent.type === 'ForOfStatement') && parentKey === 'left') return true;
    if (parent.type === 'CallExpression' && parentKey === 'callee' && ['MemberExpression', 'OptionalMemberExpression'].includes(node.type)) return true;
    if (parent.type === 'NewExpression' && parentKey === 'callee') return true;
    if (parent.type === 'TaggedTemplateExpression' && parentKey === 'tag') return true;
    return false;
}

function isNonReferenceIdentifier(parent: any, parentKey: string | undefined, node: any): boolean {
    if (!parent || !parentKey) return false;
    if (['MemberExpression', 'OptionalMemberExpression'].includes(parent.type) && parentKey === 'property' && !parent.computed) return true;
    if (parent.type === 'ObjectProperty' && (parentKey === 'key' || parent.shorthand)) return true;
    if (['ObjectMethod', 'ClassMethod', 'ClassProperty', 'ClassPrivateProperty'].includes(parent.type) && parentKey === 'key' && !parent.computed) return true;
    if (['LabeledStatement', 'BreakStatement', 'ContinueStatement'].includes(parent.type) && parentKey === 'label') return true;
    if (['ImportSpecifier', 'ExportSpecifier'].includes(parent.type)) return true;
    if (parent.type === 'VariableDeclarator' && parentKey === 'id') return true;
    if (/^(?:Function|Class)(?:Declaration|Expression)$/.test(parent.type) && (parentKey === 'id' || parentKey === 'params')) return true;
    if (parent.type === 'ArrowFunctionExpression' && parentKey === 'params') return true;
    if (parent.type === 'CatchClause' && parentKey === 'param') return true;
    if (/^Import.*Specifier$/.test(parent.type)) return true;
    if (parent.type === 'RestElement' || parent.type === 'ArrayPattern' || parent.type === 'ObjectPattern') return true;
    if (parent.type === 'AssignmentPattern' && parentKey === 'left') return true;
    if (parent.type === 'UnaryExpression' && parent.operator === 'typeof') return true;
    return isNonReadPosition(parent, parentKey, node);
}

function isInsideNewCallee(ancestors: Array<{ node: any; key: string }>): boolean {
    for (let i = ancestors.length - 1; i >= 0; i--) {
        const { node, key } = ancestors[i]!;
        if (node.type === 'NewExpression' && key === 'callee') return true;
        if (!['MemberExpression', 'OptionalMemberExpression'].includes(node.type)) return false;
    }
    return false;
}

/** Adapt executable cross-origin top/parent window accesses. Stored author source is unchanged. */
export async function adaptAuthorWindow(source: string, sourceType: 'unambiguous' | 'script' | 'module' = 'unambiguous'): Promise<string> {
    if (!needsAuthorWindowAdapt(source)) return source;
    const { parse } = await import('@babel/parser');
    const ast = parse(source, {
        sourceType,
        errorRecovery: true,
        allowAwaitOutsideFunction: true,
        allowReturnOutsideFunction: true,
        allowSuperOutsideMethod: true,
        allowNewTargetOutsideFunction: true,
    });
    const replaces: Array<{ start: number; end: number; replacement: string; guard: string }> = [];
    const wraps: Array<{ start: number; end: number; chainOptional?: 'dot' | 'bracket' }> = [];
    const shadowed = new Set<string>();
    const globals = new Set(['window', 'self', 'globalThis', 'parent', 'top']);
    const binding = (node: any) => {
        if (!node) return;
        if (node.type === 'Identifier' && globals.has(node.name)) shadowed.add(node.name);
        else if (node.type === 'ObjectPattern') node.properties.forEach((prop: any) => binding(prop.value ?? prop.argument));
        else if (node.type === 'ArrayPattern') node.elements.forEach(binding);
        else if (node.type === 'AssignmentPattern') binding(node.left);
        else if (node.type === 'RestElement') binding(node.argument);
    };
    const ancestors: Array<{ node: any; key: string }> = [];
    const visit = (node: any, parent?: any, parentKey?: string) => {
        if (!node || typeof node !== 'object') return;
        if (node.type === 'VariableDeclarator' || /^(?:Function|Class)(?:Declaration|Expression)$/.test(node.type)) binding(node.id);
        if (node.params) node.params.forEach(binding);
        if (node.type === 'CatchClause') binding(node.param);
        if (/^Import.*Specifier$/.test(node.type)) binding(node.local);

        const key = memberKey(node);
        let skipChildren = false;
        if (key && (key === 'top' || key === 'parent') && !isNonReadPosition(parent, parentKey, node)) {
            if (node.object.type === 'Identifier' && ['window', 'self', 'globalThis'].includes(node.object.name) && key === 'top') {
                replaces.push({ start: node.start, end: node.end, replacement: `${node.object.name}.__tipsyHostWindow`, guard: node.object.name });
                skipChildren = true;
            } else if (!isInsideNewCallee(ancestors)) {
                const chainOptional = parent?.type === 'OptionalMemberExpression' && parentKey === 'object' && !parent.optional
                    ? (parent.computed ? 'bracket' : 'dot') : undefined;
                wraps.push({ start: node.start, end: node.end, chainOptional });
            }
        } else if (node.type === 'Identifier' && node.name === 'top' && !isNonReferenceIdentifier(parent, parentKey, node)) {
            replaces.push({ start: node.start, end: node.end, replacement: 'globalThis.__tipsyHostWindow', guard: 'top' });
            skipChildren = true;
        }

        if (skipChildren) return;
        for (const [prop, value] of Object.entries(node)) {
            if (['loc', 'comments', 'tokens', 'errors'].includes(prop)) continue;
            ancestors.push({ node, key: prop });
            if (Array.isArray(value)) value.forEach(item => visit(item, node, prop));
            else if (value && typeof value === 'object') visit(value, node, prop);
            ancestors.pop();
        }
    };
    visit(ast.program);

    const activeReplaces = replaces.filter(edit => !shadowed.has(edit.guard));
    // Apply point ops cleanly: replacements and nested __tipsySafeWindow(...) wraps.
    type Op = { pos: number; end: number; kind: 'replace' | 'open' | 'close'; text: string; spanStart: number; spanEnd: number };
    const ops: Op[] = [];
    for (const r of activeReplaces) {
        ops.push({ pos: r.start, end: r.end, kind: 'replace', text: r.replacement, spanStart: r.start, spanEnd: r.end });
    }
    for (const w of wraps) {
        const closeText = w.chainOptional === 'dot' ? ')?' : w.chainOptional === 'bracket' ? ')?.' : ')';
        ops.push({ pos: w.start, end: w.start, kind: 'open', text: 'globalThis.__tipsySafeWindow(', spanStart: w.start, spanEnd: w.end });
        ops.push({ pos: w.end, end: w.end, kind: 'close', text: closeText, spanStart: w.start, spanEnd: w.end });
    }
    // Sort right-to-left. At the same pos, process in reverse emission order:
    // we want final string at pos to be: `close` (inner first -> outer last), then `open` (outer first -> inner last), then `replace`.
    // When applying right-to-left, ops applied EARLIER end up to the RIGHT of ops applied LATER at the same pos.
    const kindRank = { close: 0, open: 1, replace: 2 };
    ops.sort((a, b) => {
        if (b.pos !== a.pos) return b.pos - a.pos;
        if (kindRank[b.kind] !== kindRank[a.kind]) return kindRank[b.kind] - kindRank[a.kind];
        if (a.kind === 'open') return a.spanEnd - b.spanEnd; // smaller span applied earlier -> ends up right (inner)
        if (a.kind === 'close') return a.spanStart - b.spanStart; // larger spanStart (inner) applied later -> ends up left (inner)
        return b.end - a.end;
    });
    for (const op of ops) {
        source = source.slice(0, op.pos) + op.text + source.slice(op.end);
    }
    return source;
}

const inlineScriptTag = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
const nonJsScriptType = /\btype\s*=\s*["']?(?!text\/javascript|application\/javascript|module\b)[^"'\s>]+/i;

export async function adaptAuthorHtml(html: string): Promise<string> {
    if (!/<script\b/i.test(html) || !needsAuthorWindowAdapt(html)) return html;
    const matches = [...html.matchAll(inlineScriptTag)];
    if (!matches.length) return html;
    let cursor = 0;
    const parts: string[] = [];
    for (const match of matches) {
        const index = match.index!;
        const [full, attrs, body] = match;
        parts.push(html.slice(cursor, index));
        cursor = index + full.length;
        if (/\bsrc\s*=/i.test(attrs) || nonJsScriptType.test(attrs) || !needsAuthorWindowAdapt(body)) {
            parts.push(full);
            continue;
        }
        const sourceType = /\btype\s*=\s*["']?module\b/i.test(attrs) ? 'module' : 'script';
        try {
            const adapted = await adaptAuthorWindow(body, sourceType);
            parts.push(`<script${attrs}>${adapted}</script>`);
        } catch {
            parts.push(full);
        }
    }
    parts.push(html.slice(cursor));
    return parts.join('');
}

/** Explain unsupported source only after a script fails; valid JS keeps its normal loading path. */
export async function explainAuthorScriptFailure(source: string, error: unknown): Promise<string> {
    const message = error instanceof Error ? error.message : String(error);
    if (!/SyntaxError|Unexpected|Missing initializer|Missing semicolon/i.test(message)) return message;
    const { parse } = await import('@babel/parser');
    try { parse(source, { sourceType: 'module' }); return message; } catch { /* check whether this was TypeScript source */ }
    try {
        const { program } = parse(source, { sourceType: 'module', plugins: ['typescript'] });
        const relativeImports = [...new Set(program.body.flatMap(node =>
            (node.type === 'ImportDeclaration' && node.importKind !== 'type' || node.type === 'ExportNamedDeclaration' && node.exportKind !== 'type' || node.type === 'ExportAllDeclaration' && node.exportKind !== 'type')
                && node.source && /^\.{1,2}\//.test(node.source.value) ? [node.source.value] : []))];
        return relativeImports.length
            ? `卡内嵌入了未编译的 TypeScript，并引用了本地模块 ${relativeImports.join('、')}。请导入作者已打包的角色卡。`
            : '卡内嵌入了未编译的 TypeScript。请导入作者已编译为 JavaScript 的角色卡。';
    } catch { return message; }
}

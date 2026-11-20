/** Adapt only executable static top-window accesses. Stored author source is unchanged. */
export async function adaptAuthorWindow(source: string): Promise<string> {
    if (!/\b(?:window|self|globalThis)\s*(?:(?:\?\.|\.)\s*top\b|(?:\?\.)?\s*\[\s*['"]top['"]\s*\])/.test(source)) return source;
    const { parse } = await import('@babel/parser');
    const ast = parse(source, { sourceType: 'unambiguous', allowAwaitOutsideFunction: true });
    const edits: Array<{ start: number; end: number; name: string }> = [];
    const shadowed = new Set<string>();
    const globals = new Set(['window', 'self', 'globalThis']);
    const binding = (node: any) => {
        if (!node) return;
        if (node.type === 'Identifier' && globals.has(node.name)) shadowed.add(node.name);
        else if (node.type === 'ObjectPattern') node.properties.forEach((prop: any) => binding(prop.value ?? prop.argument));
        else if (node.type === 'ArrayPattern') node.elements.forEach(binding);
        else if (node.type === 'AssignmentPattern') binding(node.left);
        else if (node.type === 'RestElement') binding(node.argument);
    };
    const visit = (node: any) => {
        if (!node || typeof node !== 'object') return;
        if (node.type === 'VariableDeclarator' || /^(?:Function|Class)(?:Declaration|Expression)$/.test(node.type)) binding(node.id);
        if (node.params) node.params.forEach(binding);
        if (node.type === 'CatchClause') binding(node.param);
        if (/^Import.*Specifier$/.test(node.type)) binding(node.local);
        if (['MemberExpression', 'OptionalMemberExpression'].includes(node.type) && node.object.type === 'Identifier'
            && globals.has(node.object.name) && (node.computed ? node.property.type === 'StringLiteral' && node.property.value === 'top' : node.property.name === 'top')) {
            edits.push({ start: node.start, end: node.end, name: node.object.name });
        }
        for (const [key, value] of Object.entries(node)) {
            if (['loc', 'comments', 'tokens', 'errors'].includes(key)) continue;
            if (Array.isArray(value)) value.forEach(visit);
            else if (value && typeof value === 'object') visit(value);
        }
    };
    visit(ast.program);
    for (const edit of edits.filter(edit => !shadowed.has(edit.name)).sort((a, b) => b.start - a.start)) {
        source = source.slice(0, edit.start) + `${edit.name}.__tipsyHostWindow` + source.slice(edit.end);
    }
    return source;
}

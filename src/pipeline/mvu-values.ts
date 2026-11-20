import JSON5 from 'json5';
import { parse as parseYaml } from 'yaml';

const forbiddenKeys = new Set(['__proto__', 'prototype', 'constructor']);
export function assertMvuKey(key: string): void {
    if (forbiddenKeys.has(key)) throw new Error(`MVU 不允许写入路径：${key}`);
}

/** Values cross persistence/worker boundaries as JSON, never as executable code. */
export function mvuJsonValue(value: any, ancestors = new Set<object>(), depth = 0): any {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
    if (!value || typeof value !== 'object') throw new Error('MVU 值必须能保存为 JSON，不能包含 undefined、非有限数字或函数');
    if (depth > 128 || ancestors.has(value)) throw new Error('MVU 值层级过深或包含循环引用');
    ancestors.add(value);
    try {
        if (Array.isArray(value)) return Array.from(value, child => mvuJsonValue(child, ancestors, depth + 1));
        const result: Record<string, any> = {};
        for (const [key, child] of Object.entries(value)) {
            assertMvuKey(key);
            result[key] = mvuJsonValue(child, ancestors, depth + 1);
        }
        return result;
    } finally { ancestors.delete(value); }
}

export function parseMvuStructuredValue(text: string): any {
    const content = text.trim().replace(/^```(?:json5?|ya?ml)?\s*/i, '').replace(/\s*```$/, '').trim();
    try { return JSON5.parse(content); }
    catch { return parseYaml(content, { maxAliasCount: 100 }); }
}

const numericFunctions = [
    'abs', 'acos', 'acosh', 'asin', 'asinh', 'atan', 'atan2', 'atanh', 'ceil', 'cos', 'cosh', 'cube', 'exp', 'expm1',
    'floor', 'gcd', 'hypot', 'lcm', 'log', 'log10', 'log1p', 'log2', 'max', 'mean', 'median', 'min', 'mod', 'nthRoot',
    'pow', 'prod', 'round', 'sign', 'sin', 'sinh', 'sqrt', 'square', 'std', 'sum', 'tan', 'tanh', 'variance',
];
let mathLoader: Promise<{ math: typeof import('mathjs'); evaluator: import('mathjs').MathJsInstance; scope: Record<string, unknown> }> | undefined;
function loadMath() {
    return mathLoader ??= import('mathjs').then(math => {
        const facade = (source: Record<string, any>, keys: string[]) => Object.freeze(Object.fromEntries(keys.map(key => [key,
            typeof source[key] === 'function' ? source[key].bind(source) : source[key]])));
        return { math, evaluator: math.create(math.all), scope: {
            Math: facade(Math, Object.getOwnPropertyNames(Math)),
            math: facade(math, [...numericFunctions, 'e', 'pi', 'tau']),
        } };
    });
}

/** Same data-first parsing order as MVU; mathjs handles expressions without JS eval. */
export async function parseMvuCommandValue(value: any, mathEnabled = true): Promise<any> {
    if (typeof value !== 'string') return value;
    const text = value.trim();
    if (text === 'undefined') return undefined;
    try { return JSON.parse(text); } catch { /* relaxed literal or expression */ }
    if ((text.startsWith('{') && text.endsWith('}')) || (text.startsWith('[') && text.endsWith(']'))) {
        try { return JSON5.parse(text); } catch { /* YAML can still supply the data */ }
    }
    if (text.startsWith("'") && text.endsWith("'")) {
        try { return parseYaml(text, { maxAliasCount: 100 }); } catch { /* a mathematical expression may follow */ }
    }
    if (mathEnabled && text.length <= 8192 && /[\d()+*/^]|\b(?:pi|e|tau)\b|\b(?:Math|math)\./.test(text)) {
        try {
            const { math, evaluator, scope } = await loadMath();
            const expression = evaluator.parse(text);
            const nodes = expression.filter(() => true);
            const accessorAllowed = (node: any) => {
                const property = node.index.dimensions[0];
                return math.isSymbolNode(node.object) && node.index.dimensions.length === 1 && math.isConstantNode(property)
                    && typeof property.value === 'string' && Object.hasOwn(scope, node.object.name)
                    && Object.hasOwn(scope[node.object.name] as object, property.value);
            };
            const allowedNodes = new Set(['ConstantNode', 'SymbolNode', 'OperatorNode', 'ParenthesisNode', 'FunctionNode', 'AccessorNode', 'IndexNode', 'ArrayNode', 'ConditionalNode', 'RelationalNode']);
            if (nodes.length > 512 || nodes.some(node => !allowedNodes.has(node.type)
                || math.isAccessorNode(node) && !accessorAllowed(node)
                || math.isSymbolNode(node) && ![...numericFunctions, 'pi', 'e', 'tau', 'Math', 'math', 'true', 'false'].includes(node.name)
                || math.isFunctionNode(node) && !(math.isSymbolNode(node.fn) && numericFunctions.includes(node.fn.name)
                    || math.isAccessorNode(node.fn) && accessorAllowed(node.fn)))) throw new Error('非只读数学表达式');
            const result = expression.compile().evaluate({ ...scope });
            if (typeof result === 'number' && Number.isFinite(result)) return Number(result.toPrecision(12));
            if (typeof result === 'boolean') return result;
            if (math.isComplex(result) || math.isMatrix(result)) return result.toString();
        } catch { /* Unrecognized text remains data, as in the upstream parser. */ }
    }
    try { return parseYaml(text, { maxAliasCount: 100 }); }
    catch { return text.replace(/^[\\"'` ]*(.*?)[\\"'` ]*$/, '$1'); }
}

export const slashOutput = (value: unknown): string => value == null ? '' : value instanceof SlashClosure ? `{:${value.source}:}` : typeof value === 'object' ? JSON.stringify(value) : String(value);
export const slashKey = (value: string): string => {
    if (!value || ['__proto__', 'constructor', 'prototype'].includes(value)) throw new Error('Slash 变量名无效');
    return value;
};

export class SlashScope {
    readonly values = new Map<string, unknown>();
    readonly macros = new Map<string, unknown>();
    pipe: unknown;
    constructor(readonly parent?: SlashScope) { this.pipe = parent?.pipe ?? ''; }
    owner(key: string): SlashScope | undefined { return this.values.has(key) ? this : this.parent?.owner(key); }
    get(key: string): unknown { const owner = this.owner(key); if (!owner) throw new Error(`Slash 局部变量不存在：${key}`); return owner.values.get(key); }
    declare(key: string, value: unknown): void {
        slashKey(key);
        if (this.values.has(key)) throw new Error(`Slash 局部变量重复声明：${key}`);
        this.values.set(key, value);
    }
    set(key: string, value: unknown): void {
        const owner = this.owner(key);
        if (!owner) throw new Error(`Slash 局部变量不存在：${key}`);
        owner.values.set(slashKey(key), value);
    }
    macro(key: string): unknown { return this.macros.has(key) ? this.macros.get(key) : this.parent?.macro(key); }
    get variableNames(): string[] { return [...this.values.keys()]; }
    get allVariableNames(): string[] { return [...new Set([...this.variableNames, ...(this.parent?.allVariableNames ?? [])])]; }
    existsVariable(key: string): boolean { return !!this.owner(key); }
    existsVariableInScope(key: string): boolean { return this.values.has(key); }
    letVariable(key: string, value?: unknown): void { this.declare(key, value); }
    getVariable(key: string, index?: string): unknown { return slashIndexed(this.get(key), index); }
    setVariable(key: string, value: unknown, index?: string, type?: string): unknown { this.set(key, index == null ? value : slashAssignIndex(this.get(key), index, value, type)); return value; }
    setMacro(key: string, value: unknown, overwrite = true): void { if (overwrite || this.macro(key) === undefined) this.macros.set(key, value); }
}

export class SlashClosure {
    source: string;
    scope: SlashScope;
    abortController?: import('./slash-control').SlashCommandAbortController;
    breakController?: import('./slash-control').SlashCommandBreakController;
    constructor(source: string | SlashScope = '', scope?: SlashScope) {
        this.source = typeof source === 'string' ? source : '';
        this.scope = scope ?? new SlashScope(typeof source === 'string' ? undefined : source);
    }
    get rawText(): string { return `{:${this.source}:}`; }
    execute?: () => Promise<{ pipe: unknown; stop?: string; isAborted?: boolean; isBreak?: boolean; isError?: boolean }>;
}

export function slashTruthy(value: unknown): boolean {
    if (/^(false|off|no|0)$/i.test(String(value))) return false;
    if (/^(true|on|yes|1)$/i.test(String(value))) return true;
    return !!value;
}

export function compareSlash(rule: string | undefined, a: unknown, b: unknown): boolean {
    if (a === undefined) throw new Error('Slash 条件缺少左操作数');
    if (b === undefined) {
        if (rule && rule !== 'not') throw new Error(`Slash 单值条件不支持规则：${rule}`);
        return rule === 'not' ? !slashTruthy(a) : slashTruthy(a);
    }
    rule ??= 'eq';
    if (typeof a === 'number' && typeof b === 'number') {
        if (rule === 'gt') return a > b;
        if (rule === 'gte') return a >= b;
        if (rule === 'lt') return a < b;
        if (rule === 'lte') return a <= b;
        if (rule === 'eq') return a === b;
        if (rule === 'neq') return a !== b;
    }
    const left = slashOutput(a).toLowerCase(), right = slashOutput(b).toLowerCase();
    if (rule === 'eq') return left === right;
    if (rule === 'neq') return left !== right;
    if (rule === 'in') return left.includes(right);
    if (rule === 'nin') return !left.includes(right);
    throw new Error(`Slash 条件规则不适用于当前值：${rule}`);
}

export function slashIndexed(value: unknown, index?: string): unknown {
    if (index === undefined) return value;
    const data = typeof value === 'string' ? JSON.parse(value || 'null') : value;
    return (data as any)?.[index];
}

export function slashAssignIndex(value: unknown, index: string, next: unknown, type?: string): string {
    slashKey(index);
    const data = (typeof value === 'string' ? JSON.parse(value || 'null') : structuredClone(value)) ?? (Number.isNaN(Number(index)) ? {} : []);
    if (typeof data !== 'object') throw new Error('Slash index 需要 JSON 对象或数组');
    if (type === 'number') next = Number(next);
    else if (type === 'boolean') next = slashTruthy(next);
    else if (type === 'string') next = slashOutput(next);
    else if (type === 'object' || type === 'array') next = typeof next === 'string' ? JSON.parse(next) : next;
    (data as any)[index] = next;
    return JSON.stringify(data);
}

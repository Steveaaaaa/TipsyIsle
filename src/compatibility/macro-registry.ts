export interface MacroLikeContext { message_id?: number; role?: 'user' | 'assistant' | 'system' }
type Replacement = (context: MacroLikeContext, substring: string, ...args: any[]) => string;
const macros = new Map<string, { regex: RegExp; replace: Replacement; owner?: object }>();
const named = new Map<string, { value: string | ((nonce: string) => string); owner?: object }>();
export function registerHostMacro(name: string, value: string | ((nonce: string) => string), owner?: object): void {
    if (!name || typeof value !== 'string' && typeof value !== 'function') throw new Error('注册宏需要名称以及字符串或函数');
    named.set(name.toLowerCase(), { value, owner });
}
export function unregisterHostMacro(name: string): void { named.delete(name.toLowerCase()); }

export function registerMacroLike(regex: RegExp, replace: Replacement, owner?: object): { unregister(): void } {
    if (typeof regex?.source !== 'string' || typeof replace !== 'function') throw new Error('助手宏需要正则和替换函数');
    if (!macros.has(regex.source)) macros.set(regex.source, { regex: new RegExp(regex.source, regex.flags), replace, owner });
    return { unregister: () => unregisterMacroLike(regex) };
}
export function unregisterMacroLike(regex: RegExp): void { macros.delete(regex.source); }
export function disposeMacroLikes(owner: object): void {
    for (const [key, entry] of macros) if (entry.owner === owner) macros.delete(key);
    for (const [key, entry] of named) if (entry.owner === owner) named.delete(key);
}
export function applyHostMacros(text: string): string {
    if (!named.size) return text;
    const nonce = crypto.randomUUID();
    return text.replace(/\{\{([^{}]+)\}\}/g, (match, name) => {
        const macro = named.get(name.toLowerCase()); if (!macro) return match;
        const value = typeof macro.value === 'function' ? macro.value(nonce) : macro.value;
        return value == null ? '' : String(value);
    });
}
export function applyMacroLikes(text: string, context: MacroLikeContext = {}): string {
    for (const { regex, replace } of macros.values()) { regex.lastIndex = 0; text = text.replace(regex, (...args: any[]) => replace(context, args[0], ...args.slice(1))); }
    return text;
}

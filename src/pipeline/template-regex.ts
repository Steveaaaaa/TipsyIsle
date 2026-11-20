import { applyRegexScripts, type ApplyRegexOptions } from './macro-regex-engine';
import type { RegexScriptRule } from '../types';

type Replacer = string | ((substring: string, ...args: any[]) => string);
export interface TemplateRegexOptions {
    uuid?: string; message?: boolean; generate?: boolean; basic?: boolean;
    user?: boolean; assistant?: boolean; system?: boolean; worldinfo?: boolean; reasoning?: boolean;
    minDepth?: number; maxDepth?: number; before?: boolean; after?: boolean; html?: boolean;
    order?: number; sticky?: number;
}
export interface TemplateRegexSelection extends TemplateRegexOptions { depth?: number; role?: 'system' | 'user' | 'assistant' }
interface Entry { id: string; search: string | RegExp; replace: Replacer; options: TemplateRegexOptions }

/** Executable replacements remain inside their author realm. Lifecycle state
 * must never be represented by stringifying/evaluating a function over RPC. */
export class TemplateRegexRegistry {
    private readonly basic = new Map<string, Entry>();
    private readonly generate = new Map<string, Entry>();
    private readonly message = new Map<string, Entry>();

    checkpoint(): { basic: Entry[]; generate: Entry[]; message: Entry[] } {
        const copy = (entries: Map<string, Entry>) => [...entries.values()].map(entry => ({ ...entry,
            search: entry.search instanceof RegExp ? new RegExp(entry.search.source, entry.search.flags) : entry.search,
            options: { ...entry.options } }));
        return { basic: copy(this.basic), generate: copy(this.generate), message: copy(this.message) };
    }
    restore(checkpoint: ReturnType<TemplateRegexRegistry['checkpoint']>): void {
        for (const kind of ['basic', 'generate', 'message'] as const) {
            this[kind].clear();
            for (const entry of checkpoint[kind]) this[kind].set(entry.id, { ...entry, options: { ...entry.options } });
        }
    }

    activate = (pattern: string | RegExp, replace: Replacer, options: TemplateRegexOptions = {}): void => {
        if (!(typeof pattern === 'string' || pattern instanceof RegExp) || !['string', 'function'].includes(typeof replace)) throw new Error('activateRegex 需要有效查找表达式和字符串或函数替换器');
        if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('activateRegex 选项必须为对象');
        for (const key of ['order', 'sticky', 'minDepth', 'maxDepth'] as const) if (options[key] !== undefined && !Number.isFinite(options[key])) throw new Error(`临时正则 ${key} 必须为有限数字`);
        for (const key of ['message', 'generate', 'basic', 'user', 'assistant', 'system', 'worldinfo', 'reasoning', 'before', 'after', 'html'] as const) if (options[key] !== undefined && typeof options[key] !== 'boolean') throw new Error(`临时正则 ${key} 必须为布尔值`);
        if (options.uuid !== undefined && typeof options.uuid !== 'string') throw new Error('临时正则 uuid 必须为字符串');
        const basic = options.basic || options.basic == null && options.generate == null && options.message == null;
        if (basic && typeof replace !== 'string') throw new Error('basic 临时正则只接受字符串替换器');
        const id = options.uuid || `auto:${String(pattern).length}:${pattern}@${replace}`;
        const base: TemplateRegexOptions = { user: true, assistant: true, system: true, worldinfo: false, order: 100, sticky: 0, ...options };
        const entry = (opts: TemplateRegexOptions): Entry => ({ id, search: pattern, replace, options: opts });
        if (basic) this.basic.set(id, entry({ ...base, reasoning: options.reasoning ?? true }));
        if (options.generate) this.generate.set(id, entry(base));
        if (options.message) this.message.set(id, entry({ ...base, reasoning: options.reasoning ?? false,
            before: options.before ?? (options.after ?? options.html) == null, after: options.after ?? false, html: options.html ?? false }));
    };

    deactivate(selector: Pick<TemplateRegexOptions, 'uuid' | 'basic' | 'message' | 'generate'>, count = 1): void {
        if (!Number.isFinite(count)) throw new Error('临时正则清理次数无效');
        if (selector.basic || selector.uuid) for (const id of this.basic.keys()) if (!selector.uuid || id === selector.uuid) this.basic.delete(id);
        for (const [kind, registry] of [['generate', this.generate], ['message', this.message]] as const) {
            if (!selector[kind] && !selector.uuid) continue;
            for (const [id, rule] of registry) if (!selector.uuid || id === selector.uuid) {
                rule.options.sticky = (rule.options.sticky ?? 0) - count;
                if (rule.options.sticky <= 0) registry.delete(id);
            }
        }
    }

    applyBasic(content: string, options: ApplyRegexOptions): string {
        const rules = [...this.basic.values()].map(({ id, search, replace, options: flags }): RegexScriptRule => ({
            id, scriptName: `\u200b${id}`, findRegex: search instanceof RegExp ? `/${search.source}/${search.flags}` : search,
            replaceString: replace as string, placement: [flags.user ? 'user_input' : undefined, flags.assistant ? 'ai_output' : undefined,
                flags.worldinfo ? 'world_info' : undefined, flags.reasoning ? 'reasoning' : undefined].filter(Boolean) as RegexScriptRule['placement'],
            disabled: false, promptOnly: true, markdownOnly: false, trimStrings: [],
            minDepth: flags.minDepth, maxDepth: flags.maxDepth,
        }));
        return applyRegexScripts(content, rules, options);
    }

    apply(context: Record<string, any>, content: string, selection: TemplateRegexSelection): string {
        for (const [kind, registry] of [['message', this.message], ['generate', this.generate]] as const) {
            if (!selection[kind] && !selection.uuid) continue;
            const entries = [...registry.values()].sort((a, b) => (a.options.order ?? 100) - (b.options.order ?? 100));
            for (const rule of entries) {
                if (selection.uuid && selection.uuid !== rule.id) continue;
                const flags = rule.options;
                if (!selection.uuid) {
                    if (kind === 'generate' && selection.role && flags[selection.role] === false) continue;
                    if (kind === 'message' && (['user', 'assistant', 'system'] as const).some(role => selection[role] && flags[role] === false)) continue;
                    if ((['worldinfo', ...(kind === 'message' ? ['reasoning', 'before', 'after', 'html'] : [])] as Array<keyof TemplateRegexOptions>).some(flag => selection[flag] && !flags[flag])) continue;
                    if (kind === 'message' && Number.isSafeInteger(selection.depth)
                        && (flags.minDepth !== undefined && flags.minDepth >= -1 && selection.depth! < flags.minDepth
                            || flags.maxDepth !== undefined && flags.maxDepth >= 0 && selection.depth! > flags.maxDepth)) continue;
                }
                const replacement = typeof rule.replace === 'function' && !selection.uuid ? rule.replace.bind(context) : rule.replace;
                // String searches keep String.replace's literal, first-match semantics.
                content = typeof replacement === 'string' ? content.replace(rule.search, replacement) : content.replace(rule.search, replacement);
            }
        }
        return content;
    }
}

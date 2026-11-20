/** Serializable state: executable author functions never cross the Worker boundary. */
export interface TemplatePromptInjection { key: string; uid: string; prompt: string; order: number; sticky: number }
export interface InjectionPostProcess { search: string | RegExp; replace: string }

export class TemplateInjections {
    private entries: TemplatePromptInjection[];
    forceOutlet = false;
    constructor(entries: TemplatePromptInjection[] = []) { this.entries = structuredClone(entries); }
    snapshot(): TemplatePromptInjection[] { return structuredClone(this.entries); }
    restore(entries: TemplatePromptInjection[]): void { this.entries = structuredClone(entries); }
    inject = (key: string, prompt: string, order = 100, sticky = 0, uid = ''): void => {
        if (typeof key !== 'string' || typeof prompt !== 'string' || typeof uid !== 'string' || !Number.isFinite(order) || !Number.isFinite(sticky)) throw new Error('injectPrompt 的键、正文、排序、持续次数或 UID 无效');
        const identity = uid || `auto:${key.length}:${key}${prompt}`;
        const found = this.entries.findIndex(entry => entry.key === key && entry.uid === identity);
        const next = { key, prompt, order, sticky, uid: identity };
        if (found >= 0) this.entries[found] = next;
        else {
            if (this.entries.length >= 16384) throw new Error('模板提示注入超过 16384 项');
            this.entries.push(next);
        }
    };
    get = (key: string, postprocess: InjectionPostProcess[] = [], outlet = this.forceOutlet): string => {
        if (typeof key !== 'string' || !Array.isArray(postprocess)) throw new Error('getPromptsInjected 参数无效');
        if (outlet && !postprocess.length) return `{{outletPromptsInjected:${key}}}`;
        let result = this.entries.filter(entry => entry.key === key).sort((a, b) => a.order - b.order).map(entry => entry.prompt).join('\n');
        for (const process of postprocess) {
            if (!process || !(typeof process.search === 'string' || process.search instanceof RegExp) || typeof process.replace !== 'string') throw new Error('模板注入后处理需要 search 和 replace');
            result = result.replace(process.search, process.replace);
        }
        return result;
    };
    has = (key: string): boolean => this.entries.some(entry => entry.key === key);
    outlets(text: string, worldOutlets: Map<string, string>, recursion: number): string {
        let result = text;
        const seen = new Set<string>();
        for (let step = 0; step < recursion; step++) {
            if (seen.has(result)) break;
            seen.add(result);
            const next = result.replace(/\{\{outletPromptsInjected:([^}]+)\}\}/g, (_all, key: string) => this.get(key, [], false))
                .replace(/\{\{outlet::([^}]+)\}\}/gi, (_all, key: string) => worldOutlets.get(key.trim()) ?? '');
            if (next === result) break;
            result = next;
            if (result.length > 16 * 1024 * 1024) throw new Error('模板具名出口展开超过大小限制');
        }
        return result;
    }
    advance(): void { this.entries = this.entries.map(entry => ({ ...entry, sticky: entry.sticky - 1 })).filter(entry => entry.sticky >= 0); }
}

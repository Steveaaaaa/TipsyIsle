import { parseWorldInfoDecorators } from './worldinfo-decorators';

/** The template plugin's public query API consumes legacy ST entries, not Helper entries. */
export interface TemplateWorldInfo extends Record<string, any> {
    uid: number; world?: string; content: string; comment: string; key: string[]; keysecondary: string[];
    position: number; depth: number; order: number; constant: boolean; disable: boolean; vectorized: boolean;
}
export interface WorldInfoQueryCondition { constant?: boolean; disabled?: boolean; vectorized?: boolean; force?: boolean }

export function sortTemplateWorldInfo<T>(entries: T[], metadata: (entry: T) => Pick<TemplateWorldInfo, 'position' | 'depth' | 'order' | 'uid'> = entry => entry as T & TemplateWorldInfo): T[] {
    const rows = entries.map(entry => ({ entry, ...metadata(entry) }));
    const top = Math.max(0, ...rows.map(entry => entry.position === 4 ? entry.depth ?? 4 : 0));
    const offsets: Record<number, number> = { 0: 4, 1: 3, 5: 2, 6: 1, 2: 1, 3: -1 };
    const depth = (entry: typeof rows[number]) => offsets[entry.position] === undefined ? entry.depth ?? 4 : top + offsets[entry.position];
    return rows.sort((a, b) => depth(b) - depth(a) || a.order - b.order || b.uid - a.uid).map(row => row.entry);
}

function matches(text: string, key: string, entry: TemplateWorldInfo): boolean {
    if (!key) return false;
    const literal = /^\/([\s\S]*)\/([dgimsuvy]*)$/.exec(key);
    if (literal) { try { return new RegExp(literal[1], literal[2]).test(text); } catch { return false; } }
    const haystack = entry.caseSensitive ? text : text.toLowerCase();
    const needle = entry.caseSensitive ? key : key.toLowerCase();
    if (entry.matchWholeWords && needle.split(/\s+/).length === 1) {
        return new RegExp(`(?:^|\\W)(${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})(?:$|\\W)`).test(haystack);
    }
    return haystack.includes(needle);
}

/** Pure selection: no timers, recursive scan or persistent activation side effects. */
export function queryTemplateWorldInfo<T extends TemplateWorldInfo>(entries: T[], keywords: string | string[], condition: WorldInfoQueryCondition = {}, substitute: (text: string) => string = text => text,
    defaults: { caseSensitive?: boolean; matchWholeWords?: boolean; useGroupScoring?: boolean } = {}): T[] {
    if (!Array.isArray(entries) || entries.length > 16384) throw new Error('世界书查询 entries 必须为条目数组且不超过 16384 项');
    if (!(typeof keywords === 'string' || Array.isArray(keywords) && keywords.every(text => typeof text === 'string'))) throw new Error('世界书查询 keywords 必须为字符串或字符串数组');
    if (!condition || typeof condition !== 'object' || Object.entries(condition).some(([key, value]) => !['constant', 'disabled', 'vectorized', 'force'].includes(key) || value !== undefined && typeof value !== 'boolean')) throw new Error('世界书查询 condition 无效');
    const trigger = Array.isArray(keywords) ? keywords.join('\n\n') : keywords;
    const roll = (key: string) => {
        let hash = 2166136261;
        const seed = `${trigger}\n${key}`;
        for (let index = 0; index < seed.length; index++) hash = Math.imul(hash ^ seed.charCodeAt(index), 16777619);
        hash ^= hash >>> 16; hash = Math.imul(hash, 0x85ebca6b); hash ^= hash >>> 13;
        return (hash >>> 0) / 4294967296;
    };
    const scores = new Map<T, number>();
    const selected = entries.filter(entry => {
        if (!entry || typeof entry.content !== 'string' || !Array.isArray(entry.key) || !Array.isArray(entry.keysecondary)) throw new Error('世界书查询需要原酒馆条目结构，请使用 getWorldInfoData/getEnabledWorldInfoEntries 获取');
        for (const [key, actual] of [['constant', entry.constant], ['disabled', entry.disable], ['vectorized', entry.vectorized]] as const) if (condition[key] !== undefined && actual !== condition[key]) return false;
        if (entry.useProbability && roll(`probability:${entry.world}:${entry.uid}`) * 100 >= (entry.probability ?? 100)) return false;
        const decorators: string[] = entry.decorators ?? parseWorldInfoDecorators(entry.content).decorators.map(item => item.source);
        const effective = { ...entry, caseSensitive: entry.caseSensitive ?? defaults.caseSensitive, matchWholeWords: entry.matchWholeWords ?? defaults.matchWholeWords };
        const primary = entry.key.filter(key => matches(trigger, substitute(String(key)), effective)).length;
        const secondary = entry.keysecondary.filter(key => matches(trigger, substitute(String(key)).trim(), effective)).length;
        scores.set(entry, entry.key.length ? primary + (([0, 3].includes(entry.selectiveLogic)) && (entry.selectiveLogic !== 3 || secondary === entry.keysecondary.length) ? secondary : 0) : 0);
        // Ordering follows the upstream query tool, including constant entries before decorator filters.
        if (entry.constant || decorators.includes('@@activate')) return true;
        if (decorators.includes('@@dont_activate') || decorators.includes('@@only_preload') || !primary) return false;
        if (!entry.selective || !entry.keysecondary.length) return true;
        switch (entry.selectiveLogic ?? 0) {
            case 0: return secondary > 0;
            case 1: return secondary < entry.keysecondary.length;
            case 2: return secondary === 0;
            case 3: return secondary === entry.keysecondary.length;
            default: return false;
        }
    });
    const groups = new Map<string, T[]>(); const winners: T[] = [];
    for (const entry of selected) {
        if (!entry.group) winners.push(entry);
        else { const group = groups.get(entry.group) ?? []; group.push(entry); groups.set(entry.group, group); }
    }
    for (const [name, group] of groups) {
        if (group.length === 1) { winners.push(group[0]); continue; }
        if (group.some(entry => entry.groupOverride)) { winners.push(group.reduce((a, b) => a.order <= b.order ? a : b)); continue; }
        if (group.some(entry => entry.useGroupScoring ?? defaults.useGroupScoring) && Math.max(...group.map(entry => scores.get(entry) ?? 0)) > 0) {
            winners.push(group.reduce((a, b) => (scores.get(a) ?? 0) >= (scores.get(b) ?? 0) ? a : b)); continue;
        }
        const weights = group.map(entry => typeof entry.groupWeight === 'number' && Number.isFinite(entry.groupWeight) ? Math.max(0, entry.groupWeight) : 100);
        let remaining = roll(`group:${name}`) * weights.reduce((total, value) => total + value, 0);
        if (weights.every(weight => weight === 0)) continue;
        const index = weights.findIndex(weight => { remaining -= weight; return weight > 0 && remaining <= 0; });
        winners.push(group[index < 0 ? group.length - 1 : index]);
    }
    return sortTemplateWorldInfo(winners);
}

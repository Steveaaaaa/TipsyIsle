import type { RegexScriptRule } from '../types';
import { normalizeRegexScripts } from '../pipeline/normalizer';

export const regexSources = ['user_input', 'ai_output', 'slash_command', 'world_info', 'reasoning'] as const;
export function toTavernRegex(rule: RegexScriptRule) {
    return { id: rule.id, script_name: rule.scriptName, enabled: !rule.disabled,
        find_regex: rule.findRegex, replace_string: rule.replaceString, trim_strings: [...(rule.trimStrings ?? [])],
        source: Object.fromEntries(regexSources.map(source => [source, rule.placement.includes(source)])),
        destination: { display: !!rule.markdownOnly, prompt: !!rule.promptOnly }, run_on_edit: !!rule.runOnEdit,
        min_depth: rule.minDepth ?? null, max_depth: rule.maxDepth ?? null };
}
export function fromTavernRegexes(values: any[], previous: RegexScriptRule[] = []): RegexScriptRule[] {
    if (!Array.isArray(values)) throw new Error('正则列表必须为数组');
    const old = new Map(previous.map(rule => [rule.id, rule]));
    return normalizeRegexScripts(values.map(value => {
        if (!value || typeof value.find_regex !== 'string' || typeof value.replace_string !== 'string') throw new Error('正则需要 find_regex 和 replace_string 字符串');
        const prior = old.get(value.id);
        return { ...prior?.rawData, id: value.id || crypto.randomUUID(), scriptName: value.script_name || `未命名-${value.id ?? ''}`,
            findRegex: value.find_regex, replaceString: value.replace_string, disabled: value.enabled === false,
            trimStrings: value.trim_strings ?? [], placement: regexSources.filter(source => value.source?.[source]),
            markdownOnly: !!value.destination?.display, promptOnly: !!value.destination?.prompt, runOnEdit: !!value.run_on_edit,
            minDepth: value.min_depth ?? null, maxDepth: value.max_depth ?? null, substituteRegex: prior?.substituteRegex ?? 0 };
    }));
}

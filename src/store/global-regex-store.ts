import { scopedVariableStore } from './scoped-variable-store';
import { normalizeRegexScripts } from '../pipeline/normalizer';
import type { RegexScriptRule } from '../types';

const emptyRules: RegexScriptRule[] = [];
export function workspaceGlobalRegexes(): RegexScriptRule[] {
    return (scopedVariableStore.getState().extension.tipsy_regex?.rules as RegexScriptRule[] | undefined) ?? emptyRules;
}
let previousRules = emptyRules;
let previousExtensionRules: unknown;
let combined = emptyRules;
export function globalRegexes(): RegexScriptRule[] {
    const rules = workspaceGlobalRegexes();
    const extra = (scopedVariableStore.getState().extension.tipsy_host_settings?.values as Record<string, unknown> | undefined)?.regex;
    if (!Array.isArray(extra) || !extra.length) return rules;
    if (rules !== previousRules || extra !== previousExtensionRules) {
        previousRules = rules; previousExtensionRules = extra;
        combined = [...rules, ...normalizeRegexScripts(extra)];
    }
    return combined;
}

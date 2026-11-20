import _ from 'lodash';
import { stringify } from 'yaml';
export type MacroVariableScopes = Partial<Record<'global' | 'chat' | 'message' | 'character' | 'preset', Record<string, unknown>>>;
function withoutMetadata(value: any): any {
    if (Array.isArray(value)) return value.map(withoutMetadata);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => !key.startsWith('$')).map(([key, item]) => [key, withoutMetadata(item)]));
    return value;
}
/** Helper's variable macros strip MVU metadata and preserve YAML indentation. */
export function applyVariableMacros(text: string, scopes: MacroVariableScopes): string {
    if (!/_variable(?:_quoted)?::/i.test(text)) return text;
    const read = (scope: string, path: string) => withoutMetadata(_.get(scopes[scope as keyof MacroVariableScopes] ?? {}, _.unescape(path), null));
    text = text.replace(/\{\{get_(message|chat|character|preset|global)_variable::(.*?)\}\}/gi, (_match, scope, path) => {
        const value = read(scope.toLowerCase(), path); return typeof value === 'string' ? value : JSON.stringify(value);
    });
    let output = '', cursor = 0;
    for (const match of text.matchAll(/\{\{format_(message|chat|character|preset|global)_variable(_quoted)?::(.*?)\}\}/gi)) {
        output += text.slice(cursor, match.index);
        const value = read(match[1].toLowerCase(), match[3]);
        const formatted = typeof value === 'string' ? value : stringify(value, { blockQuote: 'literal', ...(match[2] ? { defaultKeyType: 'PLAIN' as const, defaultStringType: 'QUOTE_DOUBLE' as const } : {}) }).trimEnd();
        const indent = output.length - output.lastIndexOf('\n') - 1;
        output += formatted.replaceAll('\n', '\n' + ' '.repeat(indent));
        cursor = match.index! + match[0].length;
    }
    return output + text.slice(cursor);
}

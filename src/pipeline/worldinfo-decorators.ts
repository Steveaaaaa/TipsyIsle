import type { LorebookEntry } from '../types';

const known = new Set(['activate', 'dont_activate', 'message_formatting', 'generate_before', 'generate_after', 'render_before', 'render_after',
    'dont_preload', 'initial_variables', 'always_enabled', 'only_preload', 'preload', 'iframe', 'preprocessing', 'if', 'private']);

/** Match the pinned template plugin's leading-line and @@@ fallback escape rules. */
export function parseWorldInfoDecorators(content: string) {
    const decorators: Array<{ name: string; argument: string; source: string }> = [];
    let offset = 0;
    let fallback = false;
    while (content.startsWith('@@', offset)) {
        const end = content.indexOf('\n', offset);
        const line = content.slice(offset, end < 0 ? content.length : end).replace(/\r$/, '');
        const escaped = line.startsWith('@@@');
        if (escaped && !fallback) break;
        const source = escaped ? line.slice(1) : line;
        const space = source.indexOf(' ');
        const name = (space < 0 ? source : source.slice(0, space)).slice(2);
        if (known.has(name)) { decorators.push({ name, argument: space < 0 ? '' : source.slice(space + 1), source }); fallback = false; }
        else fallback = true;
        offset = end < 0 ? content.length : end + 1;
    }
    return { decorators, content: content.slice(offset), has: (name: string) => decorators.some(item => item.name === name) };
}
export function isInitialWorldInfo(entry: LorebookEntry): boolean {
    return entry.comment.includes('[InitialVariables]') || parseWorldInfoDecorators(entry.content).has('initial_variables');
}
export function isSpecialWorldInfo(entry: LorebookEntry): boolean {
    const parsed = parseWorldInfoDecorators(entry.content);
    return isInitialWorldInfo(entry) || parsed.has('only_preload') || entry.comment.includes('@INJECT') || /\[(?:GENERATE|RENDER):/.test(entry.comment) ||
        ['generate_before', 'generate_after', 'render_before', 'render_after'].some(parsed.has);
}

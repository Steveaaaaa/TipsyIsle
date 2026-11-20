import { fromHelperWorldbookEntries, toHelperWorldbookEntry } from './worldbook-codec';
import type { NormalizedLorebook } from '../types';

const positions = ['before_character_definition', 'after_character_definition', 'before_example_messages', 'after_example_messages',
    'before_author_note', 'after_author_note', 'at_depth_as_system', 'at_depth_as_user', 'at_depth_as_assistant'];
const mapped = { case_sensitive: 'caseSensitive', match_whole_words: 'matchWholeWords', use_group_scoring: 'useGroupScoring' } as const;
export function toLegacyWorldbook(book: NormalizedLorebook): Array<Record<string, any>> {
    return book.entries.map((entry, index) => {
        const value = toHelperWorldbookEntry(entry);
        const keys = value.strategy.keys.map(String), filters = value.strategy.keys_secondary.keys.map(String);
        return {
            uid: value.uid, display_index: entry.rawData?.displayIndex ?? index, comment: value.name, enabled: value.enabled,
            type: value.strategy.type, position: value.position.type === 'at_depth' || value.position.type === 'outlet' ? `at_depth_as_${value.position.role}` : value.position.type,
            depth: value.position.type === 'at_depth' ? value.position.depth : null, order: value.position.order, probability: value.probability,
            key: keys, keys, logic: value.strategy.keys_secondary.logic, filter: filters, filters, scan_depth: value.strategy.scan_depth,
            case_sensitive: value.caseSensitive ?? 'same_as_global', match_whole_words: value.matchWholeWords ?? 'same_as_global', use_group_scoring: value.useGroupScoring ?? 'same_as_global',
            automation_id: value.automationId || null, exclude_recursion: value.recursion.prevent_incoming, prevent_recursion: value.recursion.prevent_outgoing,
            delay_until_recursion: value.recursion.delay_until ?? 0, content: value.content, group: value.group ?? '', group_prioritized: value.groupOverride ?? false,
            group_weight: value.groupWeight ?? 100, sticky: value.effect.sticky, cooldown: value.effect.cooldown, delay: value.effect.delay,
        };
    });
}

export function fromLegacyWorldbookEntries(book: NormalizedLorebook, entries: Array<Record<string, any>>): NormalizedLorebook {
    if (!Array.isArray(entries) || entries.some(value => !value || typeof value !== 'object' || Array.isArray(value))) throw new Error('旧版世界书条目必须是对象数组');
    let display = Math.max(-1, ...entries.map(value => value.display_index ?? -1));
    const displayIndices = entries.map(value => value.display_index ?? ++display);
    if (displayIndices.some(value => !Number.isSafeInteger(value) || value < 0)) throw new Error('display_index 必须是非负整数');
    const values = entries.map(value => {
        const position = value.position ?? 'before_character_definition';
        if (!positions.includes(position)) throw new Error(`未知旧版世界书位置：${position}`);
        const previous = book.entries.find(entry => Number(entry.uid) === value.uid);
        const baseline = previous ? toHelperWorldbookEntry(previous) : undefined;
        const flags = Object.fromEntries(Object.entries(mapped).map(([legacy, current]) => [current,
            value[legacy] === undefined || value[legacy] === 'same_as_global' ? null : value[legacy]]));
        return {
            // Keep vendor fields not represented in the older contract.
            ...baseline, ...flags,
            uid: value.uid, name: value.comment ?? '', enabled: value.enabled ?? true, content: value.content ?? '',
            strategy: { type: value.type ?? 'selective', keys: value.keys ?? value.key ?? [], keys_secondary: { logic: value.logic ?? 'and_any', keys: value.filters ?? value.filter ?? [] }, scan_depth: value.scan_depth ?? 'same_as_global' },
            position: { type: position.startsWith('at_depth_as_') ? 'at_depth' : position, role: position.startsWith('at_depth_as_') ? position.slice(12) : 'system', depth: value.depth ?? 4, order: value.order ?? 100 },
            probability: value.probability ?? 100,
            recursion: { prevent_incoming: value.exclude_recursion ?? false, prevent_outgoing: value.prevent_recursion ?? false,
                delay_until: value.delay_until_recursion === true ? 1 : value.delay_until_recursion === false ? null : value.delay_until_recursion ?? null },
            effect: { sticky: value.sticky ?? null, cooldown: value.cooldown ?? null, delay: value.delay ?? null },
            automationId: value.automation_id ?? '', group: value.group ?? '', groupOverride: value.group_prioritized ?? false, groupWeight: value.group_weight ?? 100,
        };
    });
    const updated = fromHelperWorldbookEntries(book, values);
    return { ...updated, entries: updated.entries.map((entry, index) => ({ ...entry, rawData: { ...entry.rawData, displayIndex: displayIndices[index] } })) };
}

export function filterLegacyEntries(entries: Array<Record<string, any>>, filter: unknown): Array<Record<string, any>> {
    if (filter === undefined || filter === 'none') return entries;
    if (!filter || typeof filter !== 'object' || Array.isArray(filter)) throw new Error('旧版世界书 filter 必须是对象或 none');
    return entries.filter(entry => Object.entries(filter).every(([key, expected]) => {
        const value = entry[key];
        if (Array.isArray(value)) return Array.isArray(expected) && expected.every(item => value.includes(item));
        if (typeof value === 'string') return value.includes(String(expected));
        return value === expected;
    }));
}

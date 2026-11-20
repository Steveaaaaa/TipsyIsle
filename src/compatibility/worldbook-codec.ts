import _ from 'lodash';
import { normalizeLorebook } from '../pipeline/normalizer';
import { serializeLorebook } from '../pipeline/asset-serializer';
import type { LorebookEntry, NormalizedLorebook } from '../types';

export interface HelperWorldbookEntry {
    uid: number; name: string; enabled: boolean; content: string;
    strategy: { type: 'constant' | 'selective' | 'vectorized'; keys: Array<string | RegExp>;
        keys_secondary: { logic: 'and_any' | 'and_all' | 'not_all' | 'not_any'; keys: Array<string | RegExp> }; scan_depth: number | 'same_as_global' };
    position: { type: string; role: 'system' | 'user' | 'assistant'; depth: number; order: number };
    probability: number;
    recursion: { prevent_incoming: boolean; prevent_outgoing: boolean; delay_until: number | null };
    effect: { sticky: number | null; cooldown: number | null; delay: number | null };
    extra?: Record<string, unknown>;
    [key: string]: any;
}
const positions: Record<string, LorebookEntry['position']> = { before_character_definition: 'before_char', after_character_definition: 'after_char',
    before_example_messages: 'before_example', after_example_messages: 'after_example', before_author_note: 'before_an', after_author_note: 'after_an', at_depth: 'at_depth', outlet: 'outlet' };
const implicit = ['addMemo', 'matchPersonaDescription', 'matchCharacterDescription', 'matchCharacterPersonality', 'matchCharacterDepthPrompt', 'matchScenario',
    'matchCreatorNotes', 'group', 'groupOverride', 'groupWeight', 'caseSensitive', 'matchWholeWords', 'useGroupScoring', 'automationId', 'ignoreBudget', 'outletName', 'triggers', 'characterFilter'];
const implicitAliases: Record<string, string> = { group: 'group', groupOverride: 'group_override', groupWeight: 'group_weight', caseSensitive: 'case_sensitive',
    matchWholeWords: 'match_whole_words', useGroupScoring: 'use_group_scoring', automationId: 'automation_id', ignoreBudget: 'ignore_budget', outletName: 'outlet_name',
    matchPersonaDescription: 'match_persona_description', matchCharacterDescription: 'match_character_description', matchCharacterPersonality: 'match_character_personality',
    matchCharacterDepthPrompt: 'match_character_depth_prompt', matchScenario: 'match_scenario', matchCreatorNotes: 'match_creator_notes' };
const implicitDefaults: Record<string, unknown> = { addMemo: true, matchPersonaDescription: false, matchCharacterDescription: false,
    matchCharacterPersonality: false, matchCharacterDepthPrompt: false, matchScenario: false, matchCreatorNotes: false,
    group: '', groupOverride: false, groupWeight: 100, caseSensitive: null, matchWholeWords: null, useGroupScoring: null,
    automationId: '', ignoreBudget: false, outletName: '', triggers: [], characterFilter: { isExclude: false, names: [], tags: [] } };
const keyword = (text: string): string | RegExp => {
    const match = /^\/([\s\S]*)\/([dgimsuvy]*)$/.exec(text);
    if (match) { try { return new RegExp(match[1], match[2]); } catch { /* preserve invalid authored regex as text */ } }
    return text;
};
const positiveOrNull = (value: number | undefined) => value && value > 0 ? value : null;
/** Original host field names used by world-info events and STscript commands. */
export function toNativeWorldbookEntry(entry: LorebookEntry): Record<string, any> {
    const { rawData, ...normalized } = entry;
    const nullable = Object.fromEntries(['caseSensitive', 'matchWholeWords', 'useGroupScoring'].map(key => [key,
        rawData && Object.hasOwn(rawData, key) ? rawData[key] : (rawData?.extensions as Record<string, unknown> | undefined)?.[implicitAliases[key]] ?? null]));
    return structuredClone({ ...rawData, ...normalized, ...nullable, uid: Number(entry.uid), key: entry.keys, keysecondary: entry.secondaryKeys,
        disable: !!entry.disabled, scanDepth: entry.scanDepth ?? null,
        position: ({ before_char: 0, after_char: 1, before_an: 2, an_top: 2, after_an: 3, an_bottom: 3, at_depth: 4, before_example: 5, after_example: 6, outlet: 7 })[entry.position],
        role: ({ system: 0, user: 1, assistant: 2 })[entry.role ?? 'system'],
        selectiveLogic: ({ AND_ANY: 0, NOT_ALL: 1, NOT_ANY: 2, AND_ALL: 3 })[entry.selectiveLogic] });
}
function object(value: any, label: string): asserts value is Record<string, any> {
    if (!_.isPlainObject(value)) throw new Error(`${label} 必须是对象`);
}
export function toHelperWorldbookEntry(entry: LorebookEntry): HelperWorldbookEntry {
    const raw = entry.rawData ?? {};
    const ext = raw.extensions as Record<string, unknown> | undefined;
    const result: HelperWorldbookEntry = {
        uid: Number(entry.uid), name: entry.comment, enabled: !entry.disabled, content: entry.content,
        strategy: { type: entry.constant ? 'constant' : entry.vectorized ? 'vectorized' : 'selective', keys: entry.keys.map(keyword),
            keys_secondary: { logic: String(entry.selectiveLogic).toLowerCase() as any, keys: entry.secondaryKeys.map(keyword) }, scan_depth: entry.scanDepth ?? 'same_as_global' },
        position: { type: Object.keys(positions).find(key => positions[key] === entry.position) ?? (entry.position === 'an_top' ? 'before_author_note' : 'after_author_note'),
            role: entry.role ?? 'system', depth: entry.depth, order: entry.order }, probability: entry.useProbability === false ? 100 : entry.probability ?? 100,
        recursion: { prevent_incoming: entry.excludeRecursion ?? false, prevent_outgoing: entry.preventRecursion ?? false, delay_until: positiveOrNull(entry.delayUntilRecursion) },
        effect: { sticky: positiveOrNull(entry.sticky), cooldown: positiveOrNull(entry.cooldown), delay: positiveOrNull(entry.delay) },
    };
    if (!Number.isSafeInteger(result.uid) || result.uid < 0) throw new Error(`世界书条目 UID 不是非负整数：${entry.uid}`);
    if (raw.extra !== undefined) result.extra = structuredClone(raw.extra) as Record<string, unknown>;
    for (const key of implicit) {
        const value = Object.prototype.hasOwnProperty.call(raw, key) ? raw[key] : ext?.[implicitAliases[key] ?? key];
        if (value !== undefined) result[key] = structuredClone(value);
    }
    return result;
}
/** Helper exposes editor order, independent of numeric object-key enumeration. */
export function toHelperWorldbook(book: NormalizedLorebook): HelperWorldbookEntry[] {
    return _.sortBy(book.entries, entry => entry.rawData?.displayIndex).map(toHelperWorldbookEntry);
}

/** Overlay known edits onto each original entry; vendor fields survive helper updates. */
export function fromHelperWorldbookEntries(book: NormalizedLorebook, values: unknown[]): NormalizedLorebook {
    if (!Array.isArray(values)) throw new Error('世界书条目必须是数组');
    const used = new Set<number>();
    const previousEntries = new Map(book.entries.map(entry => [Number(entry.uid), entry]));
    const previousOrder = _.sortBy(book.entries, entry => entry.rawData?.displayIndex);
    const reserved = new Set(values.filter((v: any) => Number.isSafeInteger(v?.uid) && v.uid >= 0).map((v: any) => v.uid));
    let nextUid = 0;
    const entries = values.map((value, index) => {
        object(value, '世界书条目');
        for (const key of Object.keys(value)) if (!['uid', 'name', 'enabled', 'content', 'strategy', 'position', 'probability', 'recursion', 'effect', 'extra', ...implicit].includes(key)) throw new Error(`世界书条目字段尚未接通：${key}`);
        let uid = value.uid;
        if (uid !== undefined && (!Number.isSafeInteger(uid) || uid < 0)) throw new Error('世界书 UID 必须是非负整数');
        if (uid === undefined || used.has(uid)) { while (used.has(nextUid) || reserved.has(nextUid)) nextUid++; uid = nextUid++; }
        used.add(uid);
        const previous = value.uid === uid ? previousEntries.get(uid) : undefined;
        const baseline = previous ? toHelperWorldbookEntry(previous) : undefined;
        if (previous && previousOrder[index] === previous && _.isEqual(value, baseline)) return previous;
        const data = _.mergeWith({ ...structuredClone(implicitDefaults), name: '', enabled: true, content: '', strategy: { type: 'constant', keys: [], keys_secondary: { logic: 'and_any', keys: [] }, scan_depth: 'same_as_global' },
            position: { type: 'at_depth', role: 'system', depth: 4, order: 100 }, probability: 100, recursion: { prevent_incoming: false, prevent_outgoing: false, delay_until: null },
            effect: { sticky: null, cooldown: null, delay: null } }, value, (_a: unknown, b: unknown) => Array.isArray(b) ? b : undefined) as HelperWorldbookEntry;
        for (const key of ['strategy', 'position', 'recursion', 'effect']) object(data[key], key);
        object(data.strategy.keys_secondary, 'keys_secondary');
        for (const [obj, allowed] of [[data.strategy, ['type', 'keys', 'keys_secondary', 'scan_depth']], [data.strategy.keys_secondary, ['logic', 'keys']],
            [data.position, ['type', 'role', 'depth', 'order']], [data.recursion, ['prevent_incoming', 'prevent_outgoing', 'delay_until']], [data.effect, ['sticky', 'cooldown', 'delay']]] as const) {
            for (const key of Object.keys(obj)) if (!(allowed as readonly string[]).includes(key)) throw new Error(`未知世界书嵌套字段：${key}`);
        }
        if (typeof data.name !== 'string' || typeof data.content !== 'string' || typeof data.enabled !== 'boolean') throw new Error('世界书 name/content 必须是字符串，enabled 必须是布尔值');
        if (!['constant', 'selective', 'vectorized'].includes(data.strategy.type) || !['and_any', 'and_all', 'not_any', 'not_all'].includes(data.strategy.keys_secondary.logic)) throw new Error('未知世界书激活策略');
        if (!positions[data.position.type] || !['system', 'user', 'assistant'].includes(data.position.role)) throw new Error('未知世界书插入位置或角色');
        for (const list of [data.strategy.keys, data.strategy.keys_secondary.keys]) if (!Array.isArray(list) || list.some(v => typeof v !== 'string' && !_.isRegExp(v))) throw new Error('世界书关键字必须是字符串或 RegExp 数组');
        for (const amount of [data.position.depth, ...(data.strategy.scan_depth === 'same_as_global' ? [] : [data.strategy.scan_depth])]) if (!Number.isSafeInteger(amount) || Number(amount) < 0) throw new Error('世界书深度必须是非负整数');
        for (const amount of [...Object.values(data.effect), data.recursion.delay_until]) if (amount !== null && (!Number.isSafeInteger(amount) || Number(amount) < 0)) throw new Error('递归和计时参数必须是非负整数或 null');
        if (typeof data.position.order !== 'number' || !Number.isFinite(data.position.order) || typeof data.probability !== 'number' || !Number.isFinite(data.probability) || data.probability < 0 || data.probability > 100) throw new Error('世界书排序或概率参数无效');
        if (typeof data.recursion.prevent_incoming !== 'boolean' || typeof data.recursion.prevent_outgoing !== 'boolean') throw new Error('世界书递归开关必须是布尔值');
        for (const key of ['addMemo', 'matchPersonaDescription', 'matchCharacterDescription', 'matchCharacterPersonality', 'matchCharacterDepthPrompt', 'matchScenario', 'matchCreatorNotes', 'groupOverride', 'ignoreBudget']) {
            if (typeof data[key] !== 'boolean') throw new Error(`世界书 ${key} 必须是布尔值`);
        }
        for (const key of ['caseSensitive', 'matchWholeWords', 'useGroupScoring']) if (data[key] !== null && typeof data[key] !== 'boolean') throw new Error(`世界书 ${key} 必须是布尔值或 null`);
        for (const key of ['group', 'automationId', 'outletName']) if (typeof data[key] !== 'string') throw new Error(`世界书 ${key} 必须是字符串`);
        if (typeof data.groupWeight !== 'number' || !Number.isFinite(data.groupWeight) || data.groupWeight < 0) throw new Error('世界书 groupWeight 必须是非负数');
        object(data.characterFilter, 'characterFilter');
        if (typeof data.characterFilter.isExclude !== 'boolean') throw new Error('世界书 characterFilter.isExclude 必须是布尔值');
        for (const list of [data.triggers, data.characterFilter.names, data.characterFilter.tags]) if (!Array.isArray(list) || list.some(item => typeof item !== 'string')) throw new Error('世界书触发类型及角色过滤条件必须是字符串数组');
        const raw = previous ? (serializeLorebook({ ...book, entries: [previous], rawData: { entries: [] } }).entries as any[])[0] : {};
        const changed = (key: keyof HelperWorldbookEntry) => !baseline || !_.isEqual(data[key], baseline[key]);
        const patch: Record<string, unknown> = { uid, id: uid, displayIndex: index };
        if (changed('name')) patch.comment = data.name;
        if (changed('content')) patch.content = data.content;
        if (changed('enabled')) Object.assign(patch, { disable: !data.enabled, disabled: !data.enabled, enabled: data.enabled });
        if (changed('strategy')) Object.assign(patch, { constant: data.strategy.type === 'constant', vectorized: data.strategy.type === 'vectorized', selective: data.strategy.type === 'selective',
            key: data.strategy.keys.map(String), keysecondary: data.strategy.keys_secondary.keys.map(String), selectiveLogic: { and_any: 0, not_all: 1, not_any: 2, and_all: 3 }[data.strategy.keys_secondary.logic],
            scanDepth: data.strategy.scan_depth === 'same_as_global' ? null : data.strategy.scan_depth });
        if (changed('position')) Object.assign(patch, { role: { system: 0, user: 1, assistant: 2 }[data.position.role], depth: data.position.depth, order: data.position.order });
        // The raw numeric enum has a different order from the public position names.
        if (changed('position')) patch.position = ({ before_char: 0, after_char: 1, before_an: 2, after_an: 3, at_depth: 4, before_example: 5, after_example: 6, outlet: 7 } as any)[positions[data.position.type]];
        if (changed('probability')) Object.assign(patch, { probability: data.probability, useProbability: true });
        if (changed('recursion')) Object.assign(patch, { excludeRecursion: data.recursion.prevent_incoming, preventRecursion: data.recursion.prevent_outgoing, delayUntilRecursion: data.recursion.delay_until ?? 0 });
        if (changed('effect')) Object.assign(patch, { sticky: data.effect.sticky ?? 0, cooldown: data.effect.cooldown ?? 0, delay: data.effect.delay ?? 0 });
        if (data.extra !== undefined) { object(data.extra, 'extra'); if (changed('extra')) patch.extra = structuredClone(data.extra); }
        else delete raw.extra;
        const extensions = { ...(raw.extensions ?? {}) };
        if (changed('strategy')) { delete raw.scanDepth; delete extensions.scan_depth; }
        for (const key of implicit) if (!baseline || !_.isEqual(data[key], baseline[key])) { patch[key] = structuredClone(data[key]); extensions[implicitAliases[key] ?? key] = structuredClone(data[key]); }
        // Keep the extension enum in sync: card imports prioritize this over the raw position.
        if (changed('position')) extensions.position = patch.position;
        if (changed('strategy')) { extensions.scan_depth = patch.scanDepth; extensions.selectiveLogic = patch.selectiveLogic; }
        return normalizeLorebook({ name: book.name, entries: [{ ...raw, ...patch, extensions }] }).entries[0];
    });
    return { ...book, entries };
}

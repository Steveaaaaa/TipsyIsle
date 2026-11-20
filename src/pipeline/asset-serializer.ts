import { normalizeCharacterCard, normalizeLorebook, normalizeRegexScripts } from './normalizer';
import type { NormalizedCharacterCard, NormalizedLorebook, LorebookEntry, RegexScriptRule } from '../types';

const record = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// Overlay only edited fields on the original document. Vendor fields, nulls,
// whitespace, disabled content and extension values survive an untouched round trip.
export function serializeRegexRule(rule: RegexScriptRule): Record<string, unknown> {
    const raw = structuredClone(rule.rawData ?? {});
    const baseline = rule.rawData ? normalizeRegexScripts([raw])[0]! : undefined;
    for (const key of ['id', 'scriptName', 'findRegex', 'replaceString', 'trimStrings', 'disabled',
        'markdownOnly', 'promptOnly', 'runOnEdit', 'substituteRegex', 'minDepth', 'maxDepth'] as const) {
        if (!baseline || !same(rule[key], baseline[key])) raw[key] = rule[key];
    }
    if (!baseline || !same(rule.placement, baseline.placement)) {
        const placements: Record<string, number> = { user_input: 1, ai_output: 2, slash_command: 3, world_info: 5, reasoning: 6 };
        raw.placement = rule.placement.map(p => placements[p] ?? p);
    }
    return raw;
}

export function serializeEntry(entry: LorebookEntry): Record<string, unknown> {
    const raw = structuredClone(entry.rawData ?? {});
    const baseline = entry.rawData ? normalizeLorebook({ entries: [raw] }).entries[0]! : undefined;
    const changed = (key: keyof LorebookEntry) => !baseline || !same(entry[key], baseline[key]);
    const fields = { uid: 'id', comment: 'comment', content: 'content', keys: 'keys', secondaryKeys: 'secondary_keys',
        constant: 'constant', selective: 'selective', order: 'insertion_order' } as const;
    for (const [key, target] of Object.entries(fields)) {
        if (changed(key as keyof LorebookEntry)) raw[target] = entry[key as keyof LorebookEntry];
    }
    if (changed('disabled')) {
        raw.enabled = !entry.disabled;
        for (const key of ['disable', 'disabled']) if (key in raw) raw[key] = Boolean(entry.disabled);
    }
    for (const [alias, key] of [['uid', 'uid'], ['key', 'keys'], ['keysecondary', 'secondaryKeys'], ['order', 'order']] as const) {
        if (alias in raw && changed(key)) raw[alias] = entry[key];
    }
    const extensionFields = { depth: 'depth', role: 'role', probability: 'probability', useProbability: 'useProbability',
        excludeRecursion: 'exclude_recursion', preventRecursion: 'prevent_recursion', delayUntilRecursion: 'delay_until_recursion',
        sticky: 'sticky', cooldown: 'cooldown', delay: 'delay', group: 'group', groupOverride: 'group_override',
        groupWeight: 'group_weight', useGroupScoring: 'use_group_scoring', caseSensitive: 'case_sensitive',
        matchWholeWords: 'match_whole_words', scanDepth: 'scan_depth', ignoreBudget: 'ignore_budget',
        automationId: 'automation_id', vectorized: 'vectorized', triggers: 'triggers', selectiveLogic: 'selectiveLogic', outletName: 'outlet_name',
        characterFilter: 'character_filter', matchPersonaDescription: 'match_persona_description', matchCharacterDescription: 'match_character_description',
        matchCharacterPersonality: 'match_character_personality', matchCharacterDepthPrompt: 'match_character_depth_prompt', matchScenario: 'match_scenario', matchCreatorNotes: 'match_creator_notes' } as const;
    for (const [key, target] of Object.entries(extensionFields)) {
        if (!changed(key as keyof LorebookEntry)) continue;
        let value = entry[key as keyof LorebookEntry];
        if (key === 'role') value = { system: 0, user: 1, assistant: 2 }[entry.role ?? 'system'];
        if (key === 'selectiveLogic') value = ({ AND_ANY: 0, NOT_ALL: 1, NOT_ANY: 2, AND_ALL: 3 } as Record<string, number>)[String(entry.selectiveLogic)] ?? entry.selectiveLogic;
        raw.extensions = { ...record(raw.extensions), [target]: value };
        if (key in raw) raw[key] = key === 'selectiveLogic' || key === 'role' && typeof raw[key] === 'number' ? value : entry[key as keyof LorebookEntry];
    }
    if (changed('position')) {
        const positions = { before_char: 0, after_char: 1, before_an: 2, an_top: 2, after_an: 3, an_bottom: 3, at_depth: 4, before_example: 5, after_example: 6, outlet: 7 };
        raw.position = entry.position === 'before_char' ? 'before_char' : 'after_char';
        raw.extensions = { ...record(raw.extensions), position: positions[entry.position] };
        if (typeof raw.position === 'number' || typeof entry.rawData?.position === 'number') raw.position = positions[entry.position];
    }
    return raw;
}

export function serializeLorebook(book: NormalizedLorebook): Record<string, unknown> {
    const raw = structuredClone(book.rawData ?? {});
    const baseline = book.rawData ? normalizeLorebook(raw) : undefined;
    if (!baseline || book.name !== baseline.name) raw.name = book.name;
    const entries = book.entries.map(serializeEntry);
    const originalEntries = Array.isArray(raw.entries) ? raw.entries : Object.values(record(raw.entries));
    if (!baseline || !same(entries, originalEntries)) {
        if (raw.entries && !Array.isArray(raw.entries) && typeof raw.entries === 'object') {
            const keys = Object.keys(raw.entries);
            const keyByUid = new Map(baseline?.entries.map((entry, index) => [String(entry.uid), keys[index]]));
            const used = new Set<string>();
            raw.entries = Object.fromEntries(entries.map((entry, index) => {
                let key = keyByUid.get(String(book.entries[index].uid)) ?? String(book.entries[index].uid);
                while (used.has(key)) key = `${key}_`;
                used.add(key);
                return [key, entry];
            }));
        } else raw.entries = entries;
    }
    for (const [key, target] of Object.entries({ scanDepth: 'scan_depth', tokenBudget: 'token_budget', recursiveScanning: 'recursive_scanning', maxRecursionSteps: 'max_recursion_steps' }) as Array<[keyof NormalizedLorebook, string]>) {
        if ((!baseline && book[key] !== undefined) || (baseline && !same(book[key], baseline[key]))) {
            raw[target] = book[key];
            if (key in raw) raw[key] = book[key];
        }
    }
    return raw;
}

export function serializeCharacterCard(card: NormalizedCharacterCard): Record<string, unknown> {
    const raw = structuredClone(card.rawData ?? { spec: 'chara_card_v3', spec_version: '3.0', data: {} });
    const baseline = card.rawData ? normalizeCharacterCard(raw) : undefined;
    const data = raw.data && typeof raw.data === 'object' ? raw.data as Record<string, unknown> : raw;
    const fields = { name: 'name', description: 'description', personality: 'personality', scenario: 'scenario',
        firstMessage: 'first_mes', alternateGreetings: 'alternate_greetings', mesExample: 'mes_example',
        systemPrompt: 'system_prompt', postHistoryInstructions: 'post_history_instructions', creatorNotes: 'creator_notes',
        tags: 'tags', creator: 'creator', characterVersion: 'character_version' } as const;
    for (const [key, target] of Object.entries(fields) as Array<[keyof typeof fields, string]>) {
        if (!baseline || !same(card[key], baseline[key])) {
            data[target] = card[key];
            if (data !== raw && target in raw) raw[target] = card[key];
            if (key === 'creatorNotes' && 'creatorcomment' in raw) raw.creatorcomment = card.creatorNotes;
        }
    }
    const book = card.characterBook ?? card.embeddedLorebook;
    if (book) data.character_book = serializeLorebook(book);
    else if (baseline?.embeddedLorebook) delete data.character_book;
    const extensions = structuredClone(record(data.extensions));
    for (const [key, value] of Object.entries(card.extensions ?? {})) {
        if (!baseline || !same(value, baseline.extensions?.[key])) extensions[key] = structuredClone(value);
    }
    for (const key of Object.keys(baseline?.extensions ?? {})) {
        if (card.extensions && !(key in card.extensions)) delete extensions[key];
    }
    if (!baseline || !same(card.regexScripts, baseline.regexScripts)) {
        if (card.regexScripts.length || 'regex_scripts' in extensions) extensions.regex_scripts = card.regexScripts.map(serializeRegexRule);
    }
    if (card.depthPrompt && (!baseline || !same(card.depthPrompt, baseline.depthPrompt))) {
        extensions.depth_prompt = { ...record(extensions.depth_prompt), ...card.depthPrompt };
    }
    if (Object.keys(extensions).length || 'extensions' in data) data.extensions = extensions;
    return raw;
}

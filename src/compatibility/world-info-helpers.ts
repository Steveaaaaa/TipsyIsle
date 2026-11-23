import _ from 'lodash';

export const originalWIDataKeyMap: Record<string, string> = {
    displayIndex: 'extensions.display_index',
    excludeRecursion: 'extensions.exclude_recursion',
    preventRecursion: 'extensions.prevent_recursion',
    delayUntilRecursion: 'extensions.delay_until_recursion',
    selectiveLogic: 'selectiveLogic',
    comment: 'comment',
    constant: 'constant',
    order: 'insertion_order',
    depth: 'extensions.depth',
    probability: 'extensions.probability',
    useProbability: 'extensions.useProbability',
    position: 'extensions.position',
    role: 'extensions.role',
    content: 'content',
    enabled: 'enabled',
    key: 'keys',
    keysecondary: 'secondary_keys',
    selective: 'selective',
    matchWholeWords: 'extensions.match_whole_words',
    useGroupScoring: 'extensions.use_group_scoring',
    caseSensitive: 'extensions.case_sensitive',
    matchPersonaDescription: 'extensions.match_persona_description',
    matchCharacterDescription: 'extensions.match_character_description',
    matchCharacterPersonality: 'extensions.match_character_personality',
    matchCharacterDepthPrompt: 'extensions.match_character_depth_prompt',
    matchScenario: 'extensions.match_scenario',
    matchCreatorNotes: 'extensions.match_creator_notes',
    scanDepth: 'extensions.scan_depth',
    automationId: 'extensions.automation_id',
    vectorized: 'extensions.vectorized',
    group: 'extensions.group',
    groupOverride: 'extensions.group_override',
    groupWeight: 'extensions.group_weight',
    sticky: 'extensions.sticky',
    cooldown: 'extensions.cooldown',
    delay: 'extensions.delay',
    ignoreBudget: 'extensions.ignore_budget',
    outletName: 'extensions.outlet_name',
    triggers: 'extensions.triggers',
};

const newWorldInfoEntryTemplate = {
    key: [] as string[],
    keysecondary: [] as string[],
    comment: '',
    content: '',
    constant: false,
    vectorized: false,
    selective: true,
    selectiveLogic: 0,
    addMemo: true,
    order: 100,
    position: 0,
    disable: false,
    ignoreBudget: false,
    excludeRecursion: false,
    preventRecursion: false,
    matchPersonaDescription: false,
    matchCharacterDescription: false,
    matchCharacterPersonality: false,
    matchCharacterDepthPrompt: false,
    matchScenario: false,
    matchCreatorNotes: false,
    delayUntilRecursion: 0,
    probability: 100,
    useProbability: true,
    depth: 4,
    outletName: '',
    group: '',
    groupOverride: false,
    groupWeight: 100,
    scanDepth: null as number | null,
    caseSensitive: null as boolean | null,
    matchWholeWords: null as boolean | null,
    useGroupScoring: null as boolean | null,
    automationId: '',
    role: null as number | null,
    sticky: 0,
    cooldown: 0,
    delay: 0,
    triggers: [] as string[],
    displayIndex: 0,
    characterFilter: { isExclude: false, names: [] as string[], tags: [] as string[] },
};

class WorldInfoCache extends Map<string, any> {
    override get(key: string) {
        const value = super.get(key);
        return value === undefined ? undefined : structuredClone(value);
    }
}

export function createWorldInfoCache(): Map<string, any> {
    return new WorldInfoCache();
}

export function createWorldInfoEntry(_name: string, data: Record<string, any>): Record<string, any> | undefined {
    if (!data || typeof data !== 'object') return undefined;
    if (!data.entries || typeof data.entries !== 'object') data.entries = {};
    const used = new Set(Object.values(data.entries).map((entry: any) => Number(entry?.uid)));
    let uid = 0;
    while (used.has(uid)) uid++;
    const entry = { uid, ...structuredClone(newWorldInfoEntryTemplate), displayIndex: Object.keys(data.entries).length };
    data.entries[uid] = entry;
    return entry;
}

export function setWIOriginalDataValue(data: Record<string, any>, uid: number | string, key: string, value: unknown): void {
    const entries = data?.originalData?.entries;
    if (!Array.isArray(entries)) return;
    const target = entries.find((item: any) => item?.uid == uid);
    if (target) _.set(target, key, value);
}

export function deleteWIOriginalDataValue(data: Record<string, any>, uid: number | string): void {
    const entries = data?.originalData?.entries;
    if (!Array.isArray(entries)) return;
    const index = entries.findIndex((item: any) => item?.uid == uid);
    if (index >= 0) entries.splice(index, 1);
}

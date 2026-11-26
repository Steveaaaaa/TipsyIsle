import type { Json, MessageRef, PluginApi, RouteAddress } from '@tipsy-isle/plugin-sdk';

export interface CastLedgerEntry {
    outfit?: string;
    condition?: string;
    prop?: string;
}

export interface DeceasedEntry {
    floor?: number;
    reason?: string;
}

export interface KnownCharacter {
    name: string;
    aliases?: readonly string[];
}

export interface LedgerState {
    location?: string;
    lighting?: string;
    weather?: string;
    timeOfDay?: string;
    palette?: [string, string];
    cast?: Record<string, CastLedgerEntry>;
    deceased?: Record<string, DeceasedEntry>;
    variables?: string;
}

const NEGATED = /(?:没|未|并未|不再|并不)(?:穿着|穿|戴着|拿着|握着)/;
const REMOVED = /(?:脱下|褪去|解下|摘下|放下|丢掉)([^，。\n]{1,18})/;
const DEATH_NEGATED_RE =
    /(?:没死|没有死|并未死|未死|不会死|不能死|不想死|不要死|差点死|差点死了|差点被杀|差点被处刑|差点丧命|险些死|险些被杀|险些丧命|假死|装死|诈死|以为[^，。；！？\n]{0,8}死|如果[^，。；！？\n]{0,8}死|要是[^，。；！？\n]{0,8}死|假如[^，。；！？\n]{0,8}死|就算[^，。；！？\n]{0,8}死|怕[^，。；！？\n]{0,8}死|别死|还活着|活着|生还|not\s+dead|didn't\s+die|almost\s+died|might\s+die|would\s+die|if\s+[^,.;]{0,16}\s+dies?)/i;
const MVU_DEATH_VALUE_RE =
    /(?:已死|已死亡|死亡|身亡|阵亡|遇害|被处刑|处刑|处决|毙命|退场|\bdead\b|\bdeceased\b|\bkilled\b|\bexecuted\b)/i;
const MVU_DEATH_NEGATED_RE = /(?:未死|没死|没有死|存活|活着|生还|not\s+dead|\balive\b|\bliving\b)/i;
const MVU_ALIVE_VALUE_RE = /(?:存活|活着|生还|复活|\balive\b|\bliving\b)/i;
const MVU_STATUS_KEYS = new Set(['status', 'state', '状态', '生死', '存活', '生命', '处刑', '退场', 'alive_status']);
const MVU_ALIVE_BOOL_KEYS = new Set(['alive', 'is_alive', 'isAlive', '存活']);
const MVU_DEAD_BOOL_KEYS = new Set(['dead', 'is_dead', 'isDead', '已死', '死亡']);
const MVU_DEAD_LIST_KEYS = new Set(['deceased', 'dead', 'dead_characters', 'deadCharacters', '死亡名单', '已死亡', '阵亡名单', '处刑名单']);
const DEATH_OR_REVIVE_QUICK_RE =
    /(?:死|亡|杀|处刑|处决|遇害|毙命|断气|气绝|呼吸|心跳|尸体|遗体|遗骸|复活|起死回生|重获新生|还活着|dead|died|killed|executed|revived|still\s+alive)/i;
const aliasDeathPatterns = new Map<string, { reviveRe: RegExp; suffixRe: RegExp; prefixRe: RegExp }>();

function getAliasDeathPatterns(alias: string) {
    let cached = aliasDeathPatterns.get(alias);
    if (cached) return cached;
    const esc = escapeRegExp(alias);
    cached = {
        reviveRe: new RegExp(
            `(?:${esc}[^，,]{0,12}(?:复活了|起死回生|并没有死|其实没死|还活着|重获新生|\\brevived\\b|\\bis\\s+still\\s+alive\\b)|(?:复活的|起死回生的).{0,4}${esc})`,
            'i',
        ),
        suffixRe: new RegExp(
            `${esc}[^，,]{0,12}?(?:已经死了|死了|已死|已死亡|身亡|丧命|断气|气绝|咽下最后一口气|停止了呼吸|心跳停止|没有了呼吸|被处刑|已被处刑|被处决|被杀害|被杀了|遇害|阵亡|毙命|死去了|化作(?:了)?尸体|变成(?:了)?尸体|的尸体|的遗体|的遗骸|\\bis\\s+dead\\b|\\bhas\\s+died\\b|\\bwas\\s+killed\\b|\\bwas\\s+executed\\b|\\bdied\\b)`,
            'i',
        ),
        prefixRe: new RegExp(
            `(?:(?:已死|死去|死亡|遇害|被处刑|被处决|被杀害|阵亡)的?.{0,6}${esc}|(?:处刑了|处决了|杀害了|杀死了).{0,4}${esc})`,
            'i',
        ),
    };
    if (aliasDeathPatterns.size > 256) aliasDeathPatterns.clear();
    aliasDeathPatterns.set(alias, cached);
    return cached;
}

export function normalizeActorKey(name: string): string {
    return name.replace(/\s+/g, '').trim().toLowerCase();
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildCanonicalResolver(knownCharacters: readonly KnownCharacter[]) {
    const aliasToCanonical = new Map<string, string>();
    const normalizedToCanonical = new Map<string, string>();
    for (const ch of knownCharacters) {
        const canonical = ch.name?.trim();
        if (!canonical) continue;
        normalizedToCanonical.set(normalizeActorKey(canonical), canonical);
        for (const rawAlias of [canonical, ...(ch.aliases ?? [])]) {
            const alias = rawAlias.trim();
            if (!alias) continue;
            normalizedToCanonical.set(normalizeActorKey(alias), canonical);
            if (alias.length >= 2) aliasToCanonical.set(alias, canonical);
        }
    }
    return {
        resolve: (value: string) => normalizedToCanonical.get(normalizeActorKey(value)),
        aliasToCanonical,
    };
}

function purgeCastKeys(
    cast: Record<string, CastLedgerEntry>,
    deceasedKeys: ReadonlySet<string>,
    knownCharacters: readonly KnownCharacter[] = [],
) {
    const forbidden = new Set<string>(deceasedKeys);
    for (const ch of knownCharacters) {
        if (!deceasedKeys.has(normalizeActorKey(ch.name))) continue;
        for (const alias of [ch.name, ...(ch.aliases ?? [])]) {
            if (alias.trim()) forbidden.add(normalizeActorKey(alias));
        }
    }
    for (const key of Object.keys(cast)) {
        if (forbidden.has(normalizeActorKey(key))) delete cast[key];
    }
}

export function extractDeceasedFromMvu(
    mvu: unknown,
    knownCharacters: readonly KnownCharacter[] = [],
): { deceased: string[]; revived: string[] } {
    if (!mvu || typeof mvu !== 'object') return { deceased: [], revived: [] };
    const { resolve } = buildCanonicalResolver(knownCharacters);
    const deceased = new Set<string>();
    const revived = new Set<string>();
    const visited = new WeakSet<object>();

    const checkEntry = (nameCandidate: string, obj: Record<string, unknown>) => {
        const canonical = resolve(nameCandidate) ?? (knownCharacters.length === 0 && nameCandidate.length >= 2 ? nameCandidate : undefined);
        if (!canonical) return;
        for (const k of MVU_DEAD_BOOL_KEYS) {
            if (obj[k] === true) { deceased.add(canonical); return; }
        }
        for (const k of MVU_ALIVE_BOOL_KEYS) {
            if (obj[k] === false) { deceased.add(canonical); return; }
        }
        for (const k of MVU_STATUS_KEYS) {
            const v = obj[k];
            if (typeof v === 'string' && v.trim()) {
                if (MVU_DEATH_VALUE_RE.test(v) && !MVU_DEATH_NEGATED_RE.test(v)) { deceased.add(canonical); return; }
                if (MVU_ALIVE_VALUE_RE.test(v)) { revived.add(canonical); return; }
            }
        }
        for (const k of MVU_ALIVE_BOOL_KEYS) {
            if (obj[k] === true) { revived.add(canonical); return; }
        }
        for (const k of MVU_DEAD_BOOL_KEYS) {
            if (obj[k] === false) { revived.add(canonical); return; }
        }
    };

    const visit = (node: unknown, keyHint: string | undefined, depth: number) => {
        if (depth > 6 || !node || typeof node !== 'object') return;
        if (visited.has(node)) return;
        visited.add(node);

        if (Array.isArray(node)) {
            if (keyHint && MVU_DEAD_LIST_KEYS.has(keyHint)) {
                for (const item of node) {
                    if (typeof item === 'string' && item.trim()) {
                        const canonical = resolve(item) ?? item.trim();
                        deceased.add(canonical);
                    }
                }
            }
            for (const item of node) visit(item, undefined, depth + 1);
            return;
        }

        const record = node as Record<string, unknown>;
        const explicitName = ['name', '姓名', '角色', 'character']
            .map((k) => record[k])
            .find((v): v is string => typeof v === 'string' && v.trim().length > 0);
        if (explicitName) checkEntry(explicitName.trim(), record);
        else if (keyHint) checkEntry(keyHint, record);

        for (const [k, v] of Object.entries(record)) {
            if (MVU_DEAD_LIST_KEYS.has(k) && v && typeof v === 'object' && !Array.isArray(v)) {
                for (const [entryName, flag] of Object.entries(v as Record<string, unknown>)) {
                    if (flag === true || (typeof flag === 'string' && MVU_DEATH_VALUE_RE.test(flag) && !MVU_DEATH_NEGATED_RE.test(flag))) {
                        deceased.add(resolve(entryName) ?? entryName.trim());
                    }
                }
            }
            if (typeof v === 'object' && v !== null) visit(v, k, depth + 1);
        }
    };

    visit(mvu, undefined, 0);
    return { deceased: [...deceased], revived: [...revived] };
}

export function extractDeceasedFromText(
    text: string,
    knownCharacters: readonly KnownCharacter[],
): { deceased: string[]; revived: string[] } {
    if (!text.trim() || !knownCharacters.length || !DEATH_OR_REVIVE_QUICK_RE.test(text)) {
        return { deceased: [], revived: [] };
    }
    const { aliasToCanonical } = buildCanonicalResolver(knownCharacters);
    if (!aliasToCanonical.size) return { deceased: [], revived: [] };

    const deceased = new Set<string>();
    const revived = new Set<string>();
    const sentences = text.split(/[。！？!?\n；;]+/);

    for (const sentence of sentences) {
        const cleanSentence = sentence.trim();
        if (!cleanSentence || !DEATH_OR_REVIVE_QUICK_RE.test(cleanSentence)) continue;
        const subClauses = DEATH_NEGATED_RE.test(cleanSentence)
            ? cleanSentence.split(/[，,]+/).map((s) => s.trim()).filter(Boolean)
            : [cleanSentence];

        for (const clause of subClauses) {
            if (!DEATH_OR_REVIVE_QUICK_RE.test(clause)) continue;
            for (const [alias, canonical] of aliasToCanonical) {
                if (!clause.includes(alias)) continue;
                const { reviveRe, suffixRe, prefixRe } = getAliasDeathPatterns(alias);
                if (reviveRe.test(clause)) {
                    revived.add(canonical);
                    continue;
                }
                if (DEATH_NEGATED_RE.test(clause)) continue;

                if (suffixRe.test(clause) || prefixRe.test(clause)) {
                    deceased.add(canonical);
                }
            }
        }
    }

    return { deceased: [...deceased], revived: [...revived] };
}

export function pruneLedgerForFloor(ledger: LedgerState, currentFloor?: number): LedgerState {
    if (currentFloor === undefined || !ledger.deceased) return ledger;
    const kept: Record<string, DeceasedEntry> = {};
    for (const [name, entry] of Object.entries(ledger.deceased)) {
        if (entry && (entry.floor === undefined || entry.floor <= currentFloor)) {
            kept[name] = entry;
        }
    }
    return { ...ledger, deceased: kept };
}

export function resolveDeceasedSet(ledger: LedgerState, currentFloor?: number): Set<string> {
    const pruned = pruneLedgerForFloor(ledger, currentFloor);
    return new Set(Object.keys(pruned.deceased ?? {}));
}

export async function mutate(
    api: Pick<PluginApi, 'storage'>,
    route: RouteAddress,
    reply: MessageRef | undefined,
    operationId: string,
    change: (value: Record<string, any>) => Record<string, unknown>,
) {
    for (let attempt = 0; ; attempt++) {
        const current = await api.storage.readAt({ route, reply });
        try {
            return await api.storage.patchAt({
                route,
                reply,
                expectedVersion: current.version,
                patch: {
                    operationId,
                    set: JSON.parse(JSON.stringify(change(current.values))) as Record<string, Json>,
                },
            });
        } catch (error) {
            const code = String((error as { code?: string }).code);
            if (attempt >= 2 || !['STORAGE_CONFLICT', 'VERSION_CONFLICT'].includes(code)) throw error;
        }
    }
}

function readMvuField(mvu: Record<string, unknown>, keys: string[]): string | undefined {
    for (const key of keys) {
        const val = mvu[key];
        if (typeof val === 'string' && val.trim()) return val.trim().slice(0, 60);
    }
    return undefined;
}

export function continuity(
    text: string,
    previous: LedgerState | Record<string, string> = {},
    mvu?: unknown,
    activeActors: string[] = [],
    options?: {
        floor?: number;
        knownCharacters?: readonly KnownCharacter[];
        replyText?: string;
        recentTexts?: ReadonlyArray<{ floor?: number; text: string }>;
    },
): LedgerState {
    const prevPruned = pruneLedgerForFloor(previous as LedgerState, options?.floor);
    const base: LedgerState = {
        ...prevPruned,
        cast: { ...(typeof prevPruned.cast === 'object' ? prevPruned.cast : {}) },
        deceased: { ...(typeof prevPruned.deceased === 'object' ? prevPruned.deceased : {}) },
    };

    const knownCharacters = options?.knownCharacters ?? [];
    const applyDeathUpdate = (
        update: { deceased: string[]; revived: string[] },
        floor: number | undefined,
        reason: string,
    ) => {
        for (const name of update.deceased) {
            const norm = normalizeActorKey(name);
            const existingKey = Object.keys(base.deceased!).find((k) => normalizeActorKey(k) === norm);
            if (!existingKey) base.deceased![name] = { ...(floor !== undefined && { floor }), reason };
        }
        for (const name of update.revived) {
            const norm = normalizeActorKey(name);
            for (const key of Object.keys(base.deceased!)) {
                if (normalizeActorKey(key) === norm) delete base.deceased![key];
            }
        }
    };

    if (options?.recentTexts?.length && knownCharacters.length) {
        const ordered = [...options.recentTexts]
            .filter((item) => item.floor === undefined || options.floor === undefined || item.floor <= options.floor)
            .sort((a, b) => (a.floor ?? 0) - (b.floor ?? 0));
        for (const item of ordered) {
            applyDeathUpdate(extractDeceasedFromText(item.text, knownCharacters), item.floor, 'story');
        }
    }

    if (knownCharacters.length) {
        applyDeathUpdate(
            extractDeceasedFromText(options?.replyText ?? text, knownCharacters),
            options?.floor,
            'narrative',
        );
    }

    if (mvu) {
        applyDeathUpdate(extractDeceasedFromMvu(mvu, knownCharacters), options?.floor, 'mvu');
    }

    const deceasedKeys = new Set(Object.keys(base.deceased!).map(normalizeActorKey));
    purgeCastKeys(base.cast!, deceasedKeys, knownCharacters);

    const weatherMatch = text.match(/(?:暴雨|细雨|落雪|大雪|晴朗|阴云|晨雾|夜雨|雷雨)[^，。\n]{0,12}/);
    if (weatherMatch) base.weather = weatherMatch[0].trim();

    const timeMatch = text.match(/(?:黎明|清晨|正午|黄昏|暮色|深夜|午夜|傍晚)[^，。\n]{0,10}/);
    if (timeMatch) base.timeOfDay = timeMatch[0].trim();

    const clauses = text.split(/[，,。！？\n]+/).map((s) => s.trim()).filter(Boolean);
    let currentActor = activeActors[0];
    for (const clause of clauses) {
        const mentioned = activeActors.find((name) => clause.includes(name));
        if (mentioned) currentActor = mentioned;
        if (NEGATED.test(clause) || !currentActor || deceasedKeys.has(normalizeActorKey(currentActor))) continue;
        const entry = { ...(base.cast![currentActor] ?? {}) };

        const removed = REMOVED.exec(clause);
        if (removed && entry.outfit && removed[1].trim() && entry.outfit.includes(removed[1].trim())) {
            delete entry.outfit;
        } else {
            const outfitMatch = clause.match(/(?:换上|披着|身穿|身着|穿着)([^，。\n]{1,22})/);
            if (outfitMatch) entry.outfit = outfitMatch[1].trim();
        }

        const injuryMatch = clause.match(/(?:擦伤|流血|负伤|缠着绷带|湿透|淋湿)[^，。\n]{0,14}/);
        if (injuryMatch) entry.condition = injuryMatch[0].trim();

        const propMatch = clause.match(/(?:握着|手持|拿起|举起)([^，。\n]{1,18})/);
        if (propMatch) entry.prop = propMatch[1].trim();

        if (Object.keys(entry).length) base.cast![currentActor] = entry;
    }

    if (mvu && typeof mvu === 'object' && !Array.isArray(mvu)) {
        const record = mvu as Record<string, unknown>;
        base.location = readMvuField(record, ['地点', '位置', '场景', 'location', 'place']) ?? base.location;
        base.weather = readMvuField(record, ['天气', 'weather']) ?? base.weather;
        base.timeOfDay = readMvuField(record, ['时间', '时段', 'time']) ?? base.timeOfDay;
        base.variables = JSON.stringify(mvu).slice(0, 600);
    } else if (mvu) {
        base.variables = JSON.stringify(mvu).slice(0, 600);
    }

    return base;
}

export function mergeLedger(base: LedgerState, patch?: Partial<LedgerState>, floor?: number): LedgerState {
    if (!patch) return base;
    const deceased: Record<string, DeceasedEntry> = { ...base.deceased };
    if (patch.deceased) {
        for (const [name, entry] of Object.entries(patch.deceased)) {
            const norm = normalizeActorKey(name);
            if (!Object.keys(deceased).some((k) => normalizeActorKey(k) === norm)) {
                deceased[name] = { ...(floor !== undefined && entry?.floor === undefined ? { floor } : {}), ...entry };
            }
        }
    }
    const cast = { ...base.cast, ...patch.cast };
    purgeCastKeys(cast, new Set(Object.keys(deceased).map(normalizeActorKey)));
    return {
        ...base,
        ...(patch.location && { location: patch.location }),
        ...(patch.lighting && { lighting: patch.lighting }),
        ...(patch.weather && { weather: patch.weather }),
        ...(patch.timeOfDay && { timeOfDay: patch.timeOfDay }),
        ...(patch.palette && { palette: patch.palette }),
        cast,
        deceased,
    };
}

export function filterLedgerForShot(ledger: LedgerState, presentActorNames: readonly string[]): LedgerState {
    const presentSet = new Set(presentActorNames.map(normalizeActorKey));
    const deceasedSet = new Set(Object.keys(ledger.deceased ?? {}).map(normalizeActorKey));
    const filteredCast: Record<string, CastLedgerEntry> = {};
    for (const [name, entry] of Object.entries(ledger.cast ?? {})) {
        const norm = normalizeActorKey(name);
        if (presentSet.has(norm) && !deceasedSet.has(norm)) {
            filteredCast[name] = entry;
        }
    }
    return {
        ...(ledger.location && { location: ledger.location }),
        ...(ledger.lighting && { lighting: ledger.lighting }),
        ...(ledger.weather && { weather: ledger.weather }),
        ...(ledger.timeOfDay && { timeOfDay: ledger.timeOfDay }),
        ...(ledger.palette && { palette: ledger.palette }),
        ...(Object.keys(filteredCast).length > 0 && { cast: filteredCast }),
    };
}

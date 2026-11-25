import type { Json, MessageRef, PluginApi, RouteAddress } from '@tipsy-isle/plugin-sdk';

export interface CastLedgerEntry {
    outfit?: string;
    condition?: string;
    prop?: string;
}

export interface LedgerState {
    location?: string;
    lighting?: string;
    weather?: string;
    timeOfDay?: string;
    palette?: [string, string];
    cast?: Record<string, CastLedgerEntry>;
    variables?: string;
}

const NEGATED = /(?:没|未|并未|不再|并不)(?:穿着|穿|戴着|拿着|握着)/;
const REMOVED = /(?:脱下|褪去|解下|摘下|放下|丢掉)([^，。\n]{1,18})/;

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
): LedgerState {
    const base: LedgerState = {
        ...previous,
        cast: { ...(typeof (previous as LedgerState).cast === 'object' ? (previous as LedgerState).cast : {}) },
    };

    const weatherMatch = text.match(/(?:暴雨|细雨|落雪|大雪|晴朗|阴云|晨雾|夜雨|雷雨)[^，。\n]{0,12}/);
    if (weatherMatch) base.weather = weatherMatch[0].trim();

    const timeMatch = text.match(/(?:黎明|清晨|正午|黄昏|暮色|深夜|午夜|傍晚)[^，。\n]{0,10}/);
    if (timeMatch) base.timeOfDay = timeMatch[0].trim();

    const clauses = text.split(/[，,。！？\n]+/).map((s) => s.trim()).filter(Boolean);
    let currentActor = activeActors[0];
    for (const clause of clauses) {
        const mentioned = activeActors.find((name) => clause.includes(name));
        if (mentioned) currentActor = mentioned;
        if (NEGATED.test(clause) || !currentActor) continue;
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

export function mergeLedger(base: LedgerState, patch?: Partial<LedgerState>): LedgerState {
    if (!patch) return base;
    return {
        ...base,
        ...(patch.location && { location: patch.location }),
        ...(patch.lighting && { lighting: patch.lighting }),
        ...(patch.weather && { weather: patch.weather }),
        ...(patch.timeOfDay && { timeOfDay: patch.timeOfDay }),
        ...(patch.palette && { palette: patch.palette }),
        cast: { ...base.cast, ...patch.cast },
    };
}

import type {
    CharacterVisualAsset,
    CharacterVisualEntry,
    Immutable,
    MediaRef,
    SpatialActorPrompt,
    StoryParticipant,
} from '@tipsy-isle/plugin-sdk';

export type Registry = Record<string, { canonicalMediaId: string }>;

const TRAIT_PATTERNS = [
    /(?:\d{1,2}岁|初[一二三]|高[一二三]|大[一二三四]|二十出头)/g,
    /(?:骨架|身材|体型|身段|个子|身高)[^，。\n；]{0,18}/g,
    /(?:娇小|纤细|苗条|瘦弱|偏瘦|病弱|高挑|中等身材|身材匀称|丰满|微胖|平胸|小胸|贫乳|巨乳|[A-G]罩杯)[^，。\n；]{0,12}/g,
    /(?:黑|银|白|金|棕|红|蓝|紫|粉|灰|绿|茶)色?(?:长|短|卷|直|马尾|双马尾|及腰|齐肩)?发/g,
    /(?:黑|蓝|红|琥珀|金|绿|紫|灰|异色)?瞳|眼眸/g,
    /(?:身穿|身着|穿着|巫女服|水手服|校服|制服|便服|常服|风衣|连衣裙|长裙|大衣|西装|衬衫|和服|旗袍|礼服|斗篷)[^，。\n；]{0,18}/g,
    /\b(?:silver|black|blonde|brown|red|blue|white|pink|long|short)\s+(?:hair|eyes)\b/gi,
    /\b(?:wearing|dressed in|uniform|miko|shrine maiden|kimono|coat|dress|suit|glasses|scarf)\b[^,.;\n]{0,24}/gi,
];

export function extractVisualTraits(source: string): string {
    if (!source) return '';
    const cleaned = source.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const hits = new Set<string>();
    for (const pattern of TRAIT_PATTERNS) {
        for (const match of cleaned.matchAll(pattern)) {
            const token = match[0].trim();
            if (token) hits.add(token);
            if (hits.size >= 8) break;
        }
        if (hits.size >= 8) break;
    }
    const regexTraits = [...hits].join(', ');
    if (cleaned.length <= 600 && /(?:年龄|体型|身材|发|瞳|眼|衣|裙|鞋|发带|服|外观|外貌|hair|eyes|wearing|uniform|miko)/i.test(cleaned)) {
        const summary = cleaned.slice(0, 480);
        return regexTraits ? `${regexTraits}; ${summary}`.slice(0, 540) : summary;
    }
    return regexTraits.slice(0, 240);
}

function actorCenters(count: number, index: number): { x: number; y: number } {
    const presets: Record<number, number[]> = {
        1: [0.5],
        2: [0.32, 0.68],
        3: [0.22, 0.5, 0.78],
        4: [0.18, 0.4, 0.62, 0.82],
    };
    const row = presets[count];
    const x = row ? row[index] ?? 0.5 : (index + 1) / (count + 1);
    return { x, y: 0.48 };
}

const PREV_BOUNDARY = new Set([...'和与跟被把向对让看见问找叫拉抱小阿']);
const NEXT_BOUNDARY = new Set([...'说道问笑看望轻低点摇走站坐转抬伸拉握抱的也却便就正把被向对和与在从着了']);
const HAN_RE = /\p{Script=Han}/u;

function compact(value: string) {
    return value.replace(/\s+/g, '').trim();
}

function matchSingleCharAlias(paragraph: string, ch: string): boolean {
    let from = 0;
    while (from < paragraph.length) {
        const idx = paragraph.indexOf(ch, from);
        if (idx === -1) return false;
        const prev = idx > 0 ? paragraph[idx - 1] : '';
        const next = idx + 1 < paragraph.length ? paragraph[idx + 1] : '';
        const prevOk = !prev || !HAN_RE.test(prev) || PREV_BOUNDARY.has(prev);
        const nextOk = !next || !HAN_RE.test(next) || NEXT_BOUNDARY.has(next);
        if (prevOk && nextOk) return true;
        from = idx + 1;
    }
    return false;
}

function tagMatchBonus(context: string, tags: readonly string[] = []): number {
    let bonus = 0;
    for (const tag of tags) {
        if (/制服/.test(tag) && /制服|校服|学校|教室|高中/.test(context)) bonus += 0.15;
        else if (/舞蹈服/.test(tag) && /舞蹈|练功服|芭蕾|排练/.test(context)) bonus += 0.20;
        else if (/外出/.test(tag) && /外出|约会|逛街|海边|公园|神社|夏日祭/.test(context)) bonus += 0.12;
        else if (/日常/.test(tag) && /日常|居家|家里|客厅|厨房/.test(context)) bonus += 0.10;
        else if (/成人|大学篇/.test(tag) && /成人|大学/.test(context)) bonus += 0.15;
        else if (/highschool|高中篇/.test(tag) && /高中|中学/.test(context)) bonus += 0.08;
        else if (/小学篇/.test(tag) && /小学/.test(context)) bonus += 0.08;
    }
    return bonus;
}

function pickBestReference(
    references: readonly Immutable<CharacterVisualAsset>[],
    context: string,
): MediaRef | undefined {
    let best: Immutable<CharacterVisualAsset> | undefined;
    let bestScore = -1;
    for (const item of references) {
        const score =
            item.confidence +
            (item.origin === 'local-gallery' ? 0.03 : 0) +
            tagMatchBonus(context, item.tags);
        if (score > bestScore) {
            bestScore = score;
            best = item;
        }
    }
    return best?.ref;
}

export function visualBible(
    cast: Immutable<StoryParticipant[]>,
    paragraph: string,
    registry: Registry,
    people: string[],
    profiles: Record<string, string> = {},
    characters: Immutable<CharacterVisualEntry[]> = [],
    sceneHint = '',
    corefContext = '',
) {
    const card = cast.find((item) => item.role === 'character');
    const ensemble =
        /学院|世界|模拟器|群像|RPG|academy|simulator|ensemble/i.test(`${card?.name ?? ''} ${card?.description ?? ''}`) ||
        new Set([...people, ...characters.map((c) => c.name)]).size >= 3;

    const spokenNames = characters.length || people.length
        ? []
        : Array.from(
            paragraph.matchAll(/(?:^|[\n。！？「」\s])([\p{Script=Han}]{2,4})(?=说|低声|推开|拔剑|转身|抬起|望向|走进|冲破|轻笑|皱眉)/gu),
            (match) => match[1],
        );

    const entities: {
        name: string;
        aliases: string[];
        traits?: string;
        references: readonly Immutable<CharacterVisualAsset>[];
    }[] = characters.map((c) => ({
        name: c.name,
        aliases: [...new Set([c.name, compact(c.name), ...c.aliases])],
        traits: c.traits,
        references: c.references,
    }));

    const coveredCompacts = new Set<string>();
    for (const ent of entities) {
        coveredCompacts.add(compact(ent.name));
        for (const a of ent.aliases) {
            if (a.length >= 2) coveredCompacts.add(compact(a));
        }
    }

    const extraCandidates = [
        ...new Set([
            ...cast.filter((actor) => !ensemble || actor.role !== 'character').map((actor) => actor.name),
            ...Object.keys(registry),
            ...people,
            ...spokenNames,
        ]),
    ];
    for (const raw of extraCandidates) {
        if (!raw) continue;
        const comp = compact(raw);
        if (!comp || coveredCompacts.has(comp)) continue;
        coveredCompacts.add(comp);
        entities.push({
            name: raw,
            aliases: comp !== raw ? [raw, comp] : [raw],
            references: [],
        });
    }

    // Count single-char alias owners so ambiguous 1-char aliases are ignored
    const singleCharOwners = new Map<string, number>();
    for (const ent of entities) {
        for (const alias of ent.aliases) {
            if (alias.length === 1 && HAN_RE.test(alias)) {
                singleCharOwners.set(alias, (singleCharOwners.get(alias) ?? 0) + 1);
            }
        }
    }

    const matchText = (text: string, limit: number) =>
        entities
            .filter((ent) =>
                ent.aliases.some((alias) => {
                    if (!alias) return false;
                    if (alias.length === 1 && HAN_RE.test(alias)) {
                        return singleCharOwners.get(alias) === 1 && matchSingleCharAlias(text, alias);
                    }
                    return text.includes(alias);
                }),
            )
            .slice(0, limit);

    const matched = matchText(paragraph, 4);

    if (
        !matched.length &&
        corefContext.trim() &&
        /(?:她|他|少女|少年|女孩|男孩|女人|男人|脸颊|脸庞|侧脸|眉眼|眼眸|眼睛|长发|发丝|身影|唇|指尖|\b(?:she|he|her|his|girl|boy)\b)/i.test(paragraph)
    ) {
        const corefLines = corefContext.split('\n').filter((line) => line.trim());
        const corefHits: typeof entities = [];
        for (const line of corefLines) {
            for (const hit of matchText(line, 2)) {
                if (!corefHits.includes(hit)) corefHits.push(hit);
                if (corefHits.length >= 2) break;
            }
            if (corefHits.length >= 2) break;
        }
        matched.push(...corefHits);
    }

    if (!matched.length && !ensemble && card) {
        const cardEntity = entities.find((e) => compact(e.name) === compact(card.name));
        matched.push(
            cardEntity ?? {
                name: card.name,
                aliases: [card.name],
                references: [],
            },
        );
    }

    const sceneContext = `${paragraph} ${sceneHint}`;
    const actors: SpatialActorPrompt[] = matched.map((ent, index) => {
        const officialRef = pickBestReference(ent.references, sceneContext);
        const participant = cast.find(
            (actor) =>
                (compact(actor.name) === compact(ent.name) || ent.aliases.includes(actor.name)) &&
                (!ensemble || actor.role !== 'character'),
        );
        const registryKey = [ent.name, ...ent.aliases].find((k) => Object.hasOwn(registry, k));
        const canonical = registryKey ? registry[registryKey]?.canonicalMediaId : undefined;

        const reference: MediaRef | undefined =
            officialRef ??
            participant?.avatar ??
            (canonical ? { source: 'media', id: canonical } : undefined);

        const profileKey = [ent.name, ...ent.aliases].find((k) => Object.hasOwn(profiles, k));
        const rawSource = ent.traits || participant?.description || (profileKey ? profiles[profileKey] : '');
        const traits = extractVisualTraits(rawSource);
        return {
            name: ent.name,
            prompt: traits ? `${ent.name}, ${traits}` : ent.name,
            center: actorCenters(matched.length, index),
            ...(reference && { reference }),
        };
    });

    return { ensemble, actors };
}

export interface ShotCandidate {
    part: string;
    index: number;
    score: number;
    explicitPrompt?: string;
}

const IGNORED_BLOCKS = /<(think|thinking|reasoning|draft|cot|thought|analysis|scratchpad|reflection|logic_check|dice_calculation|review|plan|planning|script|style|details|pre|html|div|section|aside|table|svg|iframe|UpdateVariable|UpdateVariableVariable|jsonpatch|scene_time|scene_cover|status|status_bar|statusplaceholderimpl|summary|action|suggested_questions|nsfw_illust|dream_after_format)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi;
const BARE_PIC_TAG = /<pic\b(?![^>]*\bprompt\s*=)[^>]*>[\s\S]{0,160}?(?:<\/pic\s*>|$)/gi;
const TRANSPARENT_WRAPPERS = /<\/?(?:now_plot|dream_plot|dream_body|story|content|text|plot|narrative|maintext|main_text|response|message|body|prose|chapter|scene|main|output|[a-z][a-z0-9]*_[a-z0-9_]+)\b[^>]*>/gi;
const CODE_AND_EJS = /```[\s\S]*?(?:```|$)|<%[\s\S]*?%>/g;
const PIC_TAG = /<pic\b[^<>]{0,400}?\bprompt\s*=\s*(["'])([\s\S]{1,1600}?)\1[^<>]*>/i;
const IIG_TAG = /<img\b[^<>]{0,2400}?\bsrc\s*=\s*(["'])\[IMG:GEN\]\1[^<>]*>/i;
const IIG_ATTR = /\bdata-iig-instruction\s*=\s*(["'])([\s\S]{1,2000}?)\1/i;
const LEGACY_IMG_GEN = /\[IMG:GEN:(\{[^\n]{1,1600}?\})\]/i;

const transition = /转眼|翌日|次日|推开.{0,4}门|踏入|映入眼帘|与此同时|场景切换|镜头切|夜幕降临|暴雨骤至|meanwhile|the next morning|stepped into/i;
const action = /骤然|崩塌|爆裂|拔剑|闪电|纵身|冲破|跃下|轰鸣|拥抱|吻住|跌落|burst into|lightning|embraced/i;
const visualCues = [
    /光|影|逆光|剪影|微光|霓虹|candlelight|silhouette|sunset/i,
    /雨|雪|雾|月|火|星|海|rain|snow|moonlight|fog/i,
    /凝望|注视|泪|唇|指尖|发丝|背影|gaze|tears|fingertips/i,
    /镜|窗|灯|血|花|剑|信|怀表|window|mirror|lantern|blade/i,
];

function decodeEntities(value: string) {
    return value.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}

export function extractExplicitPrompt(raw: string): string | undefined {
    const pic = PIC_TAG.exec(raw);
    if (pic?.[2]?.trim()) return pic[2].trim().slice(0, 1400);

    const img = IIG_TAG.exec(raw);
    if (img) {
        const attr = IIG_ATTR.exec(img[0]);
        if (attr?.[2]) {
            try {
                const parsed = JSON.parse(decodeEntities(attr[2])) as { prompt?: unknown };
                if (typeof parsed.prompt === 'string' && parsed.prompt.trim()) {
                    return parsed.prompt.trim().slice(0, 1400);
                }
            } catch {
                // Ignore malformed author JSON attributes.
            }
        }
    }

    const legacy = LEGACY_IMG_GEN.exec(raw);
    if (legacy?.[1]) {
        try {
            const parsed = JSON.parse(legacy[1]) as { prompt?: unknown };
            if (typeof parsed.prompt === 'string' && parsed.prompt.trim()) {
                return parsed.prompt.trim().slice(0, 1400);
            }
        } catch {
            // Ignore malformed legacy inline JSON.
        }
    }

    return undefined;
}

function stripNarrativeParts(text: string): string[] {
    return text
        .replace(IGNORED_BLOCKS, '')
        .replace(BARE_PIC_TAG, '')
        .replace(CODE_AND_EJS, '')
        .replace(TRANSPARENT_WRAPPERS, '')
        .split(/\n\s*\n/)
        .map((part) => part.trim())
        .filter(Boolean);
}

export function narrative(text: string) {
    return text
        .replace(IGNORED_BLOCKS, '')
        .replace(BARE_PIC_TAG, '')
        .replace(CODE_AND_EJS, '')
        .replace(TRANSPARENT_WRAPPERS, '')
        .replace(/<[^>]+>/g, ' ');
}

export function surroundingContext(text: string, index: number): string {
    const parts = stripNarrativeParts(text);
    const slice = [parts[index - 1], parts[index + 1]].filter((item): item is string => !!item);
    return slice.join('\n').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 600);
}

const FOCUS_PAIRS: [RegExp, RegExp][] = [
    [/侧脸|脸颊|脸庞|面容|容貌|轮廓|五官/, /侧脸|脸颊|脸庞|轮廓|下颌|眉眼|唇|鼻/],
    [/眼睛|眼眸|瞳|眼神|目光|凝视|注视|盯/, /眼|瞳|目光|眼神|视线|睫毛/],
    [/手|指|十指|牵|握/, /手|指尖|掌心|手腕/],
    [/抱|拥|靠|怀/, /抱|怀|肩|贴近/],
    [/笑|哭|泪|表情|神情/, /笑|唇|泪|眼角|虎牙|红晕/],
    [/背影|转身|发丝|头发|长发/, /背影|转身|发丝|发梢|长发|挑染/],
    [/衣|裙|服|穿搭|造型|领|袖/, /衣|裙|袖|领|服|蝴蝶结|丝带/],
];

function userFocusScore(clean: string, index: number, userPrompt: string, targetAliases: string[]): number {
    if (!userPrompt.trim()) return 0;
    let bonus = 0;
    const matchedAlias = targetAliases.some((alias) => alias.length >= 2 && clean.includes(alias));
    if (matchedAlias) {
        bonus += 8;
    } else if (
        targetAliases.length > 0 &&
        index <= 3 &&
        clean.length >= 36 &&
        /(?:她|他|少女|少年|女孩|男孩|脸颊|脸庞|侧脸|眉眼|眼眸|眼睛|发丝|轮廓|身影)/i.test(clean)
    ) {
        bonus += 7;
    }

    let cueBonus = 0;
    for (const [userCue, textCue] of FOCUS_PAIRS) {
        if (userCue.test(userPrompt) && textCue.test(clean)) {
            cueBonus += 4;
            if (cueBonus >= 6) {
                cueBonus = 6;
                break;
            }
        }
    }
    bonus += cueBonus;

    if (
        targetAliases.length > 0 &&
        !/电视|屏幕|广播|通知|公告|典狱长/.test(userPrompt) &&
        /电视屏幕|雪花|试音|广播/.test(clean)
    ) {
        bonus -= 2;
    }
    return bonus;
}

function scoreParagraph(raw: string, clean: string): { score: number; explicitPrompt?: string } {
    const explicitPrompt = extractExplicitPrompt(raw);
    let score = explicitPrompt ? 20 : 0;
    if (transition.test(clean)) score += 8;
    if (action.test(clean)) score += 8;
    for (const cue of visualCues) {
        if (cue.test(clean)) score += 2;
    }
    return { score, explicitPrompt };
}

export function shots(
    text: string,
    early = false,
    options?: { markersOnly?: boolean; userPrompt?: string; targetAliases?: string[] },
): ShotCandidate[] {
    const rawParts = stripNarrativeParts(text);
    const windowParts = early ? rawParts.slice(0, 4) : rawParts;
    const userPrompt = options?.userPrompt ?? '';
    const targetAliases = options?.targetAliases ?? [];

    const candidates: ShotCandidate[] = [];
    for (const [index, raw] of windowParts.entries()) {
        const clean = raw.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        if (!clean && !extractExplicitPrompt(raw)) continue;
        const { score: baseScore, explicitPrompt } = scoreParagraph(raw, clean);
        if (options?.markersOnly && !explicitPrompt) continue;
        const focusBonus = userFocusScore(clean, index, userPrompt, targetAliases);
        const score = baseScore + focusBonus;
        const minScore = early ? (index < 2 ? 8 : 4) : 4;
        if (score >= minScore && (!early || index < 2 || !!explicitPrompt || clean.length >= 36)) {
            candidates.push({ part: clean || explicitPrompt || '', index, score, explicitPrompt });
        }
    }

    if (!candidates.length) return [];

    const hasUserFocus = userPrompt.trim().length > 0;
    const ranked = [...candidates].sort((left, right) =>
        right.score - left.score || (hasUserFocus ? left.index - right.index : right.index - left.index),
    );
    const first = ranked[0];
    const second =
        !early &&
        text.length > 1800 &&
        ranked.find((shot) => {
            if (shot.index === first.index) return false;
            const lo = Math.min(first.index, shot.index) + 1;
            const hi = Math.max(first.index, shot.index) + 1;
            return rawParts.slice(lo, hi).some((part) => transition.test(part));
        });

    return (second ? [first, second] : [first]).sort((left, right) => left.index - right.index);
}

export function extractShotFromReply(
    text: string,
    preferredIndex?: number,
): { scene: string; index: number; replyText: string } {
    const parts = stripNarrativeParts(text);
    const cleanParts = parts.map((raw) => raw.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
    const replyText = narrative(text).replace(/\s+/g, ' ').trim();

    if (typeof preferredIndex === 'number' && preferredIndex >= 0 && cleanParts[preferredIndex]) {
        return { scene: cleanParts[preferredIndex], index: preferredIndex, replyText };
    }
    const picked = shots(text, false)[0];
    if (picked?.part) {
        return { scene: picked.part, index: picked.index, replyText };
    }
    const firstNonEmpty = cleanParts.findIndex(Boolean);
    if (firstNonEmpty >= 0) {
        return { scene: cleanParts[firstNonEmpty], index: firstNonEmpty, replyText };
    }
    return { scene: replyText.slice(0, 1200), index: 0, replyText };
}

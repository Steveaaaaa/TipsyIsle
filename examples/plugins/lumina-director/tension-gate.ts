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

const transition = /转眼|翌日|次日|推开.{0,4}门|踏入|跨进|走进|步入|绕过来|穿过|走上|停在.{0,14}(?:阴影|门|廊|前|旁)|映入眼帘|与此同时|场景切换|镜头切|夜幕降临|暴雨骤至|meanwhile|the next morning|stepped into/i;
const action = /骤然|崩塌|爆裂|拔剑|闪电|纵身|冲破|跃下|轰鸣|拥抱|吻住|跌落|burst into|lightning|embraced/i;
const visualCues = [
    /光|影|逆光|剪影|微光|霓虹|树荫|阴影|日头|阳光|日光|夕阳|黄昏|暮色|热浪|candlelight|silhouette|sunset/i,
    /雨|雪|雾|月|火|星|海|风|蝉鸣|樟树|樱|浪|rain|snow|moonlight|fog/i,
    /凝望|注视|泪|唇|指尖|发丝|背影|身影|轮廓|微笑|红晕|发带|gaze|tears|fingertips/i,
    /镜|窗|灯|血|花|剑|信|怀表|神社|鸟居|走廊|廊下|木廊|偏屋|拉门|屋门|石阶|屋檐|庭院|小径|window|mirror|lantern|blade/i,
];
const POSTURE_FRAMING_CUE = /坐在|跪坐|倚在|靠在|站在|蹲在|俯身|探头|并肩|回眸|裙摆/;

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
    [/看着|悄悄看|偷看|看她|看他|望向|望着|瞧着|观察|打量|偷窥/, /阴影|树荫|走廊|廊下|木廊|拉门|屋门|鸟居|神社|偏屋|坐在|跪坐|交谈|说话|笑着|背影|身影|侧脸|回头|发丝|裙/],
    [/背后|身后|悄悄|偷偷|躲|阴影|角落|门边|廊下|走廊/, /背后|身后|阴影|树荫|拉门|屋门|走廊|廊下|木廊|偏屋|小径|角落|门边/],
    [/她俩|她们|他俩|他们|两人|二人|坐在|坐着|交谈|聊天|说话|一起/, /坐在|跪坐|并肩|交谈|聊天|说话|开口|轻声|笑道|笑着|木廊|走廊|廊下|刨冰|茶/],
];

const HAN_RE = /\p{Script=Han}/u;
const PREV_BOUNDARY = new Set([...'和与跟被把向对让看见问找叫拉抱小阿']);
const NEXT_BOUNDARY = new Set([...'说道问笑看望轻低点摇走站坐转抬伸拉握抱的也却便就正把被向对和与在从着了']);
const FOCUS_STOP_WORDS = new Set([
    '什么', '时候', '发现', '怎么', '一下', '按照', '最新', '可以', '这里', '那里',
    '现在', '开始', '继续', '进行', '他们', '她们', '她俩', '他俩', '我们', '你们',
    '自己', '因为', '所以', '如果', '但是', '已经', '还是', '应该', '觉得', '知道',
    '不会', '没有', '就是', '一个', '这个', '那个',
]);

function matchesFocusAlias(text: string, alias: string): boolean {
    if (alias.length >= 2) return text.includes(alias);
    if (alias.length === 1 && HAN_RE.test(alias)) {
        let from = 0;
        while (from < text.length) {
            const idx = text.indexOf(alias, from);
            if (idx === -1) return false;
            const prev = idx > 0 ? text[idx - 1] : '';
            const next = idx + 1 < text.length ? text[idx + 1] : '';
            if (
                (!prev || !HAN_RE.test(prev) || PREV_BOUNDARY.has(prev)) &&
                (!next || !HAN_RE.test(next) || NEXT_BOUNDARY.has(next))
            ) {
                return true;
            }
            from = idx + 1;
        }
    }
    return false;
}

function extractFocusTokens(userPrompt: string): string[] {
    const segments = userPrompt
        .split(/[在的了着过是有我你他她它俩们这那把被让给向从到和与跟很也都还就才下上]+|[，。！？、；：“”‘’「」『』（）()\s]+/)
        .map((seg) => seg.trim())
        .filter((seg) => seg.length >= 2 && !FOCUS_STOP_WORDS.has(seg));
    const tokens = new Set<string>();
    for (const seg of segments) {
        if (seg.length <= 4) tokens.add(seg);
        if (seg.length > 2 && [...seg].every((ch) => HAN_RE.test(ch))) {
            for (let i = 0; i <= seg.length - 2; i += 2) {
                const chunk = seg.slice(i, i + 2);
                if (chunk.length === 2 && !FOCUS_STOP_WORDS.has(chunk)) tokens.add(chunk);
            }
            if (seg.length % 2 === 1) {
                const tail = seg.slice(-2);
                if (!FOCUS_STOP_WORDS.has(tail)) tokens.add(tail);
            }
        }
    }
    return [...tokens];
}

function userFocusScore(clean: string, index: number, userPrompt: string, targetAliases: string[]): number {
    if (!userPrompt.trim()) return 0;
    let bonus = 0;
    const matchedAlias = targetAliases.some((alias) => matchesFocusAlias(clean, alias));
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

    let tokenBonus = 0;
    for (const token of extractFocusTokens(userPrompt)) {
        if (clean.includes(token)) {
            tokenBonus += 3;
            if (tokenBonus >= 6) {
                tokenBonus = 6;
                break;
            }
        }
    }
    bonus += tokenBonus;

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
    if (clean.length >= 28 && POSTURE_FRAMING_CUE.test(clean)) score += 2;
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

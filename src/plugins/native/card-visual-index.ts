import type { CharacterVisualAsset, CharacterVisualEntry, MediaRef } from '../../../packages/plugin-sdk/index.js';
import type { StoryGallery } from '../../core/gallery-types';
import type { NormalizedCharacterCard, NormalizedLorebook, RegexScriptRule } from '../../types';

export interface IndexedCardAsset {
    assetId: string;
    url?: string;
    fallbackUrls?: string[];
    localGalleryPath?: string;
    label?: string;
    tags: string[];
}

export interface CardVisualIndex {
    characterId: string;
    fingerprint: string;
    people: string[];
    profiles: Record<string, string>;
    gallery: string[];
    characters: CharacterVisualEntry[];
    assetsById: Map<string, IndexedCardAsset>;
    worldContext?: string;
    inferredStyle?: string;
}

interface InternalEntity {
    canonical: string;
    compact: string;
    aliases: Set<string>;
    slugs: Set<string>;
    count?: number;
    traits: string;
    references: CharacterVisualAsset[];
}

interface CandidateAsset {
    url?: string;
    fallbackUrls?: string[];
    localGalleryPath?: string;
    label?: string;
    tags: string[];
    confidence: number;
    boundTo?: string;
}

const NSFW_RE = /(?:nsfw|春宵|r18|ero|只在色情|色情场景(?:时)?可用|色情专用|做爱|小穴|乳头|射精|高潮|拘束|自慰|摸胸|肉棒|指交|掰开|暴露|舔|内衣|赤裸|裸体|全裸|口交|足交|乳交|女上位|正常位|后入|_kj_|_zj_|_rj_|_nsw_|_zcw_|_hrw_)/i;
const CHIBI_OR_UI_RE = /(?:^|[_/-])q\.(?:png|webp|jpe?g)$|_q\.(?:png|webp|jpe?g)$|(?:^|[/_\-])map[_-]|chibi|q版|chatbg|phonebg|dynamicbg|chatlistbg|wallpaper|background|feng_mian|banner|icon|logo|角色卡链接|示例角色卡/i;
const META_WORLDBOOK_RE = /^(?:user|主角|角色|人物|npc|少女|少年|旁白|典狱长)$|(?:约束|分析|规则|世界观|状态栏|对话|说明|系统|日程|前端|合理性|节日|nsfw|分析约束库|插画|插图|立绘|任务|指令|模板|变量|更新|列表|封面|配置|指南|文风|协议|格式|地图|平面图|楼层)/i;
const NON_IMAGE_HOST_RE = /(?:fonts\.googleapis\.com|w3\.org|discord\.com|api\.openai\.com|api\.deepseek\.com)/i;
const NON_IMAGE_EXT_RE = /\.(?:js|mjs|css|mp3|wav|ogg|mp4|webm|json|md|html|svg)(?:$|[?#])/i;
const IMAGE_EXT_RE = /\.(?:png|jpe?g|webp|avif)(?:$|[?#])/i;
const PRIVATE_HOST_RE = /^(?:localhost|127\.0\.0\.1|\[::1\]|::1|0\.0\.0\.0|10\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.)/i;

function hash36(input: string): string {
    let h1 = 0x811c9dc5;
    let h2 = 0x9e3779b9;
    for (let i = 0; i < input.length; i++) {
        const ch = input.charCodeAt(i);
        h1 = Math.imul(h1 ^ ch, 0x01000193);
        h2 = Math.imul(h2 ^ (ch + i), 0x85ebca6b);
    }
    return `${(h1 >>> 0).toString(36)}${(h2 >>> 0).toString(36)}`;
}

function compactName(name: string): string {
    return name.replace(/\s+/g, '').trim();
}

function isSafeHttpImageUrl(raw: string, allowNoExt = false): boolean {
    if (!raw || raw.length > 1000) return false;
    if (/\$1|\$\{|['"]\s*\+|\+\s*['"]|\{[^}]*\|[^}]*\}/.test(raw)) return false;
    if (NSFW_RE.test(raw) || CHIBI_OR_UI_RE.test(raw)) return false;
    let parsed: URL;
    try {
        parsed = new URL(raw);
    } catch {
        return false;
    }
    if (!['https:', 'http:'].includes(parsed.protocol)) return false;
    if (parsed.username || parsed.password || parsed.hash) return false;
    if (PRIVATE_HOST_RE.test(parsed.hostname)) return false;
    if (NON_IMAGE_HOST_RE.test(parsed.hostname) || parsed.pathname.includes('/tree/')) return false;
    if (NON_IMAGE_EXT_RE.test(parsed.pathname)) return false;
    if (!allowNoExt && !IMAGE_EXT_RE.test(parsed.pathname)) return false;
    return true;
}

function decodeSafe(value: string): string {
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
}

function collectRegexScripts(card: NormalizedCharacterCard): { scriptName: string; findRegex: string; replaceString: string; disabled?: boolean }[] {
    const out: { scriptName: string; findRegex: string; replaceString: string; disabled?: boolean }[] = [];
    const seen = new Set<string>();
    const add = (script: Partial<RegexScriptRule> & { script_name?: string; find_regex?: string; replace_string?: string }) => {
        const scriptName = String(script.scriptName ?? script.script_name ?? '');
        const findRegex = String(script.findRegex ?? script.find_regex ?? '');
        const replaceString = String(script.replaceString ?? script.replace_string ?? '');
        if (!replaceString || script.disabled) return;
        const key = `${scriptName}:${replaceString.length}:${replaceString.slice(0, 48)}`;
        if (seen.has(key)) return;
        seen.add(key);
        out.push({ scriptName, findRegex, replaceString, disabled: script.disabled });
    };
    for (const s of card.regexScripts ?? []) add(s);
    const extScripts = card.extensions?.regex_scripts;
    if (Array.isArray(extScripts)) {
        for (const s of extScripts) {
            if (s && typeof s === 'object') add(s as Partial<RegexScriptRule>);
        }
    }
    return out;
}

function collectScriptContents(card: NormalizedCharacterCard): { name: string; content: string; findRegex?: string }[] {
    const out: { name: string; content: string; findRegex?: string }[] = [];
    for (const s of collectRegexScripts(card)) {
        if (NSFW_RE.test(s.scriptName)) continue;
        out.push({ name: s.scriptName, content: s.replaceString, ...(s.findRegex ? { findRegex: s.findRegex } : {}) });
    }
    const th = card.extensions?.tavern_helper as Record<string, unknown> | undefined;
    const thScripts = Array.isArray(th?.scripts) ? th.scripts : [];
    for (const s of thScripts) {
        if (s && typeof s === 'object') {
            const rec = s as Record<string, unknown>;
            const name = String(rec.name ?? '');
            const content = typeof rec.content === 'string' ? rec.content : '';
            if (content && !NSFW_RE.test(name)) out.push({ name, content });
        }
    }
    return out;
}

const ATTIRE_LINE_RE = /(?:穿着?|身着|巫女服|水手服|校服|制服|和服|旗袍|礼服|便服|常服|居家服|睡衣|连衣裙|长裙|风衣|大衣|西装|斗篷|wearing|uniform|miko|shrine maiden|kimono|dress)/i;
const AGE_LINE_RE = /(?:^|\s)(?:年龄|age)\s*[:：]\s*([^\n]{1,36})/i;
const HEIGHT_BUILD_FIELD_RE = /(?:^|\s)(?:身高|体型|身材|身段|胸部|height|build|body)\s*[:：]\s*\|?\s*([^\n]{1,90})/i;
const PHYSIQUE_CUE_RE = /(?:身材|体型|身段|骨架|个子|身高|娇小|纤细|苗条|瘦弱|偏瘦|病弱|高挑|中等身材|身材匀称|丰满|微胖|平胸|小胸|贫乳|巨乳|[A-G]罩杯|\d{3}\s*cm|slender|petite|slim|tall|curvy|busty|flat chest)/i;

function extractAppearanceSnippet(content: string): string {
    const parts: string[] = [];
    const ageMatch = AGE_LINE_RE.exec(content);
    if (ageMatch?.[1]?.trim()) {
        const age = ageMatch[1].trim().replace(/\s+/g, ' ');
        if (!/^使用说明|待定/.test(age)) parts.push(`年龄：${age}`);
    }

    const appearanceMatch = /(?:外貌|外观|容貌|穿搭|服装|形象|appearance)\s*[:：]\s*\|?\s*([\s\S]{1,600})/i.exec(content);
    let faceHairBase = '';
    if (appearanceMatch) {
        const rawBlock = appearanceMatch[1].split(/\n[A-Za-z\u4e00-\u9fa5_][^:\n]{0,16}:\s*(?:\||$|\n)/)[0] ?? appearanceMatch[1];
        faceHairBase = rawBlock.replace(/\s+/g, ' ').trim().slice(0, 300);
    }

    const physiqueSet: string[] = [];
    const pushPhysique = (raw: string) => {
        const clean = raw.replace(/^[\s\-*•]+/, '').trim();
        if (!clean || clean.length > 120 || /^(?:[“"'「]|标签\s*[:：]|基调\s*[:：]|别名\s*[:：]|使用说明|不得在正文|写作基准)/.test(clean)) return;
        if (physiqueSet.some((prev) => prev.includes(clean) || clean.includes(prev))) return;
        physiqueSet.push(clean);
    };
    for (const m of content.matchAll(new RegExp(HEIGHT_BUILD_FIELD_RE.source, 'gi'))) {
        if (m[1]) pushPhysique(m[1]);
        if (physiqueSet.length >= 2) break;
    }
    if (physiqueSet.length < 2) {
        for (const chunk of content.split(/[\n。！？；]+/)) {
            if (PHYSIQUE_CUE_RE.test(chunk)) {
                pushPhysique(chunk);
                if (physiqueSet.length >= 2) break;
            }
        }
    }
    if (physiqueSet.length) {
        parts.push(`体型：${physiqueSet.join('；').slice(0, 130)}`);
    }

    if (faceHairBase) {
        parts.push(`外貌：${faceHairBase}`);
    } else if (!parts.length) {
        parts.push(content.slice(0, 260).replace(/\s+/g, ' ').trim());
    }

    const joinedSoFar = parts.join('；');
    const attireLines: string[] = [];
    for (const line of content.split('\n')) {
        const clean = line.replace(/^[\s\-*•]+/, '').trim();
        if (!clean || clean.length > 120 || /^[“"'「]|使用说明|不得在正文|写作基准/.test(clean)) continue;
        if (ATTIRE_LINE_RE.test(clean) && !joinedSoFar.includes(clean)) {
            attireLines.push(clean);
            if (attireLines.length >= 2) break;
        }
    }
    if (attireLines.length) {
        parts.push(`衣着：${attireLines.join('；').slice(0, 110)}`);
    }

    return parts.join('；').slice(0, 540);
}

function splitNameList(raw: string): string[] {
    return raw
        .split(/[,，、/|]+/)
        .map((part) => part.replace(/^['"`\[\(（\s]+|['"`\]\)）\s]+$/g, '').trim())
        .filter((part) => part.length > 0 && part.length <= 24 && !META_WORLDBOOK_RE.test(part));
}

function stripEntityDecorations(rawName: string): string {
    return rawName
        .replace(/^[\d\s.\-•★☆◆◇■□●○【】\[\]⚙_#]*(?:\uFE0F\u20E3|\u20E3)?\s*/, '')
        .replace(/\[[^\]]*\]/g, '')
        .replace(/[（(][^）)]*[）)]/g, '')
        .replace(/^(?:角色详情|人物详情|角色档案|人物档案|角色设定|人物设定|后日谈|角色|人物)\s*[-—:：·|]\s*/i, '')
        .replace(/^['"`]+|['"`【\]]+$/g, '')
        .trim();
}

function buildCharacterEntities(
    card: NormalizedCharacterCard,
    books: (NormalizedLorebook | null | undefined)[],
    scripts: { name: string; content: string; findRegex?: string }[],
): InternalEntity[] {
    const entities: InternalEntity[] = [];

    const findOrCreate = (rawName: string, aliases: string[] = []): InternalEntity | null => {
        const clean = stripEntityDecorations(rawName);
        if (!clean || clean.length > 24 || META_WORLDBOOK_RE.test(clean) || /\{\{user\}\}/i.test(clean)) return null;
        const comp = compactName(clean);
        // Pass 1: exact canonical/compact match
        let existing = entities.find((e) => e.compact === comp || e.canonical === clean);
        // Pass 2: existing alias match for clean name
        if (!existing) {
            existing = entities.find((e) => e.aliases.has(clean) || e.aliases.has(comp));
        }
        // Pass 3: unique alias overlap among candidate aliases (never merge when spanning >=2 distinct entities)
        if (!existing && aliases.length) {
            const aliasMatches = entities.filter((e) =>
                aliases.some((a) => {
                    const ac = compactName(a);
                    return ac.length >= 2 && (e.compact === ac || e.aliases.has(a) || e.aliases.has(ac));
                }),
            );
            if (aliasMatches.length === 1) {
                existing = aliasMatches[0];
            } else if (aliasMatches.length >= 2) {
                return null;
            }
        }
        if (!existing) {
            existing = {
                canonical: clean,
                compact: comp,
                aliases: new Set([clean, ...(comp !== clean ? [comp] : [])]),
                slugs: new Set(),
                traits: '',
                references: [],
            };
            entities.push(existing);
        } else if (clean.includes(' ') && !existing.canonical.includes(' ') && compactName(existing.canonical) === comp) {
            existing.canonical = clean;
        }
        for (const a of aliases) {
            const at = stripEntityDecorations(a);
            if (!at || at.length > 24 || META_WORLDBOOK_RE.test(at)) continue;
            existing.aliases.add(at);
            const ac = compactName(at);
            if (ac && ac !== at) existing.aliases.add(ac);
        }
        return existing;
    };

    // 1. Worldbook entries (deduplicated across embeddedLorebook + bound worldbooks)
    const seenEntries = new Set<string>();
    for (const book of books) {
        for (const entry of book?.entries ?? []) {
            if (entry.disabled || NSFW_RE.test(entry.comment) || entry.keys.some((k) => NSFW_RE.test(k))) continue;
            const entryDedupKey = `${entry.comment.trim()}|${entry.keys.join(',')}|${entry.content.slice(0, 120)}`;
            if (seenEntries.has(entryDedupKey)) continue;
            seenEntries.add(entryDedupKey);

            // Roster overview blocks (e.g. "主要角色：\n  水瀬 澪: ...")
            if (/(?:主要角色|登场人物|人物速览|角色一览)/.test(`${entry.comment}\n${entry.content.slice(0, 200)}`)) {
                for (const line of entry.content.split('\n')) {
                    const m = /^\s{1,4}([\p{Script=Han}\w·\s]{2,18}?)\s*[:：]\s*([^\n]{6,220})$/u.exec(line);
                    if (m && !/^(?:主要角色|npc|关系|性别|年龄|职业|标签|使用说明)$/i.test(m[1].trim())) {
                        const ent = findOrCreate(m[1].trim());
                        if (ent && !ent.traits) ent.traits = m[2].trim();
                    }
                }
                continue;
            }

            if (/^[⚙_#]|\[mvu_/i.test(entry.comment.trim()) || META_WORLDBOOK_RE.test(entry.comment)) continue;
            if (/<[^>\n]{1,24}(?:规则|任务|指令)>/i.test(entry.content.slice(0, 240))) continue;

            const charHeader = /(?:^|\n)\s*(?:character|chinese_name|中文名|姓名|全名|角色名)\s*[:：]\s*([^\n#]+)/i.exec(entry.content);
            const nickHeader = /(?:^|\n)\s*(?:nickname|aliases?|别名|昵称|称呼)\s*[:：]\s*([^\n#]+)/i.exec(entry.content);
            const rawComment = stripEntityDecorations(entry.comment);
            const entryKeyAliases = entry.keys.flatMap((k) => splitNameList(k));
            if (!charHeader && entryKeyAliases.length >= 6) continue;

            const isPersonEntry =
                !!charHeader ||
                /人物|角色|姓名|外貌|外观|身高|发色|瞳色|穿搭|appearance/i.test(`${entry.comment}\n${entry.content}`);
            if (!isPersonEntry) continue;

            const cleanedHeader = charHeader?.[1] ? stripEntityDecorations(charHeader[1]) : '';
            const primaryName =
                (cleanedHeader && !META_WORLDBOOK_RE.test(cleanedHeader) ? cleanedHeader : '') ||
                (rawComment && rawComment.length <= 14 && !META_WORLDBOOK_RE.test(rawComment) ? rawComment : '');
            const aliasList = [
                ...(nickHeader ? splitNameList(nickHeader[1]) : []),
                ...(entryKeyAliases.length < 6 ? entryKeyAliases : []),
                ...(rawComment && rawComment.length <= 14 && rawComment !== primaryName ? [rawComment] : []),
            ];

            const targetName = primaryName || aliasList[0];
            if (!targetName) continue;
            const ent = findOrCreate(targetName, aliasList);
            if (ent) {
                const snippet = extractAppearanceSnippet(entry.content);
                if (snippet && (!ent.traits || snippet.length > ent.traits.length)) {
                    ent.traits = snippet;
                }
            }
        }
    }

    // 2. JS Role Profile Tables & Array Records
    for (const script of scripts) {
        // Pattern A: 'inari': { aliases: ['稻荷灵铃', '稻荷 灵铃', '灵铃'], name: '稻荷 灵铃', count: 25 }
        const slugObjRe = /['"]?([a-z][a-z0-9_]{1,24})['"]?\s*:\s*\{([^{}]{1,420})\}/gi;
        for (const m of script.content.matchAll(slugObjRe)) {
            const slug = m[1];
            const body = m[2];
            const nameMatch = /\b(?:name|cn)\s*:\s*(['"])([^'"\n]{1,24})\1/.exec(body);
            if (!nameMatch) continue;
            const aliasesMatch = /\baliases\s*:\s*\[([^\]]{0,240})\]/.exec(body);
            const aliases = aliasesMatch
                ? [...aliasesMatch[1].matchAll(/(['"])([^'"\n]{1,24})\1/g)].map((a) => a[2])
                : [];
            const countMatch = /\bcount\s*:\s*(\d{1,3})/.exec(body);
            const ent = findOrCreate(nameMatch[2], aliases);
            if (ent) {
                ent.slugs.add(slug);
                if (countMatch) ent.count = Number(countMatch[1]);
            }
        }

        // Pattern B: { id: 'cui_zhiwei', ..., cn: '崔知微', aliases: [...] }
        const recordRe = /\{\s*id\s*:\s*(['"])([a-z][a-z0-9_]{1,28})\1([^}]{1,420})\}/gi;
        for (const m of script.content.matchAll(recordRe)) {
            const slug = m[2];
            const body = m[3];
            const nameMatch = /\b(?:cn|name)\s*:\s*(['"])([^'"\n]{1,24})\1/.exec(body);
            if (!nameMatch) continue;
            const aliasesMatch = /\baliases\s*:\s*\[([^\]]{0,240})\]/.exec(body);
            const aliases = aliasesMatch
                ? [...aliasesMatch[1].matchAll(/(['"])([^'"\n]{1,24})\1/g)].map((a) => a[2])
                : [];
            const ent = findOrCreate(nameMatch[2], aliases);
            if (ent) ent.slugs.add(slug);
        }
    }

    // 3. Structured tavern_helper.variables character lists (e.g. phone_data.characters)
    const walkVariables = (node: unknown, keyPath = '') => {
        if (!node || typeof node !== 'object') return;
        if (/(?:^|\.)user$/i.test(keyPath)) return;
        if (Array.isArray(node)) {
            for (const item of node) walkVariables(item, keyPath);
            return;
        }
        const rec = node as Record<string, unknown>;
        const rawName = typeof rec.name === 'string' ? rec.name : typeof rec.cn === 'string' ? rec.cn : '';
        if (rawName && !/\{\{user\}\}/i.test(rawName)) {
            const aliases: string[] = [];
            if (typeof rec.nickname === 'string') aliases.push(rec.nickname);
            if (Array.isArray(rec.aliases)) {
                for (const a of rec.aliases) if (typeof a === 'string') aliases.push(a);
            }
            const ent = findOrCreate(rawName, aliases);
            if (ent && typeof rec.id === 'string' && /^[a-z][a-z0-9_]{1,24}$/i.test(rec.id)) {
                ent.slugs.add(rec.id);
            }
        }
        for (const [k, v] of Object.entries(rec)) {
            if (v && typeof v === 'object') walkVariables(v, keyPath ? `${keyPath}.${k}` : k);
        }
    };
    const thVars = (card.extensions?.tavern_helper as Record<string, unknown> | undefined)?.variables;
    if (thVars) walkVariables(thVars);

    // 4. Non-ensemble fallback: ensure card.name is registered
    const isEnsemble =
        /学院|世界|模拟器|群像|RPG|academy|simulator|ensemble/i.test(`${card.name} ${card.description}`) ||
        entities.length >= 3;
    if (!isEnsemble && card.name.trim()) {
        const ent = findOrCreate(card.name.trim());
        if (ent && !ent.traits && card.description) {
            ent.traits = extractAppearanceSnippet(card.description);
        }
    }

    return entities;
}

function collectJsAssets(
    scripts: { name: string; content: string }[],
    entities: InternalEntity[],
): CandidateAsset[] {
    const candidates: CandidateAsset[] = [];

    for (const script of scripts) {
        const content = script.content;
        const baseUrls: string[] = [];
        for (const m of content.matchAll(/(?:var|let|const)\s+[A-Za-z_$][\w$]*\s*=\s*(['"])(https?:\/\/[^'"\s]+\/)\1/g)) {
            if (!baseUrls.includes(m[2])) baseUrls.push(m[2]);
        }

        // Alt-slug ternary overrides (e.g. id==='huo_ling'?'NEWhuo_ling':id)
        const altSlugMap = new Map<string, string>();
        for (const m of content.matchAll(/===?\s*(['"])([a-z][a-z0-9_]{1,24})\1\s*\?\s*(['"])([A-Za-z0-9_]{2,32})\3/g)) {
            altSlugMap.set(m[2], m[4]);
        }

        // 3a & 3b: Slug-driven expansion when baseUrl is present
        if (baseUrls.length) {
            const primaryBase = baseUrls[0];
            const hasJpgConcat = /['"]\.jpg['"]/i.test(content);
            const hasPngBackup = /['"]\.png['"]/i.test(content);
            const hasDailySuffix = /['"]_daily\.png['"]/i.test(content);

            for (const ent of entities) {
                for (const slug of ent.slugs) {
                    if (typeof ent.count === 'number' && ent.count > 0 && hasJpgConcat) {
                        const cap = Math.min(ent.count, 6);
                        for (let i = 1; i <= cap; i++) {
                            const url = `${primaryBase}${slug}_${i}.jpg`;
                            if (!isSafeHttpImageUrl(url)) continue;
                            candidates.push({
                                url,
                                ...(hasPngBackup ? { fallbackUrls: [`${primaryBase}${slug}_${i}.png`] } : {}),
                                label: `NO.${String(i).padStart(2, '0')}`,
                                tags: ['cg'],
                                confidence: i === 1 ? 0.94 : 0.91,
                                boundTo: ent.canonical,
                            });
                        }
                    } else if (hasDailySuffix) {
                        const effectiveSlug = altSlugMap.get(slug) ?? slug;
                        const url = `${primaryBase}${effectiveSlug}_daily.png`;
                        if (isSafeHttpImageUrl(url)) {
                            candidates.push({
                                url,
                                label: `${ent.canonical} daily`,
                                tags: ['daily', 'portrait'],
                                confidence: 0.94,
                                boundTo: ent.canonical,
                            });
                        }
                    }
                }
            }

            // 3c: Relative image filename literals inside JS objects/assignments
            const relImgRe = /(['"])([^'"\s<>/{}$]+\.(?:png|jpe?g|webp))\1/gi;
            for (const m of content.matchAll(relImgRe)) {
                const relFile = m[2];
                if (/^\.(?:png|jpe?g|webp)$/i.test(relFile) || /^_(?:daily|q)\./i.test(relFile)) continue;
                if (NSFW_RE.test(relFile) || CHIBI_OR_UI_RE.test(relFile)) continue;

                const idx = m.index ?? 0;
                const contextBefore = content.slice(Math.max(0, idx - 140), idx);
                const keyMatches = [...contextBefore.matchAll(/(['"]?)([A-Za-z0-9_\u4e00-\u9fa5]{1,18})\1\s*:/g)];
                const tags = keyMatches.slice(-3).map((km) => km[2]).filter(Boolean);
                if (tags.some((t) => NSFW_RE.test(t) || CHIBI_OR_UI_RE.test(t))) continue;

                const url = `${primaryBase}${relFile}`;
                if (!isSafeHttpImageUrl(url)) continue;
                const isPortrait = /立绘|daily|日常|portrait/i.test(relFile) || tags.some((t) => /日常|制服|外出|舞蹈服|highschool|adult/i.test(t));
                const isOpening = /开场/.test(relFile);
                candidates.push({
                    url,
                    label: relFile.replace(/\.[^.]+$/, ''),
                    tags,
                    confidence: isPortrait ? 0.94 : isOpening ? 0.84 : 0.88,
                });
            }
        }

        // 3d: Direct HTTP(S) image literals inside script
        for (const m of content.matchAll(/https?:\/\/[^\s"'`<>\)\]]+\.(?:png|jpe?g|webp)(?:\?[^\s"'`<>\)\]]*)?/gi)) {
            if (isSafeHttpImageUrl(m[0])) {
                candidates.push({ url: m[0], tags: [], confidence: 0.88 });
            }
        }
    }

    return candidates;
}

function collectMarkdownAndHtmlAssets(texts: string[]): CandidateAsset[] {
    const candidates: CandidateAsset[] = [];
    for (const text of texts) {
        if (!text) continue;
        // Markdown links/images: ![label](url) or [label](url)
        for (const m of text.matchAll(/!?\[([^\]]{1,80})\]\((https?:\/\/[^\s)"']+)\)/g)) {
            const rawLabel = m[1].trim();
            const url = m[2].trim();
            if (!isSafeHttpImageUrl(url)) continue;
            const tags = [...rawLabel.matchAll(/[（(]([^）)]{1,20})[）)]/g)].map((t) => t[1].trim());
            const cleanLabel = rawLabel.replace(/[（(][^）)]*[）)]/g, '').trim();
            candidates.push({
                url,
                label: rawLabel,
                tags,
                confidence: 0.93,
                ...(cleanLabel && cleanLabel.length <= 16 ? { boundToHint: cleanLabel } : {}),
            } as CandidateAsset);
        }
        // HTML <img> tags
        for (const m of text.matchAll(/<img\b[^>]*\bsrc\s*=\s*(["'])(https?:\/\/[^"']+)\1[^>]*>/gi)) {
            const url = m[2].trim();
            if (!isSafeHttpImageUrl(url)) continue;
            const alt = /\balt\s*=\s*(["'])([^"']{1,60})\1/i.exec(m[0])?.[2]?.trim();
            const backup = /\bdata-backup\s*=\s*(["'])(https?:\/\/[^"']+)\1/i.exec(m[0])?.[2]?.trim();
            candidates.push({
                url,
                ...(backup && isSafeHttpImageUrl(backup) ? { fallbackUrls: [backup] } : {}),
                ...(alt ? { label: alt } : {}),
                tags: [],
                confidence: 0.90,
            });
        }
        // Bare HTTP(S) image URLs
        for (const m of text.matchAll(/https?:\/\/[^\s"'`<>\)\]]+\.(?:png|jpe?g|webp)(?:\?[^\s"'`<>\)\]]*)?/gi)) {
            if (isSafeHttpImageUrl(m[0])) {
                candidates.push({ url: m[0], tags: [], confidence: 0.85 });
            }
        }
    }
    return candidates;
}

const SFW_ARRAY_DISALLOW_KEY_RE = /(?:nsfw|r18|只在色情|色情场景(?:时)?可用|色情专用|成人|h图)/i;

function collectTemplatePicAssets(
    scripts: { name: string; content: string; findRegex?: string }[],
    texts: string[],
    books: (NormalizedLorebook | null | undefined)[],
): CandidateAsset[] {
    const templates: { prefix: string; suffix: string }[] = [];
    const seenTpl = new Set<string>();
    for (const s of scripts) {
        for (const m of s.content.matchAll(/https?:\/\/[^\s"'<>]*\$1[^\s"'<>]*/g)) {
            const rawTpl = m[0];
            const idx = rawTpl.indexOf('$1');
            if (idx <= 0 || rawTpl.indexOf('$1', idx + 2) !== -1) continue;
            const prefix = rawTpl.slice(0, idx);
            const suffix = rawTpl.slice(idx + 2);
            if (!isSafeHttpImageUrl(`${prefix}SFW/sample1${suffix}`)) continue;
            const tplKey = `${prefix}|${suffix}`;
            if (seenTpl.has(tplKey)) continue;
            seenTpl.add(tplKey);
            templates.push({ prefix, suffix });
        }
    }
    if (!templates.length) return [];

    const candidates: CandidateAsset[] = [];
    const seenUrls = new Set<string>();
    const usesSfwDir = texts.some((t) => /<pic>\s*SFW\//i.test(t));

    const addPath = (rawPath: string, keyHint: string, baseConfidence: number) => {
        const resolved = rawPath
            .replace(/\{\{roll\s*:\s*d\d+\}\}/gi, '1')
            .trim()
            .replace(/^\/+|\/+$/g, '');
        if (!resolved || NSFW_RE.test(resolved) || /\bNSFW\b/i.test(resolved) || CHIBI_OR_UI_RE.test(resolved)) return;
        const normalized =
            !/^SFW\//i.test(resolved) && (/sfw/i.test(keyHint) || usesSfwDir)
                ? `SFW/${resolved}`
                : resolved;
        const encoded = normalized.split('/').map((seg) => encodeURIComponent(seg)).join('/');
        const isNeutral = /通常|日常|微笑|高兴|正常|立绘|portrait/i.test(normalized);
        const confidence = isNeutral ? 0.95 : baseConfidence;
        const tags = isNeutral ? ['portrait', 'sfw'] : ['sfw'];
        const label = normalized.replace(/^SFW\//i, '');
        for (const { prefix, suffix } of templates) {
            const url = `${prefix}${encoded}${suffix}`;
            if (seenUrls.has(url) || !isSafeHttpImageUrl(url)) continue;
            seenUrls.add(url);
            candidates.push({ url, label, tags, confidence });
        }
    };

    for (const text of texts) {
        if (!text) continue;
        for (const m of text.matchAll(/<pic>\s*([^<\n]{2,120}?)\s*<\/pic>/gi)) {
            addPath(m[1], '', 0.90);
        }
    }

    const seenBookEntries = new Set<string>();
    for (const book of books) {
        for (const entry of book?.entries ?? []) {
            if (entry.disabled || NSFW_RE.test(entry.comment)) continue;
            const dedupKey = `${entry.comment.trim()}|${entry.keys.join(',')}|${entry.content.slice(0, 120)}`;
            if (seenBookEntries.has(dedupKey)) continue;
            seenBookEntries.add(dedupKey);

            const extractArrayItems = (arrKey: string, items: string[]) => {
                if (SFW_ARRAY_DISALLOW_KEY_RE.test(arrKey)) return;
                if (!/sfw|图片|插画|立绘|cg|portrait/i.test(arrKey)) return;
                const safeItems = items.filter(
                    (item) => typeof item === 'string' && !NSFW_RE.test(item) && !/\bNSFW\b/i.test(item),
                );
                safeItems.sort((a, b) => {
                    const na = /通常|日常|微笑|高兴|正常|立绘|portrait/i.test(a) ? 0 : 1;
                    const nb = /通常|日常|微笑|高兴|正常|立绘|portrait/i.test(b) ? 0 : 1;
                    return na - nb;
                });
                for (const item of safeItems.slice(0, 3)) {
                    addPath(item, arrKey, 0.89);
                }
            };

            const trimmed = entry.content.trim();
            if (trimmed.startsWith('{')) {
                try {
                    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
                    for (const [k, v] of Object.entries(parsed)) {
                        if (Array.isArray(v)) extractArrayItems(k, v.filter((x): x is string => typeof x === 'string'));
                    }
                    continue;
                } catch {
                    // Fall through to regex extraction for non-strict JSON
                }
            }

            for (const m of entry.content.matchAll(/"([^"\n]{1,80})"\s*:\s*\[([\s\S]*?)\]/g)) {
                const items = [...m[2].matchAll(/"([^"\n]{2,120})"/g)].map((im) => im[1]);
                if (items.length) extractArrayItems(m[1], items);
            }
        }
    }

    return candidates;
}

function collectExtensionObjectAssets(card: NormalizedCharacterCard): CandidateAsset[] {
    const candidates: CandidateAsset[] = [];
    const ext = card.extensions;
    if (!ext || typeof ext !== 'object') return candidates;

    const IMAGE_FIELDS = new Set(['avatar', 'portrait', 'img', 'image', 'stand', 'cg', '立绘', '头像']);
    const walk = (node: unknown, pathKey = '') => {
        if (!node || typeof node !== 'object') return;
        if (/(?:^|\.)(?:user|regex_scripts|xiaobaix-tasks|RubyAnalyzer)$/i.test(pathKey)) return;
        if (Array.isArray(node)) {
            for (const item of node) walk(item, pathKey);
            return;
        }
        const rec = node as Record<string, unknown>;
        const ownerName =
            typeof rec.name === 'string' ? rec.name :
                typeof rec.cn === 'string' ? rec.cn :
                    typeof rec.character === 'string' ? rec.character : '';
        for (const [k, v] of Object.entries(rec)) {
            if (typeof v === 'string' && IMAGE_FIELDS.has(k.toLowerCase()) && isSafeHttpImageUrl(v, true)) {
                candidates.push({
                    url: v,
                    label: ownerName ? `${ownerName} ${k}` : k,
                    tags: [k],
                    confidence: 0.95,
                    ...(ownerName && !/\{\{user\}\}/i.test(ownerName) ? { boundTo: ownerName.trim() } : {}),
                });
            } else if (v && typeof v === 'object' && k !== 'scripts') {
                walk(v, pathKey ? `${pathKey}.${k}` : k);
            }
        }
    };
    walk(ext);
    return candidates;
}

function matchSlugBoundary(haystack: string, slug: string): boolean {
    const escaped = slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?:^|[/_.\\-])${escaped}(?:$|[/_.\\-0-9])`, 'i').test(haystack);
}

function resolveEntityByNameOrHint(entities: InternalEntity[], rawName: string): InternalEntity | undefined {
    const comp = compactName(rawName);
    return entities.find(
        (e) => e.canonical === rawName || e.compact === comp || e.aliases.has(rawName) || e.aliases.has(comp),
    );
}

function scoreMatch(ent: InternalEntity, candidate: CandidateAsset): number {
    if (candidate.boundTo) {
        const compBound = compactName(candidate.boundTo);
        if (ent.canonical === candidate.boundTo || ent.compact === compBound || ent.aliases.has(candidate.boundTo) || ent.aliases.has(compBound)) {
            return candidate.confidence;
        }
        return 0;
    }
    const decoded = decodeSafe(`${candidate.url ?? ''} ${candidate.localGalleryPath ?? ''} ${candidate.label ?? ''}`);
    // 1. Canonical or multi-char alias match
    if (decoded.includes(ent.canonical) || decoded.includes(ent.compact)) {
        return Math.max(candidate.confidence, 0.90);
    }
    for (const alias of ent.aliases) {
        if (alias.length >= 2 && decoded.includes(alias)) {
            return Math.max(candidate.confidence, 0.90);
        }
    }
    // 2. Strict token-boundary slug match (prevents shio matching shion)
    for (const slug of ent.slugs) {
        if (slug.length >= 2 && matchSlugBoundary(decoded, slug)) {
            return Math.max(candidate.confidence, 0.89);
        }
    }
    return 0;
}

const WORLD_ENTRY_COMMENT_RE = /世界观|背景|世界设定|地理|时代|舞台|日程|城镇|小镇|学院|学园|设定集|overview|setting|world|lore|era|background|geography|premise/i;
const META_NOISE_LINE_RE = /^(?:使用说明|注意事项说明|本文件为|不得在正文|写作基准|核心原则|任务[:：]|性质[:：]|用途[:：]|<FORMAT_RULE|<rule_|#\s*(?:触发词|场景结算)|\{?\s*"CONSTRAINT_LIBRARY")/;
const PHOTOREAL_CUE_RE = /写实风格|照片质感|摄影风|真人实拍|实景摄影|photorealistic|live[\s-]*action|film photography/i;
const MODERN_ERA_CUE_RE = /20[0-3]\d年|手机|智能机|电视|冰箱|空调|便利店|T恤|短裤|拖鞋|牛仔裤|帆布鞋|卫衣|运动服|校服|制服|高中|高[一二三]|初[一二三]|大学|暑假|寒假|公寓|沙发|可乐|冰棒|瓷砖|电脑|笔记本|网吧|游戏机|公交|电车|地铁|高铁|柏油路|现代|都市|smartphone|television|high school|modern|contemporary/i;
const JP_SLICE_OF_LIFE_CUE_RE = /神社|鸟居|巫女|电车|和室|榻榻米|蝉鸣|夏日祭|潮灯祭|花火大会|浴衣|木廊|拉门|商店街|町|学园|高二|社团/i;
const SCIFI_ERA_CUE_RE = /赛博|义体|机甲|星际|飞船|太空|宇航|全息|虚拟现实|空间站|殖民星|cyberpunk|sci-fi|futuristic|mecha|spaceship|starship/i;
const FANTASY_ERA_CUE_RE = /魔法|魔导|精灵|骑士团|魔王|冒险者|公会|地下城|剑与魔法|圣骑士|中世纪|炼金术|fantasy|magic|knight|elf|dungeon|medieval/i;
const HISTORICAL_EASTERN_CUE_RE = /江湖|武林|仙侠|修仙|修真|朝廷|皇帝|皇宫|将军|宰相|丞相|王爷|宗门|弟子|灵气|金丹|元婴|内功|剑气|汉服|佩剑|青衫|大宋|大唐|大明|大清|古代|古风|xianxia|wuxia|ancient china|cultivation/i;

function sanitizeSettingText(raw: string): string {
    return raw
        .replace(/```[\s\S]*?(?:```|$)/g, ' ')
        .replace(/<(FORMAT_RULE|script|style|scene_cover|UpdateVariable|think|thinking|reasoning)[\s\S]*?(?:<\/\1\s*>|$)/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\{\{(?:user|char)\}\}/gi, '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !META_NOISE_LINE_RE.test(line))
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
}

export function extractWorldVisualBaseline(
    card: NormalizedCharacterCard,
    books: (NormalizedLorebook | null | undefined)[],
): { worldContext?: string; inferredStyle: string } {
    const snippets: string[] = [];
    const pushSnippet = (raw: string, maxLen: number) => {
        const clean = sanitizeSettingText(raw);
        if (!clean || clean.length < 8) return;
        const cut = clean.slice(0, maxLen);
        if (!snippets.some((s) => s.includes(cut))) snippets.push(cut);
    };

    if (card.scenario) pushSnippet(card.scenario, 160);
    if (card.description) pushSnippet(card.description, 160);

    const seenEntries = new Set<string>();
    for (const book of books) {
        for (const entry of book?.entries ?? []) {
            if (entry.disabled || NSFW_RE.test(entry.comment)) continue;
            if (!WORLD_ENTRY_COMMENT_RE.test(entry.comment) && !WORLD_ENTRY_COMMENT_RE.test(entry.content.slice(0, 80))) {
                continue;
            }
            const dedupKey = `${entry.comment.trim()}|${entry.content.slice(0, 100)}`;
            if (seenEntries.has(dedupKey)) continue;
            seenEntries.add(dedupKey);
            pushSnippet(entry.content, 180);
            if (snippets.length >= 4) break;
        }
        if (snippets.length >= 4) break;
    }

    const firstMesClean = sanitizeSettingText(card.firstMessage ?? '');
    if (firstMesClean) pushSnippet(firstMesClean, 220);

    const worldContext = snippets.join('；').slice(0, 360).trim() || undefined;
    const signalCorpus = [
        (card.tags ?? []).join(' '),
        card.name,
        worldContext ?? '',
        firstMesClean.slice(0, 700),
    ].join(' ');

    const isModern = MODERN_ERA_CUE_RE.test(signalCorpus);
    const isJpSlice = JP_SLICE_OF_LIFE_CUE_RE.test(signalCorpus);
    const isSciFi = SCIFI_ERA_CUE_RE.test(signalCorpus);
    const isFantasy = FANTASY_ERA_CUE_RE.test(signalCorpus);
    const isHistoricalEastern = HISTORICAL_EASTERN_CUE_RE.test(signalCorpus);
    const isPhoto = PHOTOREAL_CUE_RE.test(signalCorpus);

    let inferredStyle: string;
    if (isPhoto) {
        if (isModern) inferredStyle = 'modern contemporary setting, cinematic photography, natural film lighting, modern everyday clothing';
        else if (isSciFi) inferredStyle = 'sci-fi futuristic setting, cinematic film still, dramatic lighting';
        else if (isHistoricalEastern && !isModern) inferredStyle = 'historical period setting, cinematic photography, natural lighting';
        else inferredStyle = 'cinematic photography, natural film lighting';
    } else if (isModern) {
        inferredStyle = isJpSlice
            ? 'modern contemporary Japanese setting, anime visual novel CG illustration, vibrant natural lighting, modern everyday clothing'
            : 'modern contemporary setting, detailed anime illustration, natural lighting, modern everyday clothing';
    } else if (isSciFi) {
        inferredStyle = 'sci-fi futuristic setting, detailed anime illustration, sleek atmospheric lighting';
    } else if (isFantasy) {
        inferredStyle = 'fantasy setting, atmospheric anime illustration, dramatic lighting';
    } else if (isHistoricalEastern) {
        inferredStyle = 'historical eastern setting, painterly atmospheric illustration, traditional period attire';
    } else {
        inferredStyle = 'anime visual novel illustration, clean lineart, atmospheric cinematic lighting';
    }

    return { worldContext, inferredStyle };
}

const indexCache = new Map<string, CardVisualIndex>();

export function buildCardVisualIndex(
    card: NormalizedCharacterCard,
    books: (NormalizedLorebook | null | undefined)[],
    gallery: StoryGallery | null,
): CardVisualIndex {
    const galleryFiles = (gallery?.files ?? []).filter((f) => /\.(?:png|jpe?g|webp)$/i.test(f));
    const scripts = collectScriptContents(card);
    const entities = buildCharacterEntities(card, books, scripts);

    // Collect remote candidates from all card surfaces (deduped worldbook entries)
    const texts: string[] = [
        card.firstMessage,
        ...(card.alternateGreetings ?? []),
        card.description,
    ];
    const seenTextEntries = new Set<string>();
    for (const book of books) {
        for (const entry of book?.entries ?? []) {
            if (entry.disabled || NSFW_RE.test(entry.comment)) continue;
            const key = `${entry.comment.trim()}|${entry.keys.join(',')}|${entry.content.slice(0, 120)}`;
            if (seenTextEntries.has(key)) continue;
            seenTextEntries.add(key);
            texts.push(entry.content);
        }
    }

    const rawCandidates: CandidateAsset[] = [
        ...collectExtensionObjectAssets(card),
        ...collectJsAssets(scripts, entities),
        ...collectTemplatePicAssets(scripts, texts, books),
        ...collectMarkdownAndHtmlAssets(texts),
    ];

    // Deduplicate remote candidates by URL, preserving highest confidence & boundTo
    const byUrl = new Map<string, CandidateAsset>();
    for (const c of rawCandidates) {
        if (!c.url) continue;
        const prev = byUrl.get(c.url);
        if (!prev) {
            byUrl.set(c.url, { ...c, tags: [...new Set(c.tags)] });
        } else {
            if (c.confidence > prev.confidence) prev.confidence = c.confidence;
            if (c.boundTo && !prev.boundTo) prev.boundTo = c.boundTo;
            if (c.label && !prev.label) prev.label = c.label;
            if (c.fallbackUrls?.length && !prev.fallbackUrls?.length) prev.fallbackUrls = c.fallbackUrls;
            prev.tags = [...new Set([...prev.tags, ...c.tags])];
        }
    }

    // Build local StoryGallery suffix map (mirrors gallery-runtime.ts)
    const cleanGallery = galleryFiles.filter((f) => !NSFW_RE.test(f) && !CHIBI_OR_UI_RE.test(f));
    const suffixes = new Map<string, string | null>();
    for (const file of cleanGallery) {
        const parts = file.split('/');
        for (let i = 0; i < parts.length; i++) {
            const suffix = parts.slice(i).join('/').toLocaleLowerCase();
            suffixes.set(suffix, suffixes.has(suffix) ? null : file);
        }
    }

    const matchedLocal = new Set<string>();
    for (const c of byUrl.values()) {
        if (!c.url) continue;
        try {
            const pathname = decodeSafe(new URL(c.url).pathname);
            const parts = pathname.split('/').filter(Boolean);
            for (let i = 0; i < parts.length; i++) {
                const file = suffixes.get(parts.slice(i).join('/').toLocaleLowerCase());
                if (file) {
                    c.localGalleryPath = file;
                    matchedLocal.add(file);
                    break;
                }
            }
        } catch {
            // Ignore malformed URL
        }
    }

    const allCandidates: CandidateAsset[] = [...byUrl.values()];
    for (const file of cleanGallery) {
        if (!matchedLocal.has(file)) {
            allCandidates.push({
                localGalleryPath: file,
                label: file.split('/').pop()?.replace(/\.[^.]+$/, ''),
                tags: [],
                confidence: 0.92,
            });
        }
    }

    const assetsById = new Map<string, IndexedCardAsset>();
    const registerCardAsset = (c: CandidateAsset): MediaRef => {
        if (c.localGalleryPath && !c.url) {
            return { source: 'story.gallery', characterId: card.id, path: c.localGalleryPath };
        }
        const key = c.url ?? `local:${c.localGalleryPath}`;
        const assetId = `ca_${hash36(key)}`;
        if (!assetsById.has(assetId)) {
            assetsById.set(assetId, {
                assetId,
                ...(c.url ? { url: c.url } : {}),
                ...(c.fallbackUrls?.length ? { fallbackUrls: c.fallbackUrls } : {}),
                ...(c.localGalleryPath ? { localGalleryPath: c.localGalleryPath } : {}),
                ...(c.label ? { label: c.label } : {}),
                tags: c.tags,
            });
        }
        return { source: 'card.asset', characterId: card.id, assetId };
    };

    const isEnsemble =
        /学院|世界|模拟器|群像|RPG|academy|simulator|ensemble/i.test(`${card.name} ${card.description}`) ||
        entities.length >= 3;

    // Bind candidates to entities
    for (const c of allCandidates) {
        if (c.boundTo) {
            const ent = resolveEntityByNameOrHint(entities, c.boundTo);
            if (ent) {
                const ref = registerCardAsset(c);
                ent.references.push({
                    ref,
                    ...(c.label ? { label: c.label } : {}),
                    ...(c.tags.length ? { tags: c.tags } : {}),
                    confidence: c.confidence,
                    origin: c.localGalleryPath ? 'local-gallery' : 'remote-card',
                });
            }
            continue;
        }

        let bestEnt: InternalEntity | undefined;
        let bestScore = 0;
        for (const ent of entities) {
            const s = scoreMatch(ent, c);
            if (s > bestScore) {
                bestScore = s;
                bestEnt = ent;
            }
        }
        if (!bestEnt && !isEnsemble && entities.length === 1 && c.confidence >= 0.84) {
            const decoded = decodeSafe(`${c.url ?? ''} ${c.localGalleryPath ?? ''} ${c.label ?? ''}`);
            if (/立绘|portrait|daily|开场/i.test(decoded)) {
                bestEnt = entities[0];
                bestScore = 0.82;
            }
        }
        if (bestEnt && bestScore > 0) {
            const ref = registerCardAsset(c);
            bestEnt.references.push({
                ref,
                ...(c.label ? { label: c.label } : {}),
                ...(c.tags.length ? { tags: c.tags } : {}),
                confidence: bestScore,
                origin: c.localGalleryPath ? 'local-gallery' : 'remote-card',
            });
        }
    }

    // Sort, deduplicate, and project CharacterVisualEntry[]
    const people = new Set<string>();
    const profiles: Record<string, string> = {};
    const characters: CharacterVisualEntry[] = [];

    for (const ent of entities) {
        people.add(ent.canonical);
        if (ent.compact !== ent.canonical) people.add(ent.compact);
        for (const a of ent.aliases) {
            if (people.size < 128) people.add(a);
        }
        if (ent.traits) {
            if (!Object.hasOwn(profiles, ent.canonical) && Object.keys(profiles).length < 64) {
                profiles[ent.canonical] = ent.traits;
            }
            if (ent.compact !== ent.canonical && !Object.hasOwn(profiles, ent.compact) && Object.keys(profiles).length < 64) {
                profiles[ent.compact] = ent.traits;
            }
        }

        const deduped: CharacterVisualAsset[] = [];
        const seenRefs = new Set<string>();
        const sorted = [...ent.references].sort((a, b) => {
            const scoreA = a.confidence + (a.origin === 'local-gallery' ? 0.03 : 0);
            const scoreB = b.confidence + (b.origin === 'local-gallery' ? 0.03 : 0);
            return scoreB - scoreA;
        });
        for (const item of sorted) {
            const rk = JSON.stringify(item.ref);
            if (seenRefs.has(rk)) continue;
            seenRefs.add(rk);
            deduped.push(item);
            if (deduped.length >= 8) break;
        }

        characters.push({
            name: ent.canonical,
            aliases: [...ent.aliases],
            ...(ent.traits ? { traits: ent.traits } : {}),
            references: deduped,
        });
    }

    const { worldContext, inferredStyle } = extractWorldVisualBaseline(card, books);
    const fingerprint = hash36(`${card.id}:${card.name}:${gallery?.version ?? ''}:${books.length}:${scripts.length}`);
    return {
        characterId: card.id,
        fingerprint,
        people: [...people].slice(0, 128),
        profiles,
        gallery: galleryFiles.slice(0, 256),
        characters: characters.slice(0, 48),
        assetsById,
        worldContext,
        inferredStyle,
    };
}

export function getCardVisualIndex(
    card: NormalizedCharacterCard,
    books: (NormalizedLorebook | null | undefined)[],
    gallery: StoryGallery | null,
): CardVisualIndex {
    const key = `${card.id}:${gallery?.version ?? ''}:${books.length}:${card.regexScripts?.length ?? 0}`;
    const cached = indexCache.get(key);
    if (cached) return cached;

    const index = buildCardVisualIndex(card, books, gallery);
    if (indexCache.size >= 8) {
        const oldest = indexCache.keys().next().value;
        if (oldest !== undefined) indexCache.delete(oldest);
    }
    indexCache.set(key, index);
    return index;
}

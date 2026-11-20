import type { LorebookActivationHit, LorebookTimedState, NormalizedLorebook, NormalizedLorebookEntry } from '../types';
import { WorldInfoTimedEffects } from './worldinfo-effects';

interface AhoNode {
    next: Map<string, number>;
    fail: number;
    outputs: Array<{ patternIndex: number; keyword: string }>;
}

/**
 * High-speed Aho-Corasick multi-pattern automaton for scanning hundreds of Lorebook keywords
 * in O(N + M) time without locking the UI thread.
 */
export class AhoCorasickAutomaton {
    private nodes: AhoNode[] = [{ next: new Map(), fail: 0, outputs: [] }];

    constructor(keywords: string[]) {
        keywords.forEach((rawKw, idx) => {
            const kw = rawKw.toLowerCase();
            if (!kw) return;
            let curr = 0;
            for (const ch of kw) {
                let nextNode = this.nodes[curr]!.next.get(ch);
                if (nextNode === undefined) {
                    nextNode = this.nodes.length;
                    this.nodes.push({ next: new Map(), fail: 0, outputs: [] });
                    this.nodes[curr]!.next.set(ch, nextNode);
                }
                curr = nextNode;
            }
            this.nodes[curr]!.outputs.push({ patternIndex: idx, keyword: rawKw });
        });

        this.buildFailureLinks();
    }

    private buildFailureLinks(): void {
        const queue: number[] = [];
        for (const [, childIdx] of this.nodes[0]!.next) {
            this.nodes[childIdx]!.fail = 0;
            queue.push(childIdx);
        }

        for (let index = 0; index < queue.length; index++) {
            const curr = queue[index]!;
            const currNode = this.nodes[curr]!;

            for (const [ch, nextIdx] of currNode.next) {
                queue.push(nextIdx);
                let failState = currNode.fail;
                while (failState > 0 && !this.nodes[failState]!.next.has(ch)) {
                    failState = this.nodes[failState]!.fail;
                }
                const resolvedFail = this.nodes[failState]!.next.get(ch) ?? 0;
                this.nodes[nextIdx]!.fail = resolvedFail;
                if (this.nodes[resolvedFail]!.outputs.length > 0) {
                    this.nodes[nextIdx]!.outputs.push(...this.nodes[resolvedFail]!.outputs);
                }
            }
        }
    }

    public findAll(haystack: string): Set<string> {
        const matched = new Set<string>();
        const lower = haystack.toLowerCase();
        let curr = 0;
        for (const ch of lower) {
            while (curr > 0 && !this.nodes[curr]!.next.has(ch)) {
                curr = this.nodes[curr]!.fail;
            }
            curr = this.nodes[curr]!.next.get(ch) ?? 0;
            const outs = this.nodes[curr]!.outputs;
            for (let i = 0; i < outs.length; i++) {
                matched.add(outs[i]!.keyword.toLowerCase());
            }
        }
        return matched;
    }
}

function parseRegexLiteral(key: string): RegExp | null {
    const trimmed = key.trim();
    if (!trimmed.startsWith('/')) return null;
    const lastSlash = trimmed.lastIndexOf('/');
    if (lastSlash <= 1) return null;
    const pattern = trimmed.slice(1, lastSlash);
    const flags = trimmed.slice(lastSlash + 1);
    try {
        return new RegExp(pattern, flags);
    } catch {
        return null;
    }
}

function testSingleKey(key: string, text: string, prematchedLowerSet: Set<string>, entry: NormalizedLorebookEntry): boolean {
    const rx = parseRegexLiteral(key);
    if (rx) {
        return rx.test(text);
    }
    if (entry.caseSensitive) {
        if (entry.matchWholeWords) {
            const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            return new RegExp(`\\b${escaped}\\b`).test(text);
        }
        return text.includes(key);
    }
    const lowerKey = key.toLowerCase();
    if (!prematchedLowerSet.has(lowerKey)) {
        return false;
    }
    if (entry.matchWholeWords) {
        const escaped = lowerKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return new RegExp(`\\b${escaped}\\b`, 'i').test(text);
    }
    return true;
}

function checkSecondaryLogic(entry: NormalizedLorebookEntry, text: string, prematchedSet: Set<string>): boolean {
    if (entry.selective === false) return true;
    if (entry.secondaryKeys.length === 0) return true;
    const hits = entry.secondaryKeys.map((k) => testSingleKey(k, text, prematchedSet, entry));
    switch (entry.selectiveLogic) {
        case 'AND_ANY':
            return hits.some(Boolean);
        case 'AND_ALL':
            return hits.every(Boolean);
        case 'NOT_ANY':
            return !hits.some(Boolean);
        case 'NOT_ALL':
            return !hits.every(Boolean);
        default:
            return true;
    }
}

export interface LorebookScanOptions {
    lorebooks: NormalizedLorebook[];
    recentMessagesText: string[];
    /** Scan-enabled extension prompts are not chat floors and must not consume scan depth. */
    additionalScanText?: string[];
    scanDepth: number;
    maxRecursionSteps: number;
    currentMessageCount: number;
    stickyState?: Map<string, number>;
    cooldownState?: Map<string, number>;
    timedStates?: Record<string, LorebookTimedState>;
    forceActivationKeys?: Set<string>;
    externalActivationKeys?: Set<string>;
    preview?: boolean;
    generationType?: string;
    character?: { id: string; name: string; tags: string[] };
    extraScanText?: Partial<Record<'matchPersonaDescription' | 'matchCharacterDescription' | 'matchCharacterPersonality' | 'matchCharacterDepthPrompt' | 'matchScenario' | 'matchCreatorNotes', string>>;
    tokenBudget?: number;
    countTokens?: (text: string) => number;
    minActivations?: number;
    maxScanDepth?: number;
    recursive?: boolean;
    priority?: (entry: NormalizedLorebookEntry) => number;
    prepareContent?: (entry: NormalizedLorebookEntry) => string;
    onScanDone?: (event: LorebookScanEvent) => void | Promise<void>;
}

export const worldInfoScanState = { NONE: 0, INITIAL: 1, RECURSION: 2, MIN_ACTIVATIONS: 3 } as const;
export interface LorebookScanEvent {
    state: { current: number; next: number; loopCount: number };
    new: { all: NormalizedLorebookEntry[]; successful: NormalizedLorebookEntry[] };
    activated: { entries: Map<string, NormalizedLorebookEntry>; text: string };
    sortedEntries: NormalizedLorebookEntry[];
    recursionDelay: { availableLevels: number[]; currentLevel: number };
    budget: { current: number; overflowed: boolean };
    timedEffects: WorldInfoTimedEffects;
}

export interface LorebookScanResult {
    activatedEntries: NormalizedLorebookEntry[];
    hits: LorebookActivationHit[];
    nextTimedStates: Record<string, LorebookTimedState>;
    durationMs: number;
    budgetOverflowed: boolean;
}

export async function scanLorebooks(options: LorebookScanOptions): Promise<LorebookScanResult> {
    const startAt = globalThis.performance?.now?.() ?? Date.now();
    const allEntries: NormalizedLorebookEntry[] = [];
    const settings = new Map(options.lorebooks.map(book => [book.name, book]));
    for (const book of options.lorebooks) {
        for (const entry of book.entries) {
            if (entry.triggers?.length && !entry.triggers.includes(options.generationType ?? 'normal')) continue;
            const filter = entry.characterFilter;
            if (filter && options.character) {
                if (filter.names?.length) {
                    const included = filter.names.some(name => [options.character!.id, `${options.character!.id}.png`, options.character!.name].includes(name));
                    if (filter.isExclude ? included : !included) continue;
                }
                if (filter.tags?.length) {
                    const included = filter.tags.some(tag => options.character!.tags.includes(tag));
                    if (filter.isExclude ? included : !included) continue;
                }
            }
            // Disabled and empty entries remain visible to scan listeners.
            // Candidate selection below handles activation independently.
            allEntries.push(entry);
        }
    }

    const plainKeywords = () => [...new Set(allEntries.flatMap(entry => [...entry.keys, ...entry.secondaryKeys]).filter(key => !key.startsWith('/')))];
    let keywordSignature = JSON.stringify(plainKeywords());
    let automaton = new AhoCorasickAutomaton(JSON.parse(keywordSignature));
    const corpusCache = new Map<number, string>();
    const matchCache = new Map<string, Set<string>>();
    const matchesFor = (text: string): Set<string> => {
        if (!matchCache.has(text)) matchCache.set(text, automaton.findAll(text));
        return matchCache.get(text)!;
    };
    const corpusFor = (depth: number): string => {
        if (!corpusCache.has(depth)) corpusCache.set(depth, [...(depth <= 0 ? [] : options.recentMessagesText.slice(-depth)), ...(options.additionalScanText ?? [])].join('\n'));
        return corpusCache.get(depth)!;
    };
    const extraFor = (entry: NormalizedLorebookEntry) => Object.entries(options.extraScanText ?? {})
        .filter(([key, value]) => value && entry[key as keyof NormalizedLorebookEntry]).map(([, value]) => value).join('\n');
    const seedText = `${options.currentMessageCount}\n${options.recentMessagesText.join('\n')}\n${(options.additionalScanText ?? []).join('\n')}`;
    let seed = 2166136261;
    for (let i = 0; i < seedText.length; i++) seed = Math.imul(seed ^ seedText.charCodeAt(i), 16777619);
    // Stable per input: previews do not reroll activation or extend timers.
    const randomFor = (key: string): number => {
        if (!options.preview) return Math.random();
        let hash = seed;
        for (let i = 0; i < key.length; i++) hash = Math.imul(hash ^ key.charCodeAt(i), 16777619);
        hash ^= hash >>> 16;
        hash = Math.imul(hash, 0x85ebca6b);
        hash ^= hash >>> 13;
        return (hash >>> 0) / 4294967296;
    };

    const keyFor = (entry: NormalizedLorebookEntry) => `${entry.world}::${entry.uid}`;
    const publicKey = (entry: NormalizedLorebookEntry) => `${entry.world}.${entry.uid}`;
    const timedStates = options.timedStates ?? Object.fromEntries([...new Set([...(options.stickyState?.keys() ?? []), ...(options.cooldownState?.keys() ?? [])])]
        .map(key => [key, { stickyUntilFloor: options.stickyState?.get(key) ?? 0, cooldownUntilFloor: options.cooldownState?.get(key) ?? 0 }]));
    const timedEffects = new WorldInfoTimedEffects(allEntries, timedStates, options.currentMessageCount);
    timedEffects.checkTimedEffects();
    const isSticky = (entry: NormalizedLorebookEntry) => timedEffects.isEffectActive('sticky', entry);
    allEntries.sort((a, b) => Number(isSticky(b)) - Number(isSticky(a)) || (options.priority?.(a) ?? 0) - (options.priority?.(b) ?? 0) || b.order - a.order);
    const activated = new Map<string, NormalizedLorebookEntry>();
    const hitByKey = new Map<string, LorebookActivationHit>();
    const failedProbability = new Set<string>();
    const groupsFor = (entry: NormalizedLorebookEntry) => [...new Set((entry.group ?? '').split(',').map(name => name.trim()).filter(Boolean))];
    let state: number = worldInfoScanState.INITIAL;
    let loops = 0;
    let scanDepth = options.scanDepth;
    let recursionBuffer = '';
    let activatedText = '';
    let budget = options.tokenBudget ?? Infinity;
    let overflowed = false;
    let usedBudget = 0;
    const usedByBook = new Map<string, number>();
    const countTokens = options.countTokens ?? ((text: string) => Math.ceil(text.length / 4));
    const recursionDelayLevels = [...new Set(allEntries.map(entry => entry.delayUntilRecursion ?? 0).filter(Boolean))].sort((a, b) => a - b);
    let recursionDelay = recursionDelayLevels.shift() ?? 0;
    const maxDepth = Math.min(options.recentMessagesText.length, options.maxScanDepth || options.recentMessagesText.length);
    const recursive = options.recursive ?? true;
    const textFor = (entry: NormalizedLorebookEntry) => [corpusFor(entry.scanDepth ?? Math.max(settings.get(entry.world ?? '')?.scanDepth ?? options.scanDepth, scanDepth)),
        extraFor(entry), state === worldInfoScanState.MIN_ACTIVATIONS ? '' : recursionBuffer].filter(Boolean).join('\n');
    const score = (entry: NormalizedLorebookEntry): number => {
        if (!entry.keys.length) return 0;
        const text = textFor(entry), matches = matchesFor(text);
        const primary = entry.keys.filter(key => testSingleKey(key, text, matches, entry)).length;
        const secondary = entry.secondaryKeys.filter(key => testSingleKey(key, text, matches, entry)).length;
        return primary + (entry.selectiveLogic === 'AND_ANY' || entry.selectiveLogic === 'AND_ALL' && secondary === entry.secondaryKeys.length ? secondary : 0);
    };
    while (state && allEntries.length) {
        if (options.maxRecursionSteps > 0 && loops >= options.maxRecursionSteps) break;
        loops++;
        matchCache.clear();
        const candidates: NormalizedLorebookEntry[] = [];
        for (const entry of allEntries) {
            const key = keyFor(entry);
            if (entry.disabled || activated.has(publicKey(entry)) || failedProbability.has(key)) continue;
            const sticky = isSticky(entry), forced = options.forceActivationKeys?.has(key);
            const book = settings.get(entry.world ?? '');
            if (!forced && !sticky) {
                if (timedEffects.isEffectActive('cooldown', entry) || timedEffects.isEffectActive('delay', entry)) continue;
                if (entry.delayUntilRecursion && (state !== worldInfoScanState.RECURSION || entry.delayUntilRecursion > recursionDelay)) continue;
                if (state === worldInfoScanState.RECURSION && (entry.excludeRecursion || book?.recursiveScanning === false)) continue;
                if (book?.maxRecursionSteps && loops > book.maxRecursionSteps) continue;
            }
            const text = textFor(entry), matches = matchesFor(text);
            const external = options.externalActivationKeys?.has(key);
            const matchedKeys = forced ? ['[强制激活]'] : sticky ? ['[黏性持续 Sticky]'] : external ? ['[外部激活]'] : entry.constant ? ['[常驻 Constant]']
                : entry.keys.filter(keyword => testSingleKey(keyword, text, matches, entry));
            if (!matchedKeys.length || !forced && !sticky && !external && !entry.constant && !checkSecondaryLogic(entry, text, matches)) continue;
            hitByKey.set(key, { world: entry.world, uid: entry.uid, comment: entry.comment, matchedKeys, recursionLevel: loops - 1,
                reason: sticky ? 'sticky' : forced || entry.constant ? 'constant' : state === worldInfoScanState.RECURSION ? 'recursion' : 'keyword' });
            candidates.push(entry);
        }
        // Resolve groups before their contents can activate dependent entries.
        const surviving = new Set(candidates);
        const occupiedGroups = new Set([...activated.values()].flatMap(groupsFor));
        const groups = new Map<string, NormalizedLorebookEntry[]>();
        for (const entry of candidates) for (const group of groupsFor(entry)) {
            const bucket = groups.get(group) ?? []; bucket.push(entry); groups.set(group, bucket);
        }
        for (const [group, members] of groups) {
            let eligible = members.filter(entry => surviving.has(entry));
            if (eligible.some(isSticky)) { for (const entry of eligible) if (!isSticky(entry)) surviving.delete(entry); continue; }
            if (occupiedGroups.has(group)) { for (const entry of eligible) surviving.delete(entry); continue; }
            if (eligible.length <= 1) continue;
            if (eligible.some(entry => entry.useGroupScoring)) {
                const scores = new Map(eligible.map(entry => [entry, score(entry)]));
                const highest = Math.max(...scores.values());
                eligible = eligible.filter(entry => {
                    if (!entry.useGroupScoring || scores.get(entry) === highest) return true;
                    surviving.delete(entry); return false;
                });
            }
            if (eligible.length <= 1) continue;
            let picked = eligible.filter(entry => entry.groupOverride).sort((a, b) => b.order - a.order)[0];
            if (!picked) {
                let roll = randomFor(`group:${group}:${loops}`) * eligible.reduce((sum, entry) => sum + Math.max(0, entry.groupWeight ?? 100), 0);
                for (const entry of eligible) {
                    const weight = Math.max(0, entry.groupWeight ?? 100);
                    roll -= weight; if (weight > 0 && roll <= 0) { picked = entry; break; }
                }
            }
            for (const entry of eligible) if (entry !== picked) surviving.delete(entry);
        }
        const newEntries = candidates.filter(entry => surviving.has(entry));
        const successful: NormalizedLorebookEntry[] = [];
        usedBudget = countTokens(activatedText);
        let newContent = '';
        for (const entry of newEntries) {
            if (overflowed && !entry.ignoreBudget) continue;
            const key = keyFor(entry);
            if (!isSticky(entry) && !options.forceActivationKeys?.has(key) && entry.useProbability !== false && randomFor(`probability:${key}`) * 100 >= (entry.probability ?? 100)) {
                failedProbability.add(key); continue;
            }
            entry.content = options.prepareContent?.(entry) ?? entry.content;
            const cost = countTokens(entry.content + '\n');
            newContent += entry.content + '\n';
            const bookName = entry.world ?? '', used = usedByBook.get(bookName) ?? 0;
            if (!entry.ignoreBudget && usedBudget + countTokens(newContent) >= budget) { overflowed = true; continue; }
            if (!entry.ignoreBudget && used + cost > (settings.get(bookName)?.tokenBudget ?? Infinity)) continue;
            activated.set(publicKey(entry), entry); successful.push(entry);
            usedByBook.set(bookName, used + cost);
        }
        let next: number = worldInfoScanState.NONE;
        const recursionEntries = successful.filter(entry => !entry.preventRecursion);
        if (recursive && !overflowed && (recursionEntries.length || state === worldInfoScanState.MIN_ACTIVATIONS && recursionBuffer)) next = worldInfoScanState.RECURSION;
        if (!next && !overflowed && activated.size < (options.minActivations ?? 0) && scanDepth < maxDepth) {
            scanDepth++; next = worldInfoScanState.MIN_ACTIVATIONS;
        }
        if (!next && recursive && !overflowed && recursionDelayLevels.length) {
            recursionDelay = recursionDelayLevels.shift()!; next = worldInfoScanState.RECURSION;
        }
        if (next && recursionEntries.length) {
            const text = recursionEntries.map(entry => entry.content).join('\n');
            recursionBuffer += (recursionBuffer ? '\n' : '') + text;
            activatedText = text + '\n' + activatedText;
        }
        if (options.onScanDone) {
            const event: LorebookScanEvent = { state: { current: state, next, loopCount: loops }, new: { all: newEntries, successful },
                activated: { entries: activated, text: activatedText }, sortedEntries: allEntries,
                recursionDelay: { availableLevels: recursionDelayLevels, currentLevel: recursionDelay }, budget: { current: budget, overflowed }, timedEffects };
            await options.onScanDone(event);
            next = event.state.next; activatedText = event.activated.text; recursionDelay = event.recursionDelay.currentLevel;
            budget = event.budget.current; overflowed = event.budget.overflowed;
            // Rebuild only when an author listener changes the keyword collection.
            const signature = JSON.stringify(plainKeywords());
            if (signature !== keywordSignature) { automaton = new AhoCorasickAutomaton(JSON.parse(signature)); keywordSignature = signature; }
            usedByBook.clear();
            for (const entry of activated.values()) {
                const cost = countTokens(entry.content + '\n');
                usedByBook.set(entry.world ?? '', (usedByBook.get(entry.world ?? '') ?? 0) + cost);
            }
        }
        state = next;
    }
    const winners = [...activated.values()].sort((a, b) => b.order - a.order).map(entry => ({ entry,
        hit: hitByKey.get(keyFor(entry)) ?? { world: entry.world, uid: entry.uid, comment: entry.comment, matchedKeys: ['[作者事件]'], recursionLevel: loops - 1, reason: 'constant' as const } }));

    timedEffects.setTimedEffects(winners.map(winner => winner.entry));
    const nextTimedStates = timedEffects.snapshot();
    timedEffects.cleanUp();

    const endAt = globalThis.performance?.now?.() ?? Date.now();
    return {
        activatedEntries: winners.map((w) => w.entry),
        hits: winners.map((w) => w.hit),
        nextTimedStates,
        durationMs: Math.max(0, endAt - startAt),
        budgetOverflowed: overflowed,
    };
}


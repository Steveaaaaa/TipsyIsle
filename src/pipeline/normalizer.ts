import type {
    ChatMessageNode,
    NormalizedCharacterCard,
    NormalizedLorebook,
    NormalizedLorebookEntry,
    NormalizedPreset,
    NormalizedPresetPromptSlot,
    NormalizedRegexScript,
} from '../types';

function asRecord(val: unknown): Record<string, unknown> {
    return val && typeof val === 'object' && !Array.isArray(val) ? (val as Record<string, unknown>) : {};
}

function asString(val: unknown, fallback = ''): string {
    return typeof val === 'string' ? val : fallback;
}

function asNumber(val: unknown, fallback = 0): number {
    const n = Number(val);
    return Number.isFinite(n) ? n : fallback;
}

let generatedId = 0;
function uniqueId(prefix: string): string {
    return `${prefix}_${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}_${++generatedId}`}`;
}

function optionalNumber(val: unknown): number | undefined {
    if (val === undefined || val === null || val === '') return undefined;
    const n = Number(val);
    return Number.isFinite(n) ? n : undefined;
}

function asStringArray(val: unknown): string[] {
    if (Array.isArray(val)) {
        return val.map((item) => String(item ?? '').trim()).filter(Boolean);
    }
    if (typeof val === 'string' && val.trim()) {
        return val.split(',').map((s) => s.trim()).filter(Boolean);
    }
    return [];
}

export function normalizeRegexScripts(rawList: unknown): NormalizedRegexScript[] {
    if (!Array.isArray(rawList)) return [];
    return rawList.map((item, idx) => {
        const r = asRecord(item);
        const rawPlacement = Array.isArray(r.placement) ? r.placement : [];
        const placement: NormalizedRegexScript['placement'] = [];
        for (const p of rawPlacement) {
            const num = Number(p);
            if (num === 1 || p === 'user_input') placement.push('user_input');
            else if (num === 2 || p === 'ai_output') placement.push('ai_output');
            else if (num === 3 || p === 'slash_command') placement.push('slash_command');
            else if (num === 5 || p === 'world_info') placement.push('world_info');
            else if (num === 6 || p === 'reasoning') placement.push('reasoning');
            else if (p === 'input' || p === 'output' || p === 'prompt' || p === 'render') placement.push(p);
        }
        if (!Array.isArray(r.placement)) {
            placement.push('ai_output');
        }
        return {
            rawData: structuredClone(r),
            id: asString(r.id, `regex_${idx}`),
            scriptName: asString(r.scriptName || r.name, `正则脚本 #${idx + 1}`),
            findRegex: asString(r.findRegex || r.regex),
            replaceString: asString(r.replaceString ?? r.replacement),
            trimStrings: Array.isArray(r.trimStrings) ? r.trimStrings.filter((s): s is string => typeof s === 'string') : [],
            placement,
            disabled: Boolean(r.disabled),
            markdownOnly: Boolean(r.markdownOnly),
            promptOnly: Boolean(r.promptOnly),
            runOnEdit: Boolean(r.runOnEdit),
            substituteRegex: asNumber(r.substituteRegex, 0),
            minDepth: r.minDepth != null ? asNumber(r.minDepth) : null,
            maxDepth: r.maxDepth != null ? asNumber(r.maxDepth) : null,
        };
    });
}

function mapPosition(rawPos: unknown): NormalizedLorebookEntry['position'] {
    if (typeof rawPos === 'string') {
        if (
            rawPos === 'before_char' ||
            rawPos === 'after_char' ||
            rawPos === 'before_example' ||
            rawPos === 'after_example' ||
            rawPos === 'before_an' ||
            rawPos === 'after_an' ||
            rawPos === 'an_top' ||
            rawPos === 'an_bottom' ||
            rawPos === 'at_depth' || rawPos === 'outlet'
        ) {
            return rawPos;
        }
    }
    const num = Number(rawPos);
    switch (num) {
        case 0:
            return 'before_char';
        case 1:
            return 'after_char';
        case 2:
            return 'before_an';
        case 3:
            return 'after_an';
        case 4:
            return 'at_depth';
        case 5:
            return 'before_example';
        case 6:
            return 'after_example';
        case 7:
            return 'outlet';
        default:
            return 'before_char';
    }
}

function mapSelectiveLogic(rawLogic: unknown): NormalizedLorebookEntry['selectiveLogic'] {
    if (rawLogic === 'AND_ANY' || rawLogic === 'AND_ALL' || rawLogic === 'NOT_ANY' || rawLogic === 'NOT_ALL') return rawLogic;
    const num = Number(rawLogic);
    switch (num) {
        case 1:
            return 'NOT_ALL';
        case 2:
            return 'NOT_ANY';
        case 3:
            return 'AND_ALL';
        default:
            return 'AND_ANY';
    }
}

function mapRole(rawRole: unknown): 'system' | 'user' | 'assistant' {
    if (rawRole === 'user' || rawRole === 1 || rawRole === '1') return 'user';
    if (rawRole === 'assistant' || rawRole === 2 || rawRole === '2') return 'assistant';
    return 'system';
}

function compactLorebookEntryRaw(rawData: Record<string, unknown> | undefined): { value: Record<string, unknown> | undefined; changed: boolean } {
    if (!rawData || typeof rawData.content !== 'string') return { value: rawData, changed: false };
    const copy = { ...rawData };
    delete copy.content;
    return { value: copy, changed: true };
}

function compactLorebookEntriesContainer(entries: unknown): { value: unknown; changed: boolean } {
    if (Array.isArray(entries)) {
        return entries.length ? { value: [], changed: true } : { value: entries, changed: false };
    }
    if (entries && typeof entries === 'object') {
        const record = entries as Record<string, unknown>;
        let bloated = false;
        const slim: Record<string, Record<string, unknown>> = {};
        for (const [key, item] of Object.entries(record)) {
            const entry = item && typeof item === 'object' ? item as Record<string, unknown> : undefined;
            const stub: Record<string, unknown> = {};
            if (entry && entry.uid !== undefined) stub.uid = entry.uid;
            else if (entry && entry.id !== undefined) stub.id = entry.id;
            if (!entry || Object.keys(entry).some(k => k !== 'uid' && k !== 'id')) bloated = true;
            slim[key] = stub;
        }
        return bloated ? { value: slim, changed: true } : { value: entries, changed: false };
    }
    return { value: entries, changed: false };
}

function compactLorebookRaw(rawData: Record<string, unknown> | undefined): { value: Record<string, unknown> | undefined; changed: boolean } {
    if (!rawData || rawData.entries === undefined) return { value: rawData, changed: false };
    const { value: compactedEntries, changed } = compactLorebookEntriesContainer(rawData.entries);
    if (!changed) return { value: rawData, changed: false };
    return { value: { ...rawData, entries: compactedEntries }, changed: true };
}

function compactCardRaw(rawData: Record<string, unknown> | undefined): { value: Record<string, unknown> | undefined; changed: boolean } {
    if (!rawData) return { value: rawData, changed: false };
    let changed = false;
    const stripExtensions = (ext: unknown): unknown => {
        if (!ext || typeof ext !== 'object' || !('tavern_helper' in ext)) return ext;
        changed = true;
        const copy = { ...(ext as Record<string, unknown>) };
        delete copy.tavern_helper;
        return copy;
    };
    const top = { ...rawData };
    for (const key of ['character_book', 'characterBook', 'embeddedLorebook']) {
        if (key in top) { delete top[key]; changed = true; }
    }
    if ('extensions' in top) top.extensions = stripExtensions(top.extensions);
    if (top.data && typeof top.data === 'object' && !Array.isArray(top.data)) {
        const dataCopy = { ...(top.data as Record<string, unknown>) };
        for (const key of ['character_book', 'characterBook', 'embeddedLorebook']) {
            if (key in dataCopy) { delete dataCopy[key]; changed = true; }
        }
        if ('extensions' in dataCopy) dataCopy.extensions = stripExtensions(dataCopy.extensions);
        top.data = dataCopy;
    }
    return { value: changed ? top : rawData, changed };
}

export function compactLorebook(book: NormalizedLorebook): { value: NormalizedLorebook; changed: boolean } {
    let changed = false;
    const rawResult = compactLorebookRaw(book.rawData);
    if (rawResult.changed) changed = true;
    const entries = book.entries.map(entry => {
        const compacted = compactLorebookEntryRaw(entry.rawData);
        if (!compacted.changed) return entry;
        changed = true;
        return { ...entry, rawData: compacted.value };
    });
    if (!changed) return { value: book, changed: false };
    return { value: { ...book, rawData: rawResult.value, entries }, changed: true };
}

export function compactCharacterCard(card: NormalizedCharacterCard): { value: NormalizedCharacterCard; changed: boolean } {
    let changed = false;
    const rawResult = compactCardRaw(card.rawData);
    if (rawResult.changed) changed = true;
    let embeddedLorebook = card.embeddedLorebook;
    if (embeddedLorebook) {
        const compacted = compactLorebook(embeddedLorebook);
        if (compacted.changed) { embeddedLorebook = compacted.value; changed = true; }
    }
    let characterBook = card.characterBook;
    if (characterBook) {
        const compacted = compactLorebook(characterBook);
        if (compacted.changed) { characterBook = compacted.value; changed = true; }
    }
    if (!changed) return { value: card, changed: false };
    return { value: { ...card, rawData: rawResult.value, embeddedLorebook, characterBook }, changed: true };
}

export function normalizeLorebook(rawBook: unknown, fallbackName = 'WorldBook'): NormalizedLorebook {
    const root = asRecord(rawBook);
    const name = asString(root.name, fallbackName);
    const rawEntries = root.entries;
    const entriesList: unknown[] = Array.isArray(rawEntries)
        ? rawEntries
        : rawEntries && typeof rawEntries === 'object'
          ? Object.values(rawEntries as Record<string, unknown>)
          : [];

    const entries: NormalizedLorebookEntry[] = entriesList.map((raw, idx) => {
        const e = asRecord(raw);
        const ext = asRecord(e.extensions);
        return {
            rawData: structuredClone(compactLorebookEntryRaw(e).value),
            uid: (e.uid ?? e.id ?? idx) as number | string,
            world: name,
            comment: asString(e.comment ?? e.name, `Entry #${idx}`),
            content: asString(e.content),
            keys: asStringArray(e.key ?? e.keys),
            secondaryKeys: asStringArray(e.keysecondary ?? e.secondary_keys ?? e.secondaryKeys),
            selectiveLogic: mapSelectiveLogic(e.selectiveLogic ?? ext.selectiveLogic),
            selective: (e.selective ?? true) !== false,
            constant: Boolean(e.constant),
            disabled: Boolean(e.disable ?? e.disabled ?? (e.enabled === false)),
            order: asNumber(e.order ?? e.insertion_order, 100),
            // ST stores its precise enum in extensions; the card spec only has before/after_char.
            position: mapPosition(ext.position ?? e.position),
            outletName: asString(e.outletName ?? ext.outlet_name),
            depth: asNumber(e.depth ?? ext.depth, 4),
            role: mapRole(e.role ?? ext.role),
            probability: asNumber(e.probability ?? ext.probability, 100),
            useProbability: (e.useProbability ?? ext.useProbability ?? ext.use_probability) !== false,
            excludeRecursion: Boolean(e.excludeRecursion ?? ext.exclude_recursion),
            preventRecursion: Boolean(e.preventRecursion ?? ext.prevent_recursion),
            delayUntilRecursion: asNumber(e.delayUntilRecursion ?? ext.delay_until_recursion, 0),
            sticky: asNumber(e.sticky ?? ext.sticky, 0),
            cooldown: asNumber(e.cooldown ?? ext.cooldown, 0),
            delay: asNumber(e.delay ?? ext.delay, 0),
            group: asString(e.group ?? ext.group),
            groupOverride: Boolean(e.groupOverride ?? ext.group_override),
            groupWeight: asNumber(e.groupWeight ?? ext.group_weight, 100),
            useGroupScoring: Boolean(e.useGroupScoring ?? ext.use_group_scoring),
            caseSensitive: Boolean(e.caseSensitive ?? ext.case_sensitive),
            matchWholeWords: Boolean(e.matchWholeWords ?? ext.match_whole_words),
            scanDepth: optionalNumber(e.scanDepth ?? ext.scan_depth),
            ignoreBudget: Boolean(e.ignoreBudget ?? ext.ignore_budget),
            automationId: asString(e.automationId ?? ext.automation_id),
            vectorized: Boolean(e.vectorized ?? ext.vectorized),
            triggers: asStringArray(e.triggers ?? ext.triggers),
            characterFilter: (() => { const filter = asRecord(e.characterFilter ?? ext.character_filter); return {
                isExclude: !!filter.isExclude, names: asStringArray(filter.names), tags: asStringArray(filter.tags),
            }; })(),
            matchPersonaDescription: !!(e.matchPersonaDescription ?? ext.match_persona_description),
            matchCharacterDescription: !!(e.matchCharacterDescription ?? ext.match_character_description),
            matchCharacterPersonality: !!(e.matchCharacterPersonality ?? ext.match_character_personality),
            matchCharacterDepthPrompt: !!(e.matchCharacterDepthPrompt ?? ext.match_character_depth_prompt),
            matchScenario: !!(e.matchScenario ?? ext.match_scenario),
            matchCreatorNotes: !!(e.matchCreatorNotes ?? ext.match_creator_notes),
        };
    });

    const settings = asRecord(root.extensions);
    const id = asString(root.id, uniqueId('wb'));
    return {
        rawData: structuredClone(compactLorebookRaw(root).value),
        id, name, entries,
        scanDepth: optionalNumber(root.scanDepth ?? root.scan_depth ?? settings.scan_depth),
        tokenBudget: optionalNumber(root.tokenBudget ?? root.token_budget ?? settings.token_budget),
        recursiveScanning: typeof (root.recursiveScanning ?? root.recursive_scanning) === 'boolean'
            ? Boolean(root.recursiveScanning ?? root.recursive_scanning) : undefined,
        maxRecursionSteps: optionalNumber(root.maxRecursionSteps ?? root.max_recursion_steps ?? settings.max_recursion_steps),
    };
}

export function normalizeCharacterCard(rawCard: unknown): NormalizedCharacterCard {
    const top = asRecord(rawCard);
    const v2Data = asRecord(top.data);
    const merged = { ...top, ...v2Data };
    const extensions = { ...asRecord(top.extensions), ...asRecord(v2Data.extensions) };

    const avatar = asString(top.avatar || merged.avatar, 'default.png');
    const name = asString(merged.name || top.ch_name, 'Unnamed Character');

    const rawCharacterBook = merged.embeddedLorebook ?? merged.characterBook ?? merged.character_book ?? top.character_book;
    const embeddedLorebook = rawCharacterBook ? normalizeLorebook(rawCharacterBook, `${name}_Book`) : null;

    const regexScripts = normalizeRegexScripts(merged.regexScripts ?? extensions.regex_scripts ?? merged.regex_scripts);
    const depthPrompt = asRecord(extensions.depth_prompt);

    return {
        id: asString(top.id) || uniqueId('char'),
        rawData: structuredClone(compactCardRaw(top).value),
        specVersion: asString(top.spec_version),
        creator: asString(merged.creator),
        avatar,
        name,
        description: asString(merged.description),
        personality: asString(merged.personality),
        scenario: asString(merged.scenario),
        firstMessage: asString(merged.firstMessage ?? merged.first_mes ?? top.first_mes),
        alternateGreetings: (() => {
            const greetings = merged.alternateGreetings ?? merged.alternate_greetings;
            return Array.isArray(greetings) ? greetings.filter((g): g is string => typeof g === 'string') : [];
        })(),
        mesExample: asString(merged.mesExample ?? merged.mes_example ?? top.mes_example),
        systemPrompt: asString(merged.systemPrompt ?? merged.system_prompt),
        postHistoryInstructions: asString(merged.postHistoryInstructions ?? merged.post_history_instructions ?? merged.jailbreak),
        creatorNotes: asString(merged.creatorNotes ?? merged.creator_notes ?? top.creatorcomment),
        tags: asStringArray(merged.tags ?? top.tags),
        characterVersion: asString(merged.characterVersion ?? merged.character_version),
        primaryWorldbook: asString(extensions.world || merged.world) || null,
        additionalWorldbooks: asStringArray(extensions.extra_worlds),
        embeddedLorebook,
        regexScripts,
        extensions,
        depthPrompt: { prompt: asString(depthPrompt.prompt), depth: asNumber(depthPrompt.depth, 4), role: mapRole(depthPrompt.role) },
    };
}

export function normalizePreset(rawPreset: unknown, fallbackName = 'Default Preset'): NormalizedPreset {
    const p = asRecord(rawPreset);
    const rawPrompts = Array.isArray(p.promptSlots) ? p.promptSlots : Array.isArray(p.prompts) ? p.prompts : [];
    const promptOrderRoot = Array.isArray(p.prompt_order) ? p.prompt_order : [];
    const validGroups = promptOrderRoot.map(asRecord).filter((g) => Array.isArray(g.order));
    const orderGroup = validGroups.find((g) => Number(g.character_id) === 100001) ?? validGroups[0];
    const orderList = orderGroup ? orderGroup.order as unknown[] : promptOrderRoot;
    const hasExplicitOrder = Array.isArray(p.prompt_order);

    const orderMap = new Map<string, { enabled: boolean; index: number }>();
    orderList.forEach((item, index) => {
        const o = asRecord(item);
        const id = asString(o.identifier);
        if (id) {
            orderMap.set(id, { enabled: o.enabled !== false, index });
        }
    });

    const promptSlots: NormalizedPresetPromptSlot[] = rawPrompts.map((rawSlot, idx) => {
        const s = asRecord(rawSlot);
        const identifier = asString(s.identifier, `slot_${idx}`);
        const orderInfo = orderMap.get(identifier);
        return {
            identifier,
            name: asString(s.name, identifier),
            role: mapRole(s.role),
            content: asString(s.content),
            enabled: orderInfo ? orderInfo.enabled : !hasExplicitOrder && s.enabled !== false,
            marker: Boolean(s.marker),
            injectionPosition: s.injectionPosition === 'in_chat' || Number(s.injectionPosition ?? s.injection_position) === 1 ? 'in_chat' : 'relative',
            injectionDepth: asNumber(s.injectionDepth ?? s.injection_depth, 4),
            injectionOrder: orderInfo ? orderInfo.index : hasExplicitOrder ? orderList.length + idx : asNumber(s.injectionOrder, idx),
            depthOrder: asNumber(s.depthOrder ?? s.injection_order, 100),
            forbidOverrides: Boolean(s.forbidOverrides ?? s.forbid_overrides),
        };
    });

    if (promptSlots.length === 0) {
        promptSlots.push(
            {
                identifier: 'main',
                name: 'Main System Prompt',
                role: 'system',
                content: asString(p.main_prompt, "Write {{char}}'s next reply in a fictional chat between {{char}} and {{user}}."),
                enabled: true,
                marker: false,
                injectionPosition: 'relative',
                injectionDepth: 0,
                injectionOrder: 0,
                forbidOverrides: false,
            },
            {
                identifier: 'worldInfoBefore',
                name: 'World Info (before)',
                role: 'system',
                content: '',
                enabled: true,
                marker: true,
                injectionPosition: 'relative',
                injectionDepth: 0,
                injectionOrder: 1,
                forbidOverrides: false,
            },
            {
                identifier: 'charDescription',
                name: 'Char Description',
                role: 'system',
                content: '',
                enabled: true,
                marker: true,
                injectionPosition: 'relative',
                injectionDepth: 0,
                injectionOrder: 2,
                forbidOverrides: false,
            },
            {
                identifier: 'charPersonality',
                name: 'Char Personality',
                role: 'system',
                content: '',
                enabled: true,
                marker: true,
                injectionPosition: 'relative',
                injectionDepth: 0,
                injectionOrder: 3,
                forbidOverrides: false,
            },
            {
                identifier: 'scenario',
                name: 'Scenario',
                role: 'system',
                content: '',
                enabled: true,
                marker: true,
                injectionPosition: 'relative',
                injectionDepth: 0,
                injectionOrder: 4,
                forbidOverrides: false,
            },
            {
                identifier: 'worldInfoAfter',
                name: 'World Info (after)',
                role: 'system',
                content: '',
                enabled: true,
                marker: true,
                injectionPosition: 'relative',
                injectionDepth: 0,
                injectionOrder: 5,
                forbidOverrides: false,
            },
            {
                identifier: 'dialogueExamples',
                name: 'Chat Examples',
                role: 'system',
                content: '',
                enabled: true,
                marker: true,
                injectionPosition: 'relative',
                injectionDepth: 0,
                injectionOrder: 6,
                forbidOverrides: false,
            },
            {
                identifier: 'chatHistory',
                name: 'Chat History',
                role: 'system',
                content: '',
                enabled: true,
                marker: true,
                injectionPosition: 'relative',
                injectionDepth: 0,
                injectionOrder: 7,
                forbidOverrides: false,
            },
            {
                identifier: 'jailbreak',
                name: 'Post-History Instructions',
                role: 'system',
                content: asString(p.jailbreak_prompt, ''),
                enabled: true,
                marker: false,
                injectionPosition: 'relative',
                injectionDepth: 0,
                injectionOrder: 8,
                forbidOverrides: false,
            },
        );
    }

    promptSlots.sort((a, b) => (a.injectionOrder ?? 0) - (b.injectionOrder ?? 0));

    const parameters: Record<string, unknown> = { ...asRecord(p.parameters) };
    // Keep vendor-specific numeric sampling parameters without admitting structural objects.
    for (const [key, value] of Object.entries(p)) {
        if (typeof value === 'number' && Number.isFinite(value)) parameters[key] = value;
    }
    const parameter = (...keys: string[]): number | undefined => {
        for (const key of keys) {
            const value = optionalNumber(p[key] ?? parameters[key]);
            if (value !== undefined) return value;
        }
        return undefined;
    };

    const ext = asRecord(p.extensions);
    const regexScripts = normalizeRegexScripts(p.regexScripts ?? ext.regex_scripts ?? p.regex_scripts);

    return {
        rawData: structuredClone(p),
        id: asString(p.name, fallbackName),
        name: asString(p.name, fallbackName),
        apiId: asString(p.apiId ?? p.api_id, 'openai'),
        temperature: parameter('temperature'),
        topP: parameter('topP', 'top_p'),
        topK: parameter('topK', 'top_k'),
        minP: parameter('minP', 'min_p'),
        repetitionPenalty: parameter('repetitionPenalty', 'repetition_penalty', 'rep_pen'),
        frequencyPenalty: parameter('frequencyPenalty', 'frequency_penalty'),
        presencePenalty: parameter('presencePenalty', 'presence_penalty'),
        maxContextTokens: parameter('maxContextTokens', 'openai_max_context', 'max_context', 'max_context_length'),
        maxResponseTokens: parameter('maxResponseTokens', 'openai_max_tokens', 'max_tokens', 'max_length'),
        parameters,
        promptSlots,
        regexScripts,
    };
}

export function normalizeChatPayload(rawLines: unknown[]): ChatMessageNode[] {
    const nodes: ChatMessageNode[] = [];
    rawLines.forEach((rawItem, idx) => {
        const item = asRecord(rawItem);
        // First line in SillyTavern JSONL is often chat_metadata header without `mes`
        if (idx === 0 && !('mes' in item) && ('chat_metadata' in item || 'user_name' in item)) {
            return;
        }
        const isUser = Boolean(item.is_user);
        const isSystem = Boolean(item.is_system);
        const role: 'user' | 'assistant' | 'system' = isSystem ? 'system' : isUser ? 'user' : 'assistant';
        const mainMes = asString(item.mes);
        const rawSwipes = Array.isArray(item.swipes) ? item.swipes.map((s) => asString(s)) : [mainMes];
        const swipeInfo = Array.isArray(item.swipe_info) ? item.swipe_info : [];
        const extra = asRecord(item.extra);

        const swipes = (rawSwipes.length > 0 ? rawSwipes : [mainMes]).map((content, sIdx) => {
            const info = asRecord(swipeInfo[sIdx]);
            return {
                id: sIdx,
                content,
                reasoning: asString(info.reasoning || (sIdx === Number(item.swipe_id || 0) ? extra.reasoning : '')) || undefined,
                sendDate: asString(info.send_date || item.send_date, new Date().toISOString()),
                extra: info,
            };
        });

        const activeSwipeId = Math.min(Math.max(0, asNumber(item.swipe_id, 0)), swipes.length - 1);
        const floor = nodes.length;
        const id = asString(item.uid, `msg_${floor}_${Date.now()}`);
        const rawVars = Array.isArray(item.variables) ? asRecord(item.variables[activeSwipeId]) : asRecord(item.variables);
        const perSwipeVariables = Array.isArray(item.variables)
            ? Object.fromEntries(item.variables.map((value, index) => [index, asRecord(value)]))
            : item.variables && typeof item.variables === 'object' ? { [activeSwipeId]: rawVars } : {};
        const initialized = Array.isArray(item.variables_initialized)
            ? Object.fromEntries(item.variables_initialized.map((value, index) => [index, !!value])) : {};

        nodes.push({
            id,
            messageId: id,
            parentId: nodes.length > 0 ? nodes[nodes.length - 1].id : null,
            floor,
            role,
            speakerName: asString(item.name, isUser ? 'User' : 'Character'),
            content: swipes[activeSwipeId]?.content ?? mainMes,
            swipes,
            activeSwipeIndex: activeSwipeId,
            sendDate: swipes[activeSwipeId]?.sendDate,
            reasoning: swipes[activeSwipeId]?.reasoning,
            extra: { ...extra, variables: rawVars,
                swipeVariables: { ...asRecord(extra.swipeVariables), ...perSwipeVariables },
                tipsy_template_variables_initialized: { ...asRecord(extra.tipsy_template_variables_initialized), ...initialized } },
        });
    });

    return nodes;
}





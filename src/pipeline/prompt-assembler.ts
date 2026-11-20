import { scanLorebooks } from './lorebook-scanner';
import { prepareTokenCounter, type TokenizerSelection } from './token-counter';
export { estimateTokenCount } from './token-counter';
import { applyRegexScripts, evaluateMacros, orderedRegexScripts } from './macro-regex-engine';
import { TemplateRuntime } from './template-runtime';
import { injectTemplateEntries } from './template-inject-loader';
import { parseWorldInfoDecorators } from './worldinfo-decorators';
import type { TemplatePromptInjection } from './template-injections';
import { hostMessageHidden } from '../compatibility/chat-message-codec';
import type { TemplateFeatures } from './template-features';
import { formatTemplateMarkdown } from './template-formatting';
import { defaultWorldinfoSettings, type WorldinfoSettings } from './worldinfo-settings';
import { formatPresetMessages } from '../core/generation-settings';
import { DEFAULT_CONTEXT_TOKENS, DEFAULT_RESPONSE_TOKENS } from '../core/generation-defaults';
import type { PromptInjection, HelperGenerationConfig, InterceptedHistoryMessage } from '../compatibility/contracts';
import { promptLiterals, type NativePromptInput, type NativeScanHook } from './native-prompt-input';
import type {
    AssembledChatMessage,
    AssembledPromptResult,
    ChatMessageNode,
    LorebookEntry,
    LorebookTimedState,
    NormalizedCharacterCard,
    NormalizedLorebook,
    NormalizedPreset,
} from '../types';

export interface AssemblePromptInput {
    character: NormalizedCharacterCard;
    characterAvatar?: string;
    characterCatalog?: NormalizedCharacterCard[];
    modelName?: string;
    macroLastUserMessage?: string;
    firstIncludedMessage?: number;
    tokenizer?: TokenizerSelection;
    vectorActivations?: string[];
    generationSettings?: { model: string; stream: boolean; source: string; parameters: Record<string, unknown> };
    messageImages?: Record<string, string[]>;
    preset: NormalizedPreset;
    lorebooks: NormalizedLorebook[];
    lorebookCatalog?: NormalizedLorebook[];
    primaryWorldbookName?: string | null;
    characterWorldbooks?: { primary: string | null; additional: string[] };
    worldbookGroups?: { character: string[]; global: string[]; persona: string[]; additional: string[]; chat: string[] };
    messages: ChatMessageNode[];
    userName: string;
    persona?: import('../types').UserPersona;
    worldinfoSettings?: WorldinfoSettings;
    chatId?: string;
    maxContextTokens?: number;
    maxResponseTokens?: number;
    timedStates?: Record<string, LorebookTimedState>;
    initialVariables?: Record<string, unknown>;
    initialBaseVariables?: Record<string, unknown>;
    initialGlobalVariables?: Record<string, unknown>;
    initialLocalVariables?: Record<string, unknown>;
    initialMessageVariables?: Record<string, Record<string, unknown>>;
    scanDepth?: number;
    maxRecursionSteps?: number;
    injections?: PromptInjection[];
    chatMetadata?: Record<string, unknown>;
    interceptedHistory?: InterceptedHistoryMessage[];
    helperGeneration?: { config: HelperGenerationConfig; raw: boolean };
    generationType?: string;
    mvuExtraAnalysis?: boolean;
    mvuWarnings?: string[];
    mvuWorldbookFilter?: import('./mvu-worldbooks').MvuWorldbookFilter;
    templateInjections?: TemplatePromptInjection[];
    templateActivations?: Array<{ world: string; uid: string | number; force: boolean }>;
    templateFeatures?: Partial<TemplateFeatures>;
    /** Host preparation identity, unaffected by a Helper's transient prompt layout. */
    templatePreparationKey?: string;
    /** Direct exported API calls retain activations until the next generation. */
    templateApi?: boolean;
    templateForcePreload?: boolean;
    quickReplyConfig?: Record<string, any>;
    globalRegexScripts?: import('../types').RegexScriptRule[];
    /** Inspector previews use disposable Workers; committed work uses the author realm. */
    templatePreview?: boolean;
    templateTask?: { type: 'preload' } | { type: 'render'; messageId: string; source: string; dryRun: boolean };
    /** Set only for the user's main generation. */
    nativePrompt?: NativePromptInput;
}

export async function assemblePromptPipeline(input: AssemblePromptInput, runtime?: TemplateRuntime, afterNativeScan?: NativeScanHook): Promise<AssembledPromptResult> {
    const templates = runtime ?? new TemplateRuntime(input);
    const literals = input.nativePrompt && !input.templateTask && !input.templatePreview && !input.helperGeneration ? promptLiterals(input.nativePrompt) : undefined;
    templates.nativeMacroMask = literals?.mask;
    try { return await assemble(input, templates, !runtime, literals, afterNativeScan); }
    finally { templates.nativeMacroMask = undefined; }
}

async function assemble(input: AssemblePromptInput, templates: TemplateRuntime, preload: boolean, literals?: ReturnType<typeof promptLiterals>, afterNativeScan?: NativeScanHook): Promise<AssembledPromptResult> {
    const {
        character,
        preset,
        lorebooks,
        messages,
        userName,
        chatId = 'default_chat',
        maxContextTokens = preset.maxContextTokens ?? DEFAULT_CONTEXT_TOKENS,
        maxResponseTokens = preset.maxResponseTokens ?? DEFAULT_RESPONSE_TOKENS,
        timedStates = {},
    } = input;

    const expandWorldInfo = (text: string, entry: LorebookEntry) => templates.expand(text, entry.depth, entry.role ?? 'system', 'world_info', `world-info:${entry.world}:${entry.uid}`);
    if (preload) await templates.preload(expandWorldInfo, input.templateTask?.type === 'preload');
    if (input.templateTask) {
        let templateContent = '';
        let templateMessageContent: string | undefined;
        if (input.templateTask.type === 'render') {
            const task = input.templateTask;
            const node = messages.find(message => message.id === task.messageId);
            if (!node) throw new Error('模板渲染的消息已不存在');
            templates.activationClosed = true;
            const depth = messages.length - 1 - node.floor;
            templateContent = !templates.features.enabled || !templates.features.render_enabled || templates.features.depth_limit >= 0 && depth > templates.features.depth_limit ? task.source
                : await templates.withMessageContext(node.id, () => templates.withEnvironment({ runType: 'render', isDryRun: task.dryRun, generateType: '',
                message_id: node.floor, swipe_id: node.activeSwipeIndex, is_last: node.id === messages.at(-1)?.id, is_user: node.role === 'user', is_system: !!node.isHidden, name: node.speakerName }, async () => {
                await templates.beginStage();
                const expand = (text: string, entry: LorebookEntry) => templates.expand(text, messages.length - 1 - node.floor, node.role, 'render', `render-wi:${entry.world}:${entry.uid}`);
                const before = await templates.loader('render_before', undefined, '', '', expand);
                let source = task.source;
                if (!task.dryRun && templates.features.raw_message_evaluation_enabled) {
                    const evaluated = await templates.withEnvironment({ runType: 'render_permanent' },
                        () => templates.render(node.content, `render-permanent:${node.id}:${node.activeSwipeIndex}`, {}, undefined,
                            { message: true, user: node.role === 'user', assistant: node.role === 'assistant', system: !!node.isHidden, depth, before: true }, 'reasoning'));
                    if (evaluated !== node.content) {
                        templateMessageContent = evaluated;
                        source = templates.prepare(evaluated, depth, node.role, 'render');
                    }
                }
                const content = templates.finish(await templates.render(formatTemplateMarkdown(source), `render:${node.id}:${node.activeSwipeIndex}`, {}, undefined,
                    { message: true, user: node.role === 'user', assistant: node.role === 'assistant', system: !!node.isHidden, depth, html: true }, templates.features.code_blocks_enabled ? 'reasoning' : 'code'));
                const after = await templates.loader('render_after', undefined, content, '', expand);
                return `<div class="tipsy-template-message">${before}${content}${after}</div>`;
            }));
        }
        return { messages: [], activatedLorebookEntries: [], nextTimedStates: timedStates, templateContent, templateMessageContent, ...templates.changes(), compatibilityWarnings: [...templates.warnings],
            tokenUsage: { system: 0, lorebook: 0, history: 0, total: 0, budgetRemaining: maxContextTokens }, droppedHistoryCount: 0 };
    }
    const tokenizer = await prepareTokenCounter(input.modelName, input.tokenizer);
    const countTokens = literals ? (text: string) => tokenizer(literals.reveal(text)) : tokenizer;
    templates.countTokens = countTokens;
    templates.regex.deactivate({ message: true });
    const finalVariables = templates.variables;
    for (const activation of input.templateActivations ?? []) await templates.activewi(activation.world, Number.isNaN(Number(activation.uid)) ? activation.uid : Number(activation.uid), activation.force);
    const globalVariables = templates.globals;
    const variableChanges = templates.variableChanges;
    const globalVariableChanges = templates.globalChanges;
    const macroCtx = {
        userName,
        modelName: input.modelName, chatId, maxContextTokens, maxResponseTokens, generationType: input.generationType,
        messageCount: messages.length, currentSwipe: messages.at(-1)?.activeSwipeIndex, swipeCount: messages.at(-1)?.swipes.length,
        firstIncludedMessage: input.firstIncludedMessage, characterDescription: character.description, characterPersonality: character.personality,
        scenario: character.scenario, personaDescription: input.persona?.description, characterPrompt: character.systemPrompt, characterJailbreak: character.postHistoryInstructions,
        examples: character.mesExample,
        charName: character.name,
        lastMessage: messages.at(-1)?.content,
        lastUserMessage: input.macroLastUserMessage ?? messages.filter((m) => m.role === 'user').at(-1)?.content,
        lastCharMessage: messages.filter((m) => m.role === 'assistant').at(-1)?.content,
        variableContext: { presetId: preset.id, characterId: character.id, chatId },
        variables: finalVariables,
        globalVariables,
        onSetVariable: templates.recordLocalChange,
        onSetGlobalVariable: (key: string, value: unknown) => { globalVariableChanges[key] = value; },
    };
    const allRegex = orderedRegexScripts(input.globalRegexScripts, preset.regexScripts, character.regexScripts);
    const helper = input.helperGeneration;
    const overrides = helper?.config.overrides;
    // Frame personal settings only at injection; macros and author APIs keep the raw description.
    const personaDescription = input.persona?.description_mode === 'supplement' && input.persona.description.trim()
        ? `以下是用户希望融入故事的个人特征与补充设定。请在不改变故事既定的主角身份、世界观、人物关系和已发生事实的前提下自然融入；未提及的内容沿用故事设定，与故事明确设定冲突时以故事为准。不要把这些补充当作新的身份或已发生的剧情，不要仅凭这些补充直接改写已有数值，也不必反复强调这些特征。\n\n${input.persona.description}`
        : input.persona?.description;
    const historyLimit = helper?.config.max_chat_history;
    const visibleHistory = input.interceptedHistory ?? messages.filter(message => !hostMessageHidden(message, input.chatMetadata));
    const selectedHistory = overrides?.chat_history?.prompts ?? (typeof historyLimit === 'number' ? historyLimit === 0 ? [] : visibleHistory.slice(-historyLimit) : visibleHistory);
    const additionalScanText = (input.injections ?? []).filter(item => item.should_scan).map(item => item.content);
    if (literals) for (const item of input.nativePrompt!.injections) if (item.scan || item.position === 'scanOnly') additionalScanText.push(item.text);
    const expandText = (raw: string, depth = 0, role: 'system' | 'user' | 'assistant' = 'system', worldInfo = false) => templates.expand(raw, depth, role, worldInfo ? 'world_info' : 'prompt');

    const generateBefore = await templates.withEnvironment({ runType: 'generate', isDryRun: false, generateType: input.generationType ?? 'normal' }, async () => {
        if (templates.features.generate_loader_enabled) await templates.beginStage();
        return templates.loader('generate_before', undefined, '', '', expandWorldInfo);
    });
    const helperUserInput = helper ? applyRegexScripts((helper.config.user_input ?? '').split(/(<%[\s\S]*?%>)/g)
        .map(part => part.startsWith('<%') ? part : evaluateMacros(part, macroCtx)).join(''), allRegex,
        { stage: 'user_input', role: 'user', macroContext: macroCtx }) : '';
    const worldSettings = { ...defaultWorldinfoSettings, ...input.worldinfoSettings };
    const scanTexts = [...selectedHistory.map(message => worldSettings.include_names && 'speakerName' in message ? `${message.speakerName}: ${message.content}` : message.content), ...(helperUserInput ? [helperUserInput] : [])];
    await templates.beginStage();
    await templates.prepareWorldInfoEvents();
    await templates.prepareExternalWorldInfo();
    const scanBooks = await templates.prepareLorebooks((text, entry) => expandText(text, entry.depth, entry.role ?? 'system', true));

    const stickyMap = new Map<string, number>();
    const cooldownMap = new Map<string, number>();
    for (const [key, st] of Object.entries(timedStates)) {
        if (st?.stickyUntilFloor) stickyMap.set(key, st.stickyUntilFloor);
        if (st?.cooldownUntilFloor) cooldownMap.set(key, st.cooldownUntilFloor);
    }

    const entryKey = (entry: LorebookEntry) => `${entry.world}::${entry.uid}`;
    const allowed = (entry: LorebookEntry) => !templates.suppressed.has(entryKey(entry)) || templates.forceActivationKeys.has(entryKey(entry));
    const characterBooks = new Set([...(input.worldbookGroups?.character ?? []), ...(input.worldbookGroups?.additional ?? [])]);
    const priority = (entry: LorebookEntry) => worldSettings.insertion_strategy === 'evenly' ? 0 : Number(characterBooks.has(entry.world ?? '')) * (worldSettings.insertion_strategy === 'character_first' ? -1 : 1);
    const globalBudget = Math.min(Math.round(maxContextTokens * worldSettings.context_percentage / 100) || 1, worldSettings.budget_cap > 0 ? worldSettings.budget_cap : Infinity);
    const scan = (depth = input.scanDepth ?? 12) => {
        const requested = [...templates.forced.values()];
        const explicitlySelectedBooks = (input.lorebookCatalog ?? []).filter(book =>
            !scanBooks.some(active => active.id === book.id) && requested.some(entry => entry.world === book.name));
        const candidates = [...scanBooks, ...explicitlySelectedBooks.map(book => ({ ...book, entries: [] }))].map(book => ({
            ...book,
            entries: [
                ...book.entries.map(entry => templates.forced.get(entryKey(entry)) ?? entry),
                ...requested.filter(entry => entry.world === book.name && !book.entries.some(other => entryKey(other) === entryKey(entry))),
            ].filter(allowed).map(entry => {
                const raw = entry.rawData as Record<string, any> ?? {}; const ext = raw.extensions ?? {};
                return { ...entry, caseSensitive: raw.caseSensitive ?? ext.case_sensitive ?? worldSettings.case_sensitive,
                    matchWholeWords: raw.matchWholeWords ?? ext.match_whole_words ?? worldSettings.match_whole_words,
                    useGroupScoring: raw.useGroupScoring ?? ext.use_group_scoring ?? worldSettings.use_group_scoring };
            }),
            ...(!worldSettings.recursive ? { recursiveScanning: false, maxRecursionSteps: 0 } : {}),
        }));
        return scanLorebooks({
            lorebooks: candidates,
            recentMessagesText: scanTexts,
            additionalScanText,
            scanDepth: depth,
            maxRecursionSteps: worldSettings.recursive ? input.maxRecursionSteps ?? 3 : 0,
            currentMessageCount: messages.length,
            generationType: input.generationType ?? 'normal',
            character: { id: character.id, name: character.name, tags: character.tags },
            extraScanText: { matchPersonaDescription: overrides?.persona_description ?? input.persona?.description, matchCharacterDescription: overrides?.char_description ?? character.description,
                matchCharacterPersonality: overrides?.char_personality ?? character.personality, matchCharacterDepthPrompt: character.depthPrompt?.prompt,
                matchScenario: overrides?.scenario ?? character.scenario, matchCreatorNotes: character.creatorNotes },
            stickyState: stickyMap,
            cooldownState: cooldownMap,
            timedStates,
            forceActivationKeys: templates.forceActivationKeys,
            externalActivationKeys: new Set(input.vectorActivations ?? []),
            preview: input.templatePreview,
            tokenBudget: globalBudget,
            countTokens,
            priority,
            recursive: worldSettings.recursive,
            minActivations: worldSettings.min_activations,
            maxScanDepth: worldSettings.max_depth,
            prepareContent: entry => evaluateMacros(literals?.mask(entry.content) ?? entry.content, macroCtx),
            onScanDone: templates.worldInfoScanListener(),
        });
    };
    let scanResult = await scan();
    const evaluated = new Map<string, LorebookEntry>();
    for (let round = 0; ; round++) {
        if (round >= 128 || evaluated.size > 4096) throw new Error('模板激活世界书超过限制');
        const before = JSON.stringify([...templates.forced]);
        for (const entry of scanResult.activatedEntries) {
            const key = `${entry.world}::${entry.uid}`;
            if (evaluated.has(key) || templates.suppressed.has(key) && !templates.forceActivationKeys.has(key)) continue;
            evaluated.set(key, { ...entry, content: templates.preprocessed.has(key) ? entry.content : await templates.withWorldInfo(entry, () => expandText(entry.content, entry.depth, entry.role ?? 'system', true)) });
        }
        if (before === JSON.stringify([...templates.forced])) break;
        scanResult = await scan();
    }
    const activatedEntries = scanResult.activatedEntries.filter(allowed).map(entry => ({ ...entry, content: evaluated.get(entryKey(entry))?.content ?? entry.content }));
    const activationKeys = literals && input.nativePrompt!.afterScan ? new Set(activatedEntries.map(entryKey)) : undefined;
    const hits = activationKeys ? scanResult.hits.filter(hit => activationKeys.has(`${hit.world}::${hit.uid}`)) : undefined;
    const afterScan = hits && afterNativeScan ? await afterNativeScan(input.nativePrompt!.id, hits.slice(0, 100).map(hit => ({
        book: (hit.world ?? '').slice(0, 200), uid: typeof hit.uid === 'string' ? hit.uid.slice(0, 200) : hit.uid, label: hit.comment.slice(0, 200),
        reason: hit.reason, matchedKeys: hit.matchedKeys.slice(0, 12).map(key => key.slice(0, 200)),
    })), hits.length).catch(() => undefined) : undefined;
    if (worldSettings.overflow_alert && scanResult.budgetOverflowed) templates.warnings.add(`世界书预算提示：本轮预算 ${globalBudget} Tokens（上下文的 ${worldSettings.context_percentage}%${worldSettings.budget_cap > 0 ? `，另设 ${worldSettings.budget_cap} Tokens 上限` : ''}），保留 ${activatedEntries.length} 条，部分内容未纳入本轮提示词。可在「参数与连接」调整世界书预算占比。`);
    templates.activationClosed = true;
    await templates.emitWorldInfoActivated(activatedEntries);
    await templates.hostEvent('generate_before_combine_prompts');
    const beforeCharEntries = overrides?.world_info_before !== undefined ? [] : activatedEntries.filter((e) => e.position === 'before_char');
    const afterCharEntries = activatedEntries.filter(
        (e) => overrides?.world_info_after === undefined && (e.position === 'after_char' || !e.position),
    );
    const rawHasHistory = !helper?.raw || (preset.promptSlots ?? []).some(slot => slot.identifier === 'chat_history' && slot.enabled !== false);
    const rawHasUserInput = helper?.raw && (preset.promptSlots ?? []).some(slot => slot.identifier === 'user_input' && slot.enabled !== false);
    const depthEntries = overrides?.chat_history?.with_depth_entries === false || !rawHasHistory ? [] : activatedEntries.filter((e) => e.position === 'at_depth');

    const systemMessages: AssembledChatMessage[] = [];
    const postHistoryBuffer: AssembledChatMessage[] = [];
    const rawLayout: Array<AssembledChatMessage | 'history'> = [];
    const depthMessages: Array<{ message: AssembledChatMessage; depth: number; order: number; category: 'system' | 'lorebook' | 'char' }> = [];
    let historyInserted = false;
    let insertionDepth: number | undefined;
    let insertionOrder = 100;
    let lorebookTokens = 0;
    let charTokens = 0;
    const preparedWorldInfo = new WeakSet<AssembledChatMessage>();
    const historyContexts = new WeakMap<AssembledChatMessage, string>();
    const historySpeakers = new Map(messages.map(node => [node.id, node.speakerName]));
    const categories = new WeakMap<AssembledChatMessage, 'system' | 'lorebook' | 'char' | 'history'>();
    const nativeInjections = literals ? [...input.nativePrompt!.injections, ...(afterScan?.injections ?? [])] : [];
    for (const item of nativeInjections) {
        if (item.position === 'scanOnly') continue;
        const tokens = tokenizer(item.text);
        const message: AssembledChatMessage = { role: item.role ?? 'system', content: literals!.literal(item.text), sourceId: item.source,
            sourceLabel: `原生插件：${item.label}`, tokens, estimatedTokens: tokens };
        categories.set(message, 'system');
        if (item.position === 'atDepth') depthMessages.push({ message, depth: item.depth ?? 0, order: 100, category: 'system' });
        else (item.position === 'afterHistory' ? postHistoryBuffer : systemMessages).push(message);
    }

    const pushMsg = async (
        role: 'system' | 'user' | 'assistant',
        rawContent: string,
        sourceId: string,
        sourceLabel: string,
        category: 'system' | 'lorebook' | 'char' = 'system',
    ) => {
        const expanded = (category === 'lorebook' ? rawContent : templates.prepare(rawContent, insertionDepth ?? 0, role)).trim();
        if (!expanded) return;
        const tokens = countTokens(expanded);
        if (category === 'lorebook') lorebookTokens += tokens;
        if (category === 'char') charTokens += tokens;
        const message = { role, content: expanded, sourceId, sourceLabel, tokens, estimatedTokens: tokens };
        if (category === 'lorebook') preparedWorldInfo.add(message);
        categories.set(message, category);
        if (insertionDepth !== undefined) depthMessages.push({ message, depth: insertionDepth, order: insertionOrder, category });
        else if (helper?.raw) rawLayout.push(message);
        else (historyInserted ? postHistoryBuffer : systemMessages).push(message);
    };

    let expandedHistory: AssembledChatMessage[] | undefined;
    const expandHistory = async (): Promise<AssembledChatMessage[]> => {
        const output: AssembledChatMessage[] = [];
        const history = selectedHistory;
        const sourceIds = new Set<string>();
        const intercepted = input.interceptedHistory === history;
        const historyId = (message: (typeof history)[number]): string | undefined => intercepted ? (message as InterceptedHistoryMessage).messageId : 'id' in message && typeof message.id === 'string' ? message.id : undefined;
        const positions = new Map<string | undefined, number>(afterScan?.history.length ? history.map((message, index) => [historyId(message), index] as const) : []);
        const edits = new Map((afterScan?.history ?? []).map(edit => [positions.get(edit.from), edit]));
        let editedThrough = -1;
        for (const [index, message] of history.entries()) {
            if (index <= editedThrough) continue;
            const edit = edits.get(index);
            if (edit) {
                editedThrough = positions.get(edit.through) ?? index;
                if (edit.text !== undefined) {
                    const tokens = tokenizer(edit.text);
                    const replacement: AssembledChatMessage = { role: edit.role ?? 'system', content: literals!.literal(edit.text), sourceId: edit.source,
                        sourceLabel: `原生插件历史：${edit.label}`, tokens, estimatedTokens: tokens };
                    categories.set(replacement, 'history'); output.push(replacement);
                }
                continue;
            }
            const nodeId = historyId(message);
            const prepare = () => templates.prepare(message.content, history.length - 1 - index, message.role, 'prompt', intercepted);
            const content = nodeId ? await templates.withMessageContext(nodeId, async () => prepare()) : prepare();
            const tokens = countTokens(content);
            const sourceId = nodeId && !sourceIds.has(nodeId) ? nodeId : `${intercepted ? 'intercepted' : 'helper'}_history_${index}`;
            sourceIds.add(sourceId);
            const prepared = { role: message.role, content, sourceId, sourceLabel: `历史 #${index}`, tokens, estimatedTokens: tokens };
            if (nodeId) historyContexts.set(prepared, nodeId);
            if ('speakerName' in message) historySpeakers.set(sourceId, message.speakerName);
            categories.set(prepared, 'history'); output.push(prepared);
        }
        if (helper && (!helper.raw || !rawHasUserInput)) {
            const content = templates.prepare(helperUserInput, 0, 'user');
            if (content) { const tokens = countTokens(content); output.push({ role: 'user', content, sourceId: 'helper_user_input', sourceLabel: '临时用户输入', tokens, estimatedTokens: tokens }); }
        }
        return output;
    };
    const slots = preset.promptSlots || preset.prompts || [];
    const enabledSlots = slots.filter((s) => s.enabled !== false).slice().sort((a, b) => (a.injectionOrder ?? 0) - (b.injectionOrder ?? 0));
    const hasMain = enabledSlots.some((s) => s.identifier === 'main');
    const hasPostHistory = enabledSlots.some((s) => s.identifier === 'jailbreak');
    for (const item of input.injections ?? []) if (item.position === 'before_prompt') {
        await pushMsg(item.role, item.content, `helper_${item.id}`, `脚本注入: ${item.id}`);
    }
    for (const slot of enabledSlots) {
        insertionOrder = slot.depthOrder ?? 100;
        insertionDepth = slot.injectionPosition === 'in_chat' || slot.injectionPosition === 1 ? Math.max(0, slot.injectionDepth ?? 4) : undefined;
        const id = slot.identifier;
        if (id === 'worldInfoBefore' || id === 'world_info_before') {
            if (overrides?.world_info_before !== undefined) await pushMsg(slot.role, await expandText(overrides.world_info_before, insertionDepth ?? 0, slot.role, true), 'helper_world_before', '世界书前置覆盖', 'lorebook');
            for (const entry of beforeCharEntries) {
                await pushMsg(entry.role || 'system', entry.content, `wb_${entry.uid}`, `世界书: ${entry.comment}`, 'lorebook');
            }
            continue;
        }
        if (id === 'charDescription' || id === 'char_description') {
            await pushMsg(slot.role || 'system', overrides?.char_description ?? character.description, 'char_desc', `角色描述 (${character.name})`, 'char');
            continue;
        }
        if (id === 'charPersonality' || id === 'char_personality') {
            await pushMsg(slot.role || 'system', overrides?.char_personality ?? character.personality, 'char_pers', `角色性格 (${character.name})`, 'char');
            continue;
        }
        if (id === 'scenario') {
            await pushMsg(slot.role || 'system', overrides?.scenario ?? character.scenario, 'char_scen', `场景设定 (${character.name})`, 'char');
            continue;
        }
        if (id === 'worldInfoAfter' || id === 'world_info_after') {
            if (overrides?.world_info_after !== undefined) await pushMsg(slot.role, await expandText(overrides.world_info_after, insertionDepth ?? 0, slot.role, true), 'helper_world_after', '世界书后置覆盖', 'lorebook');
            for (const entry of afterCharEntries) {
                await pushMsg(entry.role || 'system', entry.content, `wb_${entry.uid}`, `世界书: ${entry.comment}`, 'lorebook');
            }
            continue;
        }
        if (id === 'dialogueExamples' || id === 'dialogue_examples') {
            for (const entry of activatedEntries.filter((e) => e.position === 'before_example')) {
                await pushMsg(entry.role || 'system', entry.content, `wb_${entry.uid}`, `世界书: ${entry.comment}`, 'lorebook');
            }
            await pushMsg(slot.role || 'system', overrides?.dialogue_examples ?? character.mesExample, 'char_ex', '对话示例', 'char');
            for (const entry of activatedEntries.filter((e) => e.position === 'after_example')) {
                await pushMsg(entry.role || 'system', entry.content, `wb_${entry.uid}`, `世界书: ${entry.comment}`, 'lorebook');
            }
            continue;
        }
        if (id === 'chatHistory' || id === 'chat_history') {
            expandedHistory ??= await expandHistory();
            if (helper?.raw) rawLayout.push('history');
            historyInserted = true;
            continue;
        }
        if (id === 'user_input') {
            await pushMsg('user', helperUserInput, 'helper_user_input', '临时用户输入');
            continue;
        }
        if (id === 'personaDescription' || id === 'persona_description') {
            if (overrides?.persona_description !== undefined || !input.persona || [0, 1].includes(input.persona.position))
                await pushMsg(slot.role, overrides?.persona_description ?? personaDescription ?? slot.content, 'helper_persona', '用户描述');
            continue;
        }
        if (id === 'authorsNote' || id === 'authors_note') {
            for (const entry of activatedEntries.filter((e) => e.position === 'before_an' || e.position === 'an_top')) {
                await pushMsg(entry.role || 'system', entry.content, `wb_${entry.uid}`, `世界书: ${entry.comment}`, 'lorebook');
            }
            const note = overrides?.chat_history?.author_note ?? slot.content;
            const persona = overrides?.persona_description === undefined ? input.persona : undefined;
            const content = persona?.position === 2 ? [personaDescription, note].filter(Boolean).join('\n')
                : persona?.position === 3 ? [note, personaDescription].filter(Boolean).join('\n') : note;
            await pushMsg(slot.role || 'system', content, `preset_${id}`, `预设: ${slot.name}`);
            for (const entry of activatedEntries.filter((e) => e.position === 'after_an' || e.position === 'an_bottom')) {
                await pushMsg(entry.role || 'system', entry.content, `wb_${entry.uid}`, `世界书: ${entry.comment}`, 'lorebook');
            }
            continue;
        }
        // Known card overrides occupy their preset slot, preserving order and toggles.
        const content = !slot.forbidOverrides && id === 'main' && character.systemPrompt ? character.systemPrompt
            : !slot.forbidOverrides && id === 'jailbreak' && character.postHistoryInstructions ? character.postHistoryInstructions : slot.content;
        // Unknown markers with supplied content remain editable and usable.
        await pushMsg(slot.role || 'system', content, `preset_${id}`, `预设: ${slot.name}`);
    }
    insertionDepth = undefined;
    if (helper?.raw && !rawHasHistory && !rawHasUserInput) await pushMsg('user', helperUserInput, 'helper_user_input', '临时用户输入');
    if (!helper?.raw && input.persona?.description && [0, 1].includes(input.persona.position) && overrides?.persona_description === undefined
        && !slots.some(slot => ['personaDescription', 'persona_description'].includes(slot.identifier))) {
        const previous = historyInserted;
        historyInserted = false;
        await pushMsg('system', personaDescription!, 'helper_persona', '用户描述');
        historyInserted = previous;
    }
    if (helper && !helper.raw && overrides?.persona_description !== undefined && !slots.some(slot => ['personaDescription', 'persona_description'].includes(slot.identifier))) {
        const previous = historyInserted;
        historyInserted = false;
        await pushMsg('system', overrides.persona_description, 'helper_persona', '用户描述覆盖');
        historyInserted = previous;
    }
    if (!helper?.raw && character.systemPrompt && !hasMain && !slots.some((s) => s.identifier === 'main')) {
        const previous = historyInserted;
        historyInserted = false;
        await pushMsg('system', character.systemPrompt, 'char_sys', '角色卡内置 System Prompt', 'char');
        historyInserted = previous;
    }
    if (!helper?.raw && character.postHistoryInstructions && !hasPostHistory && !slots.some((s) => s.identifier === 'jailbreak')) {
        historyInserted = true;
        await pushMsg('system', character.postHistoryInstructions, 'char_phi', '角色卡后置指令 (PHI)', 'char');
    }
    for (const entry of depthEntries) {
        insertionOrder = entry.order;
        insertionDepth = Math.max(0, entry.depth ?? 4);
        await pushMsg(entry.role || 'system', entry.content, `wb_depth_${entry.uid}`, `世界书@Depth(${insertionDepth}): ${entry.comment}`, 'lorebook');
    }
    insertionOrder = 100;
    if (input.persona?.description && input.persona.position === 4 && overrides?.persona_description === undefined) {
        insertionDepth = input.persona.depth;
        await pushMsg((['system', 'user', 'assistant'] as const)[input.persona.role] ?? 'system', personaDescription!, 'persona_depth', '个人设定');
    }
    if (helper && !helper.raw && overrides?.chat_history?.author_note !== undefined && !slots.some(slot => ['authorsNote', 'authors_note'].includes(slot.identifier))) {
        insertionDepth = 4;
        await pushMsg('system', overrides.chat_history.author_note, 'helper_author_note', '作者注释覆盖');
    }
    if (character.depthPrompt?.prompt && (!helper?.raw || rawLayout.includes('history'))) {
        insertionDepth = Math.max(0, character.depthPrompt.depth);
        await pushMsg(character.depthPrompt.role, character.depthPrompt.prompt, 'char_depth', '角色深度提示词', 'char');
    }
    for (const item of input.injections ?? []) {
        // `none` is a scan-only injection. Missing position defaults to in_chat upstream.
        if (item.position === 'none' || item.position === 'before_prompt' || !rawHasHistory && item.position !== 'in_prompt') continue;
        if (item.position === 'in_prompt') {
            insertionDepth = undefined;
            const previous = historyInserted;
            historyInserted = false;
            await pushMsg(item.role, item.content, `helper_${item.id}`, `脚本注入: ${item.id}`);
            historyInserted = previous;
            continue;
        }
        insertionDepth = Math.max(0, item.depth ?? 0);
        await pushMsg(item.role, item.content, `helper_${item.id}`, `脚本注入: ${item.id}`);
    }
    insertionDepth = undefined;
    const historyCopies = helper?.raw ? rawLayout.filter(item => item === 'history').length : 1;
    const depthTokens = depthMessages.reduce((total, item) => total + item.message.tokens, 0);
    const systemTokens = [...systemMessages, ...postHistoryBuffer, ...rawLayout.filter((item): item is AssembledChatMessage => item !== 'history')].reduce((acc, m) => acc + m.tokens, 0) + depthTokens * historyCopies;
    if (historyCopies > 1) for (const item of depthMessages) {
        if (item.category === 'char') charTokens += item.message.tokens * (historyCopies - 1);
        if (item.category === 'lorebook') lorebookTokens += item.message.tokens * (historyCopies - 1);
    }
    const availableForHistory = Math.max(0, Math.floor((maxContextTokens - maxResponseTokens - systemTokens) / Math.max(1, historyCopies)));

    const pickedHistory: AssembledChatMessage[] = [];
    let historyTokens = 0;
    let droppedHistoryCount = 0;

    const hasHistorySlot = slots.some((s) => s.identifier === 'chatHistory' || s.identifier === 'chat_history');
    expandedHistory ??= hasHistorySlot || helper?.raw ? [] : await expandHistory();
    if (helper && !helper.raw && !expandedHistory.some(message => message.sourceId === 'helper_user_input') && helperUserInput) {
        const content = templates.prepare(helperUserInput, 0, 'user');
        const tokens = countTokens(content);
        if (content) expandedHistory.push({ role: 'user', content, sourceId: 'helper_user_input', sourceLabel: '临时用户输入', tokens, estimatedTokens: tokens });
    }
    if (hasHistorySlot && !expandedHistory.length) droppedHistoryCount = messages.length;
    for (let i = expandedHistory.length - 1; i >= 0; i--) {
        const message = expandedHistory[i]!;
        if (historyTokens + message.tokens > availableForHistory && pickedHistory.length > 0) {
            droppedHistoryCount = i + 1;
            break;
        }
        historyTokens += message.tokens;
        pickedHistory.unshift(message);
    }

    // Anchor every injection to the original history boundaries; earlier insertions
    // must not shift another entry's depth or reverse equal-depth preset order.
    const historyWithInjections: AssembledChatMessage[] = [];
    input.firstIncludedMessage = messages.find(message => message.id === pickedHistory[0]?.sourceId)?.floor ?? -1;
    depthMessages.sort((a, b) => a.order - b.order);
    for (let i = 0; i <= pickedHistory.length; i++) {
        for (const item of depthMessages) {
            if (Math.max(0, pickedHistory.length - item.depth) === i) historyWithInjections.push(item.message);
        }
        if (i < pickedHistory.length) historyWithInjections.push(pickedHistory[i]!);
    }
    const preparedMessages = helper?.raw ? rawLayout.flatMap(item => item === 'history' ? historyWithInjections : [item])
        : [...systemMessages, ...historyWithInjections, ...postHistoryBuffer];
    for (const message of preparedMessages) if (input.messageImages?.[message.sourceId]) message.images = input.messageImages[message.sourceId];
    if (input.messageImages?.helper_user_input?.length && !preparedMessages.some(message => message.sourceId === 'helper_user_input')) {
        preparedMessages.push({ role: 'user', content: '', sourceId: 'helper_user_input', sourceLabel: '图片输入', tokens: 0, images: input.messageImages.helper_user_input });
    }
    // Preserve individual template/history contexts until all author text is evaluated.
    const sendingMessages = formatPresetMessages(preparedMessages, { ...preset, rawData: { ...preset.rawData, squash_system_messages: false } },
        historySpeakers, userName, character.name);
    let finalMessages = await templates.promptReady(sendingMessages);
    templates.regex.deactivate({ basic: true });
    const preparedById = new Map(preparedMessages.map(message => [message.sourceId, message]));
    const finalCategories = new WeakMap(finalMessages.map(message => [message, categories.get(preparedById.get(message.sourceId)!)]));
    templates.injections.forceOutlet = true;
    let collectPrompts = generateBefore;
    await templates.withEnvironment({ runType: 'generate', isDryRun: false, generateType: input.generationType ?? 'normal', generateData: finalMessages }, async () => {
        await templates.beginStage();
        for (const [index, message] of finalMessages.entries()) {
            const before = await templates.loader('generate_before', index, '', collectPrompts, expandWorldInfo);
            const original = preparedById.get(message.sourceId);
            if (!original || !preparedWorldInfo.has(original)) {
                const nodeId = original && historyContexts.get(original);
                message.content = nodeId ? await templates.withMessageContext(nodeId, async () => templates.finish(await templates.render(message.content, `generate:${index}`, {}, undefined, { generate: true, role: message.role })))
                    : templates.finish(await templates.render(message.content, `generate:${index}`, {}, undefined, { generate: true, role: message.role }));
            }
            const after = await templates.loader('generate_after', index, message.content, collectPrompts + before + message.content, expandWorldInfo);
            message.content = before + message.content + after;
            collectPrompts += message.content;
            message.tokens = message.estimatedTokens = countTokens(message.content);
        }
        const after = await templates.loader('generate_after', undefined, collectPrompts, collectPrompts, expandWorldInfo);
        if (!finalMessages.length && (generateBefore.trim() || after.trim())) finalMessages.push({ role: 'system', content: '', sourceId: 'template_loaders', sourceLabel: '模板加载器', tokens: 0 });
        if (finalMessages.length) {
            finalMessages[0].content = generateBefore + finalMessages[0].content;
            finalMessages[finalMessages.length - 1].content += after;
            for (const message of [finalMessages[0], finalMessages[finalMessages.length - 1]]) message.tokens = message.estimatedTokens = countTokens(message.content);
        }
    });
    finalMessages = await templates.withEnvironment({ runType: 'generate', isDryRun: false, generateType: input.generationType ?? 'normal', generateData: finalMessages }, async () => {
        return injectTemplateEntries(finalMessages, await templates.injectionEntries(), (entry, role) => templates.withWorldInfo(entry, () => templates.expand(parseWorldInfoDecorators(entry.content).content, entry.depth, role, 'world_info', `inject:${entry.world}:${entry.uid}`)), warning => templates.warnings.add(warning));
    });
    templates.injections.forceOutlet = false;
    const outlets = new Map<string, string>();
    for (const entry of activatedEntries.filter(entry => entry.position === 'outlet')) {
        const name = entry.outletName ?? '';
        if (!name) { templates.warnings.add(`世界书「${entry.world}/${entry.comment}」未指定 outletName`); continue; }
        outlets.set(name, [outlets.get(name), entry.content].filter(Boolean).join('\n'));
    }
    for (const message of finalMessages) {
        message.content = templates.injections.outlets(message.content, outlets, Math.max(1, Math.min(32, (input.maxRecursionSteps ?? 3) + 1)));
        message.tokens = message.estimatedTokens = countTokens(message.content);
        if (message.sourceId?.startsWith('template-inject:')) finalCategories.set(message, 'lorebook');
    }
    if (preset.rawData?.squash_system_messages) finalMessages = formatPresetMessages(finalMessages,
        { ...preset, rawData: { squash_system_messages: true } }, new Map(), userName, character.name);
    const outgoing = await templates.requestReady(finalMessages);
    finalMessages = await templates.generationDataReady(outgoing.messages);
    for (const message of finalMessages) {
        if (literals) message.content = literals.reveal(message.content);
        message.tokens = message.estimatedTokens = tokenizer(message.content);
    }
    templates.injections.advance();
    templates.regex.deactivate({ generate: true, basic: true });
    const totalTokens = finalMessages.reduce((acc, m) => acc + m.tokens, 0);
    const categoryTokens = (category: string) => finalMessages.reduce((total, message) => total + (finalCategories.get(message) === category ? message.tokens : 0), 0);
    const finalLorebookTokens = categoryTokens('lorebook'); const finalCharTokens = categoryTokens('char'); const finalHistoryTokens = categoryTokens('history');
    if (totalTokens + maxResponseTokens > maxContextTokens) templates.warnings.add('模板加载器处理后的提示词超出当前上下文预算；请减少历史或调整上下文长度。');

    return {
        messages: finalMessages,
        generationSettings: outgoing.generationSettings,
        compatibilityWarnings: [...templates.warnings],
        activatedLorebookEntries: literals ? activatedEntries.map(entry => ({ ...entry, content: literals.reveal(entry.content) })) : activatedEntries,
        nextTimedStates: scanResult.nextTimedStates,
        ...templates.changes(),
        tokenUsage: {
            system: Math.max(0, totalTokens - finalHistoryTokens - finalLorebookTokens - finalCharTokens),
            lorebook: finalLorebookTokens,
            history: finalHistoryTokens,
            total: totalTokens,
            budgetRemaining: Math.max(0, maxContextTokens - totalTokens),
            budget: maxContextTokens,
            character: finalCharTokens,
        },
        droppedHistoryCount,
    };
}

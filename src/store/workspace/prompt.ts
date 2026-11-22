import { freeChatName } from '../chat-archives';
import { presetSamplingParameters } from '../../core/generation-settings';
import { runPromptPipelineAsync } from '../../pipeline/pipeline-worker-client';
import { templatePreparationKey } from '../../pipeline/template-lifecycle';
import { getSchemaValues, schemaRegistryStore } from '../../registry/schema-registry';
import { DEFAULT_CONTEXT_TOKENS, DEFAULT_RESPONSE_TOKENS } from '../../core/generation-defaults';
import { scopedVariableStore, resolveMergedVariables, getScopedVariables } from '../scoped-variable-store';
import { CompatibilityConnectionChangedError } from '../../compatibility/runtime-client';
import type { PromptInjection } from '../../compatibility/contracts';
import { readExtensionVariables } from '../../compatibility/extension-variables';
import type { AssembledPromptResult, NormalizedCharacterCard } from '../../types';
import type { AssemblePromptInput } from '../../pipeline/prompt-assembler';
import { hostHiddenKey } from '../../compatibility/chat-message-codec';
import { routeContent } from '../route-message-data';
import { normalizeTemplateFeatures, templateEntryEnabled } from '../../pipeline/template-features';
import { globalRegexes } from '../global-regex-store';
import { defaultWorldinfoSettings } from '../../pipeline/worldinfo-settings';
import { resolvedQuickReplyConfig } from '../../sandbox/quick-reply';
import { workspaceStore } from './state';
import { getActivePreset, getActiveLorebooks, getCharacterWorldbooks, getActiveCharacter, getActivePersona, getAvailableWorldbooks, getWorldbookGroups } from './library';
import { setStatusBanner } from './notice';
import { getEffectiveMvuSettings, getActiveChatMessages, authorMessageRevision } from './queries';
import { formatMessageWithoutTemplate } from './message-format';
import { persistWorkspaceNow } from './storage';

let previewConsumers = 0;

/** Inspector work is optional; message rendering is scheduled independently by the compatibility host. */
export function observePromptInspector(): () => void {
    previewConsumers++;
    schedulePreview();
    return () => { previewConsumers--; };
}

let previewRevision = 0;

let previewJob: Promise<AssembledPromptResult> | undefined;

let previewKey = '';

let previewSession = '';

export async function refreshPromptInspectorPreview(injections: PromptInjection[] = []): Promise<AssembledPromptResult> {
    if (workspaceStore.getState().sessionKind === 'free') throw new Error(`${freeChatName}不使用角色提示词。`);
    if (!injections.length && previewJob) {
        const session = workspaceStore.getState().activeChatId;
        const requestedKey = templateLifecycleKey();
        const result = await previewJob;
        if (workspaceStore.getState().activeChatId === session && (previewKey !== requestedKey || previewSession !== session)) return refreshPromptInspectorPreview();
        return result;
    }
    if (!injections.length) { previewKey = templateLifecycleKey(); previewSession = workspaceStore.getState().activeChatId; }
    const job = computePromptInspectorPreview(injections);
    if (injections.length) return job;
    previewJob = job;
    try { return await job; } finally { if (previewJob === job) previewJob = undefined; }
}

async function computePromptInspectorPreview(injections: PromptInjection[]): Promise<AssembledPromptResult> {
    const requestRevision = ++previewRevision;
    const state = workspaceStore.getState();
    const result = await runPromptPipelineAsync({ ...createPromptAssemblyInput(injections), templatePreview: true });

    if (requestRevision === previewRevision && workspaceStore.getState().activeChatId === state.activeChatId) {
        workspaceStore.setState(draft => { draft.lastAssembledPrompt = result; });
        if (result.compatibilityWarnings?.length) setStatusBanner(result.compatibilityWarnings[0], { kind: 'warning' });
        // Preview never advances timed states or mutates persistent variables.
    }
    return result;
}

const promptCards = new WeakMap<NormalizedCharacterCard, NormalizedCharacterCard>();

function promptCard(card: NormalizedCharacterCard): NormalizedCharacterCard {
    let value = promptCards.get(card);
    if (!value) {
        value = { ...card, avatar: '', characterBook: null, embeddedLorebook: null };
        promptCards.set(card, value);
    }
    return value;
}

let promptCatalogSource: NormalizedCharacterCard[] | undefined;

let promptCatalog: NormalizedCharacterCard[] = [];

let preparationSources: unknown[] = [];

let cachedPreparationKey = '';

export function createPromptAssemblyInput(injections: PromptInjection[] = [], clone = true): AssemblePromptInput {
    const state = workspaceStore.getState();
    const character = getActiveCharacter(state);
    const preset = getActivePreset(state);
    const lorebooks = getActiveLorebooks(state);
    const catalog = getAvailableWorldbooks(state);
    const binding = getCharacterWorldbooks(character, state);
    const schemaValues = getSchemaValues();
    const mvu = getEffectiveMvuSettings(state);
    const maxContextTokens = Number(schemaValues['sampler.context_max_tokens'] ?? DEFAULT_CONTEXT_TOKENS);
    const maxResponseTokens = Number(schemaValues['sampler.max_tokens'] ?? DEFAULT_RESPONSE_TOKENS);
    const worldinfoSettings = { ...defaultWorldinfoSettings, ...scopedVariableStore.getState().extension.tipsy_worldinfo,
        context_percentage: Number(schemaValues['lorebook.budget_percent'] ?? defaultWorldinfoSettings.context_percentage),
        scan_depth: Number(schemaValues['lorebook.scan_depth'] ?? 6), max_recursion_steps: Number(schemaValues['lorebook.max_recursion_steps'] ?? 4) };

    if (promptCatalogSource !== state.characters) {
        promptCatalogSource = state.characters;
        promptCatalog = state.characters.map(promptCard);
    }
    const input: AssemblePromptInput = {
        character: promptCard(character),
        characterAvatar: character.avatar,
        characterCatalog: promptCatalog,
        modelName: String(schemaValues['api.model'] ?? ''),
        tokenizer: (schemaValues['sampler.tokenizer'] ?? 'auto') as AssemblePromptInput['tokenizer'],
        generationSettings: { model: String(schemaValues['api.model'] ?? ''), stream: schemaValues['api.stream'] !== false,
            source: String(schemaValues['api.chat_completion_source'] ?? 'openai'), parameters: presetSamplingParameters(preset, schemaValues) },
        preset,
        lorebooks,
        lorebookCatalog: catalog,
        primaryWorldbookName: binding.primary,
        characterWorldbooks: binding,
        worldbookGroups: getWorldbookGroups(state),
        messages: getActiveChatMessages(state).map(({ branchBases, branchStates, nativePluginOpeningRoutes, nativePluginReplies, ...node }) => ({ ...node, content: routeContent(node, state.chatMetadata) })),
        chatMetadata: state.chatMetadata?.[hostHiddenKey] ? { [hostHiddenKey]: state.chatMetadata[hostHiddenKey] } : undefined,
        userName: state.userName,
        persona: getActivePersona(state),
        chatId: state.activeChatId,
        maxContextTokens,
        maxResponseTokens,
        timedStates: state.timedStates,
        templateInjections: state.templateInjections,
        templateActivations: state.templateActivations,
        templateFeatures: normalizeTemplateFeatures(readExtensionVariables(scopedVariableStore.getState().extension, 'EjsTemplate')),
        quickReplyConfig: resolvedQuickReplyConfig(readExtensionVariables(scopedVariableStore.getState().extension, 'quickReplyV2'), state.activeChatId, state.activeCharacterId),
        globalRegexScripts: globalRegexes(),
        worldinfoSettings,
        initialVariables: resolveMergedVariables({ presetId: preset.id, characterId: character.id, chatId: state.activeChatId, messageId: state.activeLeafId ?? undefined }),
        initialBaseVariables: { ...getScopedVariables('preset', { presetId: preset.id }), ...getScopedVariables('character', { characterId: character.id }) },
        initialGlobalVariables: getScopedVariables('global'),
        initialLocalVariables: getScopedVariables('chat', { chatId: state.activeChatId }),
        initialMessageVariables: Object.fromEntries(getActiveChatMessages(state)
            .filter(message => Object.hasOwn(scopedVariableStore.getState().message, message.id))
            .map(message => [message.id, getScopedVariables('message', { messageId: message.id })])),
        scanDepth: Number(schemaValues['lorebook.scan_depth'] ?? 6),
        maxRecursionSteps: Number(schemaValues['lorebook.max_recursion_steps'] ?? 4),
        injections,
        mvuWarnings: mvu.warnings,
        mvuWorldbookFilter: { primary: binding.primary,
            character: [binding.primary, ...binding.additional].filter((name): name is string => !!name),
            whitelist: String(mvu.settings['mvu.whitelist'] ?? ''), blacklist: String(mvu.settings['mvu.blacklist'] ?? ''),
            characterWhitelist: String(mvu.settings['mvu.character_whitelist'] ?? ''), characterBlacklist: String(mvu.settings['mvu.character_blacklist'] ?? ''),
            inlineMode: mvu.settings['mvu.mode'] !== '额外模型解析' },
    };
    const sources = [state.storyWorldbooks, state.storyCharacter, state.storyPersona, state.storyCharacterBinding, state.characters, state.lorebooks, preset, state.activeChatId, state.activeLorebookIds,
        state.characterWorldbookBindings, state.chatWorldbookBindings, state.userName, state.personas, state.activePersonaId,
        schemaRegistryStore.getState().values, scopedVariableStore.getState().extension];
    if (!cachedPreparationKey || sources.some((value, index) => value !== preparationSources[index])) {
        cachedPreparationKey = contentFingerprint(templatePreparationKey(input));
        preparationSources = sources;
    }
    // Keep the structural key on the host: only its compact signature crosses the message boundary.
    input.templatePreparationKey = cachedPreparationKey;
    return clone ? structuredClone(input) : input;
}

const messageTemplateCache = new Map<string, { content: string; swipe: number; signature: string; formatted: string }>();

export function readMessageTemplate(id: string) { return messageTemplateCache.get(id); }

let preloadSignature = '';

let preloadJob: { signature: string; promise: Promise<void> } | undefined;

let renderingJob: Promise<void> | undefined;

export function currentTemplateJobs() { return { preload: preloadJob?.promise, rendering: renderingJob }; }

let templateCommit: (result: AssembledPromptResult, input: AssemblePromptInput, signal?: AbortSignal) => Promise<void>;

export function connectTemplateCommit(commit: typeof templateCommit) { templateCommit = commit; }

export function invalidateTemplateEnvironment(): void {
    preloadSignature = '';
    messageTemplateCache.clear();
}

function templateSignature(input: AssemblePromptInput) {
    return input.templatePreparationKey ?? contentFingerprint(templatePreparationKey(input));
}

function renderSignature(input: AssemblePromptInput) {
    return contentFingerprint(JSON.stringify([templateSignature(input), input.initialVariables, input.initialGlobalVariables, input.initialLocalVariables,
        input.initialMessageVariables, input.templateInjections, input.templateActivations, input.messages.map(item => [item.id, item.content, item.activeSwipeIndex])]));
}

let lifecycleSources: unknown[] = [];

let lifecycleRevision = 0;

export function templateLifecycleKey(): string {
    const state = workspaceStore.getState();
    const variables = scopedVariableStore.getState();
    const sources = [getActiveCharacter(state), getActiveLorebooks(state), getActivePreset(state), state.activeChatId, state.activeLeafId,
        authorMessageRevision(state.messages), state.activeLorebookIds, state.characterWorldbookBindings, state.chatWorldbookBindings,
        state.userName, state.personas, state.activePersonaId, state.templateInjections, state.templateActivations,
        variables, schemaRegistryStore.getState().values];
    if (sources.some((value, index) => value !== lifecycleSources[index])) { lifecycleSources = sources; lifecycleRevision++; }
    return String(lifecycleRevision);
}

function contentFingerprint(content: string) {
    let left = 2166136261; let right = 5381;
    for (let index = 0; index < content.length; index++) { left = Math.imul(left ^ content.charCodeAt(index), 16777619); right = Math.imul(right, 33) ^ content.charCodeAt(index); }
    return `${content.length}:${left >>> 0}:${right >>> 0}`;
}

function hasRenderingTemplates(input: AssemblePromptInput) {
    const features = normalizeTemplateFeatures(input.templateFeatures);
    if (!features.enabled || !features.render_enabled) return false;
    return input.messages.some(node => node.content.includes('<%') || node.extra?.tipsy_template_source) || input.lorebooks.some(book => book.entries.some(entry =>
        templateEntryEnabled(entry, features) && (/\[RENDER:|@@render_(?:before|after)/.test(entry.comment + '\n' + entry.content))));
}

export async function ensureTemplatePreload(force = false): Promise<void> {
    if (workspaceStore.getState().sessionKind === 'free') return;
    let input = createPromptAssemblyInput([], false);
    let signature = templateSignature(input);
    if (!force && preloadSignature === signature) return;
    if (preloadJob) {
        try { await preloadJob.promise; }
        catch (error) { if (!(error instanceof TemplateInputChangedError) && !(error instanceof CompatibilityConnectionChangedError)) throw error; }
        input = createPromptAssemblyInput([], false);
        signature = templateSignature(input);
        if (!force && preloadSignature === signature) return;
    }
    const promise = (async () => {
        input = { ...input };
        input.templateTask = { type: 'preload' };
        input.templateForcePreload = force;
        const result = await runPromptPipelineAsync(input, undefined, true);
        await templateCommit(result, input);
        preloadSignature = signature;
        if (result.compatibilityWarnings?.length) setStatusBanner(result.compatibilityWarnings[0]);
    })();
    preloadJob = { signature, promise };
    try { await promise; } finally { if (preloadJob?.promise === promise) preloadJob = undefined; }
}

/** Render output is transient; only first-render writes (or explicit dryRun overrides) are committed. */
export async function refreshMessageTemplates(allowGenerating = false): Promise<void> {
    if (workspaceStore.getState().sessionKind === 'free') return;
    if (renderingJob) {
        try { await renderingJob; }
        catch (error) { if (!allowGenerating || !(error instanceof TemplateInputChangedError)) throw error; }
        if (allowGenerating) return refreshMessageTemplates(true);
        return;
    }
    if (workspaceStore.getState().isGenerating && !allowGenerating) return;
    const job = renderMessageTemplateBatch(); renderingJob = job;
    try { await job; } finally { if (renderingJob === job) renderingJob = undefined; }
}

async function renderMessageTemplateBatch(): Promise<void> {
    let changed = false;
    let processed = false;
    const session = workspaceStore.getState().activeChatId;
    try {
        let input = createPromptAssemblyInput([], false);
        if (!hasRenderingTemplates(input)) { changed = messageTemplateCache.size > 0; messageTemplateCache.clear(); return; }
        await ensureTemplatePreload();
        let inputKey = '';
        let signature = '';
        const refreshInput = () => {
            const key = templateLifecycleKey();
            if (key !== inputKey) {
                input = createPromptAssemblyInput([], false);
                signature = renderSignature(input);
                inputKey = key;
            }
        };
        for (const node of getActiveChatMessages()) {
            if (workspaceStore.getState().activeChatId !== session) break;
            const activeMessages = getActiveChatMessages();
            if (!activeMessages.some(item => item.id === node.id)) continue;
            const features = normalizeTemplateFeatures(readExtensionVariables(scopedVariableStore.getState().extension, 'EjsTemplate'));
            if (features.depth_limit >= 0 && activeMessages.length - 1 - node.floor > features.depth_limit) {
                if (messageTemplateCache.delete(node.id)) changed = true;
                continue;
            }
            refreshInput();
            const cached = messageTemplateCache.get(node.id);
            if (cached?.content === node.content && cached.swipe === node.activeSwipeIndex && cached.signature === signature) continue;
            let fingerprint = contentFingerprint(node.content);
            const previous = node.extra?.tipsy_template_render as Record<string, string> | undefined;
            const taskInput: AssemblePromptInput = { ...input, templateTask: { type: 'render', messageId: node.id, source: formatMessageWithoutTemplate(node),
                dryRun: !!node.extra?.tipsy_generation_incomplete || previous?.[node.activeSwipeIndex] === fingerprint } };
            const result = await runPromptPipelineAsync(taskInput, undefined, true);
            await templateCommit(result, taskInput);
            const current = getActiveChatMessages().find(message => message.id === node.id)!;
            fingerprint = contentFingerprint(current.content);
            if (previous?.[node.activeSwipeIndex] !== fingerprint) {
                workspaceStore.setState(draft => {
                    draft.messages = draft.messages.map(target => target.id === node.id ? { ...target,
                        extra: { ...target.extra, tipsy_template_render: { ...(target.extra?.tipsy_template_render as object ?? {}), [node.activeSwipeIndex]: fingerprint } } } : target);
                });
                processed = true;
            }
            refreshInput();
            messageTemplateCache.set(node.id, { content: current.content, swipe: current.activeSwipeIndex, signature, formatted: result.templateContent ?? formatMessageWithoutTemplate(current) });
            changed = true;
            if (result.compatibilityWarnings?.length) setStatusBanner(result.compatibilityWarnings[0]);
        }
        const active = new Set(getActiveChatMessages().map(node => node.id));
        for (const key of messageTemplateCache.keys()) if (!active.has(key)) messageTemplateCache.delete(key);
        if (processed) await persistWorkspaceNow();
    } finally {
        if (changed) workspaceStore.setState(draft => { draft.templateRenderRevision++; });
    }
}

export async function refreshTemplateLifecycle(): Promise<boolean> {
    if (workspaceStore.getState().isGenerating) return false;
    try {
        await ensureTemplatePreload();
        await refreshMessageTemplates();
        return true;
    } catch (error) {
        // A background render may be superseded by author writes (e.g. opening
        // setup creating worldbook entries). Its transaction has been released;
        // the lifecycle scheduler will pick up the current inputs.
        if (error instanceof TemplateInputChangedError || error instanceof CompatibilityConnectionChangedError) return false;
        throw error;
    }
}

let previewScheduled = false;

export function schedulePreview(): void {
    if (!previewConsumers || previewScheduled || workspaceStore.getState().sessionKind === 'free') return;
    previewScheduled = true;
    setTimeout(() => {
        previewScheduled = false;
        if (!previewConsumers || workspaceStore.getState().sessionKind === 'free') return;
        void refreshPromptInspectorPreview()
            .catch(error => setStatusBanner(error instanceof Error ? error.message : String(error)));
    }, 100);
}

export class TemplateInputChangedError extends Error {}

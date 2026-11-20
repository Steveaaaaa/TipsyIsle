import { syncRuntimeReady } from '../core/sync/activity';
import { showNotification, dismissNotification, type NotificationOptions } from './notification-store';
import { saveExport } from '../core/platform-files';
import { listChatArchives, loadChatArchive, saveChatArchive, deleteCharacterArchives, clearChatArchives, summarizeChat, type ArchivedChat } from './chat-archives';
import { batchReactiveUpdates, cloneStateValue, createReactiveStore, withoutStoreNotifications } from './reactive-store';
import { rollbackStateChanges } from './state-rollback';
import { normalizeCharacterCard, normalizeLorebook, normalizePreset, normalizeChatPayload } from '../pipeline/normalizer';
import { removeRetiredBuiltinWorldbooks } from '../core/builtin-worldbook';
import { EMPTY_CHARACTER, NO_PRESET, emptyStory } from '../core/empty-workspace';
import { isRetiredGuide, isRetiredPreset, removeStarterContinuation } from '../core/retired-starter-content';
import { embedCharacterCardIntoPng } from '../core/png-chunk-codec';
import { importCharacterFile } from '../core/character-import';
import { platformStorage, streamLlmCompletion, type CompletionResult } from '../core/platform-bridge';
import { StreamProjector, createStreamPlan, type StreamDisplayMode, type MessageStreamPreview } from '../pipeline/streaming-message';
import { StorySummaryChannel, summaryContentHash } from '../pipeline/story-summary';
import { presetSamplingParameters } from '../core/generation-settings';
import { claimPromptTemplateTask, finishPromptTemplateTask, runPromptPipelineAsync } from '../pipeline/pipeline-worker-client';
import { templatePreparationKey } from '../pipeline/template-lifecycle';
import { applyRegexScripts, evaluateMacros, orderedRegexScripts, regexRuleApplies } from '../pipeline/macro-regex-engine';
import { analyzeMvuReply } from '../compatibility/mvu-extra-analysis';
import { appendMvuRepair, buildMvuRepairTask } from '../pipeline/mvu-repair';
import _ from 'lodash';
import { findUpdateMarkupBlocks } from '../pipeline/mvu-markup';
import { resolveMvuSettings } from '../pipeline/mvu-settings';
import { getSchemaValues, setSchemaValues, schemaRegistryStore } from '../registry/schema-registry';
import { DEFAULT_CONTEXT_TOKENS, DEFAULT_RESPONSE_TOKENS } from '../core/generation-defaults';
import { scopedVariableStore, resolveMergedVariables, getScopedVariables, readScopedVariables, insertOrAssignScopedVariables, replaceScopedVariables, deleteScopedVariableKey, replaceExtensionVariables, registerAssetVariableAccess } from './scoped-variable-store';
import { activePath, branchOptions, swipeId, routeKey, storyRoutes, withSwipe, branchExcerpt } from './chat-tree';
import { branchMessageVariable, branchMessageVariables, captureVariablePages, createBranchVariableRemapper, type BranchState } from './branch-state';
import { pendingBranchOperations, runBranchOperation } from './branch-runtime';
import { compatibilityComposer } from '../compatibility/composer-bridge';
import { serializeCharacterCard, serializeLorebook } from '../pipeline/asset-serializer';
import { loadMvuInitialVariables, readInitialVariables } from '../pipeline/initial-variables';
import { mvuProjectionKeys, normalizeMvuVariables, normalizeMvuVariableMap } from '../pipeline/mvu-data';
import { executePluginHooks } from '../plugins/plugin-host';
import { assertCurrentStory, findStoryMessage, installNativeStoryPort, makeStoryTracker, messageRef, settled, type StoryCommit } from '../plugins/native/story-port';
import type { PluginBucket, PluginBuckets } from '../plugins/native/storage';
import { nativeGenerationContributions, notifyNativeReplySaved } from '../plugins/native/host';
import { prepareNativePrompt, readNativeAfterScan } from '../plugins/native/generation-stages';
import { streamStoryWithNativeTools } from '../plugins/native/generation-tools';
import { PluginApiError } from '../plugins/native/errors';
import { activeAddress, continueNativeRoute, routeGraph, routeRootId, vertexPath } from '../plugins/native/route-graph';
import type { RouteAddress, StoryChange } from '../../packages/plugin-sdk/index.js';
import { applyNativeContributions } from '../plugins/native/prompt';
import { tavernEventBus } from '../sandbox/event-bus';
import { commandCompatibilityRuntime, publishNativeGenerationProgress, stopCompatibilityRuntime, resetCompatibilityBranch, CompatibilityConnectionChangedError } from '../compatibility/runtime-client';
import { type PromptInjection, type HelperVariableOption, type VariableWrite } from '../compatibility/contracts';
import { normalizeScriptTrees, scriptsFromTrees, type ScriptScope, type ScriptTrees } from '../compatibility/script-trees';
import { validateExtensionVariableId } from '../compatibility/extension-variables';
import { readMvuCommands, settleMvuWithoutScripts } from '../pipeline/mvu-commands';
import type {
    AssembledPromptResult,
    ChatMessageNode,
    LorebookTimedState,
    NormalizedCharacterCard,
    NormalizedLorebook,
    NormalizedPreset,
    PresetPromptSlot,
} from '../types';
import type { AssemblePromptInput } from '../pipeline/prompt-assembler';
import type { TemplatePromptInjection } from '../pipeline/template-injections';
import { enqueuePersistentOperation, persistStateTransaction, registerSnapshotSource, persistRegisteredSnapshots, suspendRegisteredPersistence } from './persistence';
import { waitForReplicaCommit, holdReplicaCommit, registeredSnapshots, acknowledgeSnapshots } from './persistence';
import { hostHiddenKey, hostMessageHidden, messageExtra, patchHelperMessage, validateMessageRefresh } from '../compatibility/chat-message-codec';
import { normalizeTemplateFeatures, templateEntryEnabled, legacyTemplateFeatures } from '../pipeline/template-features';
import { readExtensionVariables } from '../compatibility/extension-variables';
import { globalRegexes } from './global-regex-store';
import { defaultWorldinfoSettings } from '../pipeline/worldinfo-settings';
import { quickReplySets, resolvedQuickReplyConfig, type QuickReplySetData } from '../sandbox/quick-reply';

function buildInitialMessages(card: NormalizedCharacterCard): ChatMessageNode[] {
    const firstMes = card.firstMessage ?? '';
    const alternate = Array.isArray(card.alternateGreetings) ? card.alternateGreetings : [];
    const swipes = [firstMes, ...alternate];
    const greeting = swipes[0];
    const now = Date.now();
    const id = `msg_${crypto.randomUUID()}`;
    return [
        {
            id,
            messageId: id,
            parentId: null,
            floor: 0,
            role: 'assistant',
            speakerName: card.name,
            content: greeting,
            swipes,
            activeSwipeIndex: 0,
            createdAt: now,
            updatedAt: now,
            extra: { tipsy_mvu_initialization_pending: true },
        },
    ];
}

export interface WorkspaceState {
    branchEpoch?: number;
    chatMetadata?: Record<string, unknown>;
    nativePluginRoute?: PluginBuckets;
    nativeStoryReply?: StoryChange;
    branchExtensionKeys?: string[];
    deletedMessageIds?: string[];
    storyWorldbooks?: NormalizedLorebook[];
    storyCharacterBinding?: { primary: string | null; additional: string[] };
    storyCharacter?: NormalizedCharacterCard;
    storyPersona?: import('../types').UserPersona;
    streamDisplayModes: Record<string, StreamDisplayMode>;
    userName: string;
    personas: import('../types').UserPersona[];
    activePersonaId: string | null;
    characters: NormalizedCharacterCard[];
    activeCharacterId: string;
    lorebooks: NormalizedLorebook[];
    activeLorebookIds: string[];
    characterWorldbookBindings: Record<string, { primary: string | null; additional: string[] }>;
    chatWorldbookBindings: Record<string, string | null>;
    presets: NormalizedPreset[];
    activePresetId: string;
    inUsePreset?: NormalizedPreset;
    activeChatId: string;
    messages: ChatMessageNode[];
    activeLeafId: string | null;
    timedStates: Record<string, LorebookTimedState>;
    lastAssembledPrompt: AssembledPromptResult | null;
    isGenerating: boolean;
    mvuExtraAnalysisActive: boolean;
    helperGenerationCount: number;
    streamingReasoning: string;
    nativeToolPreview?: { id: string; content: string; reasoning: string };
    templateRenderRevision: number;
    templateInjections: TemplatePromptInjection[];
    templateActivations: Array<{ world: string; uid: string | number; force: boolean }>;
}

let activeAbortController: AbortController | null = null;
let nativeStorySaving = false;
let generationNotificationMessage: string | undefined;
const messageNotifications = new Map<string, Promise<void>>();

function notifyMessage(event: string, node: ChatMessageNode): void {
    const session = workspaceStore.getState().activeChatId, epoch = workspaceStore.getState().branchEpoch;
    const promise = (async () => {
        await tavernEventBus.emit(event, node);
        if (workspaceStore.getState().activeChatId !== session || workspaceStore.getState().branchEpoch !== epoch) return;
        await commandCompatibilityRuntime('event', [event, node.floor]);
        if (workspaceStore.getState().activeChatId === session && !workspaceStore.getState().isGenerating) await refreshMessageTemplates();
        if (workspaceStore.getState().activeChatId === session && workspaceStore.getState().branchEpoch === epoch) {
            if (workspaceStore.getState().activeLeafId === node.id) sealBranchPoint();
            persistWorkspace();
        }
    })();
    messageNotifications.set(node.id, promise);
    if (messageNotifications.size > 64) messageNotifications.delete(messageNotifications.keys().next().value!);
    void promise.catch(error => setStatusBanner(String(error)));
}

/** Capture each swipe's variables, chat projection and lorebook timers as one logical snapshot. */
export function captureMessageSnapshot(id: string): void {
    const state = workspaceStore.getState();
    const node = state.messages.find(message => message.id === id);
    if (!node) return;
    const variables = readScopedVariables('message', { messageId: id });
    const current = id === getActiveChatMessages(state).at(-1)?.id;
    const chatVariables = current ? readScopedVariables('chat', { chatId: state.activeChatId }) : node.extra?.chatVariables ?? {};
    const timedStates = current ? state.timedStates : node.extra?.timedStates ?? {};
    const templateState = current ? { injections: state.templateInjections, activations: state.templateActivations }
        : node.extra?.templateState ?? { injections: [], activations: [] };
    const checkpoint = current && node.floor > 0 ? readBranchState(state, node) : undefined;
    workspaceStore.setState(draft => {
        const target = draft.messages.find(message => message.id === id)!;
        target.swipeIds ??= target.swipes.map((_, index) => swipeId(target, index));
        if (checkpoint) (target.branchStates ??= {})[swipeId(target)] = checkpoint;
        if (current && node.floor === 0 && state.nativePluginRoute) (target.nativePluginOpeningRoutes ??= {})[swipeId(target)] = state.nativePluginRoute;
        target.extra = { ...target.extra, chatVariables, timedStates, templateState,
            ...(current && node.floor === 0 && (state.chatMetadata || target.extra?.swipeHostMetadata) ? {
                swipeHostMetadata: { ...(target.extra?.swipeHostMetadata as object ?? {}), [target.activeSwipeIndex]: state.chatMetadata },
            } : {}),
            swipeVariables: { ...(target.extra?.swipeVariables as object ?? {}), [target.activeSwipeIndex]: variables },
            swipeChatVariables: { ...(target.extra?.swipeChatVariables as object ?? {}), [target.activeSwipeIndex]: chatVariables },
            swipeTimedStates: { ...(target.extra?.swipeTimedStates as object ?? {}), [target.activeSwipeIndex]: timedStates },
            swipeTemplateStates: { ...(target.extra?.swipeTemplateStates as object ?? {}), [target.activeSwipeIndex]: templateState } };
    });
}

function restoreMessageSnapshot(id: string): void {
    const state = workspaceStore.getState();
    const node = state.messages.find(message => message.id === id);
    if (!node) return;
    const swipe = node.activeSwipeIndex;
    const checkpoint = node.floor > 0 ? node.branchStates?.[swipeId(node)] : undefined;
    if (checkpoint && state.activeLeafId === id) { applyBranchState(checkpoint); return; }
    const extra = node.extra ?? {};
    const snapshots = extra.swipeVariables as Record<string, Record<string, unknown>> | undefined;
    const parent = state.messages.find(message => message.id === node.parentId);
    const variables = snapshots?.[swipe] ?? (swipe === 0 ? getScopedVariables('message', { messageId: node.id }) :
        parent ? getScopedVariables('message', { messageId: parent.id }) : readWorkspaceInitialVariables(state));
    replaceScopedVariables(structuredClone(variables), 'message', { messageId: node.id });
    if (node.id !== getActiveChatMessages(state).at(-1)?.id) return;
    const chatSnapshots = extra.swipeChatVariables as Record<string, Record<string, unknown>> | undefined;
    const timerSnapshots = extra.swipeTimedStates as Record<string, Record<string, LorebookTimedState>> | undefined;
    const chat = chatSnapshots?.[swipe] ?? (snapshots?.[swipe] || swipe === 0 ? extra.chatVariables : parent?.extra?.chatVariables ?? initialChatVariables(state)) ?? {};
    const projection = chatSnapshots?.[swipe] ? {} : mvuChatProjection(variables);
    replaceScopedVariables(structuredClone({ ...chat as object, ...projection }), 'chat', { chatId: state.activeChatId });
    const timedStates = timerSnapshots?.[swipe] ?? (snapshots?.[swipe] || swipe === 0 ? extra.timedStates : parent?.extra?.timedStates) ?? {};
    const templateSnapshots = extra.swipeTemplateStates as Record<string, { injections: TemplatePromptInjection[]; activations: WorkspaceState['templateActivations'] }> | undefined;
    const templateState = templateSnapshots?.[swipe] ?? (swipe === 0 ? extra.templateState : parent?.extra?.templateState) as { injections: TemplatePromptInjection[]; activations: WorkspaceState['templateActivations'] } | undefined;
    const parentSwipe = parent && node.parentSwipeId ? parent.swipes.findIndex((_, index) => swipeId(parent, index) === node.parentSwipeId) : parent?.activeSwipeIndex;
    const hostMetadata = (extra.swipeHostMetadata as Record<number, Record<string, unknown>> | undefined)?.[swipe];
    const parentMetadata = node.floor > 0 && parent && parentSwipe !== undefined && parentSwipe >= 0
        ? parent.branchStates?.[swipeId(parent, parentSwipe)]?.continuation.chatMetadata
            ?? (parent.extra?.swipeHostMetadata as Record<number, Record<string, unknown>> | undefined)?.[parentSwipe] : undefined;
    workspaceStore.setState(draft => {
        draft.timedStates = structuredClone(timedStates) as Record<string, LorebookTimedState>;
        draft.chatMetadata = hostMetadata ?? parentMetadata;
        draft.nativePluginRoute = routePluginBucketsAt(getActiveChatMessages(state));
        draft.templateInjections = structuredClone(templateState?.injections ?? []);
        draft.templateActivations = structuredClone(templateState?.activations ?? []);
    });
}

function routePluginBucketsAt(path: ChatMessageNode[]): PluginBuckets | undefined {
    for (let index = path.length - 1; index >= 0; index--) {
        const node = path[index], key = swipeId(node);
        const point = node.branchStates?.[key];
        if (point) return point.continuation.nativePluginRoute;
        if (node.floor === 0) return node.nativePluginOpeningRoutes?.[key];
    }
}

function readBranchState(state: WorkspaceState, node: ChatMessageNode): BranchState {
    const variables = scopedVariableStore.getState();
    const path = getActiveChatMessages(state);
    const parent = path.at(-2);
    const previous = node.branchStates?.[swipeId(node)] ?? (parent && parent.branchStates?.[swipeId(parent)]);
    const messageVariablePages = captureVariablePages(path, variables.message, previous);
    const continuation: NonNullable<ArchivedChat['continuation']> = {
        chatMetadata: state.chatMetadata,
        nativePluginRoute: state.nativePluginRoute,
        variables: { global: variables.global, character: { [state.activeCharacterId]: readScopedVariables('character', { characterId: state.activeCharacterId }) },
            preset: { [state.activePresetId]: readScopedVariables('preset', { presetId: state.activePresetId }) },
            chat: { [state.activeChatId]: variables.chat[state.activeChatId] ?? {} },
            message: {} },
        extensions: Object.fromEntries([...new Set([...SYNC_EXTENSIONS, ...state.branchExtensionKeys ?? []])].filter(key => key in variables.extension).map(key => [key, variables.extension[key]])),
        extensionKeys: state.branchExtensionKeys,
        activePresetId: state.activePresetId, inUsePreset: getActivePreset(state), activeLorebookIds: state.activeLorebookIds,
        userName: state.userName, activePersonaId: state.activePersonaId,
        settings: Object.fromEntries(Object.entries(getSchemaValues()).filter(([key]) => syncStorySetting(key))),
        worldbooks: getActiveLorebooks(state), characterBinding: getCharacterWorldbooks(getActiveCharacter(state), state),
        character: getActiveCharacter(state), persona: getActivePersona(state) };
    return { continuation, messageVariablePages, reply: { content: node.content, reasoning: node.reasoning, swipe: node.swipes[node.activeSwipeIndex], extra: node.extra },
        worldbookName: state.chatWorldbookBindings[state.activeChatId] ?? null, timedStates: state.timedStates, templateInjections: state.templateInjections, templateActivations: state.templateActivations };
}
function applyBranchState(checkpoint: BranchState, keepLibraryBooks = false): void {
    const c = checkpoint.continuation;
    const currentMessageVariables = scopedVariableStore.getState().message;
    const current = workspaceStore.getState();
    const currentSettings = structuredClone(getSchemaValues());
    const currentPresetId = current.activePresetId;
    const currentPreset = current.inUsePreset ? structuredClone(current.inUsePreset) : undefined;
    const currentLorebooks = [...current.activeLorebookIds];
    const currentChatWorldbook = current.chatWorldbookBindings[current.activeChatId] ?? null;
    const currentBinding = current.storyCharacterBinding ? structuredClone(current.storyCharacterBinding) : undefined;
    batchReactiveUpdates(() => {
    scopedVariableStore.setState(draft => {
        draft.global = c.variables.global;
        for (const scope of ['character', 'preset', 'chat'] as const) Object.assign(draft[scope], c.variables[scope]);
        for (const [id, value] of Object.entries(branchMessageVariables(checkpoint))) if (currentMessageVariables[id] !== value) draft.message[id] = value;
        for (const key of new Set([...SYNC_EXTENSIONS, ...workspaceStore.getState().branchExtensionKeys ?? [], ...c.extensionKeys ?? []])) { if (key in c.extensions) draft.extension[key] = c.extensions[key]; else delete draft.extension[key]; }
    });
    // A route checkpoint restores story state, but it must not undo a user's
    // current runtime choices made after that checkpoint was created.
    schemaRegistryStore.setState(draft => { Object.assign(draft.values, currentSettings); });
    workspaceStore.setState({ timedStates: structuredClone(checkpoint.timedStates),
        chatMetadata: c.chatMetadata,
        nativePluginRoute: c.nativePluginRoute,
        templateInjections: structuredClone(checkpoint.templateInjections), templateActivations: structuredClone(checkpoint.templateActivations),
        activePresetId: currentPresetId, inUsePreset: currentPreset, activeLorebookIds: currentLorebooks,
        storyCharacter: c.character, storyWorldbooks: keepLibraryBooks ? routeWorldbooks(c.worldbooks, current) : c.worldbooks,
        storyCharacterBinding: currentBinding ?? c.characterBinding, storyPersona: c.persona,
        activePersonaId: c.activePersonaId, userName: c.userName, branchExtensionKeys: c.extensionKeys ?? [], lastAssembledPrompt: null });
    workspaceStore.setState(draft => { draft.chatWorldbookBindings[draft.activeChatId] = currentChatWorldbook; });
    });
}
export function sealBranchPoint(replace = false): void {
    const state = workspaceStore.getState(), node = getActiveChatMessages(state).at(-1);
    if (!node || node.extra?.tipsy_generation_incomplete && !replace) return;
    captureMessageSnapshot(node.id);
    if (node.floor === 0) { persistWorkspace(); return; }
    workspaceStore.setState(draft => {
        const target = draft.messages.find(item => item.id === node.id)!;
        const key = swipeId(target);
        target.branchBases ??= {};
        if (replace || !target.branchBases[key]) target.branchBases[key] = target.branchStates![key];
    });
    persistWorkspace();
}
function remapBranchSnapshots(node: ChatMessageNode, oldId: string | Map<string, string>): void {
    const ids = typeof oldId === 'string' ? new Map([[oldId, node.id]]) : oldId;
    const remap = createBranchVariableRemapper(ids);
    for (const field of ['branchBases', 'branchStates'] as const) if (node[field]) {
        node[field] = Object.fromEntries(Object.entries(node[field]!).map(([key, point]) => [key, remap(point)]));
    }
}
/** Preserve an existing candidate and its descendants before an in-place author edit. */
function preserveReplyVersion(node: ChatMessageNode): void {
    const state = workspaceStore.getState();
    const hasChildren = state.messages.some(item => item.parentId === node.id);
    if (state.isGenerating || !node.branchBases?.[swipeId(node)] && !hasChildren) return;
    const graph = routeGraph(state.messages);
    const originalRoutes = Object.fromEntries(node.swipes.map((_, index) => [swipeId(node, index), graph.vertices.get(routeKey(node, index))?.routeId ?? routeRootId(node, index)]));
    const copy = structuredClone(node), id = `msg_${crypto.randomUUID()}`;
    copy.id = id; copy.messageId = id; copy.branchOrigin = node.branchOrigin ?? node.id;
    copy.branchLabel = node.branchLabel ?? '修改前的路线';
    copy.swipeIds ??= node.swipes.map((_, index) => swipeId(node, index));
    copy.nativeRouteAnchors = hasChildren ? originalRoutes : undefined;
    remapBranchSnapshots(copy, node.id);
    workspaceStore.setState(draft => {
        draft.messages.push(copy);
        const target = draft.messages.find(item => item.id === node.id)!;
        target.branchOrigin ??= node.id;
        target.nativeRouteAnchors = hasChildren ? Object.fromEntries(node.swipes.map((_, index) => [swipeId(node, index), `route:edit:${id}:${index}`])) : originalRoutes;
        const descendants = new Set([node.id]);
        for (let changed = true; changed;) {
            changed = false;
            for (const child of draft.messages) if (child.parentId && descendants.has(child.parentId) && !descendants.has(child.id)) { descendants.add(child.id); changed = true; }
        }
        for (const child of draft.messages) if (child.id !== node.id && descendants.has(child.id)) {
            if (child.parentId === node.id) child.parentId = id;
            remapBranchSnapshots(child, new Map([[node.id, id]]));
        }
    });
    scopedVariableStore.setState(draft => { draft.message[id] = draft.message[node.id] ?? {}; });
}
const branchDrafts = new Map<string, string>();
export function trackBranchExtension(id: string): void {
    const key = String(_.toPath(id)[0]);
    workspaceStore.setState(draft => { if (!draft.branchExtensionKeys?.includes(key)) (draft.branchExtensionKeys ??= []).push(key); });
}
function branchBusy(internal = false) { const s = workspaceStore.getState(); return nativeStorySaving || !syncRuntimeReady() || s.isGenerating || s.helperGenerationCount > 0 || s.mvuExtraAnalysisActive || pendingBranchOperations() > (internal ? 1 : 0); }
function rememberBranch(): void {
    const state = workspaceStore.getState(), leaf = getActiveChatMessages(state).at(-1);
    if (!leaf) return;
    captureMessageSnapshot(leaf.id);
    branchDrafts.set(`${state.activeChatId}:${routeKey(leaf)}`, compatibilityComposer());
}
function publishBranchChange(restartRuntime = true): void {
    const state = workspaceStore.getState(), leaf = getActiveChatMessages(state).at(-1);
    workspaceStore.setState({ branchEpoch: (state.branchEpoch ?? 0) + 1 });
    compatibilityComposer(leaf ? branchDrafts.get(`${state.activeChatId}:${routeKey(leaf)}`) ?? '' : '');
    persistWorkspace();
    if (restartRuntime) resetCompatibilityBranch();
    window.dispatchEvent(new Event('tipsy-branch-changed'));
    schedulePreview();
}
function activateBranch(id: string, index: number, keepLibraryBooks = false): void {
    workspaceStore.setState(draft => {
        const target = draft.messages.find(node => node.id === id)!;
        Object.assign(target, withSwipe(target, index));
        const path = activePath(draft.messages, id);
        for (const item of path) {
            const stored = draft.messages.find(node => node.id === item.id)!;
            Object.assign(stored, withSwipe(stored, item.activeSwipeIndex));
        }
        draft.activeLeafId = id;
    });
    const path = getActiveChatMessages();
    const leaf = path.at(-1);
    const checkpoint = leaf?.branchStates?.[swipeId(leaf)];
    if (checkpoint) {
        // A route checkpoint already includes the whole path. Replaying per-floor
        // variable writes would run author listeners against intermediate states.
        applyBranchState(checkpoint, keepLibraryBooks);
    } else {
        for (const node of path) restoreMessageSnapshot(node.id);
    }
}
export function retryStoryFrom(id: string, index?: number, internal = false): void {
    const state = workspaceStore.getState();
    const path = activePath(state.messages, id);
    const source = [...path].reverse().find(node => node.role === 'assistant');
    if (!source || source.floor === 0) throw new Error('开场不参与剧情分支，请新建会话更换开局');
    if (branchBusy(internal)) throw new Error('请等待本轮生成和变量结算结束后重新选择');
    const selected = source.id === id ? index ?? source.activeSwipeIndex : source.activeSwipeIndex;
    const checkpoint = source.branchBases?.[swipeId(source, selected)];
    if (!checkpoint?.reply) throw new Error('这段剧情没有完整的选择前快照，暂不能从这里重新选择');
    rememberBranch();
    invalidateTemplateEnvironment();
    batchReactiveUpdates(() => {
        const copy = { ...withSwipe(source, selected) }, nextId = `msg_${crypto.randomUUID()}`;
        const selectedKey = swipeId(source, selected);
        copy.id = nextId; copy.messageId = nextId; copy.branchOrigin = source.branchOrigin ?? source.id;
        copy.nativeRouteAnchors = { [selectedKey]: `route:fork:${nextId}` };
        copy.branchLabel = '重新选择'; copy.createdAt = Date.now(); copy.updatedAt = Date.now();
        if (checkpoint.reply) {
            copy.content = checkpoint.reply.content; copy.reasoning = checkpoint.reply.reasoning;
            copy.extra = structuredClone(checkpoint.reply.extra);
        }
        copy.swipes = [structuredClone(checkpoint.reply?.swipe ?? copy.swipes[selected])]; copy.swipeIds = [selectedKey]; copy.activeSwipeIndex = 0;
        const replies = source.nativePluginReplies?.[selectedKey];
        copy.nativePluginReplies = replies ? { [selectedKey]: replies } : undefined;
        for (const key of ['swipeVariables', 'swipeChatVariables', 'swipeTimedStates', 'swipeTemplateStates', 'helperSwipeInfo', 'tipsy_template_source', 'tipsy_template_render', 'tipsy_template_variables_initialized']) {
            const table = copy.extra?.[key] as Record<string, unknown> | undefined;
            if (table) copy.extra![key] = { 0: table[selected] };
        }
        copy.extra = { ...copy.extra, swipeVariables: { 0: branchMessageVariable(checkpoint, source.id) ?? {} },
            swipeChatVariables: { 0: structuredClone(checkpoint.continuation.variables.chat[workspaceStore.getState().activeChatId] ?? {}) },
            swipeTimedStates: { 0: structuredClone(checkpoint.timedStates) },
            swipeTemplateStates: { 0: { injections: structuredClone(checkpoint.templateInjections), activations: structuredClone(checkpoint.templateActivations) } } };
        delete copy.extra.tipsy_generation_incomplete;
        delete copy.extra.tipsy_generation_terminal;
        const point = createBranchVariableRemapper(new Map([[source.id, nextId]]))(checkpoint);
        point.reply = { content: copy.content, reasoning: copy.reasoning, swipe: copy.swipes[0], extra: copy.extra };
        copy.branchBases = { [selectedKey]: point };
        copy.branchStates = { [selectedKey]: point };
        const parent = path[source.floor - 1];
        copy.parentId = parent?.id ?? null;
        copy.parentSwipeId = parent ? swipeId(parent) : undefined;
        copy.floor = source.floor;
        workspaceStore.setState(draft => { draft.messages.push(copy); draft.activeLeafId = copy.id; });
        activateBranch(copy.id, 0);
    });
    publishBranchChange(!internal);
    setStatusBanner(`新路线已回到第 ${source.floor} 楼，可以重新选择；此后的消息保留在原路线。`);
}

function initialWorkspace(): WorkspaceState {
return {
    userName: '用户',
    streamDisplayModes: {},
    personas: [],
    activePersonaId: null,
    characters: [],
    activeCharacterId: '',
    lorebooks: [],
    activeLorebookIds: [],
    characterWorldbookBindings: {},
    chatWorldbookBindings: {},
    presets: [],
    inUsePreset: undefined,
    activePresetId: '',
    activeChatId: '',
    messages: [],
    activeLeafId: null,
    timedStates: {},
    lastAssembledPrompt: null,
    isGenerating: false,
    mvuExtraAnalysisActive: false,
    helperGenerationCount: 0,
    streamingReasoning: '',
    templateRenderRevision: 0,
    templateInjections: [],
    templateActivations: [],
};
}
export const workspaceStore = createReactiveStore<WorkspaceState>(initialWorkspace);
const authorMessageRevisions = new WeakMap<ChatMessageNode[], symbol>();
export function authorMessageRevision(messages: ChatMessageNode[]): symbol {
    let revision = authorMessageRevisions.get(messages);
    if (!revision) { revision = Symbol(); authorMessageRevisions.set(messages, revision); }
    return revision;
}
export function preserveAuthorMessageRevision(previous: ChatMessageNode[], next: ChatMessageNode[]): void {
    if (previous !== next) authorMessageRevisions.set(next, authorMessageRevision(previous));
}

const trackNativeStory = makeStoryTracker();
function isNativeStoryBusy(state = workspaceStore.getState()) {
    return !syncRuntimeReady() || state.isGenerating || state.helperGenerationCount > 0 || state.mvuExtraAnalysisActive || pendingBranchOperations() > 0;
}
function readNativeStory() {
    const state = workspaceStore.getState();
    const view = trackNativeStory(state.activeChatId, state.branchEpoch ?? 0, getActiveChatMessages(state), state.nativePluginRoute, isNativeStoryBusy(state));
    return { ...view, get route() {
        let i = view.path.length;
        while (i && !settled(view.path[i - 1])) i--;
        return activeAddress(state.activeChatId, state.messages, view.path[i - 1]);
    } };
}
installNativeStoryPort({ current: readNativeStory, busy: isNativeStoryBusy, subscribe: listener => workspaceStore.subscribe(listener),
    commit: commitNativePluginState, buckets: localNativePluginBuckets });

function commitNativePluginState(input: StoryCommit): Promise<void> {
    return enqueuePersistentOperation(async () => {
        await waitForReplicaCommit();
        const release = holdReplicaCommit();
        nativeStorySaving = true;
        try { await commitWorkspaceMutation(() => {
            input.check();
            const state = workspaceStore.getState(), view = readNativeStory(), target = input.target && findStoryMessage(view, input.target);
            assertCurrentStory(input.view, view);
            const { pluginId, route, reply } = input;
            if (route && route.before !== view.storage?.[pluginId] || reply && (!input.target || !target
                || reply.before !== target.nativePluginReplies?.[input.target.swipeId]?.[pluginId])) throw new PluginApiError('STORAGE_CONFLICT', '另一项操作刚更新了插件数据，请重试');
            const head = view.path.at(-1);
            if (route && !head) throw new Error('请先打开一段剧情');
            const key = head ? swipeId(head) : '';
            const checkpoint = route && head && head.floor > 0 && !head.branchStates?.[key] ? readBranchState(state, head) : undefined;
            workspaceStore.setState(draft => {
                if (reply && target && input.target) {
                    const node = draft.messages.find(item => item.id === target.id)!;
                    const swipes = node.nativePluginReplies ??= {};
                    (swipes[input.target.swipeId] ??= {})[pluginId] = reply.after;
                }
                if (route && head) {
                    const buckets = { ...state.nativePluginRoute, [pluginId]: route.after };
                    draft.nativePluginRoute = buckets;
                    const node = draft.messages.find(item => item.id === head.id)!;
                    if (node.floor === 0) (node.nativePluginOpeningRoutes ??= {})[key] = buckets;
                    else {
                        if (checkpoint) (node.branchStates ??= {})[key] = { ...checkpoint, continuation: { ...checkpoint.continuation, nativePluginRoute: buckets } };
                        else node.branchStates![key].continuation.nativePluginRoute = buckets;
                        // Update only native data in the before-choice checkpoint.
                        const base = node.branchBases?.[key];
                        if (base) base.continuation.nativePluginRoute = { ...base.continuation.nativePluginRoute, [pluginId]: route.after };
                    }
                }
            });
            preserveAuthorMessageRevision(state.messages, workspaceStore.getState().messages);
        }, input.extras, true);
            input.committed?.();
        } finally { nativeStorySaving = false; release(); }
    });
}

async function* localNativePluginBuckets(id: string) {
    const visited = new WeakSet<object>();
    function* add(scope: 'route' | 'reply', bucket?: PluginBucket) {
        if (!bucket || visited.has(bucket)) return;
        visited.add(bucket); yield { scope, bucket };
    }
    function* scan(messages: ChatMessageNode[], route?: PluginBuckets) {
        yield* add('route', route?.[id]);
        for (const node of messages) {
            for (const buckets of Object.values(node.nativePluginOpeningRoutes ?? {})) yield* add('route', buckets[id]);
            for (const buckets of Object.values(node.nativePluginReplies ?? {})) yield* add('reply', buckets[id]);
            for (const states of [node.branchStates, node.branchBases]) for (const checkpoint of Object.values(states ?? {})) {
                yield* add('route', checkpoint.continuation.nativePluginRoute?.[id]);
            }
        }
    }
    const workspace = workspaceStore.getState();
    yield* scan(workspace.messages, workspace.nativePluginRoute);
    for (const summary of await listChatArchives()) {
        if (summary.id === workspace.activeChatId) continue;
        const chat = await loadChatArchive(summary.id);
        if (chat) yield* scan(chat.messages, chat.continuation?.nativePluginRoute);
    }
}

registerSnapshotSource('workspace_assets', () => {
    const s = workspaceStore.getState();
    return { characters: s.characters, lorebooks: s.lorebooks, presets: s.presets };
});
registerSnapshotSource('workspace_snapshot', () => {
    const s = workspaceStore.getState();
    return {
        snapshotVersion: 2,
        branchEpoch: s.branchEpoch,
        nativeStoryPending: s.isGenerating || s.helperGenerationCount > 0 || s.mvuExtraAnalysisActive,
        nativeStoryReply: s.nativeStoryReply,
        chatMetadata: s.chatMetadata,
        nativePluginRoute: s.nativePluginRoute,
        branchExtensionKeys: s.branchExtensionKeys,
        deletedMessageIds: s.deletedMessageIds,
        storyWorldbooks: s.storyWorldbooks ?? null,
        storyCharacterBinding: s.storyCharacterBinding ?? null,
        storyCharacter: s.storyCharacter ?? null,
        storyPersona: s.storyPersona ?? null,
        streamDisplayModes: s.streamDisplayModes,
        userName: s.userName,
        personas: s.personas,
        activePersonaId: s.activePersonaId,
        activeCharacterId: s.activeCharacterId,
        activeLorebookIds: s.activeLorebookIds,
        characterWorldbookBindings: s.characterWorldbookBindings,
        chatWorldbookBindings: s.chatWorldbookBindings,
        activePresetId: s.activePresetId,
        inUsePreset: s.inUsePreset,
        activeChatId: s.activeChatId,
        messages: s.messages,
        activeLeafId: s.activeLeafId,
        timedStates: s.timedStates,
        templateInjections: s.templateInjections,
        templateActivations: s.templateActivations,
    };
});
export async function persistWorkspaceNow(): Promise<void> { await persistRegisteredSnapshots(); }
export async function saveSettingsEdits(values: Record<string, unknown>, streamModes: Record<string, StreamDisplayMode>, extensions: Record<string, boolean>): Promise<void> {
    await enqueuePersistentOperation(async () => {
        await waitForReplicaCommit();
        const oldSettings = schemaRegistryStore.getState(), oldWorkspace = workspaceStore.getState(), oldVariables = scopedVariableStore.getState();
        await persistStateTransaction(() => batchReactiveUpdates(() => {
            setSchemaValues(values, false);
            workspaceStore.setState(draft => {
                Object.assign(draft.streamDisplayModes, streamModes);
                if (!draft.activePresetId) return;
                const preset = draft.inUsePreset ?? structuredClone(getActivePreset());
                const mapping = { context_max_tokens: 'maxContextTokens', max_tokens: 'maxResponseTokens', temperature: 'temperature',
                    top_p: 'topP', top_k: 'topK', min_p: 'minP', frequency_penalty: 'frequencyPenalty', presence_penalty: 'presencePenalty' } as const;
                for (const [key, field] of Object.entries(mapping)) if (`sampler.${key}` in values) {
                    preset[field] = Number(schemaRegistryStore.getState().values[`sampler.${key}`]);
                }
                draft.inUsePreset = preset;
            });
            if (Object.keys(extensions).length) scopedVariableStore.setState(draft => {
                const settings = (draft.extension.tipsy_extensions ?? {}) as { disabled?: string[] };
                const disabled = new Set(settings.disabled ?? []);
                for (const [id, enabled] of Object.entries(extensions)) { if (enabled) disabled.delete(id); else disabled.add(id); }
                draft.extension.tipsy_extensions = { ...settings, disabled: [...disabled] };
            });
        }), () => batchReactiveUpdates(() => {
            schemaRegistryStore.setState(oldSettings); workspaceStore.setState(oldWorkspace); scopedVariableStore.setState(oldVariables);
        }));
        try { globalThis.localStorage?.setItem('tt:modern:schema_values', JSON.stringify(schemaRegistryStore.getState().values)); } catch { /* Platform snapshots are authoritative. */ }
        streamProjectors.clear(); schedulePreview();
    });
}
registerAssetVariableAccess({
    read: (scope, id) => {
        const state = workspaceStore.getState();
        const extensions = scope === 'character' ? (state.activeCharacterId === id ? getActiveCharacter(state) : state.characters.find(card => card.id === id))?.extensions
            : (id === state.activePresetId ? getActivePreset(state) : state.presets.find(preset => preset.id === id))?.rawData?.extensions as Record<string, any> | undefined;
        return ((extensions?.tavern_helper ?? extensions?.TavernHelper) as any)?.variables;
    },
    write: (scope, id, value) => {
        const current = scope === 'preset' ? getActivePreset() : undefined;
        workspaceStore.setState(draft => {
            if (scope === 'character') {
                if (id === draft.activeCharacterId) draft.storyCharacter ??= structuredClone(getActiveCharacter());
                const card = draft.storyCharacter?.id === id ? draft.storyCharacter : draft.characters.find(item => item.id === id); if (!card) throw new Error('角色变量目标不存在');
                card.extensions = { ...card.extensions, tavern_helper: { ...(card.extensions?.tavern_helper ?? card.extensions?.TavernHelper ?? {}) as object, variables: value } };
            } else {
                if (id === draft.activePresetId && !draft.inUsePreset) draft.inUsePreset = structuredClone(current!);
                const preset = id === draft.activePresetId ? draft.inUsePreset : draft.presets.find(item => item.id === id);
                if (!preset) throw new Error('预设变量目标不存在');
                const extensions = preset.rawData?.extensions as any ?? {};
                preset.rawData = { ...preset.rawData, extensions: { ...extensions, tavern_helper: { ...extensions.tavern_helper, variables: value } } };
            }
        });
    },
});
function persistWorkspace(): void { void persistWorkspaceNow().catch(error => setStatusBanner(`保存失败：${error instanceof Error ? error.message : String(error)}`)); }
export function worldbooksChanged(): void { schedulePreview(); }

function normalizeMessageVariableSnapshots(messages: ChatMessageNode[]): ChatMessageNode[] {
    let changed = false;
    const next = messages.map(node => {
        if (!node.extra) return node;
        const chat = normalizeMvuVariables(node.extra.chatVariables as Record<string, unknown>);
        const swipes = normalizeMvuVariableMap(node.extra.swipeVariables as Record<string, Record<string, unknown>>);
        const swipeChats = normalizeMvuVariableMap(node.extra.swipeChatVariables as Record<string, Record<string, unknown>>);
        if (!chat.changed && !swipes.changed && !swipeChats.changed) return node;
        changed = true;
        return { ...node, extra: { ...node.extra,
            ...(chat.changed ? { chatVariables: chat.variables } : {}),
            ...(swipes.changed ? { swipeVariables: swipes.variables } : {}),
            ...(swipeChats.changed ? { swipeChatVariables: swipeChats.variables } : {}),
        } };
    });
    return changed ? next : messages;
}

export async function hydrateWorkspaceFromPlatform(preview = true): Promise<void> {
    const [chat, assets] = await Promise.all([
        platformStorage.loadSnapshot<(Partial<WorkspaceState> & { snapshotVersion?: number }) | null>('workspace_snapshot', null),
        platformStorage.loadSnapshot<Pick<WorkspaceState, 'characters' | 'lorebooks' | 'presets'> | null>('workspace_assets', null),
    ]);
    const loaded = chat || assets ? { ...chat, ...assets } : null;
    const saved = loaded ? removeRetiredBuiltinWorldbooks(loaded) : null;
    const retiredGuides = (saved?.characters ?? []).filter(isRetiredGuide);
    // Preserve actual conversations with the old guide as recoverable archives.
    if (saved?.messages?.length && retiredGuides.some(card => card.id === saved.activeCharacterId)
        && (saved.messages.length > 1 || saved.messages[0].role !== 'assistant' || saved.messages[0].content !== retiredGuides.find(card => card.id === saved.activeCharacterId)?.firstMessage)) {
        await saveChatArchive({ id: saved.activeChatId!, characterId: saved.activeCharacterId!, messages: saved.messages,
            activeLeafId: saved.activeLeafId ?? null, timedStates: saved.timedStates ?? {},
            templateInjections: saved.templateInjections, templateActivations: saved.templateActivations, syncLabel: '原向导会话',
            continuation: captureChatContinuation({ ...workspaceStore.getState(), ...saved } as WorkspaceState) });
    }
    const messages = Array.isArray(saved?.messages) ? normalizeMessageVariableSnapshots(saved.messages) : undefined;
    if (saved && typeof saved === 'object') {
        workspaceStore.setState((draft) => {
            draft.branchEpoch = saved.branchEpoch ?? 0;
            draft.chatMetadata = saved.chatMetadata;
            draft.nativePluginRoute = saved.nativePluginRoute;
            draft.branchExtensionKeys = saved.branchExtensionKeys ?? [];
            draft.deletedMessageIds = saved.deletedMessageIds ?? [];
            draft.storyWorldbooks = saved.storyWorldbooks ?? undefined;
            draft.storyCharacterBinding = saved.storyCharacterBinding ?? undefined;
            draft.storyCharacter = saved.storyCharacter ?? undefined;
            draft.storyPersona = saved.storyPersona ?? undefined;
            if (saved.userName) draft.userName = !saved.activePersonaId && saved.userName === '玩家' ? '用户' : saved.userName;
            draft.streamDisplayModes = saved.streamDisplayModes ?? {};
            if (saved.personas) draft.personas = saved.personas;
            draft.activePersonaId = saved.activePersonaId ?? null;
            if (Array.isArray(saved.characters)) draft.characters = saved.characters;
            if (saved.activeCharacterId) draft.activeCharacterId = saved.activeCharacterId;
            if (Array.isArray(saved.lorebooks)) draft.lorebooks = saved.lorebooks;
            if (Array.isArray(saved.activeLorebookIds)) draft.activeLorebookIds = saved.activeLorebookIds;
            if (saved.characterWorldbookBindings) draft.characterWorldbookBindings = saved.characterWorldbookBindings;
            if (saved.chatWorldbookBindings) draft.chatWorldbookBindings = saved.chatWorldbookBindings;
            if (Array.isArray(saved.presets)) draft.presets = saved.presets;
            if (saved.activePresetId) draft.activePresetId = saved.activePresetId;
            draft.inUsePreset = saved.inUsePreset ?? draft.presets.find(item => item.id === draft.activePresetId);
            if (saved.activeChatId) draft.activeChatId = saved.activeChatId;
            if (messages) draft.messages = messages;
            draft.activeLeafId = saved.activeLeafId === null && (saved.snapshotVersion ?? 1) >= 2 ? null : saved.activeLeafId ?? draft.messages.at(-1)?.id ?? null;
            if (saved.timedStates) draft.timedStates = saved.timedStates;
            if (Array.isArray(saved.templateInjections)) draft.templateInjections = saved.templateInjections;
            if (Array.isArray(saved.templateActivations)) draft.templateActivations = saved.templateActivations;
        });
    }
    let retired = false;
    workspaceStore.setState(draft => {
        const guides = draft.characters.filter(isRetiredGuide), presets = draft.presets.filter(isRetiredPreset);
        retired = !!guides.length || !!presets.length || !!draft.inUsePreset && isRetiredPreset(draft.inUsePreset);
        draft.characters = draft.characters.filter(card => !isRetiredGuide(card));
        draft.presets = draft.presets.filter(preset => !isRetiredPreset(preset));
        if (draft.inUsePreset && isRetiredPreset(draft.inUsePreset)) { draft.activePresetId = ''; draft.inUsePreset = undefined; }
        else if (!draft.inUsePreset && presets.some(preset => preset.id === draft.activePresetId)) draft.activePresetId = '';
        for (const guide of guides) { delete draft.characterWorldbookBindings[guide.id]; delete draft.streamDisplayModes[guide.id]; }
        if (guides.some(card => card.id === draft.activeCharacterId) || !draft.activeCharacterId) Object.assign(draft, emptyStory());
    });
    if (!saved?.storyWorldbooks) ensureInitialVariables();
    const leaf = workspaceStore.getState().activeLeafId;
    if (!saved?.storyWorldbooks && leaf && workspaceStore.getState().messages.find(message => message.id === leaf)?.extra?.swipeVariables) {
        const node = workspaceStore.getState().messages.find(message => message.id === leaf)!;
        const legacyTemplateState = !node.extra?.swipeTemplateStates && saved
            ? { templateInjections: saved.templateInjections ?? [], templateActivations: saved.templateActivations ?? [] } : undefined;
        restoreMessageSnapshot(leaf);
        if (legacyTemplateState) workspaceStore.setState(legacyTemplateState);
    }
    if (!Object.hasOwn(scopedVariableStore.getState().extension, 'EjsTemplate')) {
        replaceExtensionVariables('EjsTemplate', saved ? { ...legacyTemplateFeatures, tipsy_migrated_legacy_features: true } : { ...normalizeTemplateFeatures() });
    }
    if (retired || saved !== loaded || messages && messages !== saved?.messages) persistWorkspace();
    if (preview) await refreshPromptInspectorPreview();
}

function ensureInitialVariables(): void {
    const state = workspaceStore.getState();
    if (!state.activeCharacterId) return;
    const existing = getScopedVariables('chat', { chatId: state.activeChatId });
    const defaults = readWorkspaceInitialVariables(state);
    const next = { ...initialChatVariables(state, defaults), ...existing };
    if (existing.stat_data && !existing.initialized_lorebooks) delete next.initialized_lorebooks;
    if (getEffectiveMvuSettings(state).settings['mvu.update_chat'] === true) loadMvuInitialVariables(next, initialWorldbooks(state), text => initialMacros(text, state));
    if (JSON.stringify(next) !== JSON.stringify(existing)) replaceScopedVariables(next, 'chat', { chatId: state.activeChatId });
    const first = getActiveChatMessages(state)[0];
    if (first && !Object.keys(getScopedVariables('message', { messageId: first.id })).length) {
        replaceScopedVariables(structuredClone({ ...defaults, ...next }), 'message', { messageId: first.id });
    }
}

function initialWorldbooks(state: WorkspaceState): NormalizedLorebook[] {
    const catalog = getAvailableWorldbooks(state);
    const binding = getCharacterWorldbooks(getActiveCharacter(state), state);
    const names = [...state.activeLorebookIds.flatMap(id => catalog.find(book => book.id === id)?.name ?? []), binding.primary, ...binding.additional];
    return [...new Set(names)].flatMap(name => catalog.find(book => book.name === name) ?? []);
}
function initialMacros(text: string, state: WorkspaceState): string {
    return evaluateMacros(text, { userName: state.userName, charName: getActiveCharacter(state).name,
        variables: getScopedVariables('chat', { chatId: state.activeChatId }), globalVariables: getScopedVariables('global') });
}
function readWorkspaceInitialVariables(state = workspaceStore.getState()): Record<string, any> {
    return readInitialVariables(getActiveCharacter(state), initialWorldbooks(state), text => initialMacros(text, state));
}
function mvuChatProjection(variables: Record<string, any>): Record<string, any> {
    if (getEffectiveMvuSettings().settings['mvu.update_chat'] !== true) return {};
    return Object.fromEntries(mvuProjectionKeys
        .filter(key => key in variables).map(key => [key, structuredClone(variables[key])]));
}
function initialChatVariables(state = workspaceStore.getState(), initial = readWorkspaceInitialVariables(state)): Record<string, any> {
    if (getEffectiveMvuSettings(state).settings['mvu.update_chat'] === true) return initial;
    return Object.fromEntries(Object.entries(initial).filter(([key]) => !mvuProjectionKeys.some(field => field === key)));
}

export function setStatusBanner(text: string | null, options: NotificationOptions = {}): void {
    if (text === null) dismissNotification('workspace');
    else showNotification(text, { id: 'workspace', kind: /失败|错误|异常/.test(text) ? 'error' : 'info', ...options });
}

let mvuSettingsSources: unknown[] = [];
let cachedMvuSettings: ReturnType<typeof resolveMvuSettings>;
export function getEffectiveMvuSettings(state = workspaceStore.getState()) {
    const primary = getCharacterWorldbooks(getActiveCharacter(state), state).primary;
    const book = getAvailableWorldbooks(state).find(book => book.name === primary);
    const settings = schemaRegistryStore.getState().values;
    if (cachedMvuSettings && mvuSettingsSources[0] === settings && mvuSettingsSources[1] === book) return cachedMvuSettings;
    mvuSettingsSources = [settings, book];
    return cachedMvuSettings = resolveMvuSettings(settings, book);
}

export function getActiveCharacter(state: WorkspaceState = workspaceStore.getState()): NormalizedCharacterCard {
    if (state.storyCharacter?.id === state.activeCharacterId) return state.storyCharacter;
    return state.characters.find((c) => c.id === state.activeCharacterId) || EMPTY_CHARACTER;
}

export function getActivePreset(state: WorkspaceState = workspaceStore.getState()): NormalizedPreset {
    return state.inUsePreset ?? state.presets.find((p) => p.id === state.activePresetId) ?? NO_PRESET;
}

const emptyScriptTrees: any[] = [];
let cachedScriptTrees: ScriptTrees | undefined;
let cachedScripts: ReturnType<typeof scriptsFromTrees> = [];
export function getWorkspaceScriptTrees(state: WorkspaceState = workspaceStore.getState()): ScriptTrees {
    const card = getActiveCharacter(state); const preset = getActivePreset(state);
    const extension = (card.extensions?.tavern_helper ?? card.extensions?.TavernHelper) as any;
    const trees = { global: (scopedVariableStore.getState().extension.tavern_helper?.scripts as any[]) ?? emptyScriptTrees,
        preset: (preset.rawData?.extensions as any)?.tavern_helper?.scripts ?? emptyScriptTrees, character: extension?.scripts ?? emptyScriptTrees };
    if (cachedScriptTrees && (Object.keys(trees) as ScriptScope[]).every(type => trees[type] === cachedScriptTrees![type])) return cachedScriptTrees;
    cachedScriptTrees = trees;
    cachedScripts = [...new Map([...scriptsFromTrees(trees.global), ...scriptsFromTrees(trees.preset), ...scriptsFromTrees(trees.character)].map(script => [script.id, script])).values()];
    return trees;
}
export function getWorkspaceScripts(state: WorkspaceState = workspaceStore.getState()) { getWorkspaceScriptTrees(state); return cachedScripts; }

export function replaceWorkspaceScriptTrees(values: any[], type: ScriptScope, normalize = true): void {
    const trees = normalize ? normalizeScriptTrees(values) : values;
    if (type === 'global') replaceExtensionVariables('tavern_helper', { ...scopedVariableStore.getState().extension.tavern_helper, scripts: trees });
    else if (type === 'character') workspaceStore.setState(draft => {
        draft.storyCharacter ??= structuredClone(getActiveCharacter());
        const card = draft.storyCharacter;
        const helper = (card.extensions?.tavern_helper ?? card.extensions?.TavernHelper ?? {}) as object;
        card.extensions = { ...card.extensions, tavern_helper: { ...helper, scripts: trees } };
    });
    else if (type === 'preset') {
        const current = getActivePreset();
        workspaceStore.setState(draft => {
            if (!draft.inUsePreset) draft.inUsePreset = structuredClone(current);
            const preset = draft.inUsePreset;
            const extensions = preset.rawData?.extensions as any ?? {};
            preset.rawData = { ...preset.rawData, extensions: { ...extensions, tavern_helper: { ...extensions.tavern_helper, scripts: trees } } };
        });
    } else throw new Error(`未知脚本作用域：${type}`);
}
let availableBookSources: unknown[] = [];
let availableBooks: NormalizedLorebook[] = [];
export function getAvailableWorldbooks(state: WorkspaceState = workspaceStore.getState()): NormalizedLorebook[] {
    if (availableBookSources[0] === state.characters && availableBookSources[1] === state.lorebooks && availableBookSources[2] === state.storyWorldbooks) return availableBooks;
    availableBookSources = [state.characters, state.lorebooks, state.storyWorldbooks];
    return availableBooks = [...new Map([...state.characters.flatMap(card => [card.characterBook, card.embeddedLorebook].filter((book): book is NormalizedLorebook => !!book)), ...state.lorebooks, ...(state.storyWorldbooks ?? [])].map(book => [book.id, book])).values()];
}
export function getActivePersona(state: WorkspaceState = workspaceStore.getState()) {
    if (state.storyPersona?.avatar_id === state.activePersonaId) return state.storyPersona;
    const selected = state.personas.find(persona => persona.avatar_id === state.activePersonaId);
    if (selected || state.activePersonaId) return selected;
    return state.personas.find(persona => persona.connections.some(link => link.type === 'character'
        && [state.activeCharacterId, `${state.activeCharacterId}.png`].includes(link.id)))
        ?? state.personas.find(persona => persona.is_default);
}
export function selectPersona(id: string): boolean {
    const persona = workspaceStore.getState().personas.find(item => item.avatar_id === id);
    if (!persona) return false;
    workspaceStore.setState(draft => { draft.activePersonaId = id; draft.userName = persona.name; draft.storyPersona = structuredClone(persona); });
    persistWorkspace(); schedulePreview(); return true;
}
export function savePlayerPersona(value: { name: string; image: string; description: string }, characterId?: string): void {
    const name = value.name.trim();
    if (!name) throw new Error('请填写称呼');
    workspaceStore.setState(draft => {
        const linked = (item: import('../types').UserPersona) => characterId
            ? item.connections.some(link => link.type === 'character' && [characterId, `${characterId}.png`].includes(link.id)) : item.is_default;
        const previous = draft.personas.find(linked);
        if (characterId && !draft.personas.some(item => item.is_default)) {
            const id = `persona_${crypto.randomUUID()}.png`;
            draft.personas.push({ avatar_id: id, avatar: id, image: '', name: draft.userName || '用户', title: '', description: '',
                position: 0, depth: 2, role: 0, lorebook: '', connections: [], is_default: true });
        }
        // A default profile stays separate when a card receives its own identity.
        const reuse = previous && !(characterId && previous.is_default);
        const id = reuse ? previous.avatar_id : `persona_${crypto.randomUUID()}.png`;
        const persona: import('../types').UserPersona = { avatar_id: id, avatar: id, title: '',
            position: 0, depth: 2, role: 0, lorebook: '', connections: [], is_default: !characterId,
            ...(reuse ? previous : {}), ...value, name, description_mode: 'supplement' };
        if (characterId) {
            for (const item of draft.personas) item.connections = item.connections.filter(link => !(link.type === 'character' && [characterId, `${characterId}.png`].includes(link.id)));
            persona.connections = [...persona.connections.filter(link => !(link.type === 'character' && [characterId, `${characterId}.png`].includes(link.id))), { type: 'character', id: characterId }];
        } else for (const item of draft.personas) item.is_default = item.avatar_id === persona.avatar_id;
        const index = draft.personas.findIndex(item => item.avatar_id === id);
        if (index < 0) draft.personas.push(persona); else draft.personas[index] = persona;
        applyCharacterPersona(draft, draft.activeCharacterId);
        draft.storyPersona = cloneStateValue(draft.personas.find(item => item.avatar_id === draft.activePersonaId));
    });
    persistWorkspace(); schedulePreview();
}
export function clearCharacterPersona(characterId: string): void {
    workspaceStore.setState(draft => {
        for (const persona of draft.personas) persona.connections = persona.connections.filter(link => !(link.type === 'character' && [characterId, `${characterId}.png`].includes(link.id)));
        applyCharacterPersona(draft, draft.activeCharacterId);
        draft.storyPersona = cloneStateValue(draft.personas.find(item => item.avatar_id === draft.activePersonaId));
    });
    persistWorkspace(); schedulePreview();
}
export function getCharacterWorldbooks(card: NormalizedCharacterCard, state: WorkspaceState = workspaceStore.getState()) {
    if (card.id === state.activeCharacterId && state.storyCharacterBinding) return structuredClone(state.storyCharacterBinding);
    const explicit = state.characterWorldbookBindings[card.id];
    if (explicit) return structuredClone(explicit);
    const declared = typeof card.primaryWorldbook === 'string' ? card.primaryWorldbook : card.primaryWorldbook?.name;
    const embedded = card.characterBook ?? card.embeddedLorebook;
    return { primary: declared && getAvailableWorldbooks(state).some(book => book.name === declared) ? declared : embedded?.name ?? declared ?? null, additional: [...(card.additionalWorldbooks ?? [])] };
}
function getWorldbookGroups(state: WorkspaceState) {
    const card = getActiveCharacter(state);
    const catalog = getAvailableWorldbooks(state);
    const binding = getCharacterWorldbooks(card, state);
    const embeddedName = (card.characterBook ?? card.embeddedLorebook)?.name;
    return {
        character: [...new Set([...(state.characterWorldbookBindings[card.id] ? [] : [embeddedName]), binding.primary].filter((name): name is string => !!name))],
        additional: binding.additional,
        global: state.activeLorebookIds.flatMap(id => catalog.find(book => book.id === id)?.name ?? []),
        persona: getActivePersona(state)?.lorebook ? [getActivePersona(state)!.lorebook] : [], chat: state.chatWorldbookBindings[state.activeChatId] ? [state.chatWorldbookBindings[state.activeChatId]!] : [],
    };
}

let activeBookSources: unknown[] = [];
let activeBooks: NormalizedLorebook[] = [];
export function getActiveLorebooks(state: WorkspaceState = workspaceStore.getState()): NormalizedLorebook[] {
    const sources = [state.storyCharacter, state.storyPersona, state.storyWorldbooks, state.storyCharacterBinding, state.characters, state.activeCharacterId, state.lorebooks, state.activeLorebookIds,
        state.characterWorldbookBindings, state.chatWorldbookBindings, state.activeChatId, state.personas, state.activePersonaId];
    if (sources.every((value, index) => value === activeBookSources[index])) return activeBooks;
    activeBookSources = sources;
    const activeSet = new Set(state.activeLorebookIds);
    const all = getAvailableWorldbooks(state);
    const list = all.filter((wb) => wb.id && activeSet.has(wb.id));
    const card = getActiveCharacter(state);
    const embedded = card.characterBook || card.embeddedLorebook;
    const charBook = embedded ? all.find(book => book.id === embedded.id) ?? embedded : undefined;
    const binding = state.storyCharacterBinding ?? state.characterWorldbookBindings[card.id];
    const resolved = getCharacterWorldbooks(card, state);
    const names = [resolved.primary, ...resolved.additional, getActivePersona(state)?.lorebook];
    const bound = names.flatMap(name => name ? (charBook?.name === name ? charBook : all.find(book => book.name === name)) ?? [] : []);
    const chatName = state.chatWorldbookBindings[state.activeChatId];
    const chatBook = chatName ? all.find(book => book.name === chatName) : undefined;
    const next = [...new Map([...(charBook && !binding ? [charBook] : []), ...bound, ...list, ...(chatBook ? [chatBook] : [])].map(book => [book.id, book])).values()];
    if (next.length !== activeBooks.length || next.some((book, index) => book !== activeBooks[index])) activeBooks = next;
    return activeBooks;
}
function routeWorldbooks(books: NormalizedLorebook[] | undefined, state: WorkspaceState) {
    const global = new Set(state.activeLorebookIds);
    const library = new Map([...state.characters.flatMap(card => [card.characterBook, card.embeddedLorebook].flatMap(book => book ?? [])),
        ...state.lorebooks].filter(book => global.has(book.id)).map(book => [book.id, book]));
    // Keep the branch's own resources but let today's global books come from the library.
    return books?.filter(book => !library.has(book.id));
}
export function setGlobalWorldbookEnabled(id: string, enabled: boolean): void {
    if (!getAvailableWorldbooks().some(book => book.id === id)) throw new Error('找不到世界书');
    workspaceStore.setState(draft => { draft.activeLorebookIds = [...new Set([...draft.activeLorebookIds.filter(item => item !== id), ...(enabled ? [id] : [])])]; });
    persistWorkspace(); schedulePreview();
}

export function updateLorebookEntry(bookId: string, uid: string | number, patch: Partial<NormalizedLorebook['entries'][number]>): void {
    if (workspaceStore.getState().isGenerating) throw new Error('请等待生成结束后修改世界书');
    workspaceStore.setState(draft => {
        const source = draft.storyWorldbooks?.find(b => b.id === bookId) ?? draft.characters.flatMap(c => [c.characterBook, c.embeddedLorebook]).find(b => b?.id === bookId)
            ?? draft.lorebooks.find(b => b.id === bookId);
        if (!source) throw new Error('找不到世界书');
        const book = cloneStateValue(source);
        const entry = book.entries.find(e => e.uid === uid);
        if (!entry) throw new Error('找不到世界书词条');
        Object.assign(entry, patch, { uid, rawData: entry.rawData });
        if (draft.storyWorldbooks?.some(item => item.id === bookId)) { draft.storyWorldbooks = draft.storyWorldbooks.map(item => item.id === bookId ? book : item); return; }
        draft.lorebooks = draft.lorebooks.map(b => b.id === bookId ? book : b);
        draft.characters = draft.characters.map(c => ({ ...c,
            ...(c.characterBook?.id === bookId ? { characterBook: book } : {}),
            ...(c.embeddedLorebook?.id === bookId ? { embeddedLorebook: book } : {}),
        }));
    });
    persistWorkspace();
    schedulePreview();
}

export function updateCharacterDocument(characterId: string, document: Record<string, unknown>): void {
    const state = workspaceStore.getState();
    if (state.isGenerating) throw new Error('请等待生成结束后修改角色卡');
    const previous = state.characters.find(c => c.id === characterId);
    if (!previous) throw new Error('找不到角色卡');
    const next = normalizeCharacterCard(document);
    next.id = previous.id;
    next.avatar = previous.avatar;
    const oldBook = previous.characterBook ?? previous.embeddedLorebook;
    if (next.embeddedLorebook && oldBook) next.embeddedLorebook.id = oldBook.id;
    workspaceStore.setState(draft => {
        draft.characters = draft.characters.map(c => c.id === characterId ? next : c);
        if (draft.storyCharacter?.id === characterId) { draft.storyCharacter = next; draft.storyCharacterBinding = undefined; }
        if (Object.hasOwn(draft.characterWorldbookBindings, characterId)) draft.characterWorldbookBindings[characterId] = {
            primary: typeof next.primaryWorldbook === 'string' ? next.primaryWorldbook : next.primaryWorldbook?.name ?? null, additional: next.additionalWorldbooks ?? [],
        };
        draft.lorebooks = draft.lorebooks.filter(b => b.id !== oldBook?.id);
        if (next.embeddedLorebook) draft.lorebooks.push(next.embeddedLorebook);
        if (!next.embeddedLorebook) draft.activeLorebookIds = draft.activeLorebookIds.filter(id => id !== oldBook?.id);
    });
    persistWorkspace();
    schedulePreview();
}

export function replaceActiveWorldbookEntries(entries: unknown[]): boolean {
    const card = getActiveCharacter();
    const book = card.characterBook ?? card.embeddedLorebook;
    if (!book) throw new Error('当前角色没有内嵌世界书，请指定需要修改的世界书');
    const document = serializeCharacterCard(card);
    const data = document.data && typeof document.data === 'object' ? document.data as Record<string, unknown> : document;
    const rawBook = data.character_book as Record<string, unknown>;
    // Accept external raw entries or the normalized objects returned by the legacy bridge.
    const normalized = normalizeLorebook({ name: book.name, entries });
    for (let i = 0; i < normalized.entries.length; i++) {
        const value = entries[i] as Record<string, unknown>;
        if (value?.rawData && typeof value.rawData === 'object') normalized.entries[i] = structuredClone(value) as unknown as NormalizedLorebook['entries'][number];
    }
    data.character_book = { ...rawBook, entries: serializeLorebook(normalized).entries };
    updateCharacterDocument(card.id, document);
    return true;
}

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
        messages: getActiveChatMessages(state).map(({ branchBases, branchStates, nativePluginOpeningRoutes, nativePluginReplies, ...node }) => node),
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
        ...(mvu.settings['mvu.mode'] === '额外模型解析' ? { mvuWorldbookFilter: { primary: binding.primary,
            character: [binding.primary, ...binding.additional].filter((name): name is string => !!name),
            whitelist: String(mvu.settings['mvu.whitelist'] ?? ''), blacklist: String(mvu.settings['mvu.blacklist'] ?? ''),
            characterWhitelist: String(mvu.settings['mvu.character_whitelist'] ?? ''), characterBlacklist: String(mvu.settings['mvu.character_blacklist'] ?? '') } } : {}),
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
let preloadSignature = '';
let preloadJob: { signature: string; promise: Promise<void> } | undefined;
let renderingJob: Promise<void> | undefined;
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
        await commitPromptTask(result, input);
        preloadSignature = signature;
        if (result.compatibilityWarnings?.length) setStatusBanner(result.compatibilityWarnings[0]);
    })();
    preloadJob = { signature, promise };
    try { await promise; } finally { if (preloadJob?.promise === promise) preloadJob = undefined; }
}
/** Render output is transient; only first-render writes (or explicit dryRun overrides) are committed. */
export async function refreshMessageTemplates(allowGenerating = false): Promise<void> {
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
            await commitPromptTask(result, taskInput);
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
function schedulePreview(): void {
    if (!previewConsumers || previewScheduled) return;
    previewScheduled = true;
    setTimeout(() => {
        previewScheduled = false;
        if (!previewConsumers) return;
        void refreshPromptInspectorPreview()
            .catch(error => setStatusBanner(error instanceof Error ? error.message : String(error)));
    }, 100);
}

let activeMessageSources: unknown[] = [];
let activeMessagesCache: ChatMessageNode[] = [];
export function getActiveChatMessages(state: WorkspaceState = workspaceStore.getState()): ChatMessageNode[] {
    if (activeMessageSources[0] !== state.messages || activeMessageSources[1] !== state.activeLeafId) {
        activeMessageSources = [state.messages, state.activeLeafId];
        activeMessagesCache = activePath(state.messages, state.activeLeafId);
    }
    return activeMessagesCache;
}

export function getChatBranchOptions(state: WorkspaceState = workspaceStore.getState()) {
    return branchOptions(state.messages);
}

export function selectChatBranch(id: string, internal = false): void {
    const state = workspaceStore.getState();
    const route = storyRoutes(state.messages).find(item => item.key === id);
    const target = state.messages.find(node => node.id === (route?.nodeId ?? id));
    if (!target) return;
    if (target.floor === 0) throw new Error('开场不参与剧情分支，请新建会话更换开局');
    if (branchBusy(internal)) throw new Error('请等待本轮生成和变量结算结束后切换路线');
    rememberBranch();
    invalidateTemplateEnvironment();
    batchReactiveUpdates(() => activateBranch(target.id, route?.swipe ?? target.activeSwipeIndex));
    publishBranchChange(!internal);
}

export function selectPreset(presetId: string): void {
    if (workspaceStore.getState().activePresetId === presetId) return;
    if (!presetId) { workspaceStore.setState({ activePresetId: '', inUsePreset: undefined }); persistWorkspace(); schedulePreview(); return; }
    const preset = workspaceStore.getState().presets.find(item => item.id === presetId);
    if (!preset) return;
    batchReactiveUpdates(() => {
        workspaceStore.setState(draft => { draft.activePresetId = presetId; draft.inUsePreset = structuredClone(preset); });
        applyPresetSettings(preset);
    });
    persistWorkspace();
    schedulePreview();
}

export function applyPresetSettings(preset: NormalizedPreset): void {
    const values: Record<string, unknown> = {
        temperature: preset.temperature, top_p: preset.topP, top_k: preset.topK,
        min_p: preset.minP, frequency_penalty: preset.frequencyPenalty,
        presence_penalty: preset.presencePenalty, max_tokens: preset.maxResponseTokens,
        context_max_tokens: preset.maxContextTokens,
    };
    const settings = Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined).map(([key, value]) => [`sampler.${key}`, value]));
    if (preset.rawData?.stream_openai !== undefined) settings['api.stream'] = preset.rawData.stream_openai;
    if (preset.rawData?.reasoning_effort !== undefined) settings['sampler.reasoning_effort'] = preset.rawData.reasoning_effort;
    setSchemaValues(settings);
}

export function updatePresetPrompt(presetId: string, identifier: string, patch: Partial<PresetPromptSlot>): void {
    workspaceStore.setState(draft => {
        const preset = presetId === draft.activePresetId && draft.inUsePreset ? draft.inUsePreset : draft.presets.find(item => item.id === presetId);
        if (!preset) return;
        const slots = preset.promptSlots ?? preset.prompts ?? [];
        const slot = slots.find(item => item.identifier === identifier);
        if (slot) Object.assign(slot, patch, { identifier });
        preset.promptSlots = slots;
        preset.prompts = slots;
    });
    persistWorkspace();
    schedulePreview();
}

async function archiveActiveChat(): Promise<void> {
    const state = workspaceStore.getState(), leaf = getActiveChatMessages(state).at(-1);
    if (leaf) batchReactiveUpdates(() => {
        captureMessageSnapshot(leaf.id);
        preserveAuthorMessageRevision(state.messages, workspaceStore.getState().messages);
    });
    const entry = readNativeChat(workspaceStore.getState().activeChatId);
    if (entry) await saveChatArchive(entry, true);
}

export function readNativeChat(id: string): ArchivedChat | null {
    const state = workspaceStore.getState();
    if (!id || id !== state.activeChatId || !state.messages.length) return null;
    return { id: state.activeChatId, characterId: state.activeCharacterId,
        messages: state.messages, deletedMessageIds: state.deletedMessageIds, activeLeafId: state.activeLeafId, timedStates: state.timedStates, worldbookName: state.chatWorldbookBindings[state.activeChatId] ?? null, templateInjections: state.templateInjections, templateActivations: state.templateActivations,
        continuation: captureChatContinuation() };
}

/** Called in the serialized storage lane; keep only the publication and its disk write exclusive. */
export async function commitNativeWorkspace(check: () => void, publish: () => void, extras: Record<string, unknown>, refresh = true) {
    await waitForReplicaCommit();
    if (isNativeStoryBusy()) throw new PluginApiError('STORY_BUSY', '请等待本轮剧情结算结束');
    const release = holdReplicaCommit();
    nativeStorySaving = true;
    try { await commitWorkspaceMutation(() => { check(); publish(); }, extras); }
    finally { nativeStorySaving = false; release(); }
    if (refresh) { invalidateTemplateEnvironment(); resetCompatibilityBranch(); schedulePreview(); }
}

export function applyNativeChatEdit(chat: ArchivedChat, activate: boolean, pluginOnly = false) {
    const state = workspaceStore.getState();
    if (state.activeChatId !== chat.id) throw new PluginApiError('STALE_ROUTE', '当前会话已切换');
    const continuation = chat.continuation;
    if (activate && continuation && !pluginOnly) scopedVariableStore.setState(draft => {
        draft.chat[chat.id] = continuation.variables.chat[chat.id] ?? {};
        Object.assign(draft.message, continuation.variables.message);
        for (const id of chat.deletedMessageIds ?? []) if (!chat.messages.some(node => node.id === id)) delete draft.message[id];
    });
    workspaceStore.setState({ messages: chat.messages, deletedMessageIds: chat.deletedMessageIds,
        ...(activate && pluginOnly ? { nativePluginRoute: continuation?.nativePluginRoute } : activate ? { activeLeafId: chat.activeLeafId, timedStates: chat.timedStates, templateInjections: chat.templateInjections ?? [],
            templateActivations: chat.templateActivations ?? [], chatMetadata: continuation?.chatMetadata, nativePluginRoute: continuation?.nativePluginRoute,
            branchEpoch: (state.branchEpoch ?? 0) + 1, lastAssembledPrompt: null } : {}) });
    if (pluginOnly) preserveAuthorMessageRevision(state.messages, chat.messages);
}

export async function openNativePluginRoute(address: RouteAddress, check: () => void) {
    await waitForReplicaCommit();
    const state = workspaceStore.getState();
    if (branchBusy()) throw new PluginApiError('STORY_BUSY', '请等待剧情结算完成后再切换路线');
    if (address.chatId !== state.activeChatId) {
        const chat = await loadChatArchive(address.chatId);
        check();
        if (!chat) throw new PluginApiError('NOT_FOUND', '会话已不存在');
        const tip = routeGraph(chat.messages).tips.get(address.routeId);
        if (!tip) throw new PluginApiError('NOT_FOUND', '路线已不存在');
        await runBranchOperation(() => openArchivedChat(chat.id, tip.key, true, check));
        resetCompatibilityBranch();
        return;
    }
    const tip = routeGraph(state.messages).tips.get(address.routeId);
    if (!tip) throw new PluginApiError('NOT_FOUND', '路线已不存在');
    if (state.activeLeafId === tip.node.id && state.messages.find(node => node.id === tip.node.id)?.activeSwipeIndex === tip.index) return;
    check();
    rememberBranch(); invalidateTemplateEnvironment();
    batchReactiveUpdates(() => activateBranch(tip.node.id, tip.index, true));
    publishBranchChange();
    await persistWorkspaceNow();
}

export async function listArchivedChats(): Promise<Array<{ id: string; characterId: string; label: string }>> {
    const archives = await listChatArchives();
    return archives.map(chat => ({ id: chat.id, characterId: chat.characterId,
        label: `${chat.syncLabel ? `${chat.syncLabel} · ` : ''}${workspaceStore.getState().characters.find(card => card.id === chat.characterId)?.name ?? '角色'} · ${chat.messageCount} 条 · ${chat.lastMessage.replace(/\s+/g, ' ').slice(0, 30)}`,
    }));
}

export async function readHelperChatArchives(characterId?: string, files?: string[]): Promise<any> {
    const state = workspaceStore.getState();
    const current: ArchivedChat = { id: state.activeChatId, characterId: state.activeCharacterId, messages: state.messages, deletedMessageIds: state.deletedMessageIds,
        activeLeafId: state.activeLeafId, timedStates: state.timedStates };
    const summaries = (await listChatArchives()).filter(chat => chat.id !== current.id);
    if (state.messages.length) summaries.push(summarizeChat(current));
    if (!files) return summaries.filter(chat => chat.characterId === characterId).map(chat => ({ file_name: `${chat.id}.jsonl`,
        chat_items: chat.activeCount, mes: chat.lastMessage, last_mes: chat.lastDate ?? '',
        ch_name: state.characters.find(card => card.id === chat.characterId)?.name ?? '' }));
    const selected = summaries.filter(chat => files.includes(`${chat.id}.jsonl`) || files.includes(chat.id));
    const archives = (await Promise.all(selected.map(chat => chat.id === current.id ? current : loadChatArchive(chat.id))))
        .filter((chat): chat is ArchivedChat => !!chat);
    if (files) return Object.fromEntries(archives.filter(chat => files.includes(`${chat.id}.jsonl`) || files.includes(chat.id)).map(chat => [files.find(file => file === chat.id || file === `${chat.id}.jsonl`)!,
        activePath(chat.messages, chat.activeLeafId).map(node => ({ name: node.speakerName, is_user: node.role === 'user', is_system: !!node.isHidden,
            mes: node.content, send_date: node.sendDate, swipe_id: node.activeSwipeIndex, swipes: node.swipes.map(swipe => typeof swipe === 'string' ? swipe : swipe.content),
            variables: node.swipes.map((_, index) => (node.extra?.swipeVariables as Record<string, unknown> | undefined)?.[index] ?? {}),
            variables_initialized: node.swipes.map((_, index) => !!(node.extra?.tipsy_template_variables_initialized as Record<string, boolean> | undefined)?.[index]),
            extra: node.extra }))]));

}

export async function importHelperChat(content: string): Promise<string> {
    const state = workspaceStore.getState();
    const lines = content.split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line));
    const messages = normalizeChatPayload(lines);
    const chatVariables = lines[0]?.chat_metadata?.variables;
    if (chatVariables && typeof chatVariables === 'object' && !Array.isArray(chatVariables)) {
        for (const node of messages) node.extra = { ...node.extra, chatVariables: structuredClone(chatVariables) };
    }
    const id = `chat_${state.activeCharacterId}_${crypto.randomUUID()}`;
    const quickReply = lines[0]?.chat_metadata?.quickReply;
    if (Array.isArray(quickReply?.setList)) {
        const settings = structuredClone(readExtensionVariables(scopedVariableStore.getState().extension, 'quickReplyV2'));
        (settings.chatConfigs ??= {})[id] = structuredClone(quickReply);
        replaceExtensionVariables('quickReplyV2', settings);
    }
    await saveChatArchive({ id, characterId: state.activeCharacterId, messages,
        activeLeafId: messages.at(-1)?.id ?? null, timedStates: {} });
    return id;
}

export async function restoreArchivedChat(id: string, selectedRoute?: string): Promise<void> {
    await waitForReplicaCommit();
    while (characterSwitchJob) await characterSwitchJob;
    const state = workspaceStore.getState();
    if (state.isGenerating || state.helperGenerationCount > 0 || id === state.activeChatId) return;
    await runBranchOperation(() => openArchivedChat(id, selectedRoute));
}

async function openArchivedChat(id: string, selectedRoute?: string, keepChoices = false, check?: () => void): Promise<void> {
    let chat = await loadChatArchive(id);
    if (!chat) throw new Error('找不到已保存的会话');
    if (selectedRoute) {
        const tip = keepChoices ? routeGraph(chat.messages).vertices.get(selectedRoute) : undefined;
        const route = tip ? { path: vertexPath(tip), nodeId: tip.node.id } : storyRoutes(chat.messages).find(item => item.key === selectedRoute);
        if (!route) throw new Error('这条路线已经发生变化，请重新打开路线列表');
        const savedLeaf = keepChoices && !!chat.continuation && chat.activeLeafId === route.nodeId
            && chat.messages.find(node => node.id === route.nodeId)?.activeSwipeIndex === route.path.at(-1)?.activeSwipeIndex;
        chat = structuredClone(chat);
        const selected = new Map(route.path.map(node => [node.id, node.activeSwipeIndex]));
        chat.messages = chat.messages.map(node => selected.has(node.id) ? withSwipe(node, selected.get(node.id)!) : node);
        chat.activeLeafId = route.nodeId;
        const leaf = chat.messages.find(node => node.id === route.nodeId)!;
        const point = leaf.branchStates?.[swipeId(leaf)];
        if (point && !savedLeaf) {
            const variables = Object.fromEntries(route.path.map(node => [node.id, (node.extra?.swipeVariables as Record<number, unknown>)?.[node.activeSwipeIndex] ?? {}]));
            chat.continuation = { ...point.continuation, variables: { ...point.continuation.variables,
                message: { ...variables, ...branchMessageVariables(point) } as Record<string, Record<string, unknown>> } };
            chat.timedStates = point.timedStates; chat.templateInjections = point.templateInjections; chat.templateActivations = point.templateActivations;
            if (!keepChoices) chat.worldbookName = point.worldbookName;
        } else if (!savedLeaf && chat.continuation) {
            chat.continuation = { ...chat.continuation, nativePluginRoute: routePluginBucketsAt(route.path) };
        }
    }
    await archiveActiveChat();
    check?.();
    await applyArchivedChat(chat, keepChoices, check);
}

export const SYNC_EXTENSIONS = ['tipsy_regex', 'tipsy_worldinfo', 'tavern_helper', 'EjsTemplate', 'quickReplyV2'];
const syncStorySetting = (key: string) => /^(sampler\.|lorebook\.)/.test(key)
    || ['mvu.mode', 'mvu.automatic', 'mvu.update_chat', 'mvu.sendas_assistant', 'mvu.preset', 'mvu.prompt_strategy', 'mvu.random_header', 'mvu.disable_thinking', 'mvu.pseudo_stream'].includes(key);
export function captureChatContinuation(state = workspaceStore.getState(), variables = scopedVariableStore.getState(), settings = getSchemaValues()): NonNullable<ArchivedChat['continuation']> {
    return { chatMetadata: state.chatMetadata, nativePluginRoute: state.nativePluginRoute, variables: { global: variables.global,
        character: { [state.activeCharacterId]: variables.character[state.activeCharacterId] ?? {} },
        preset: { [state.activePresetId]: variables.preset[state.activePresetId] ?? {} },
        chat: { [state.activeChatId]: variables.chat[state.activeChatId] ?? {} },
        message: Object.fromEntries(state.messages.map(message => [message.id, variables.message[message.id] ?? {}])) },
        extensions: Object.fromEntries([...new Set([...SYNC_EXTENSIONS, ...state.branchExtensionKeys ?? []])].filter(key => key in variables.extension).map(key => [key, variables.extension[key]])),
        extensionKeys: state.branchExtensionKeys,
        activePresetId: state.activePresetId, inUsePreset: getActivePreset(state), activeLorebookIds: state.activeLorebookIds,
        userName: state.userName, activePersonaId: state.activePersonaId,
        settings: Object.fromEntries(Object.entries(settings).filter(([key]) => syncStorySetting(key))),
        worldbooks: getActiveLorebooks(state), characterBinding: getCharacterWorldbooks(getActiveCharacter(state), state),
        character: getActiveCharacter(state), persona: getActivePersona(state) };
}
export async function applyArchivedChat(chat: ArchivedChat, keepChoices = false, check?: () => void): Promise<void> {
    await enqueuePersistentOperation(async () => {
        await persistWorkspaceNow();
        check?.();
        const release = holdReplicaCommit(), finish = suspendRegisteredPersistence();
        const oldWorkspace = workspaceStore.getState(), oldVariables = scopedVariableStore.getState(), oldSettings = schemaRegistryStore.getState();
        let candidate!: { workspace: WorkspaceState; variables: typeof oldVariables; settings: typeof oldSettings; snapshots: Record<string, unknown> };
        let replays: Array<() => number> = [];
        try {
            withoutStoreNotifications(() => {
                try {
                    applyArchivedChatState(chat, keepChoices);
                    candidate = { workspace: workspaceStore.getState(), variables: scopedVariableStore.getState(), settings: schemaRegistryStore.getState(), snapshots: registeredSnapshots() };
                } finally { workspaceStore.setState(oldWorkspace); scopedVariableStore.setState(oldVariables); schemaRegistryStore.setState(oldSettings); }
            });
            const unlock = [workspaceStore.holdWrites(), scopedVariableStore.holdWrites(), schemaRegistryStore.holdWrites()];
            try {
                await platformStorage.saveSnapshots(candidate.snapshots);
                acknowledgeSnapshots(candidate.snapshots);
                replays = unlock.map(unlock => unlock());
                batchReactiveUpdates(() => { workspaceStore.setState(candidate.workspace); scopedVariableStore.setState(candidate.variables); schemaRegistryStore.setState(candidate.settings); });
            } finally { if (!replays.length) replays = unlock.map(unlock => unlock()); }
            void tavernEventBus.emit('chat_changed', chat.id); schedulePreview();
        } finally {
            await finish(false);
            const replayed = batchReactiveUpdates(() => replays.reduce((count, replay) => count + replay(), 0)); release();
            if (replayed) await persistWorkspaceNow();
        }
    });
}
function applyArchivedChatState(chat: ArchivedChat, keepChoices = false): void {
    if (chat.continuation) chat = { ...chat, continuation: removeStarterContinuation(chat.continuation) };
    if (chat.continuation) {
        const continuation = chat.continuation;
        if (continuation.settings && !keepChoices) schemaRegistryStore.setState(draft => { Object.assign(draft.values, continuation.settings); });
        scopedVariableStore.setState(draft => {
            draft.global = structuredClone(continuation.variables.global);
            Object.assign(draft.chat, structuredClone(continuation.variables.chat));
            Object.assign(draft.message, structuredClone(continuation.variables.message));
            Object.assign(draft.character, structuredClone(continuation.variables.character ?? {}));
            Object.assign(draft.preset, structuredClone(continuation.variables.preset ?? {}));
            for (const key of new Set([...SYNC_EXTENSIONS, ...workspaceStore.getState().branchExtensionKeys ?? [], ...continuation.extensionKeys ?? []])) {
                if (key in continuation.extensions) draft.extension[key] = structuredClone(continuation.extensions[key]); else delete draft.extension[key];
            }
        });
    }
    workspaceStore.setState(draft => {
        applyCharacterPersona(draft, chat.characterId);
        if (chat.continuation) {
            const { activePresetId, inUsePreset, activeLorebookIds, userName, activePersonaId } = chat.continuation;
            Object.assign(draft, structuredClone(keepChoices ? { userName, activePersonaId } : { activePresetId, inUsePreset, activeLorebookIds, userName, activePersonaId }));
        }
        draft.lastAssembledPrompt = null;
        draft.branchExtensionKeys = chat.continuation?.extensionKeys ?? [];
        draft.chatMetadata = chat.continuation?.chatMetadata;
        draft.nativePluginRoute = chat.continuation?.nativePluginRoute;
        draft.storyWorldbooks = cloneStateValue(keepChoices ? routeWorldbooks(chat.continuation?.worldbooks, draft) : chat.continuation?.worldbooks);
        draft.storyCharacterBinding = structuredClone(chat.continuation?.characterBinding);
        draft.storyCharacter = structuredClone(chat.continuation?.character);
        draft.storyPersona = structuredClone(chat.continuation?.persona);
        draft.branchEpoch = (draft.branchEpoch ?? 0) + 1;
        draft.deletedMessageIds = chat.deletedMessageIds ?? [];
        draft.activeChatId = chat.id; draft.activeCharacterId = chat.characterId;
        draft.messages = normalizeMessageVariableSnapshots(chat.messages); draft.activeLeafId = chat.activeLeafId;
        draft.timedStates = chat.timedStates;
        draft.templateInjections = chat.templateInjections ?? [];
        draft.templateActivations = chat.templateActivations ?? [];
        if (!keepChoices && chat.continuation || !Object.hasOwn(draft.chatWorldbookBindings, chat.id)) draft.chatWorldbookBindings[chat.id] = chat.worldbookName ?? null;
    });
    if (!chat.continuation) {
        ensureInitialVariables();
        if (chat.activeLeafId) restoreMessageSnapshot(chat.activeLeafId);
    }
}

function applyCharacterPersona(draft: WorkspaceState, characterId: string): void {
    const persona = draft.personas.find(item => item.connections.some(connection => connection.type === 'character' && [characterId, `${characterId}.png`].includes(connection.id)))
        ?? draft.personas.find(item => item.is_default);
    draft.activePersonaId = persona?.avatar_id ?? null;
    draft.userName = persona?.name ?? '用户';
}

export function createChat(card: NormalizedCharacterCard, notify = true): void {
    const messages = buildInitialMessages(card);
    const greeting = messages[0];
    workspaceStore.setState(draft => {
        draft.storyWorldbooks = undefined; draft.storyCharacterBinding = undefined; draft.storyCharacter = undefined; draft.storyPersona = undefined;
        applyCharacterPersona(draft, card.id);
        draft.lastAssembledPrompt = null;
        draft.activeCharacterId = card.id;
        draft.activeChatId = `chat_${card.id}_${crypto.randomUUID()}`;
        draft.branchEpoch = 0;
        draft.chatMetadata = undefined;
        draft.nativePluginRoute = undefined;
        draft.branchExtensionKeys = []; draft.deletedMessageIds = [];
        draft.messages = messages;
        draft.activeLeafId = greeting.id;
        draft.timedStates = {};
        draft.templateInjections = [];
        draft.templateActivations = [];
    });
    ensureInitialVariables();
    captureMessageSnapshot(greeting.id);
    if (notify) {
        persistWorkspace();
        void tavernEventBus.emit('chat_changed', workspaceStore.getState().activeChatId);
        schedulePreview();
    }
}

let characterSwitchJob: Promise<void> | undefined;
export async function selectCharacter(characterId: string): Promise<void> {
    await waitForReplicaCommit();
    // Finish the current save before accepting another switch.
    while (characterSwitchJob) await characterSwitchJob;
    const job = runBranchOperation(() => switchCharacter(characterId));
    characterSwitchJob = job;
    try { await job; } finally { if (characterSwitchJob === job) characterSwitchJob = undefined; }
}
async function switchCharacter(characterId: string): Promise<void> {
    const state = workspaceStore.getState();
    if (state.isGenerating || state.helperGenerationCount > 0 || characterId === state.activeCharacterId) return;
    const target = state.characters.find(card => card.id === characterId);
    if (!target) return;
    try {
        await archiveActiveChat();
        const recent = (await listChatArchives()).reverse().find(chat => chat.characterId === characterId);
        const chat = recent ? await loadChatArchive(recent.id) : null;
        if (chat) await applyArchivedChat(chat); else createChat(target);
        await tavernEventBus.emit('character_changed', target);
    } catch (error) { setStatusBanner(String(error)); throw error; }
}

export async function startNewChat(): Promise<void> {
    await waitForReplicaCommit();
    if (workspaceStore.getState().isGenerating || workspaceStore.getState().helperGenerationCount > 0) return;
    const card = getActiveCharacter();
    if (!card.id) return;
    await runBranchOperation(async () => {
        await archiveActiveChat();
        createChat(card);
    });
}

/** Delete by identity so existing duplicate names can be cleaned up individually. */
export function removeWorldbookFromWorkspace(draft: WorkspaceState, id: string): boolean {
    const book = [...draft.characters.flatMap(card => [card.characterBook, card.embeddedLorebook]), ...draft.lorebooks].find(item => item?.id === id);
    if (!book) return false;
    const name = book.name;
    const sameNameRemains = [...draft.characters.flatMap(card => [card.characterBook, card.embeddedLorebook]), ...draft.lorebooks]
        .some(item => item && item.id !== id && item.name === name);
    draft.lorebooks = draft.lorebooks.filter(item => item.id !== id);
    draft.activeLorebookIds = draft.activeLorebookIds.filter(value => value !== id);
    for (const card of draft.characters) {
        const owns = card.characterBook?.id === id || card.embeddedLorebook?.id === id;
        if (owns) {
            if (card.characterBook?.id === id) card.characterBook = null;
            if (card.embeddedLorebook?.id === id) card.embeddedLorebook = null;
            const raw = cloneStateValue(card.rawData ?? {});
            for (const container of [raw, raw.data].filter((value): value is Record<string, unknown> => !!value && typeof value === 'object')) {
                for (const key of ['character_book', 'characterBook', 'embeddedLorebook']) delete container[key];
            }
            card.rawData = raw;
        }
        if (!sameNameRemains) {
            const primary = typeof card.primaryWorldbook === 'string' ? card.primaryWorldbook : card.primaryWorldbook?.name;
            if (primary === name) card.primaryWorldbook = null;
            if (card.additionalWorldbooks?.includes(name)) card.additionalWorldbooks = card.additionalWorldbooks.filter(value => value !== name);
            if (card.extensions?.world === name) card.extensions.world = '';
            if (Array.isArray(card.extensions?.extra_worlds) && card.extensions.extra_worlds.includes(name)) card.extensions.extra_worlds = card.extensions.extra_worlds.filter(value => value !== name);
        }
    }
    if (!sameNameRemains) {
        for (const binding of Object.values(draft.characterWorldbookBindings)) {
            if (binding.primary === name) binding.primary = null;
            binding.additional = binding.additional.filter(value => value !== name);
        }
        for (const [chatId, value] of Object.entries(draft.chatWorldbookBindings)) if (value === name) draft.chatWorldbookBindings[chatId] = null;
        for (const persona of draft.personas) if (persona.lorebook === name) persona.lorebook = '';
    }
    return true;
}
export async function deleteWorkspaceWorldbook(id: string): Promise<void> {
    const state = workspaceStore.getState();
    if (state.isGenerating || state.helperGenerationCount) throw new Error('请等待生成结束后删除世界书');
    workspaceStore.setState(draft => { removeWorldbookFromWorkspace(draft, id); });
    await persistWorkspaceNow(); worldbooksChanged();
}
export function getCharacterDeletionBooks(id: string) {
    const state = workspaceStore.getState(), card = state.characters.find(item => item.id === id);
    if (!card) return [];
    const binding = getCharacterWorldbooks(card, state);
    const ids = new Set([card.characterBook?.id, card.embeddedLorebook?.id]);
    const names = new Set([binding.primary, ...binding.additional]);
    const owned = [card.characterBook, card.embeddedLorebook].filter((book): book is NormalizedLorebook => !!book);
    return getAvailableWorldbooks(state).filter(book => ids.has(book.id) || names.has(book.name) && !owned.some(own => own.name === book.name)).map(book => ({ book,
        shared: state.characters.some(other => {
            if (other.id === id) return false;
            const own = other.characterBook ?? other.embeddedLorebook;
            if (own?.id === book.id) return true;
            const linked = getCharacterWorldbooks(other, state);
            // A duplicated card with its own same-name book does not own this copy.
            return own?.name !== book.name && (linked.primary === book.name || linked.additional.includes(book.name));
        }) || state.personas.some(persona => persona.lorebook === book.name) || state.activeLorebookIds.includes(book.id),
    }));
}
export async function deleteWorkspaceCharacter(id: string, deleteChats = false, deleteBookIds: string[] = []): Promise<boolean> {
    await waitForReplicaCommit();
    while (characterSwitchJob) await characterSwitchJob;
    return enqueuePersistentOperation(async () => {
    let state = workspaceStore.getState();
    if (state.isGenerating || state.helperGenerationCount) throw new Error('请等待生成结束后删除角色');
    const card = state.characters.find(item => item.id === id);
    if (!card) return false;
    if (state.activeCharacterId === id && !deleteChats) {
        const leaf = getActiveChatMessages(state).at(-1);
        if (leaf) captureMessageSnapshot(leaf.id);
        state = workspaceStore.getState();
    }
    await persistWorkspaceNow();
    const archives = await listChatArchives();
    const switching = state.activeCharacterId === id;
    const nextCard = state.characters.find(item => item.id !== id);
    const recent = switching && nextCard ? [...archives].reverse().find(chat => chat.characterId === nextCard.id) : undefined;
    const nextChat = recent ? await loadChatArchive(recent.id) : null;
    const extras: Record<string, any> = {};
    let index = archives;
    if (switching && !deleteChats && state.messages.length) {
        const chat: ArchivedChat = { id: state.activeChatId, characterId: id, messages: state.messages, deletedMessageIds: state.deletedMessageIds,
            activeLeafId: state.activeLeafId, timedStates: state.timedStates, worldbookName: state.chatWorldbookBindings[state.activeChatId],
            templateInjections: state.templateInjections, templateActivations: state.templateActivations, continuation: captureChatContinuation() };
        extras[`chat_archive:${chat.id}`] = chat;
        index = [...index.filter(item => item.id !== chat.id), summarizeChat(chat)];
    }
    if (deleteChats) {
        for (const chat of index.filter(item => item.characterId === id)) extras[`chat_archive:${chat.id}`] = null;
        if (switching) extras[`chat_archive:${state.activeChatId}`] = null;
        index = index.filter(item => item.characterId !== id);
    }
    extras.chat_archive_index = index;
    const cleanup = await platformStorage.loadSnapshot<string[]>('gallery_cleanup', []);
    extras.gallery_cleanup = [...new Set([...cleanup, id])];
    const finish = suspendRegisteredPersistence(), release = holdReplicaCommit();
    const oldVariables = scopedVariableStore.getState(), oldSettings = schemaRegistryStore.getState();
    let candidate: ReturnType<typeof registeredSnapshots>;
    let workspace: WorkspaceState, variables: typeof oldVariables, settings: typeof oldSettings;
    let replay: Array<() => number> = [];
    try {
    withoutStoreNotifications(() => {
    try {
    workspaceStore.setState(draft => {
        // Keep embedded books as independent resources unless explicitly selected for deletion.
        for (const book of [card.characterBook, card.embeddedLorebook]) if (book && !draft.lorebooks.some(item => item.id === book.id)) draft.lorebooks.push(book);
        draft.characters = draft.characters.filter(item => item.id !== id);
        delete draft.characterWorldbookBindings[id]; delete draft.streamDisplayModes[id];
        for (const persona of draft.personas) persona.connections = persona.connections.filter(link => link.type !== 'character' || ![id, `${id}.png`].includes(link.id));
    });
    if (switching) {
        if (nextChat) applyArchivedChatState(nextChat);
        else if (nextCard) createChat(nextCard, false);
        else workspaceStore.setState(emptyStory());
    }
    workspaceStore.setState(draft => { for (const bookId of deleteBookIds) removeWorldbookFromWorkspace(draft, bookId); });
    workspace = workspaceStore.getState(); variables = scopedVariableStore.getState(); settings = schemaRegistryStore.getState();
    candidate = { ...registeredSnapshots(), ...extras };
    } finally { workspaceStore.setState(state); scopedVariableStore.setState(oldVariables); schemaRegistryStore.setState(oldSettings); }
    });
    const unlock = [workspaceStore.holdWrites(), scopedVariableStore.holdWrites(), schemaRegistryStore.holdWrites()];
    try {
        await platformStorage.saveSnapshots(candidate!);
        acknowledgeSnapshots(candidate!);
        replay = unlock.map(unlock => unlock());
        batchReactiveUpdates(() => { workspaceStore.setState(workspace!); scopedVariableStore.setState(variables!); schemaRegistryStore.setState(settings!); });
    } finally { if (!replay.length) replay = unlock.map(unlock => unlock()); }
    } finally {
        await finish(false);
        const replayed = batchReactiveUpdates(() => replay.reduce((count, run) => count + run(), 0)); release();
        if (replayed) await persistWorkspaceNow();
    }
    if (switching) {
        void tavernEventBus.emit('chat_changed', workspaceStore.getState().activeChatId);
        void tavernEventBus.emit('character_changed', getActiveCharacter()); schedulePreview();
    }
    void import('../core/story-gallery').then(module => module.drainGalleryCleanup()).catch(error => setStatusBanner(`图库清理稍后重试：${String(error)}`));
    return true;
    });
}
export async function deleteWorkspacePreset(id: string): Promise<void> {
    const state = workspaceStore.getState();
    if (state.isGenerating || state.helperGenerationCount) throw new Error('请等待生成结束后删除预设');
    const active = state.activePresetId === id || state.inUsePreset?.id === id;
    workspaceStore.setState(draft => {
        draft.presets = draft.presets.filter(preset => preset.id !== id);
    });
    if (active) { workspaceStore.setState({ activePresetId: '', inUsePreset: undefined }); schedulePreview(); }
    await persistWorkspaceNow();
}

/** Developer testing action: remove imported content, then bootstrap defaults. */
export async function clearImportedWorkspace(): Promise<void> {
    const state = workspaceStore.getState();
    if (state.isGenerating || state.helperGenerationCount) throw new Error('请先停止生成再清空');
    stopCompatibilityRuntime();
    await Promise.allSettled([characterSwitchJob, preloadJob?.promise, renderingJob]);
    await enqueuePersistentOperation(async () => {
        await persistRegisteredSnapshots();
        const resume = suspendRegisteredPersistence();
        try {
            await clearChatArchives();
            const { unbindStoryGallery } = await import('../core/story-gallery');
            for (const card of state.characters) await unbindStoryGallery(card.id);
            const fresh = initialWorkspace();
            fresh.personas = structuredClone(state.personas);
            const profile = fresh.personas.find(persona => persona.is_default);
            fresh.activePersonaId = profile?.avatar_id ?? null;
            fresh.userName = profile?.name ?? state.userName;
            const { characters, lorebooks, presets, ...snapshot } = fresh;
            await platformStorage.saveSnapshots({ workspace_assets: { characters, lorebooks, presets },
                workspace_snapshot: { ...snapshot, snapshotVersion: 2 },
                scoped_variables: { global: {}, character: {}, preset: {}, chat: {}, message: {}, extension: {} } });
            window.location.reload();
        } catch (error) {
            await resume(false);
            window.dispatchEvent(new Event('tipsy-compatibility-reload'));
            throw error;
        }
    });
}

export function appendChatMessage(role: 'user' | 'assistant' | 'system', content: string): ChatMessageNode {
    const state = workspaceStore.getState();
    const card = getActiveCharacter(state);
    const path = getActiveChatMessages(state);
    const floor = path.length;
    const prevNode = path.at(-1);
    if (prevNode) captureMessageSnapshot(prevNode.id);
    const id = `msg_${crypto.randomUUID()}`;
    if (role !== 'system') content = applyRegexScripts(content, orderedRegexScripts(globalRegexes(), getActivePreset(state).regexScripts, card.regexScripts), {
        stage: role === 'user' ? 'user_input' : 'ai_output', role,
        macroContext: { userName: state.userName, charName: card.name },
    });
    const newNode: ChatMessageNode = {
        id,
        messageId: id,
        parentId: prevNode ? (prevNode.id || null) : null,
        parentSwipeId: prevNode ? swipeId(prevNode) : undefined,
        floor,
        role,
        speakerName: role === 'user' ? state.userName : role === 'assistant' ? card.name : 'System',
        content,
        swipes: [content],
        activeSwipeIndex: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
    };
    continueNativeRoute(state.messages, path, newNode);

    newNode.extra = { ...(newNode.extra ?? {}), chatVariables: structuredClone(getScopedVariables('chat', { chatId: state.activeChatId })), timedStates: structuredClone(state.timedStates) };
    const inherited = { ...getScopedVariables('chat', { chatId: state.activeChatId }), ...(prevNode ? getScopedVariables('message', { messageId: prevNode.id }) : {}) };
    replaceScopedVariables(structuredClone(inherited), 'message', { messageId: id });
    workspaceStore.setState((draft) => {
        draft.messages.push(newNode);
        const origin = draft.messages.find(node => node.id === prevNode?.id);
        if (origin?.branchOrigin && role === 'user') origin.branchLabel = branchExcerpt(content, 60);
        draft.activeLeafId = newNode.id;
    });
    persistWorkspace();
    captureMessageSnapshot(newNode.id);
    notifyMessage(role === 'user' ? 'message_sent' : 'message_received', newNode);
    if (!state.isGenerating) schedulePreview();
    return newNode;
}

export function validateHelperVariableWrite(variables: Record<string, unknown>, option: HelperVariableOption = {}): void {
    if (!variables || typeof variables !== 'object' || Array.isArray(variables)) throw new Error('变量表必须是对象');
    const type = option.type ?? 'chat';
    if (type === 'message') {
        const index = option.message_id === undefined || option.message_id === 'latest' ? -1 : Number(option.message_id);
        if (!Number.isInteger(index) || !getActiveChatMessages().at(index)) throw new Error('变量指定的消息楼层不存在');
    } else if (type === 'script') {
        if (!option.script_id || !getWorkspaceScripts().some(script => script.id === option.script_id)) throw new Error('脚本变量必须指定有效的 script_id');
    } else if (type === 'extension') {
        validateExtensionVariableId(option.extension_id);
    } else if (!['chat', 'character', 'preset', 'global'].includes(type)) throw new Error(`未支持的变量作用域：${type}`);
}

export function saveHelperVariables(variables: Record<string, unknown>, option: HelperVariableOption = {}): Record<string, unknown> {
    validateHelperVariableWrite(variables, option);
    if (!variables || typeof variables !== 'object' || Array.isArray(variables)) throw new Error('变量表必须是对象');
    const state = workspaceStore.getState();
    const path = getActiveChatMessages(state);
    const type = option.type ?? 'chat';
    const value = structuredClone(type === 'chat' || type === 'message' ? normalizeMvuVariables(variables).variables : variables);
    const ctx = { chatId: state.activeChatId, characterId: state.activeCharacterId, presetId: state.activePresetId };
    if (type === 'message') {
        const index = option.message_id === 'latest' || option.message_id === undefined ? -1 : Number(option.message_id);
        const node = path.at(index);
        if (!node || !Number.isInteger(index)) throw new Error('变量指定的消息楼层不存在');
        replaceScopedVariables(value, 'message', { ...ctx, messageId: node.id });
        if (node.id === path.at(-1)?.id) {
            const chat = getScopedVariables('chat', ctx);
            // Keep the MVU data and its declarations together in the current chat projection.
            if ('stat_data' in value && getEffectiveMvuSettings(state).settings['mvu.update_chat'] === true) {
                const projection = mvuChatProjection(value);
                for (const key of ['display_data', 'delta_data']) if (!(key in projection)) delete chat[key];
                replaceScopedVariables({ ...chat, ...projection }, 'chat', ctx);
            }
        }
        workspaceStore.setState(draft => {
            const target = draft.messages.find(m => m.id === node.id)!;
            const chatVariables = structuredClone(getScopedVariables('chat', ctx));
            target.extra = { ...target.extra, swipeVariables: { ...(target.extra?.swipeVariables as object ?? {}), [node.activeSwipeIndex]: value },
                ...(node.id === path.at(-1)?.id ? { chatVariables, swipeChatVariables: { ...(target.extra?.swipeChatVariables as object ?? {}), [node.activeSwipeIndex]: chatVariables } } : {}) };
        });
    } else if (type === 'script') {
        const trees = getWorkspaceScriptTrees(state);
        const type = (['character', 'preset', 'global'] as const).find(type => scriptsFromTrees(trees[type]).some(script => script.id === option.script_id))!;
        const next = structuredClone(trees[type]);
        let scriptIndex = 0;
        const visit = (scripts: any[]) => {
            if (!Array.isArray(scripts)) return;
            for (const script of scripts ?? []) {
                if (!script || typeof script !== 'object') continue;
                if (Array.isArray(script.scripts)) visit(script.scripts);
                else if (typeof script.content === 'string') {
                    if (String(script.id ?? scriptIndex) === option.script_id) script.data = structuredClone(value);
                    scriptIndex++;
                }
            }
        };
        visit(next);
        replaceWorkspaceScriptTrees(next, type, false);
    } else if (type === 'extension') {
        trackBranchExtension(option.extension_id!);
        replaceExtensionVariables(option.extension_id!, value);
    } else {
        if (!['chat', 'character', 'preset', 'global'].includes(type)) throw new Error(`未支持的变量作用域：${type}`);
        replaceScopedVariables(value, type as 'chat' | 'character' | 'preset' | 'global', ctx);
        if (type === 'chat' && path.at(-1)) captureMessageSnapshot(path.at(-1)!.id);
    }
    persistWorkspace();
    return value;
}

/** One checked publication for every greeting candidate. No partial per-swipe RPC writes. */
interface MvuInitializationPayload {
    expected: { session: string; messageId: string; swipes: string[]; swipe: number; variables: Record<string, unknown>;
        messageVariables: Record<string, any>[]; scopes: Record<string, Record<string, unknown>>; scriptVariables: Record<string, Record<string, unknown>>; extensionVariables: Record<string, Record<string, unknown>> };
    candidates: Record<string, any>[]; writes: VariableWrite[];
}
export async function commitMvuInitialization(payload: MvuInitializationPayload): Promise<void> {
    return enqueuePersistentOperation(() => commitWorkspaceMutation(() => applyMvuInitialization(payload)));
}
export async function commitMvuMessage(expected: { session: string; id: string; swipe: number; content: string; variables?: Record<string, unknown> },
    result: { variables: Record<string, unknown>; writes?: VariableWrite[]; messageContent?: string }): Promise<void> {
    await enqueuePersistentOperation(() => commitWorkspaceMutation(() => {
        const node = getActiveChatMessages().find(message => message.id === expected.id);
        if (workspaceStore.getState().activeChatId !== expected.session || !node || node.activeSwipeIndex !== expected.swipe || node.content !== expected.content) throw new Error('变量结算期间消息或候选已改变');
        if (expected.variables && !_.isEqual(getScopedVariables('message', { messageId: node.id }), expected.variables)) throw new Error('校正期间消息变量已改变，请重新发起校正');
        const writes = [...result.writes ?? [], { variables: result.variables, option: { type: 'message', message_id: node.floor } }];
        for (const write of writes) validateHelperVariableWrite(write.variables, write.option);
        for (const write of writes) saveHelperVariables(write.variables, write.option);
        if (result.messageContent !== undefined) workspaceStore.setState(draft => {
            const target = draft.messages.find(message => message.id === node.id)!;
            target.content = result.messageContent!;
            const swipe = target.swipes[target.activeSwipeIndex];
            target.swipes[target.activeSwipeIndex] = typeof swipe === 'string' ? target.content : { ...swipe, content: target.content };
            target.updatedAt = Date.now();
        });
    }));
}

function applyMvuInitialization(payload: MvuInitializationPayload): void {
    const state = workspaceStore.getState();
    const node = getActiveChatMessages(state)[0];
    const expected = payload.expected;
    const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);
    const ctx = { chatId: state.activeChatId, characterId: state.activeCharacterId, presetId: state.activePresetId };
    const swipes = node?.extra?.swipeVariables as Record<string, Record<string, any>> | undefined;
    if (!node || getActiveChatMessages(state).length !== 1 || state.activeChatId !== expected.session || node.id !== expected.messageId || node.activeSwipeIndex !== expected.swipe
        || !same(node.swipes.map(swipe => typeof swipe === 'string' ? swipe : swipe.content), expected.swipes)
        || !same(node.swipes.map((_, swipe) => swipe === node.activeSwipeIndex ? getScopedVariables('message', { messageId: node.id }) : swipes?.[swipe] ?? {}), expected.messageVariables)
        || !same(getScopedVariables('chat', { chatId: state.activeChatId }), expected.variables)
        || (['global', 'preset', 'character'] as const).some(scope => !same(getScopedVariables(scope, ctx), expected.scopes[scope]))
        || !same(Object.fromEntries(getWorkspaceScripts(state).map(script => [script.id, script.data])), expected.scriptVariables)
        || !same(scopedVariableStore.getState().extension, expected.extensionVariables)) throw new Error('开场初始化期间聊天或变量已改变，请重新读取');
    // Author MVU callbacks may deliberately update worldbooks during opening
    // initialization. Those writes are independently committed, not rolled back
    // with this variable publication, and must not invalidate their own result.
    if (!Array.isArray(payload.candidates) || payload.candidates.length !== node.swipes.length || !Array.isArray(payload.writes)) throw new Error('开场初始化结果不完整');
    const candidates = payload.candidates.map(value => {
        validateHelperVariableWrite(value, { type: 'message', message_id: 0 });
        return structuredClone(normalizeMvuVariables(value).variables);
    });
    for (const write of payload.writes) validateHelperVariableWrite(write.variables, write.option);
    for (const write of payload.writes) saveHelperVariables(write.variables, write.option);
    const previousChat = getScopedVariables('chat', { chatId: state.activeChatId });
    workspaceStore.setState(draft => {
        const target = draft.messages.find(message => message.id === node.id)!;
        target.extra = { ...target.extra, tipsy_mvu_initialized: true, tipsy_mvu_initialization_pending: false,
            swipeVariables: Object.fromEntries(candidates.map((value, swipe) => [swipe, value])),
            swipeChatVariables: Object.fromEntries(candidates.map((value, swipe) => [swipe, { ...previousChat, ...mvuChatProjection(value) }])) };
    });
    saveHelperVariables(candidates[node.activeSwipeIndex], { type: 'message', message_id: 0 });
    if (getActiveChatMessages().length === 1) captureMessageSnapshot(node.id);
    persistWorkspace();
}

type LegacyMessagePatch = { id: string; swipe: number; content: string; mes?: string; hidden?: boolean; extra?: Record<string, unknown>; variables?: Record<string, unknown> };
type LegacyMetadataPatch = { values: Record<string, unknown>; removed: string[] };
export function saveLegacyChat(rows: LegacyMessagePatch[], variables?: Record<string, unknown>, metadata: LegacyMetadataPatch = { values: {}, removed: [] }): boolean {
    const state = workspaceStore.getState();
    const path = new Map(getActiveChatMessages(state).map(node => [node.id, node]));
    const hidden = { ...state.chatMetadata?.[hostHiddenKey] as Record<string, boolean> | undefined };
    let hiddenChanged = false;
    const edits = new Map<string, { swipe: number; mes?: string; extra?: Record<string, unknown> }>();
    const writes: Array<{ floor: number; value: Record<string, unknown> }> = [];
    for (const message of rows) {
        const node = path.get(message.id);
        if (!node || message.swipe !== node.activeSwipeIndex || message.content !== node.content) {
            if (message.mes !== undefined) throw new Error('插件保存的正文对应的消息已改变');
            continue;
        }
        if (message.mes !== undefined && node.extra?.tipsy_generation_incomplete) throw new Error('不能保存尚在生成的消息正文');
        const extra = message.extra && !_.isEqual(message.extra, messageExtra(node)) ? message.extra : undefined;
        if (message.mes !== undefined || extra) edits.set(node.id, { swipe: node.activeSwipeIndex, mes: message.mes, extra });
        if (message.variables && !_.isEqual(message.variables, readScopedVariables('message', { messageId: node.id }))) writes.push({ floor: node.floor, value: message.variables });
        if (message.hidden !== undefined && message.hidden !== hostMessageHidden(node, state.chatMetadata) && !node.isHidden) {
            if (message.hidden) hidden[swipeId(node)] = true; else delete hidden[swipeId(node)];
            hiddenChanged = true;
        }
    }
    const next = { ...state.chatMetadata, ...metadata.values, ...(hiddenChanged ? { [hostHiddenKey]: hidden } : {}) };
    for (const key of metadata.removed) delete next[key];
    const metadataChanged = !_.isEqual(next, state.chatMetadata ?? {});
    const variablesChanged = !!variables && !_.isEqual(variables, readScopedVariables('chat', { chatId: state.activeChatId }));
    if (!edits.size && !metadataChanged && !variablesChanged && !writes.length) return false;
    batchReactiveUpdates(() => {
        if (edits.size) workspaceStore.setState(draft => {
            for (const node of draft.messages) {
                const patch = edits.get(node.id);
                if (!patch) continue;
                if (patch.extra) node.extra = { ...node.extra, helperSwipeInfo: { ...node.extra?.helperSwipeInfo as object, [patch.swipe]: patch.extra } };
                const key = swipeId(node, patch.swipe);
                if (patch.mes !== undefined) {
                    const previous = node.swipes[patch.swipe];
                    node.swipes[patch.swipe] = typeof previous === 'object' ? { ...previous, content: patch.mes } : patch.mes;
                    if (node.activeSwipeIndex === patch.swipe) node.content = patch.mes;
                    node.updatedAt = Date.now();
                    delete node.storySummaries?.[key];
                }
                // Keep saved choices pointing at the edited text without rolling back their variables.
                for (const point of [node.branchBases?.[key], node.branchStates?.[key]]) if (point?.reply) {
                    if (patch.mes !== undefined) {
                        point.reply.content = patch.mes;
                        const original = point.reply.swipe;
                        point.reply.swipe = typeof original === 'object' ? { ...original, content: patch.mes } : patch.mes;
                    }
                    if (patch.extra) point.reply.extra = { ...point.reply.extra,
                        helperSwipeInfo: { ...point.reply.extra?.helperSwipeInfo as object, [patch.swipe]: patch.extra } };
                }
            }
        });
        if (metadataChanged) workspaceStore.setState({ chatMetadata: next });
        for (const write of writes) saveHelperVariables(write.value, { type: 'message', message_id: write.floor });
        if (variablesChanged) saveHelperVariables(variables!, { type: 'chat' });
        if (state.activeLeafId) captureMessageSnapshot(state.activeLeafId);
    });
    if ([...edits.values()].some(edit => edit.mes !== undefined)) schedulePreview();
    return true;
}

export function editHelperChatMessage(floor: number | string, content: string, options: { swipe_id?: number; refresh?: 'none' | 'affected' | 'all' } = {}): boolean {
    const path = getActiveChatMessages();
    const node = path.find(m => m.id === floor) ?? path.at(Number(floor));
    if (!node) throw new Error('消息楼层不存在');
    const duringNotification = workspaceStore.getState().isGenerating && generationNotificationMessage === node.id;
    if (workspaceStore.getState().isGenerating && !duringNotification) throw new Error('生成期间不能修改消息');
    const swipe = options.swipe_id ?? node.activeSwipeIndex;
    if (swipe !== node.activeSwipeIndex && nativeStorySaving) throw new Error('正在保存插件数据，请稍后切换路线');
    if (!Number.isInteger(swipe) || swipe < 0 || swipe >= node.swipes.length) throw new Error('消息分支不存在');
    if (duringNotification && swipe !== node.activeSwipeIndex) throw new Error('生成事件中不能切换消息分支');
    if (node.floor > 0 && !duringNotification && swipe !== node.activeSwipeIndex) {
        const routes = storyRoutes(workspaceStore.getState().messages).filter(route => route.path.some(item => item.id === node.id && item.activeSwipeIndex === swipe));
        if (routes.length > 1) throw new Error('这个回复有多条后续，请从故事路线选择要继续的一条');
        if (routes.length === 1) {
            const current = node.swipes[swipe];
            if ((typeof current === 'string' ? current : current.content) === content) { selectChatBranch(routes[0].key, true); return true; }
        }
    }
    captureMessageSnapshot(node.id);
    const forksHistory = node.floor > 0 && !duringNotification && content !== node.content && node.id !== workspaceStore.getState().activeLeafId;
    if (forksHistory) preserveReplyVersion(workspaceStore.getState().messages.find(item => item.id === node.id)!);
    workspaceStore.setState(draft => {
        const target = draft.messages.find(m => m.id === node.id)!;
        target.swipes = [...target.swipes];
        const previous = target.swipes[swipe];
        target.swipes[swipe] = typeof previous === 'string' ? content : { ...previous, content };
        target.activeSwipeIndex = swipe; target.content = content; target.updatedAt = Date.now();
        if (target.floor === 0 && draft.activeLeafId === target.id && swipe !== node.activeSwipeIndex) draft.nativePluginRoute = node.nativePluginOpeningRoutes?.[swipeId(node, swipe)];
        if (swipe !== node.activeSwipeIndex) target.reasoning = typeof previous === 'string' ? '' : previous.reasoning ?? '';
        if (forksHistory) {
            target.branchBases = undefined; target.branchStates = undefined;
            draft.activeLeafId = target.id;
        }
    });
    if (node.floor > 0 && (forksHistory || swipe !== node.activeSwipeIndex)) restoreMessageSnapshot(node.id);
    else captureMessageSnapshot(node.id);
    if (forksHistory) { sealBranchPoint(true); publishBranchChange(false); }
    persistWorkspace();
    if (!duringNotification) {
        if (options.refresh !== 'none') schedulePreview();
        if (options.refresh === 'all') void commandCompatibilityRuntime('event', ['chat_changed', workspaceStore.getState().activeChatId]).catch(error => setStatusBanner(String(error)));
        else notifyMessage('message_edited', { ...node, content });
    }
    return true;
}

/** Validate the complete batch before publishing any mutation. */
export async function setHelperChatMessages(items: Array<Record<string, any>>, options: { refresh?: 'none' | 'affected' | 'all' } = {}): Promise<Array<{ message_id: number; role: ChatMessageNode['role'] }>> {
    await waitForReplicaCommit();
    if (!Array.isArray(items)) throw new Error('消息更新必须是数组');
    validateMessageRefresh(options.refresh);
    const state = workspaceStore.getState();
    const path = getActiveChatMessages();
    const merged = new Map<string, { node: ChatMessageNode; item: Record<string, any> }>();
    for (const item of items) {
        if (!item || typeof item !== 'object' || item.message_id == null) throw new Error('消息更新必须包含 message_id');
        const id = Number(item.message_id);
        if (!Number.isInteger(id)) throw new Error('message_id 必须为整数');
        const node = path.at(id);
        if (node) merged.set(node.id, { node, item: { ...merged.get(node.id)?.item, ...item, message_id: node.floor } });
    }
    const plans = [...merged.values()].sort((a, b) => a.node.floor - b.node.floor).map(({ node, item }) => {
        const variables = getScopedVariables('message', { messageId: node.id });
        const plan = patchHelperMessage(node, item, variables);
        if (node.floor === 0 && item.data === undefined && item.swipes_data === undefined) {
            // Changing the opening display does not roll back the author's live setup.
            plan.variables = variables;
            (plan.node.extra!.swipeVariables as Record<string, Record<string, unknown>>)[plan.node.activeSwipeIndex] = variables;
        }
        if (state.isGenerating && (generationNotificationMessage !== node.id || plan.node.activeSwipeIndex !== node.activeSwipeIndex
            || ['swipes', 'swipes_data', 'swipes_info', 'role', 'is_hidden'].some(key => item[key] !== undefined))) {
            throw new Error('生成期间不能修改其他消息或改变分支结构');
        }
        return plan;
    });
    if (!plans.length) return [];
    const changesChoice = plans.find(plan => plan.node.activeSwipeIndex !== path.find(node => node.id === plan.node.id)!.activeSwipeIndex);
    if (changesChoice && changesChoice.node.floor > 0 && plans.length === 1 && Object.keys(merged.get(changesChoice.node.id)!.item).every(key => ['message_id', 'swipe_id'].includes(key))) {
        const routes = storyRoutes(state.messages).filter(route => route.path.some(node => node.id === changesChoice.node.id && node.activeSwipeIndex === changesChoice.node.activeSwipeIndex));
        if (routes.length !== 1) throw new Error('这个回复有多条后续，请从故事路线选择');
        selectChatBranch(routes[0].key, true); return [{ message_id: changesChoice.node.floor, role: changesChoice.node.role }];
    }
    if (!state.isGenerating && plans.some(plan => {
        const original = path.find(node => node.id === plan.node.id)!;
        return original.floor > 0 && (original.id !== state.activeLeafId || state.messages.some(node => node.parentId === original.id))
            && (plan.node.content !== original.content || plan.node.activeSwipeIndex !== original.activeSwipeIndex
                || !_.isEqual(plan.node.swipes, original.swipes));
    })) {
        const edits = new Map(plans.map(plan => [plan.node.id, plan.node]));
        const first = Math.min(...plans.map(plan => plan.node.floor));
        const active = await publishHelperPath(path.map(node => edits.get(node.id) ?? node), first, new Map(plans.map(plan => [plan.node.id, plan.variables])));
        return active.slice(first).map(node => ({ message_id: node.floor, role: node.role }));
    }
    const byId = new Map(plans.map(plan => [plan.node.id, plan.node]));
    const previousHead = path.at(-1), nextHead = previousHead && byId.get(previousHead.id);
    workspaceStore.setState({ messages: state.messages.map(node => byId.get(node.id) ?? node),
        ...(nextHead?.floor === 0 && previousHead && swipeId(nextHead) !== swipeId(previousHead) && { nativePluginRoute: nextHead.nativePluginOpeningRoutes?.[swipeId(nextHead)] }) });
    for (const plan of plans) {
        replaceScopedVariables(plan.variables, 'message', { messageId: plan.node.id });
        if (plan.node.id === path.at(-1)?.id) {
            if (plan.node.floor > 0 && plan.node.activeSwipeIndex !== path.at(-1)!.activeSwipeIndex) restoreMessageSnapshot(plan.node.id);
            if ('stat_data' in plan.variables && getEffectiveMvuSettings(state).settings['mvu.update_chat'] === true) {
                const projection = mvuChatProjection(plan.variables);
                const chat = getScopedVariables('chat', { chatId: state.activeChatId });
                for (const key of ['display_data', 'delta_data']) if (!(key in projection)) delete chat[key];
                replaceScopedVariables({ ...chat, ...projection }, 'chat', { chatId: state.activeChatId });
            }
            captureMessageSnapshot(plan.node.id);
        }
    }
    await persistWorkspaceNow();
    if (!state.isGenerating) schedulePreview();
    return plans.map(plan => ({ message_id: plan.node.floor, role: plan.node.role }));
}

/** Structural edits fork the changed suffix, retaining inactive branches and their variables. */
async function publishHelperPath(next: ChatMessageNode[], from: number, newVariables = new Map<string, Record<string, unknown>>()): Promise<ChatMessageNode[]> {
    const state = workspaceStore.getState();
    if (nativeStorySaving || state.isGenerating || state.helperGenerationCount) throw new Error('请等待剧情保存或生成结束后更改消息结构');
    if (state.activeLeafId) captureMessageSnapshot(state.activeLeafId);
    const latest = workspaceStore.getState();
    const prefix = next.slice(0, from);
    const appended: ChatMessageNode[] = [];
    const remapped = new Map<string, string>();
    let continuing: string | undefined;
    for (const source of next.slice(from)) {
        const original = source;
        const id = `msg_${crypto.randomUUID()}`;
        const node = { ...structuredClone(original), id, messageId: id, parentId: appended.at(-1)?.id ?? prefix.at(-1)?.id ?? null,
            parentSwipeId: (appended.at(-1) ?? prefix.at(-1)) ? swipeId((appended.at(-1) ?? prefix.at(-1))!) : undefined,
            floor: prefix.length + appended.length, updatedAt: Date.now() };
        node.branchOrigin = original.branchOrigin ?? original.id;
        node.swipeIds ??= original.swipes.map((_, index) => swipeId(original, index));
        continuing ??= continueNativeRoute(latest.messages, prefix, node);
        node.nativeRouteAnchors = { [swipeId(node)]: continuing };
        remapped.set(original.id, id);
        if (newVariables.has(source.id)) {
            node.branchBases = undefined; node.branchStates = undefined;
            node.extra = { ...node.extra, chatVariables: structuredClone(getScopedVariables('chat', { chatId: state.activeChatId })),
                timedStates: structuredClone(state.timedStates), templateState: { injections: structuredClone(state.templateInjections), activations: structuredClone(state.templateActivations) } };
        }
        appended.push(node);
        replaceScopedVariables(structuredClone(newVariables.get(source.id) ?? getScopedVariables('message', { messageId: source.id })), 'message', { messageId: id });
    }
    for (const node of appended) remapBranchSnapshots(node, remapped);
    const active = [...prefix, ...appended];
    batchReactiveUpdates(() => {
        workspaceStore.setState({ messages: [...latest.messages, ...appended], activeLeafId: active.at(-1)?.id ?? null,
            ...(from < getActiveChatMessages(latest).length && { branchEpoch: (latest.branchEpoch ?? 0) + 1 }) });
        const leaf = active.at(-1);
        if (leaf) restoreMessageSnapshot(leaf.id);
        else {
            replaceScopedVariables(initialChatVariables(), 'chat', { chatId: state.activeChatId });
            workspaceStore.setState({ timedStates: {}, chatMetadata: undefined, nativePluginRoute: undefined, templateInjections: [], templateActivations: [] });
        }
        sealBranchPoint();
    });
    await persistWorkspaceNow(); schedulePreview();
    return active;
}

export async function createHelperChatMessages(items: Array<Record<string, any>>, options: { insert_at?: number | 'end'; insert_before?: number | 'end'; refresh?: 'none' | 'affected' | 'all' } = {}): Promise<Array<{ message_id: number; role: ChatMessageNode['role'] }>> {
    if (!Array.isArray(items)) throw new Error('消息创建参数必须是数组');
    validateMessageRefresh(options.refresh);
    const path = getActiveChatMessages();
    const position = options.insert_at ?? options.insert_before ?? 'end';
    if (position !== 'end' && !Number.isInteger(position)) throw new Error('消息插入位置必须为整数或 end');
    const rawIndex = position === 'end' ? path.length : Math.max(-path.length, Math.min(path.length, position));
    const index = rawIndex < 0 ? path.length + rawIndex : rawIndex;
    const variables = new Map<string, Record<string, unknown>>();
    // New messages inherit the preceding message's variables, as ordinary sends
    // do. Opening scripts can then remove their UI floor without losing MVU data.
    let inherited = { ...getScopedVariables('chat', { chatId: workspaceStore.getState().activeChatId }), ...(index > 0 ? getScopedVariables('message', { messageId: path[index - 1].id }) : {}) };
    const created = items.map(item => {
        if (!item || typeof item !== 'object' || !['system', 'user', 'assistant'].includes(item.role) || typeof item.message !== 'string') throw new Error('创建消息必须包含有效的 role 和 message');
        const unknown = Object.keys(item).filter(key => !['role', 'name', 'is_hidden', 'message', 'data', 'extra'].includes(key));
        if (unknown.length) throw new Error(`未知创建消息字段：${unknown.join('、')}`);
        const id = `new_${crypto.randomUUID()}`;
        const base: ChatMessageNode = { id, parentId: null, floor: 0, role: item.role, speakerName: item.role === 'user' ? workspaceStore.getState().userName : item.role === 'system' ? 'system' : getActiveCharacter().name,
            content: '', swipes: [''], activeSwipeIndex: 0, createdAt: Date.now() };
        const plan = patchHelperMessage(base, { ...item, message_id: 0 }, inherited);
        inherited = plan.variables;
        variables.set(id, plan.variables); return plan.node;
    });
    if (!created.length) return [];
    const active = await publishHelperPath([...path.slice(0, index), ...created, ...path.slice(index)], index, variables);
    return active.slice(index, index + created.length).map(node => ({ message_id: node.floor, role: node.role }));
}

export async function deleteHelperChatMessages(ids: number[], options: { refresh?: 'none' | 'affected' | 'all' } = {}): Promise<Array<{ message_id: number; role: ChatMessageNode['role'] }>> {
    if (!Array.isArray(ids) || ids.some(id => !Number.isInteger(id))) throw new Error('删除消息必须提供整数楼层数组');
    validateMessageRefresh(options.refresh);
    const path = getActiveChatMessages();
    const removed = new Set(ids.map(id => id < 0 ? path.length + id : id).filter(id => id >= 0 && id < path.length));
    if (!removed.size) return [];
    const first = Math.min(...removed);
    const active = await publishHelperPath(path.filter((_, index) => !removed.has(index)), first);
    return active.slice(first).map(node => ({ message_id: node.floor, role: node.role }));
}

export async function rotateHelperChatMessages(begin: number, middle: number, end: number, options: { refresh?: 'none' | 'affected' | 'all' } = {}): Promise<Array<{ message_id: number; role: ChatMessageNode['role'] }>> {
    if (![begin, middle, end].every(Number.isInteger)) throw new Error('消息旋转边界必须为整数');
    validateMessageRefresh(options.refresh);
    const path = getActiveChatMessages();
    const normalize = (value: number) => Math.max(0, Math.min(path.length, value < 0 ? path.length + value : value));
    begin = normalize(begin); end = normalize(end); middle = Math.max(begin, Math.min(end, normalize(middle)));
    if (begin >= end || begin === middle || middle === end) return [];
    const active = await publishHelperPath([...path.slice(0, begin), ...path.slice(middle, end), ...path.slice(begin, middle), ...path.slice(end)], begin);
    return active.slice(begin).map(node => ({ message_id: node.floor, role: node.role }));
}

export function editChatMessage(messageId: string, newContent: string): boolean {
    if (nativeStorySaving || workspaceStore.getState().isGenerating) return false;
    const visible = getActiveChatMessages();
    const resolvedId = visible.find(node => node.id === messageId)?.id ?? visible.find(node => String(node.floor) === String(messageId))?.id;
    const source = visible.find(node => node.id === resolvedId);
    if (source?.content === newContent) return true;
    if (source && source.floor > 0) { rememberBranch(); preserveReplyVersion(source); }
    let updated = false;
    workspaceStore.setState((draft) => {
        const target = draft.messages.find((m) => m.id === resolvedId);
        if (!target) return;
        newContent = applyRegexScripts(newContent, orderedRegexScripts(globalRegexes(), getActivePreset().regexScripts, getActiveCharacter().regexScripts), {
            stage: target.role === 'user' ? 'user_input' : 'ai_output', role: target.role, isEdit: true,
            macroContext: { userName: draft.userName, charName: getActiveCharacter().name },
        });
        target.content = newContent;
        const swipe = target.swipes[target.activeSwipeIndex];
        target.swipes[target.activeSwipeIndex] = typeof swipe === 'string' ? newContent : { ...swipe, content: newContent };
        target.updatedAt = Date.now();
        if (target.floor > 0) {
            target.branchBases = undefined; target.branchStates = undefined; draft.activeLeafId = target.id;
        }
        updated = true;
    });
    if (updated) {
        if (source!.floor > 0) { restoreMessageSnapshot(resolvedId!); sealBranchPoint(true); publishBranchChange(); }
        else captureMessageSnapshot(resolvedId!);
        persistWorkspace();
        const node = getActiveChatMessages().find(m => m.id === resolvedId);
        if (node) notifyMessage('message_edited', node);
        schedulePreview();
    }
    return updated;
}

export function deleteChatMessage(messageId: string): void {
    if (nativeStorySaving || workspaceStore.getState().isGenerating) return;
    const deletedFloor = getActiveChatMessages().find(m => m.id === messageId)?.floor;
    workspaceStore.setState(draft => {
        const target = draft.messages.find(node => node.id === messageId);
        if (!target) return;
        for (const child of draft.messages) if (child.parentId === messageId) { child.parentId = target.parentId; child.parentSwipeId = target.parentSwipeId; }
        draft.messages = draft.messages.filter(node => node.id !== messageId);
        if (!draft.deletedMessageIds?.includes(messageId)) (draft.deletedMessageIds ??= []).push(messageId);
        if (draft.activeLeafId === messageId) draft.activeLeafId = target.parentId ?? draft.messages.at(-1)?.id ?? null;
        for (const node of draft.messages) node.floor = activePath(draft.messages, node.id).length - 1;
    });
    const leaf = workspaceStore.getState().activeLeafId;
    if (leaf) restoreMessageSnapshot(leaf);
    else {
        workspaceStore.setState({ chatMetadata: undefined, nativePluginRoute: undefined });
        replaceScopedVariables(initialChatVariables(), 'chat', { chatId: workspaceStore.getState().activeChatId });
    }
    persistWorkspace();
    void tavernEventBus.emit('message_deleted', { messageId });
    void commandCompatibilityRuntime('event', ['message_deleted', deletedFloor]).catch(error => setStatusBanner(String(error)));
    schedulePreview();
}

export function swipeChatMessage(messageId: string, direction: 'prev' | 'next' | 'new_branch'): void {
    if (direction === 'new_branch') { retryStoryFrom(messageId); return; }
    const previous = workspaceStore.getState();
    const source = getActiveChatMessages(previous).find(node => node.id === messageId);
    if (!source || direction === 'prev' && source.activeSwipeIndex === 0 || direction === 'next' && source.activeSwipeIndex === source.swipes.length - 1) return;
    const nextIndex = source.activeSwipeIndex + (direction === 'prev' ? -1 : 1);
    if (source.floor === 0) {
        const selected = source.swipes[nextIndex];
        editHelperChatMessage(source.id, typeof selected === 'string' ? selected : selected.content, { swipe_id: nextIndex });
        return;
    }
    if (branchBusy()) return;
    const routes = storyRoutes(previous.messages).filter(route => route.path.some(node => node.id === messageId && node.activeSwipeIndex === nextIndex));
    if (routes.length > 1) { window.dispatchEvent(new CustomEvent('tipsy-open-branches', { detail: { messageId } })); return; }
    if (routes.length === 1) { selectChatBranch(routes[0].key); return; }
}

export function stopActiveGeneration(): void {
    if (activeAbortController) {
        activeAbortController.abort();
        activeAbortController = null;
    }
}

export async function regenerateLastAssistantMessage(): Promise<string> {
    return sendUserMessageAndGenerate(undefined, 'regenerate');
}

/** Explicit reprocessing starts from the preceding state, so additive commands run once. */
export async function reprocessLastMvuMessage(extraModel = false): Promise<string> {
    const state = workspaceStore.getState();
    if (state.isGenerating || state.helperGenerationCount) throw new Error('请等待当前生成结束后重算变量');
    const path = getActiveChatMessages(state), target = path.at(-1);
    if (!target || target.role !== 'assistant' || !target.parentId) throw new Error('请先选择需要重算的助手回复');
    if (extraModel && getEffectiveMvuSettings(state).settings['mvu.mode'] !== '额外模型解析') throw new Error('请先在 MVU 参数或角色配置中启用额外模型解析');
    const source = path.slice(0, -1).reverse().map(message => getScopedVariables('message', { messageId: message.id })).find(value => value.stat_data);
    if (!source) throw new Error('前序消息尚无可用于重算的 MVU 变量');
    const original = getScopedVariables('message', { messageId: target.id });
    const basis = { ...structuredClone(original) };
    for (const key of ['stat_data', 'display_data', 'delta_data', 'schema']) {
        if (Object.hasOwn(source, key)) basis[key] = structuredClone(source[key]); else delete basis[key];
    }
    const controller = new AbortController(); activeAbortController = controller;
    workspaceStore.setState({ isGenerating: true });
    let saved = false;
    try {
        let content = target.content;
        if (extraModel) {
            const last = findUpdateMarkupBlocks(content, 'update').at(-1);
            if (last) content = content.slice(0, last.start) + content.slice(last.end);
            saveHelperVariables(basis, { type: 'message', message_id: target.floor });
            workspaceStore.setState(draft => {
                const node = draft.messages.find(message => message.id === target.id)!;
                node.content = content;
                const swipe = node.swipes[node.activeSwipeIndex];
                node.swipes[node.activeSwipeIndex] = typeof swipe === 'string' ? content : { ...swipe, content };
            });
            content = await analyzeMvuReply(content, basis, controller.signal, true);
        }
        const before = extraModel ? getScopedVariables('message', { messageId: target.id }) : basis;
        const result = await commandCompatibilityRuntime('settle', [content, before], getWorkspaceScripts().some(script => script.enabled));
        const variables = result.variables ?? await settleMvuWithoutScripts(before, evaluateMacros(content, {
            userName: state.userName, charName: getActiveCharacter(state).name, variables: structuredClone(before) }),
            (command, error) => setStatusBanner(`MVU 命令 ${command.full_match}：${error instanceof Error ? error.message : String(error)}`));
        controller.signal.throwIfAborted();
        const current = getActiveChatMessages().at(-1)!;
        await commitMvuMessage({ session: state.activeChatId, id: target.id, swipe: target.activeSwipeIndex, content: current.content },
            { variables, writes: result.writes });
        workspaceStore.setState(draft => {
            const node = draft.messages.find(message => message.id === target.id)!;
            node.content = result.messageContent ?? content;
            const swipe = node.swipes[node.activeSwipeIndex];
            node.swipes[node.activeSwipeIndex] = typeof swipe === 'string' ? node.content : { ...swipe, content: node.content };
            node.updatedAt = Date.now(); node.extra = { ...node.extra }; delete node.extra.tipsy_generation_incomplete;
        });
        saved = true; captureMessageSnapshot(target.id);
        await persistWorkspaceNow();
        await refreshMessageTemplates(true);
        return extraModel ? '已重新请求额外模型并结算当前回复变量。' : '已从前序变量重新结算当前回复。';
    } finally {
        if (!saved && extraModel) {
            saveHelperVariables(original, { type: 'message', message_id: target.floor });
            workspaceStore.setState(draft => {
                const node = draft.messages.find(message => message.id === target.id)!;
                node.content = target.content; node.swipes[node.activeSwipeIndex] = structuredClone(target.swipes[target.activeSwipeIndex]);
            });
        }
        workspaceStore.setState({ isGenerating: false, mvuExtraAnalysisActive: false });
        activeAbortController = null; persistWorkspace(); schedulePreview();
    }
}

export interface MvuRepairPreview {
    expected: { session: string; id: string; swipe: number; content: string; variables: Record<string, unknown> };
    result: { variables: Record<string, unknown>; writes?: VariableWrite[]; messageContent: string };
    before: unknown; after: unknown;
}
let lastMvuRepairUndo: { session: string; id: string; swipe: number; before: ChatMessageNode; after: ChatMessageNode;
    beforeVariables: ReturnType<typeof scopedVariableStore.getState>; afterVariables: ReturnType<typeof scopedVariableStore.getState> } | undefined;

/** Preview performs the model request and author validation once; applying never reruns them. */
export async function prepareMvuRepair(direction = ''): Promise<MvuRepairPreview | undefined> {
    const state = workspaceStore.getState(), path = getActiveChatMessages(state), target = path.at(-1);
    if (state.isGenerating || state.helperGenerationCount) throw new Error('请等待当前生成结束后校正变量');
    if (!target || target.role !== 'assistant' || !target.parentId) throw new Error('请先选择需要校正的助手回复');
    const before = structuredClone(getScopedVariables('message', { messageId: target.id }));
    if (!before.stat_data) throw new Error('当前回复尚无已结算的 MVU 变量');
    const previous = path.slice(0, -1).reverse().map(message => getScopedVariables('message', { messageId: message.id })).find(value => value.stat_data);
    const expected = { session: state.activeChatId, id: target.id, swipe: target.activeSwipeIndex, content: target.content, variables: before };
    const controller = new AbortController(); activeAbortController = controller;
    workspaceStore.setState({ isGenerating: true });
    try {
        const block = await analyzeMvuReply(target.content, before, controller.signal, true, { task: buildMvuRepairTask(previous?.stat_data, before.stat_data), direction });
        controller.signal.throwIfAborted();
        if (!readMvuCommands(block).commands.length) { setStatusBanner('当前变量无需增量校正。'); return; }
        const content = appendMvuRepair(target.content, block);
        const result = await commandCompatibilityRuntime('settle', [block, before, { strict: true, messageContent: content }], getWorkspaceScripts().some(script => script.enabled));
        const variables = result.variables ?? await settleMvuWithoutScripts(before, evaluateMacros(block, {
            userName: state.userName, charName: getActiveCharacter(state).name, variables: structuredClone(before) }), (_command, error) => { throw error; });
        controller.signal.throwIfAborted();
        if (_.isEqual(variables.stat_data, before.stat_data)) { setStatusBanner('校正未产生变量变化，已保留原回复。'); return; }
        return { expected, result: { variables, writes: result.writes, messageContent: result.messageContent ?? content },
            before: before.stat_data, after: variables.stat_data };
    } finally {
        workspaceStore.setState({ isGenerating: false, mvuExtraAnalysisActive: false });
        activeAbortController = null; schedulePreview();
    }
}
export async function applyMvuRepair(preview: MvuRepairPreview): Promise<string> {
    if (workspaceStore.getState().isGenerating || workspaceStore.getState().helperGenerationCount) throw new Error('请等待当前生成结束后应用校正');
    const before = getActiveChatMessages().find(message => message.id === preview.expected.id);
    if (!before) throw new Error('校正所属消息已不存在');
    const beforeVariables = scopedVariableStore.getState();
    await commitMvuMessage(preview.expected, preview.result);
    captureMessageSnapshot(before.id);
    lastMvuRepairUndo = { session: preview.expected.session, id: before.id, swipe: preview.expected.swipe,
        before, after: getActiveChatMessages().find(message => message.id === before.id)!, beforeVariables, afterVariables: scopedVariableStore.getState() };
    await persistWorkspaceNow(); await refreshMessageTemplates(true);
    return '已应用增量校正，可撤销最近一次校正。';
}
export function canUndoMvuRepair(): boolean {
    const undo = lastMvuRepairUndo, state = workspaceStore.getState(), target = getActiveChatMessages(state).at(-1);
    return !!undo && undo.session === state.activeChatId && target?.id === undo.id && target.activeSwipeIndex === undo.swipe;
}
export async function undoMvuRepair(): Promise<string> {
    const undo = lastMvuRepairUndo;
    if (!undo || !canUndoMvuRepair()) throw new Error('当前消息没有可撤销的增量校正');
    if (workspaceStore.getState().isGenerating || workspaceStore.getState().helperGenerationCount) throw new Error('请等待生成结束后撤销校正');
    await enqueuePersistentOperation(() => commitWorkspaceMutation(() => {
        const target = getActiveChatMessages().at(-1)!;
        if (target.content !== undo.after.content || !_.isEqual(getScopedVariables('message', { messageId: undo.id }), undo.afterVariables.message[undo.id])) throw new Error('校正后正文或变量已修改，不能直接撤销');
        scopedVariableStore.setState(rollbackStateChanges(scopedVariableStore.getState(), undo.beforeVariables, undo.afterVariables));
        workspaceStore.setState(draft => { const index = draft.messages.findIndex(message => message.id === undo.id); draft.messages[index] = undo.before; });
    }));
    lastMvuRepairUndo = undefined; await refreshMessageTemplates(true); schedulePreview();
    return '已撤销最近一次增量校正。';
}
/** Script callers retain a single apply operation; the workspace offers a preview. */
export async function repairLastMvuMessage(direction = ''): Promise<string> {
    const preview = await prepareMvuRepair(direction);
    return preview ? applyMvuRepair(preview) : '当前变量无需增量校正。';
}

class TemplateInputChangedError extends Error {}

/** Shared commit for template-requested writes; return-only Helper generations use the same scope semantics. */
export function commitPromptVariableChanges(assembled: AssembledPromptResult, expected?: AssemblePromptInput): void {
    const state = workspaceStore.getState();
    const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);
    const contentTask = expected?.templateTask?.type === 'render' ? expected.templateTask : undefined;
    if (assembled.templateMessageContent !== undefined && (typeof assembled.templateMessageContent !== 'string' || !contentTask || contentTask.dryRun)) throw new Error('模板原文改写必须来自有效的首次渲染任务');
    const changedContent = assembled.templateMessageContent !== undefined && contentTask;
    if (expected) {
        if (expected.templatePreparationKey && createPromptAssemblyInput([], false).templatePreparationKey !== expected.templatePreparationKey) throw new TemplateInputChangedError('模板执行期间角色、预设、快捷回复或世界书已改变，请重试操作');
        if (!same(normalizeTemplateFeatures(readExtensionVariables(scopedVariableStore.getState().extension, 'EjsTemplate')), normalizeTemplateFeatures(expected.templateFeatures))) throw new TemplateInputChangedError('模板执行期间插件设置已改变，请重试操作');
        if (!same(state.templateInjections, expected.templateInjections ?? [])) throw new TemplateInputChangedError('模板执行期间注入状态已变化，请重试操作');
        if (!same(state.templateActivations, expected.templateActivations ?? [])) throw new TemplateInputChangedError('模板执行期间世界书动态激活状态已变化，请重试操作');
        const path = getActiveChatMessages(state);
        if (state.activeChatId !== expected.chatId || state.activeCharacterId !== expected.character.id || state.activePresetId !== expected.preset.id ||
            path.length !== expected.messages.length || path.some((node, index) => {
                const before = expected.messages[index];
                return node.id !== before.id || node.activeSwipeIndex !== before.activeSwipeIndex || node.content !== before.content
                    || node.role !== before.role || node.speakerName !== before.speakerName || node.isHidden !== before.isHidden;
            })) throw new TemplateInputChangedError('模板执行期间角色、预设、消息或分支已改变，请重试生成');
        if (!same(getActiveLorebooks(state), expected.lorebooks) || expected.lorebookCatalog && !same(getAvailableWorldbooks(state), expected.lorebookCatalog) ||
            expected.characterWorldbooks && !same(getCharacterWorldbooks(getActiveCharacter(state), state), expected.characterWorldbooks) ||
            expected.worldbookGroups && !same(getWorldbookGroups(state), expected.worldbookGroups)) {
            throw new TemplateInputChangedError('模板执行期间世界书内容或绑定已改变，请重试生成');
        }
        for (const [scope, changes, before] of [['chat', assembled.variableChanges, expected.initialLocalVariables], ['global', assembled.globalVariableChanges, expected.initialGlobalVariables]] as const) {
            const current = getScopedVariables(scope, { chatId: state.activeChatId });
            if (Object.keys(changes).some(key => !same(current[key], before?.[key]))) throw new TemplateInputChangedError('模板执行期间变量已被其他操作修改，请重试生成');
        }
        for (const messageId of Object.keys(assembled.messageVariableChanges ?? {})) {
            if (!same(getScopedVariables('message', { messageId }), expected.initialMessageVariables?.[messageId] ?? {})) throw new TemplateInputChangedError('模板执行期间消息变量已被其他操作修改，请重试生成');
        }
        for (const [messageId, swipes] of Object.entries(assembled.messageSwipeVariableChanges ?? {})) {
            const current = path.find(node => node.id === messageId);
            const before = expected.messages.find(node => node.id === messageId);
            if (!current || !before) throw new TemplateInputChangedError('模板变量对应的消息分支已经改变');
            for (const swipe of Object.keys(swipes)) {
                const read = (node: ChatMessageNode) => (node.extra?.swipeVariables as Record<string, unknown> | undefined)?.[swipe] ?? {};
                if (!same(read(current), read(before))) throw new TemplateInputChangedError('模板执行期间 swipe 变量已被其他操作修改，请重试生成');
            }
        }
    }
    for (const [messageId, swipes] of Object.entries(assembled.messageSwipeVariableChanges ?? {})) {
        const node = getActiveChatMessages(state).find(message => message.id === messageId);
        if (!node || Object.keys(swipes).some(swipe => !/^\d+$/.test(swipe) || Number(swipe) >= node.swipes.length)) throw new Error('模板变量对应的消息 swipe 已不存在');
    }
    for (const [messageId, variables] of Object.entries(assembled.messageVariableChanges ?? {})) {
        const node = getActiveChatMessages(state).find(message => message.id === messageId);
        if (!node) throw new Error('模板变量对应的消息分支已经改变');
        validateHelperVariableWrite(variables, { type: 'message', message_id: node.floor });
    }
    const injectionsChanged = assembled.templateInjections !== undefined && !same(state.templateInjections, assembled.templateInjections);
    const activationsChanged = assembled.templateActivations !== undefined && !same(state.templateActivations, assembled.templateActivations);
    if (![assembled.variableChanges, assembled.globalVariableChanges, assembled.messageVariableChanges, assembled.messageSwipeVariableChanges, assembled.messageVariableInitializationChanges].some(changes => changes && Object.keys(changes).length) && !injectionsChanged && !activationsChanged && !changedContent) return;
    if (changedContent) {
        workspaceStore.setState(draft => { draft.messages = draft.messages.map(node => {
            if (node.id !== contentTask.messageId) return node;
            const previous = node.swipes[node.activeSwipeIndex];
            const swipes = [...node.swipes];
            swipes[node.activeSwipeIndex] = typeof previous === 'string' ? assembled.templateMessageContent! : { ...previous, content: assembled.templateMessageContent! };
            return { ...node, content: assembled.templateMessageContent!, swipes, updatedAt: Date.now(),
                extra: { ...node.extra, tipsy_template_source: { ...(node.extra?.tipsy_template_source as object ?? {}), [node.activeSwipeIndex]: node.content } } };
        }); });
    }
    if (injectionsChanged) workspaceStore.setState(draft => { draft.templateInjections = structuredClone(assembled.templateInjections!); });
    if (activationsChanged) workspaceStore.setState(draft => { draft.templateActivations = structuredClone(assembled.templateActivations!); });
    for (const scope of ['chat', 'global'] as const) {
        const changes = scope === 'chat' ? assembled.variableChanges : assembled.globalVariableChanges;
        for (const [key, value] of Object.entries(changes)) {
            if (value === undefined) deleteScopedVariableKey(key, scope, { chatId: state.activeChatId });
            else insertOrAssignScopedVariables({ [key]: value }, scope, { chatId: state.activeChatId });
        }
    }
    for (const [messageId, variables] of Object.entries(assembled.messageVariableChanges ?? {})) {
        const node = state.messages.find(message => message.id === messageId)!;
        saveHelperVariables(variables, { type: 'message', message_id: node.floor });
    }
    for (const [messageId, swipes] of Object.entries(assembled.messageSwipeVariableChanges ?? {})) {
        workspaceStore.setState(draft => {
            const target = draft.messages.find(message => message.id === messageId);
            if (target) target.extra = { ...target.extra, swipeVariables: { ...(target.extra?.swipeVariables as object ?? {}), ...structuredClone(normalizeMvuVariableMap(swipes).variables) } };
        });
    }
    if (assembled.messageVariableInitializationChanges) workspaceStore.setState(draft => {
        for (const node of draft.messages) {
            const swipes = assembled.messageVariableInitializationChanges?.[node.id];
            if (swipes?.length) node.extra = { ...node.extra, tipsy_template_variables_initialized: {
                ...(node.extra?.tipsy_template_variables_initialized as object ?? {}), ...Object.fromEntries(swipes.map(swipe => [swipe, true])),
            } };
        }
    });
    if ((injectionsChanged || activationsChanged) && state.activeLeafId) captureMessageSnapshot(state.activeLeafId);
    persistWorkspace();
}

export async function commitPromptTask(result: AssembledPromptResult, input: AssemblePromptInput, signal?: AbortSignal): Promise<void> {
    return enqueuePersistentOperation(() => commitPromptTaskNow(result, input, signal));
}

async function commitPromptTaskNow(result: AssembledPromptResult, input: AssemblePromptInput, signal?: AbortSignal): Promise<void> {
    let saved = false;
    try {
        signal?.throwIfAborted();
        await claimPromptTemplateTask(result);
        signal?.throwIfAborted();
        await commitWorkspaceMutation(() => { signal?.throwIfAborted(); commitPromptVariableChanges(result, input); });
        saved = true;
        await finishPromptTemplateTask(result, true);
    } catch (error) {
        // Once storage accepted the values, a lost acknowledgement must not roll
        // the author runtime back to before those values. finish is idempotent.
        await finishPromptTemplateTask(result, saved).catch(() => {});
        throw error;
    }
}

/** Roll back only this publication if durable storage rejects it. Immutable store
 * snapshots make later edits distinguishable from the writes being undone. */
async function commitWorkspaceMutation(publish: () => void, localExtras?: Record<string, unknown>, nativeOnly = false): Promise<void> {
    let beforeWorkspace = workspaceStore.getState(); let beforeVariables = scopedVariableStore.getState();
    let afterWorkspace = beforeWorkspace; let afterVariables = beforeVariables;
    let published = false;
    const rollback = () => batchReactiveUpdates(() => {
        if (!published) return;
        const current = workspaceStore.getState(), restored = rollbackStateChanges(current, beforeWorkspace, afterWorkspace);
        if (nativeOnly) preserveAuthorMessageRevision(current.messages, restored.messages);
        workspaceStore.setState(restored);
        scopedVariableStore.setState(rollbackStateChanges(scopedVariableStore.getState(), beforeVariables, afterVariables));
    });
    await persistStateTransaction(() => batchReactiveUpdates(() => {
        beforeWorkspace = workspaceStore.getState(); beforeVariables = scopedVariableStore.getState(); published = true;
        try { publish(); }
        catch (error) {
            afterWorkspace = workspaceStore.getState(); afterVariables = scopedVariableStore.getState();
            rollback(); published = false; throw error;
        }
        afterWorkspace = workspaceStore.getState(); afterVariables = scopedVariableStore.getState();
    }), rollback, undefined, localExtras);
}

export async function sendUserMessageAndGenerate(userText?: string, generationType: 'normal' | 'regenerate' = 'normal'): Promise<string> {
    await waitForReplicaCommit();
    if (!getActiveCharacter().id) throw new Error('请先从馆藏选择一个故事。');
    if (workspaceStore.getState().isGenerating) return '';
    const controller = new AbortController();
    activeAbortController = controller;
    workspaceStore.setState(draft => { draft.isGenerating = true; });
    let assembled: AssembledPromptResult;
    let assemblyInput: AssemblePromptInput;
    let nativeContributions: Awaited<ReturnType<typeof nativeGenerationContributions>> = [];
    let originalLeaf: string | undefined;
    let originalRoute: string | undefined;
    let regeneratedNodes: ChatMessageNode[] | undefined;
    let regeneratedDeletedIds: string[] | undefined;
    let regeneratedPlaceholderId: string | undefined;
    try {
        if (renderingJob) {
            try { await renderingJob; }
            catch (error) { if (!(error instanceof TemplateInputChangedError)) throw error; }
        }
        await ensureTemplatePreload();
        controller.signal.throwIfAborted();
        if (generationType === 'regenerate') {
            const latest = getActiveChatMessages().at(-1);
            if (!latest || latest.role !== 'assistant' || !latest.parentId) throw new Error('当前没有可以重新生成的角色回复');
            originalLeaf = latest.id;
            originalRoute = readNativeStory().route?.routeId;
            captureMessageSnapshot(latest.id);
            const current = workspaceStore.getState();
            const removed = new Set<string>([latest.id]);
            for (let changed = true; changed;) {
                changed = false;
                for (const node of current.messages) if (node.parentId && removed.has(node.parentId) && !removed.has(node.id)) { removed.add(node.id); changed = true; }
            }
            regeneratedNodes = structuredClone(current.messages.filter(node => removed.has(node.id)));
            regeneratedDeletedIds = [...current.deletedMessageIds ?? []];
            workspaceStore.setState(draft => {
                draft.messages = draft.messages.filter(node => !removed.has(node.id));
                draft.deletedMessageIds = [...new Set([...(draft.deletedMessageIds ?? []), ...removed])];
                draft.activeLeafId = latest.parentId;
            });
            restoreMessageSnapshot(latest.parentId);
        }
        const sent = userText?.trim() ? appendChatMessage('user', userText.trim()) : undefined;
        const pendingMessage = sent ?? getActiveChatMessages().at(-1);
        if (pendingMessage) {
            generationNotificationMessage = pendingMessage.id;
            await messageNotifications.get(pendingMessage.id);
            messageNotifications.delete(pendingMessage.id);
        }
        if (sent) {
            await refreshMessageTemplates(true);
            await commandCompatibilityRuntime('event', ['user_message_rendered', sent.floor]);
        }
        generationNotificationMessage = undefined;
        controller.signal.throwIfAborted();
        const required = getWorkspaceScripts().some(s => s.enabled);
        await tavernEventBus.emit('generation_started', { type: generationType, characterId: workspaceStore.getState().activeCharacterId });
        const prepared = await commandCompatibilityRuntime('beforeGeneration', [generationType], required);
        if (prepared.generationAborted) {
            if (originalLeaf) {
                workspaceStore.setState(draft => {
                    if (regeneratedNodes?.length) draft.messages.push(...regeneratedNodes);
                    draft.deletedMessageIds = regeneratedDeletedIds;
                    draft.activeLeafId = originalLeaf!;
                });
                restoreMessageSnapshot(originalLeaf);
            }
            workspaceStore.setState({ isGenerating: false });
            activeAbortController = null;
            persistWorkspace();
            return '';
        }
        assemblyInput = createPromptAssemblyInput(prepared.injections);
        assemblyInput.interceptedHistory = prepared.interceptedHistory;
        assemblyInput.generationType = generationType;
        const legacyContributions = nativeGenerationContributions(generationType, controller.signal).catch(() => []);
        const stages = await prepareNativePrompt(assemblyInput, generationType, controller.signal);
        if (stages) assemblyInput.nativePrompt = stages.plan;
        try {
            [assembled, nativeContributions] = await Promise.all([runPromptPipelineAsync(assemblyInput, controller.signal, false, readNativeAfterScan), legacyContributions]);
        } finally { stages?.close(); }
        await commitPromptTask(assembled, assemblyInput, controller.signal);
        workspaceStore.setState(draft => { draft.lastAssembledPrompt = assembled; });
        if (assembled.compatibilityWarnings?.length) setStatusBanner(assembled.compatibilityWarnings[0], { kind: 'warning' });
        controller.signal.throwIfAborted();
    } catch (error) {
        generationNotificationMessage = undefined;
        if (originalLeaf) {
            workspaceStore.setState(draft => {
                if (regeneratedNodes?.length) draft.messages.push(...structuredClone(regeneratedNodes));
                draft.deletedMessageIds = regeneratedDeletedIds;
                draft.activeLeafId = originalLeaf!;
            });
            restoreMessageSnapshot(originalLeaf);
        }
        const message = error instanceof Error ? error.message : String(error);
        setStatusBanner(controller.signal.aborted ? '已停止生成。' : `生成准备失败：${message}`, { kind: controller.signal.aborted ? 'info' : 'error' });
        try { await commandCompatibilityRuntime('event', ['generation_stopped']); }
        catch (eventError) { console.warn('生成停止事件执行失败', eventError); }
        try { await commandCompatibilityRuntime('event', ['generation_ended', getActiveChatMessages().length - 1]); }
        catch (eventError) { console.warn('生成结束事件执行失败', eventError); }
        await tavernEventBus.emit('generation_stopped', { error: message });
        await tavernEventBus.emit('generation_ended', { stopped: true });
        workspaceStore.setState(draft => { draft.isGenerating = false; });
        activeAbortController = null;
        persistWorkspace();
        throw error;
    }
    const state = workspaceStore.getState();
    const card = getActiveCharacter(state);
    const schemaVals = getSchemaValues();

    const apiSource = String(schemaVals['api.chat_completion_source'] ?? 'openai');
    const baseUrl = String(schemaVals['api.custom_url'] ?? '').trim();
    const apiKey = String(schemaVals['api.key'] ?? '').trim();
    const model = String(schemaVals['api.model'] ?? 'gpt-4o-mini').trim();

    const path = getActiveChatMessages(state);
    const floor = path.length;
    const placeholderId = `msg_${crypto.randomUUID()}`;
    regeneratedPlaceholderId = placeholderId;
    const prevNode = path.at(-1);

    const assistantNode: ChatMessageNode = {
        id: placeholderId,
        branchOrigin: originalLeaf ? state.messages.find(node => node.id === originalLeaf)?.branchOrigin ?? originalLeaf : undefined,
        messageId: placeholderId,
        parentId: prevNode ? (prevNode.id || null) : null,
        parentSwipeId: prevNode ? swipeId(prevNode) : undefined,
        floor,
        role: 'assistant',
        speakerName: card.name,
        content: '',
        swipes: [''],
        activeSwipeIndex: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        tokenCount: 0,
        extra: { tipsy_generation_incomplete: true },
    };
    continueNativeRoute(state.messages, path, assistantNode, originalRoute);
    let completed = false;
    let firstCandidateSettled = false;
    let replyBase: BranchState | undefined;
    let failed = false;
    let resultContent = '';
    const summaryChannel = new StorySummaryChannel();
    let previewSummary = new StorySummaryChannel(summaryChannel.tag);
    try {
    if (prevNode) captureMessageSnapshot(prevNode.id);
    const assistantVariables = { ...getScopedVariables('chat', { chatId: state.activeChatId }), ...(prevNode ? getScopedVariables('message', { messageId: prevNode.id }) : {}) };
    workspaceStore.setState(draft => {
        draft.streamingReasoning = '';
        draft.nativeToolPreview = undefined;
        draft.messages.push(assistantNode);
        draft.activeLeafId = assistantNode.id;
        draft.timedStates = structuredClone(assembled.nextTimedStates);
    });
    saveHelperVariables(assistantVariables, { type: 'message', message_id: floor });
    captureMessageSnapshot(placeholderId);
    replyBase = readBranchState(workspaceStore.getState(), workspaceStore.getState().messages.find(node => node.id === placeholderId)!);

    let streamed: CompletionResult;
    if (!baseUrl) {
        const simulatedChunks = [
            '尚未配置模型连接，本条为本地演示提示。\n\n',
            '请在「参数与连接」中填写 OpenAI Chat Completions 兼容接口地址、API Key 和模型名称，再开始对话。',
        ];

        let built = '';
        for (const chunk of simulatedChunks) {
            await new Promise((r) => setTimeout(r, 90));
            controller.signal.throwIfAborted();
            built += chunk;
            workspaceStore.setState((draft) => {
                const target = draft.messages.find((m) => m.id === placeholderId);
                if (target) {
                    target.content = built;
                    target.swipes[target.activeSwipeIndex] = built;
                }
            });
            await tavernEventBus.emit('generation_stream_token', chunk);
        }

        streamed = { content: built, reasoning: '' };
    } else {
        streamed = await streamStoryWithNativeTools({
            source: apiSource,
            baseUrl,
            apiKey,
            model: assembled.generationSettings?.model ?? model,
            messages: await applyNativeContributions(assembled, assemblyInput, nativeContributions, summaryChannel.messages(assembled.messages), controller.signal),
            parameters: assembled.generationSettings?.parameters ?? presetSamplingParameters(getActivePreset(state), schemaVals),
            stream: assembled.generationSettings?.stream ?? schemaVals['api.stream'] !== false,
            signal: controller.signal,
            onToken: (deltaContent, deltaReasoning) => {
                if (controller.signal.aborted) return;
                deltaContent = summaryChannel.push(deltaContent);
                workspaceStore.setState((draft) => {
                    draft.nativeToolPreview = undefined;
                    if (deltaReasoning) {
                        draft.streamingReasoning += deltaReasoning;
                    }
                    const target = draft.messages.find((m) => m.id === placeholderId);
                    if (target && deltaContent) {
                        target.content += deltaContent;
                        target.swipes[target.activeSwipeIndex] = target.content;
                    }
                });
                void tavernEventBus.emit('generation_stream_token', deltaContent);
                const current = workspaceStore.getState();
                publishNativeGenerationProgress(placeholderId, floor, current.messages.find(message => message.id === placeholderId)?.content ?? '', current.streamingReasoning);
            },
        }, delta => {
            if (!delta) {
                previewSummary = new StorySummaryChannel(summaryChannel.tag);
                workspaceStore.setState({ nativeToolPreview: undefined });
                return;
            }
            if (controller.signal.aborted) return;
            const content = previewSummary.push(delta.content);
            if (!content && !delta.reasoning) return;
            workspaceStore.setState(draft => {
                const preview = draft.nativeToolPreview ??= { id: placeholderId, content: '', reasoning: '' };
                preview.content += content;
                preview.reasoning += delta.reasoning;
            });
        });
    }
        controller.signal.throwIfAborted();

        const summaries = (streamed.candidates ?? [streamed]).map(candidate => summaryChannel.split(candidate.content));
        streamed = { ...streamed, content: summaries[0].content, candidates: (streamed.candidates ?? [streamed]).map((candidate, index) => ({ ...candidate, content: summaries[index].content })) };
        publishNativeGenerationProgress(placeholderId, floor, streamed.content, streamed.reasoning, true);
        if (streamed.reasoning) await commandCompatibilityRuntime('event', ['stream_reasoning_done', streamed.reasoning, null, floor, 'done']);
        const candidates = streamed.candidates ?? [streamed];
        const candidateBase = readBranchState(workspaceStore.getState(), workspaceStore.getState().messages.find(node => node.id === placeholderId)!);
        const candidateVariables = structuredClone(getScopedVariables('message', { messageId: placeholderId }));
        const candidateTemplateState = { injections: workspaceStore.getState().templateInjections, activations: workspaceStore.getState().templateActivations };
        workspaceStore.setState(draft => {
            const target = draft.messages.find(message => message.id === placeholderId)!;
            target.swipes = candidates.map(candidate => ({ content: candidate.content, reasoning: candidate.reasoning,
                extra: { reasoning_signature: candidate.reasoning_signature, tool_calls: candidate.tool_calls } }));
        });
        let firstContent = streamed.content;
        try {
            for (const [index, candidate] of candidates.entries()) {
                controller.signal.throwIfAborted();
                if (index > 0) applyBranchState(candidateBase);
                workspaceStore.setState(draft => {
                    const target = draft.messages.find(message => message.id === placeholderId)!;
                    target.activeSwipeIndex = index; target.content = candidate.content; target.reasoning = candidate.reasoning;
                    draft.timedStates = structuredClone(assembled.nextTimedStates);
                    draft.templateInjections = structuredClone(candidateTemplateState.injections);
                    draft.templateActivations = structuredClone(candidateTemplateState.activations);
                });
                if (index > 0) saveHelperVariables(structuredClone(candidateVariables), { type: 'message', message_id: floor });
                // Each candidate starts at the same pre-reply state; additive MVU commands cannot leak between swipes.
                let before = getScopedVariables('message', { messageId: placeholderId });
                const analyzed = await analyzeMvuReply(candidate.content, before, controller.signal, false, undefined, placeholderId);
                before = getScopedVariables('message', { messageId: placeholderId });
                const settled = await commandCompatibilityRuntime('settle', [analyzed, before], getWorkspaceScripts().some(script => script.enabled));
                if (!settled.variables) settled.variables = await settleMvuWithoutScripts(before,
                    evaluateMacros(analyzed, { userName: state.userName, charName: card.name, variables: structuredClone(before) }),
                    (command, error) => setStatusBanner(`MVU 命令 ${command.full_match}：${error instanceof Error ? error.message : String(error)}`));
                controller.signal.throwIfAborted();
                const regexes = orderedRegexScripts(globalRegexes(), getActivePreset(state).regexScripts, card.regexScripts);
                const output = applyRegexScripts(settled.messageContent ?? analyzed, regexes, {
                    stage: 'ai_output', role: 'assistant', macroContext: { userName: state.userName, charName: card.name } });
                const reasoning = applyRegexScripts(candidate.reasoning, regexes, {
                    stage: 'reasoning', role: 'assistant', macroContext: { userName: state.userName, charName: card.name } });
                const content = await executePluginHooks('afterMessageReceive', output);
                if (typeof content !== 'string') throw new Error('消息处理插件必须返回字符串');
                controller.signal.throwIfAborted();
                const writes = [...(settled.writes ?? []), { variables: settled.variables, option: { type: 'message', message_id: floor } }];
                for (const write of writes) validateHelperVariableWrite(write.variables, write.option);
                for (const write of writes) saveHelperVariables(write.variables, write.option);
                workspaceStore.setState(draft => {
                    const target = draft.messages.find(message => message.id === placeholderId)!;
                    target.content = content; target.reasoning = reasoning;
                    target.swipes[index] = { content, reasoning, extra: { reasoning_signature: candidate.reasoning_signature, tool_calls: candidate.tool_calls } };
                    const summary = summaries[index];
                    if (summary.summary && summary.source) (target.storySummaries ??= {})[swipeId(target, index)] = {
                        text: summary.summary, source: summary.source, contentHash: summaryContentHash(content),
                    };
                    target.updatedAt = Date.now();
                });
                captureMessageSnapshot(placeholderId);
                sealBranchPoint(true);
                if (index === 0) { firstContent = content; firstCandidateSettled = true; }
            }
        } finally {
            workspaceStore.setState(draft => {
                const target = draft.messages.find(message => message.id === placeholderId)!;
                target.activeSwipeIndex = 0;
                const first = target.swipes[0];
                target.content = typeof first === 'string' ? first : first.content;
                target.reasoning = typeof first === 'string' ? '' : first.reasoning ?? '';
            });
            restoreMessageSnapshot(placeholderId);
        }
        workspaceStore.setState(draft => {
            const target = draft.messages.find(message => message.id === placeholderId)!;
            target.extra = { ...target.extra }; delete target.extra.tipsy_generation_incomplete;
        });
        completed = true;
        resultContent = firstContent;
        generationNotificationMessage = placeholderId;
        await commandCompatibilityRuntime('settledMessageReceived', [floor]);
        await tavernEventBus.emit('message_received', workspaceStore.getState().messages.find(message => message.id === placeholderId));
        await refreshMessageTemplates(true);
        await commandCompatibilityRuntime('event', ['character_message_rendered', floor]);
        resultContent = workspaceStore.getState().messages.find(message => message.id === placeholderId)?.content ?? firstContent;
    } catch (err) {
        failed = true;
        const msg = err instanceof Error ? err.message : String(err);
        workspaceStore.setState((draft) => {
            draft.nativeToolPreview = undefined;
            const target = draft.messages.find((m) => m.id === placeholderId);
            if (target && !target.reasoning) target.reasoning = draft.streamingReasoning;
            if (target && !completed) {
                target.extra = { ...target.extra, tipsy_generation_terminal: { swipe: target.activeSwipeIndex,
                    phase: controller.signal.aborted ? 'stopped' : 'error', detail: controller.signal.aborted ? '' : msg } };
                target.updatedAt = Date.now();
            }
        });
        setStatusBanner(controller.signal.aborted ? '已停止生成，已保留收到的回复。' : completed ? `回复已保存，作者事件执行失败：${msg}` : `生成或变量结算失败：${msg}`, { kind: controller.signal.aborted ? 'info' : 'error' });
    } finally {
        if (regeneratedNodes?.length && !completed && regeneratedPlaceholderId) {
            const removedGenerated = new Set<string>();
            const currentMessages = workspaceStore.getState().messages;
            for (const node of currentMessages) if (node.id === regeneratedPlaceholderId) removedGenerated.add(node.id);
            for (let changed = true; changed;) {
                changed = false;
                for (const node of currentMessages) if (node.parentId && removedGenerated.has(node.parentId) && !removedGenerated.has(node.id)) { removedGenerated.add(node.id); changed = true; }
            }
            workspaceStore.setState(draft => {
                draft.messages = draft.messages.filter(node => !removedGenerated.has(node.id));
                draft.messages.push(...structuredClone(regeneratedNodes));
                draft.deletedMessageIds = regeneratedDeletedIds;
                draft.activeLeafId = originalLeaf!;
            });
            restoreMessageSnapshot(originalLeaf!);
        }
        generationNotificationMessage = placeholderId;
        if (failed || controller.signal.aborted) {
            try { await commandCompatibilityRuntime('event', ['generation_stopped', floor]); }
            catch (eventError) { console.warn('生成停止事件执行失败', eventError); }
            await tavernEventBus.emit('generation_stopped', { messageId: placeholderId });
        }
        try { await commandCompatibilityRuntime('event', ['generation_ended', floor]); }
        catch (eventError) { setStatusBanner(`生成结束事件执行失败：${String(eventError)}`); }
        if (completed) resultContent = workspaceStore.getState().messages.find(message => message.id === placeholderId)?.content ?? resultContent;
        await tavernEventBus.emit('generation_ended', { messageId: placeholderId, content: resultContent, stopped: failed || controller.signal.aborted });
        if (!completed && !firstCandidateSettled && !(regeneratedNodes?.length && regeneratedPlaceholderId)) {
            if (replyBase) applyBranchState(replyBase);
            workspaceStore.setState(draft => { draft.timedStates = structuredClone(state.timedStates); });
        }
        captureMessageSnapshot(placeholderId);
        if (completed) sealBranchPoint(true);
        generationNotificationMessage = undefined;
        const readyStory = readNativeStory(), readyReply = readyStory.path.at(-1);
        const reply = completed && readyReply?.id === placeholderId && settled(readyReply) ? messageRef(readyReply) : undefined;
        workspaceStore.setState(draft => {
            draft.isGenerating = false; draft.mvuExtraAnalysisActive = false;
            if (reply && readyStory.ref) draft.nativeStoryReply = { id: crypto.randomUUID(), at: Date.now(), origin: 'local',
                kind: 'story.replySaved', chatId: readyStory.ref.chatId, route: readyStory.route ?? undefined, reply, generation: generationType };
        });
        activeAbortController = null;
        if (completed) {
            const view = readNativeStory();
            if (reply) {
                void persistWorkspaceNow().then(() => notifyNativeReplySaved(view, reply, generationType))
                    .catch(error => setStatusBanner(`保存失败：${error instanceof Error ? error.message : String(error)}`));
            } else persistWorkspace();
        } else persistWorkspace();
    }
    schedulePreview();
    return resultContent;
}

const assetNameKey = (name: string) => name.trim().normalize('NFC').toLocaleLowerCase();
function assertNewAsset(kind: string, asset: { id: string; name: string }, existing: Array<{ id: string; name: string }>): void {
    if (existing.some(item => assetNameKey(item.name) === assetNameKey(asset.name)))
        throw new Error(`已有同名${kind}「${asset.name}」，本次未导入。请先删除旧内容，再导入新版。`);
    if (existing.some(item => item.id === asset.id)) throw new Error(`这份${kind}的标识已存在，本次未导入。`);
}
function addImportedCharacter(card: NormalizedCharacterCard): void {
    const state = workspaceStore.getState();
    assertNewAsset('角色卡', card, state.characters);
    const books = [...new Map([card.characterBook, card.embeddedLorebook].filter((book): book is NormalizedLorebook => !!book).map(book => [book.id, book])).values()];
    const catalog = [...getAvailableWorldbooks(state)];
    for (const book of books) { assertNewAsset('世界书', book, catalog); catalog.push(book); }
    workspaceStore.setState(draft => { draft.characters.push(card); draft.lorebooks.push(...books); });
}

export async function importAssetFile(file: File): Promise<string> {
    if (workspaceStore.getState().isGenerating || workspaceStore.getState().helperGenerationCount) throw new Error('请等待生成结束后导入角色卡或预设');
    const fileName = file.name.toLowerCase();
    
    // 1. 处理 PNG 角色卡
    if (fileName.endsWith('.png')) {
        const card = await importCharacterFile(file);

        addImportedCharacter(card);

        await persistWorkspaceNow();
        const book = card.characterBook ?? card.embeddedLorebook;
        return `已导入故事「${card.name}」：世界书 ${book?.entries.length ?? 0} 条，正则 ${card.regexScripts.length} 条。选择故事即可进入，附带世界书自动启用。`;
    }

    // 2. 处理 JSON 文件（区分预设与角色卡）
    const text = await file.text();
    const raw = JSON.parse(text) as Record<string, unknown>;

    if (typeof raw.name === 'string' && Array.isArray(raw.qrList)) {
        const settings = structuredClone(readExtensionVariables(scopedVariableStore.getState().extension, 'quickReplyV2'));
        const set = { ...raw, name: raw.name, qrList: raw.qrList.map((reply: any, index: number) => ({ ...reply,
            id: Number.isInteger(reply.id) ? reply.id : index + 1, label: String(reply.label ?? ''), message: String(reply.message ?? '') })) } as QuickReplySetData;
        settings.sets = [...quickReplySets(settings).filter(item => item.name !== set.name), set];
        settings.config ??= { setList: [] }; settings.config.setList ??= [];
        if (!settings.config.setList.some((link: any) => (typeof link.set === 'string' ? link.set : link.set?.name) === set.name)) settings.config.setList.push({ set: set.name, isVisible: true });
        settings.isEnabled = true;
        replaceExtensionVariables('quickReplyV2', settings); await persistWorkspaceNow();
        return `已导入快捷回复集合「${set.name}」（${set.qrList.length} 条），已启用全局绑定`;
    }

    // 预设判断逻辑：带 prompts 或 prompt_order
    if (Array.isArray(raw.prompts) || Array.isArray(raw.prompt_order)) {
        // 兼容复杂结构：NormalizePreset 本身已处理采样参数解析，这里避免重复判断导致的解析报错
        const preset: NormalizedPreset = {
            ...normalizePreset(raw, String(raw.name || file.name.replace(/\.json$/i, ''))),
            id: `preset_${crypto.randomUUID()}`,
        };
        
        assertNewAsset('预设', preset, workspaceStore.getState().presets);
        workspaceStore.setState((draft) => {
            draft.presets.push(preset);
        });
        await persistWorkspaceNow();
        return `已导入预设「${preset.name}」，可在「叙事预设」中选择使用。当前对话继续使用原预设。`;
    }

    if (raw.entries && !raw.data && !raw.first_mes) {
        const book = normalizeLorebook(raw, String(raw.name ?? file.name.replace(/\.json$/i, '')));
        assertNewAsset('世界书', book, getAvailableWorldbooks());
        workspaceStore.setState(draft => { draft.lorebooks.push(book); draft.activeLorebookIds.push(book.id); });
        persistWorkspace(); schedulePreview();
        return `已导入世界书「${book.name}」`;
    }

    // 3. 处理纯 JSON 角色卡
    const card = await importCharacterFile(file, false);
    addImportedCharacter(card);
    await persistWorkspaceNow();
    return `已导入故事「${card.name}」，选择故事即可进入，附带世界书自动启用。`;
}

const streamProjectors = new Map<string, { sources: unknown[]; projector: StreamProjector; node?: ChatMessageNode; content?: string; pending?: boolean; thinking?: boolean; value?: MessageStreamPreview }>();
const componentTargetsCache = new Map<string, { sources: unknown[]; targets: Array<{ key: string; selector: string }> }>();
export function getMessageComponentTargets(node: ChatMessageNode) {
    const state = workspaceStore.getState(), card = getActiveCharacter(state), preset = getActivePreset(state);
    const key = `${card.id}:${preset.id}:${node.role}`;
    const sources = [card, preset, globalRegexes()];
    const cached = componentTargetsCache.get(key);
    if (cached && sources.every((value, i) => cached.sources[i] === value)) return cached.targets;
    // Measurement targets do not control rendering; keep them stable as new floors arrive.
    const rules = orderedRegexScripts(globalRegexes(), preset.regexScripts, card.regexScripts).filter(rule => regexRuleApplies(rule, { stage: 'render', role: node.role, ignoreDepth: true }));
    const plan = createStreamPlan(rules, `${card.id}:${preset.id}`, state.userName, card.name, 'auto');
    const targets = [...plan.tags.values()].flatMap(info => info.selector ? [{ key: info.key, selector: info.selector }] : []);
    if (componentTargetsCache.size > 32) componentTargetsCache.delete(componentTargetsCache.keys().next().value!);
    componentTargetsCache.set(key, { sources, targets }); return targets;
}
export function setStreamDisplayMode(mode: StreamDisplayMode): void {
    workspaceStore.setState(draft => { draft.streamDisplayModes[draft.activeCharacterId] = mode; draft.templateRenderRevision++; });
    streamProjectors.clear(); persistWorkspace();
}
export function getMessageStreamPreview(node: ChatMessageNode) {
    const pending = !node.extra?.tipsy_generation_incomplete && isMessageTemplatePending(node);
    if (!node.extra?.tipsy_generation_incomplete && !pending) { streamProjectors.delete(node.id); return undefined; }
    const state = workspaceStore.getState();
    const card = getActiveCharacter(state), preset = getActivePreset(state);
    const depth = Math.max(0, getActiveChatMessages(state).length - 1 - node.floor);
    const mode = state.streamDisplayModes[card.id] ?? 'auto';
    const extension = scopedVariableStore.getState().extension;
    const books = getActiveLorebooks(state);
    const sources = [card, preset, globalRegexes(), extension.EjsTemplate, books, state.userName, depth, mode, state.activeChatId, node.role];
    let cache = streamProjectors.get(node.id);
    if (!cache || sources.some((value, i) => cache!.sources[i] !== value)) {
        const rules = orderedRegexScripts(globalRegexes(), preset.regexScripts, card.regexScripts).filter(rule => regexRuleApplies(rule, { stage: 'render', role: node.role, depth }));
        const features = normalizeTemplateFeatures(readExtensionVariables(extension, 'EjsTemplate'));
        const templateDocument = features.enabled && features.render_enabled && (features.depth_limit < 0 || depth <= features.depth_limit)
            && books.some(book => book.entries.some(entry => templateEntryEnabled(entry, features)
                && /\[RENDER:|@@render_(?:before|after)/.test(entry.comment + '\n' + entry.content)
                && /<!doctype\s+html\b|<html\b|<body\b/i.test(entry.content)));
        const plan = createStreamPlan(rules, `${card.id}:${preset.id}`, state.userName, card.name, mode, templateDocument, { role: node.role, depth });
        cache = { sources, projector: new StreamProjector(plan) };
        if (streamProjectors.size > 12) streamProjectors.delete(streamProjectors.keys().next().value!);
        streamProjectors.set(node.id, cache);
    }
    const temporary = state.nativeToolPreview?.id === node.id ? state.nativeToolPreview : undefined;
    const content = temporary?.content ?? node.content;
    const thinking = !content && !!(temporary?.reasoning ?? state.streamingReasoning);
    const terminal = node.extra?.tipsy_generation_terminal as { swipe: number; phase: 'error' | 'stopped'; detail: string } | undefined;
    const ended = terminal?.swipe === node.activeSwipeIndex ? terminal : node.extra?.tipsy_generation_incomplete && !state.isGenerating && !state.helperGenerationCount
        ? { phase: 'stopped' as const, detail: '', swipe: node.activeSwipeIndex } : undefined;
    const sameTerminal = ended ? cache.value?.phase === ended.phase : cache.value?.phase !== 'error' && cache.value?.phase !== 'stopped';
    if (cache.node === node && cache.content === content && cache.pending === pending && cache.thinking === thinking && sameTerminal) return cache.value;
    cache.node = node; cache.content = content; cache.pending = pending; cache.thinking = thinking;
    const preview = cache.projector.update(content, pending, thinking);
    if (!ended) return cache.value = preview;
    return cache.value = { ...preview, phase: ended.phase, errorDetail: ended.detail,
        status: ended.phase === 'error' ? '这次回复没能完成' : '回复已停止', document: false,
        parts: preview.document ? (node.content ? [{ id: 'interrupted-content', type: 'reasoning', content: node.content, complete: true, label: '已收到的内容（未完成）' }] : []) : preview.parts };
}
export function formatMessageForDisplay(node: ChatMessageNode): string {
    const streaming = getMessageStreamPreview(node);
    if (streaming) return streaming.source;
    const rendered = messageTemplateCache.get(node.id);
    if (rendered && rendered.content === node.content && rendered.swipe === node.activeSwipeIndex) return rendered.formatted;
    return formatMessageWithoutTemplate(node);
}
export function isMessageTemplatePending(node: ChatMessageNode): boolean {
    if (node.extra?.tipsy_generation_incomplete) return false;
    const cached = messageTemplateCache.get(node.id);
    if (cached && cached.content === node.content && cached.swipe === node.activeSwipeIndex) return false;
    const features = normalizeTemplateFeatures(readExtensionVariables(scopedVariableStore.getState().extension, 'EjsTemplate'));
    if (!features.enabled || !features.render_enabled || features.depth_limit >= 0 && getActiveChatMessages().length - 1 - node.floor > features.depth_limit) return false;
    return getActiveChatMessages().some(message => message.content.includes('<%')) || getActiveLorebooks().some(book => book.entries.some(entry =>
        templateEntryEnabled(entry, features) && /\[RENDER:|@@render_(?:before|after)/.test(entry.comment + '\n' + entry.content)));
}

function formatMessageWithoutTemplate(node: ChatMessageNode): string {
    const state = workspaceStore.getState();
    const card = getActiveCharacter(state);
    const preset = getActivePreset(state);
    const macroContext = {
        userName: state.userName,
        charName: card.name,
        variables: resolveMergedVariables({ presetId: preset.id, characterId: card.id, chatId: state.activeChatId, messageId: node.id, floor: node.floor }),
        globalVariables: getScopedVariables('global'),
        variableScopes: {
            global: getScopedVariables('global'), chat: getScopedVariables('chat', { chatId: state.activeChatId }), message: getScopedVariables('message', { messageId: node.id }),
            character: getScopedVariables('character', { characterId: card.id }), preset: getScopedVariables('preset', { presetId: preset.id }),
        },
        variableContext: {
            presetId: preset.id,
            characterId: card.id,
            chatId: state.activeChatId,
            messageId: node.id,
            floor: node.floor,
        },
    };
    const macroExpanded = node.content.split(/(<%[\s\S]*?%>)/g).map(part => part.startsWith('<%') ? part : evaluateMacros(part, macroContext)).join('');
    const depth = Math.max(0, getActiveChatMessages(state).length - 1 - node.floor);
    return applyRegexScripts(macroExpanded, orderedRegexScripts(globalRegexes(), preset.regexScripts, card.regexScripts), {
        stage: 'render', role: node.role, depth, macroContext,
    });
}

export { embedCharacterCardIntoPng };



/**
 * 将当前激活角色卡（含内嵌世界书与正则脚本）编码进标准 PNG (tEXt chara + ccv3) 并触发下载
 */
export async function exportActiveCharacterAsPng(): Promise<string> {
    return exportCharacterAsPng(workspaceStore.getState().activeCharacterId);
}
export async function exportCharacterAsPng(characterId: string): Promise<string> {
    const card = workspaceStore.getState().characters.find(item => item.id === characterId);
    if (!card) throw new Error('找不到要导出的角色卡');

    // 最小合法 1x1 琥珀色 PNG 底图字节流
    const minimalPngBase64 =
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGN4uazyPwAHjAMIqJsA+gAAAABJRU5ErkJggg==';
    const binary = atob(minimalPngBase64);
    let basePng: Uint8Array = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        basePng[i] = binary.charCodeAt(i);
    }

    if (card.avatar.startsWith('data:image/png')) {
        const response = await fetch(card.avatar);
        basePng = new Uint8Array(await response.arrayBuffer());
    }
    const encodedPng = embedCharacterCardIntoPng(basePng, serializeCharacterCard(card));

    const saved = await saveExport(new Blob([new Uint8Array(encodedPng).buffer], { type: 'image/png' }), `${card.name || 'character'}_ccv3.png`);
    if (!saved) return '已取消导出';

    return `已导出角色卡「${card.name}」为标准 V2/V3 PNG 文件`;
}

/**
 * 统计当前会话树中的总分支数（含各楼层平行 swipe 与 parentId 分叉）
 */
export function getChatBranchStats(messages = workspaceStore.getState().messages): {
    totalBranches: number;
    forkFloors: number[];
} {
    let extraBranches = 0;
    const forkFloors: number[] = [];
    for (const m of messages) {
        if (m.swipes && m.swipes.length > 1) {
            extraBranches += m.swipes.length - 1;
            forkFloors.push(m.floor);
        }
    }
    return {
        totalBranches: 1 + extraBranches,
        forkFloors,
    };
}


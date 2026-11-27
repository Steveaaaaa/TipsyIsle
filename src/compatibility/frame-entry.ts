import { preloadsMessageHtml } from './render-settings';
import { storySpeakerName } from '../core/story-identity';
import { formatApproxTokens, formatReplyDuration, readMessageMetrics } from '../pipeline/message-metrics';
import { appendRuntimeDiagnostic } from './runtime-diagnostics';
import { loadGallery, installGallery, galleryMarkup } from './gallery-runtime';
import { StreamingView, mountAuthorLoading } from '../shell/streaming-view';
import { preserveReadingAnchor, observeComponentSizes, rememberComponentSize } from '../shell/stream-layout';
import { resolveReplyJumpMode, type ReplyJumpMode } from '../shell/reading-navigation';
import type { SessionResources } from './session-resources';
import './reading-host.css';
import { applyReadingPresentation, type ReadingPresentation } from '../theme/reading-presentation';
import _ from 'lodash';
import $ from 'jquery';
import * as z from 'zod';
import * as YAML from 'yaml';
import showdown from 'showdown';
import DOMPurify from 'dompurify';
import { jQueryFactory } from 'jquery/factory';
import { applyMvuCommands, mvuPathParts, readMvuCommands, setMvuVariable } from '../pipeline/mvu-commands';
import { normalizeMvuVariables, reconcileMvuVariables } from '../pipeline/mvu-data';
import { mvuJsonValue } from '../pipeline/mvu-values';
import { loadMvuInitialVariables, readMvuGreetingVariables } from '../pipeline/initial-variables';
import { applyMvuSchemaCommands, parseMvuVariables, resolveMvuSchema, type MvuSchemaProvider } from './mvu-schema';
import { evaluateMacros, extractHtmlSandboxBlocks } from '../pipeline/macro-regex-engine';
import type { AssemblePromptInput } from '../pipeline/prompt-assembler';
import type { AssembledPromptResult } from '../types';
import { placeholderPromptDefaultOrder, type CardScript, type CompatSnapshot, type CompatSnapshotDelta, type RuntimeDiagnostic, type VariableWrite, type HelperVariableOption, type HelperGenerationConfig, type InterceptedHistoryMessage } from './contracts';
import { normalizePromptInjection, resolvePromptInjections } from './prompt-injections';
import { readExtensionVariables, writeExtensionVariables } from './extension-variables';
import { tavernEvents as events, mvuEvents, canonicalEvent } from './event-contracts';
import { hostHiddenKey, hostMessageHidden, messageExtra, messageTopLevel } from './chat-message-codec';
import { routeMessageDataKey, routeMessageKey, routeMessages } from '../store/route-message-data';
import { defaultTemplateFeatures, normalizeTemplateFeatures } from '../pipeline/template-features';
import { ResidentTemplateHost } from './template-host';
import { exposeScriptSurface, preserveScriptFrameMoves } from './script-surface';
import type { TemplateRuntime } from '../pipeline/template-runtime';
import { compileAuthorTemplate, templateSyntaxError } from '../pipeline/template-compiler';
import { parseTemplateJSON, patchTemplateJSON } from '../pipeline/template-json';
import { toTavernRegex, regexSources } from './regex-codec';
import { serializeRegexRule } from '../pipeline/asset-serializer';
import { applyRegexScripts, orderedRegexScripts } from '../pipeline/macro-regex-engine';
import vueBrowserRuntimeUrl from 'vue/dist/vue.global.prod.js?url';
import { defaultHelperPreset, systemPromptIds, placeholderPromptIds } from './preset-codec';
import { normalizeScriptTrees, scriptsFromTrees, type ScriptScope } from './script-trees';
import { isRemoteSPresetInjectorScript } from './spreset-config';
import { runSPresetFinalRequestInRealm } from './spreset-runtime';
import { estimateTokenCount } from '../pipeline/token-counter';
import type { CompatibilityLoadReport } from './contracts';
import { formatTemplateMarkdown } from '../pipeline/template-formatting';
import { renderMessageMarkdown, renderMixedMessage } from '../pipeline/message-markdown';
import { createFilmSurface, type CompatFilmSlot } from './film-surface';
import { blockContentKey, computeKeptBlockIndices } from './block-reconcile';
import { normalizeRegexScripts } from '../pipeline/normalizer';
import { createAudioRuntime } from './audio-runtime';
import { executeSlashPipeline, type SlashExecutionOptions } from '../sandbox/slash-core';
import { findExecutableQuickReply } from '../sandbox/quick-reply';
import { slashRegistration, disposeSlashCommands, executeRegisteredSlashCommand, hasRegisteredSlashCommand } from './slash-registry';
import { registerMacroLike, unregisterMacroLike, applyMacroLikes, applyHostMacros, disposeMacroLikes, registerHostMacro, unregisterHostMacro } from './macro-registry';
import { createQuickReplyRuntime } from './quick-reply-runtime';
import { getImageTokenCost, getVideoTokenCost } from './media-tokens';
import { installHostSlashCommands } from './host-slash-commands';
import { SlashCommandClosureResult } from '../sandbox/slash-control';
import { createExtensionApi, findCompatibilityExtension, type CompatibilityExtension } from './extensions';
import { adaptAuthorHtml, adaptAuthorWindow, explainAuthorScriptFailure, needsAuthorWindowAdapt, unwrapAuthorScript } from './author-window';
import { adaptAvsProxyPanel, bindAvsProxyPanel } from './avs-proxy-panel';
import { authorBrowserRuntime } from './author-browser-runtime';
import { authorDocument } from './author-document';
import { observeFrameHeight, setFrameHeight } from './frame-sizing';
import { installHostFetch, tavernCompletionResponse } from './host-fetch';
import { isBlockingExtensionOverlay } from './extension-overlay';
import { collectExtensionActionTargets } from './extension-menu';
import {
    helperGenerationCommandType,
    shouldCollectGlobalInjections,
    shouldEmitGlobalGenerationStopped,
    shouldEmitMainGenerationAfterCommands,
    shouldRemoveOnceInjectionsOnIframeGenerationEnded,
} from './helper-generation-policy';
import { createWorldInfoCache, createWorldInfoEntry, deleteWIOriginalDataValue, originalWIDataKeyMap, setWIOriginalDataValue } from './world-info-helpers';
import { installBaibaiFrameStorage } from './baibai-frame-storage';
import { baibaiBody, baibaiHash } from './baibai-route';
import { createChatCompletionService } from './chat-completion-service';
import type { TemplateAssets } from './template-transport';
import { observeReadingActivity } from '../shell/reading-navigation';
import { swipeId } from '../store/chat-tree';
import { captureReadingBookmark, isReadingBookmark, readingBookmarkAdjustment, readingSwipeId, trackReadingBookmark, type ReadingBookmark } from '../shell/reading-bookmark';
import { disposePopups, focusPopup, onPopupVisibility, popupApi } from './popup-runtime';

let transportedTemplateAssets: Partial<TemplateAssets> = {};

// This entry runs on the separate compatibility origin. Only public model metadata crosses it, never stored credentials.
const outer = window.parent;
const crossOriginAncestors = new Set<unknown>();
for (const candidate of [outer, window.top]) {
    if (!candidate || candidate === window) continue;
    try { void candidate.location.href; } catch { crossOriginAncestors.add(candidate); }
}
const clampAuthorWindow = (value: unknown) => crossOriginAncestors.has(value) ? window : value;
const documentId = crypto.randomUUID();
const retainedResources: Partial<SessionResources> = {};
const root = document.getElementById('compat-root')!;
root.id = 'chat';
const globals = window as any;
const hostPopupApi = popupApi();
const extensionMenu = document.createElement('div');
extensionMenu.id = 'extensionsMenu'; extensionMenu.hidden = true;
document.body.append(extensionMenu);
const extensionMenuButton = document.createElement('div');
extensionMenuButton.id = 'extensionsMenuButton'; extensionMenuButton.hidden = true;
document.body.append(extensionMenuButton);
const extensionTopBar = document.createElement('div');
extensionTopBar.id = 'top-settings-holder'; extensionTopBar.hidden = true;
const personaMount = document.createElement('div');
personaMount.id = 'persona-management-button'; extensionTopBar.append(personaMount);
document.body.append(extensionTopBar);
const composerMount = document.createElement('div');
composerMount.id = 'send_form'; composerMount.hidden = true;
const qrBarMount = document.createElement('div');
qrBarMount.id = 'qr--bar'; composerMount.append(qrBarMount);
document.body.append(composerMount);
const extensionSettingsMount = document.createElement('div');
extensionSettingsMount.id = 'extensions_settings2'; extensionSettingsMount.hidden = true;
document.body.append(extensionSettingsMount);
const extensionMenuIds = new WeakMap<Element, string>();
function extensionActionTargets() {
    return collectExtensionActionTargets(extensionMenu, extensionTopBar, composerMount);
}
function extensionMenuEntries() {
    return extensionActionTargets().flatMap(element => {
        const name = element.textContent?.trim() || element.getAttribute('title') || element.querySelector('[title]')?.getAttribute('title');
        if (!name || !(element instanceof HTMLElement) || element.hidden) return [];
        const id = extensionMenuIds.get(element) ?? crypto.randomUUID();
        extensionMenuIds.set(element, id);
        return [{ id, name }];
    });
}
function publishExtensionMenu() {
    if (snapshot && token) outer.postMessage({ kind: 'compat:extension-menu', token, session: snapshot.session, buttons: extensionMenuEntries(), illustrationAvailable: typeof globals.STBaiBaiImage?.generate === 'function' }, '*');
}
const extensionActionsObserver = new MutationObserver(publishExtensionMenu);
for (const container of [extensionMenu, composerMount, extensionTopBar]) extensionActionsObserver.observe(container, { childList: true, subtree: true, characterData: true });
window.addEventListener('st-baibai-image:ready', () => {
    publishExtensionMenu();
    for (const row of rows.values()) messageActionUpdates.get(row.element)?.();
});
// Legacy message widgets address their parent's composer directly. Keep this
// DOM endpoint in the author origin; only its draft and focus intent cross RPC.
const composerProxy = document.createElement('textarea');
composerProxy.id = 'send_textarea';
composerProxy.hidden = true;
composerMount.append(composerProxy);
const composerValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!;
let composerPublishQueued = false;
let composerReference = '';
let pendingComposerWrite: Promise<string> | undefined;
const publishComposer = () => {
    if (composerPublishQueued) return;
    composerPublishQueued = true;
    queueMicrotask(() => {
        composerPublishQueued = false;
        const text = composerProxy.value, previous = composerReference;
        if (text === previous) return;
        composerReference = text;
        const write = request('composer.write', { text, previous }) as Promise<string>;
        pendingComposerWrite = write;
        void write.then(value => {
            if (pendingComposerWrite !== write) return;
            pendingComposerWrite = undefined;
            if (composerPublishQueued || composerReference !== text) return;
            composerReference = value;
            composerValue.set!.call(composerProxy, value);
        }, error => {
            if (pendingComposerWrite === write) pendingComposerWrite = undefined;
            diagnostic('填写输入框', error);
        });
    });
};
Object.defineProperty(composerProxy, 'value', {
    get: () => composerValue.get!.call(composerProxy),
    set: (text: string) => { composerValue.set!.call(composerProxy, text); publishComposer(); },
});
composerProxy.addEventListener('input', publishComposer);
composerProxy.addEventListener('change', publishComposer);
composerProxy.focus = () => { void request('composer.focus').catch(error => diagnostic('聚焦输入框', error)); };
const composerSendProxy = document.createElement('button');
composerSendProxy.id = 'send_but';
composerSendProxy.type = 'button';
composerSendProxy.hidden = true;
composerSendProxy.addEventListener('click', () => {
    if (!composerProxy.value.trim() || snapshot.generating) return;
    void (async () => {
        await Promise.resolve();
        const text = await (pendingComposerWrite ?? composerProxy.value);
        // Commit the card's variable writes before entering the normal send path.
        await flush();
        await request('composer.send', { text }, 600000);
    })().catch(error => diagnostic('发送消息', error));
});
composerMount.append(composerSendProxy);
// TavernHelper's predefine environment shares these DOM-independent libraries
// with author frames. Keep the host and child globals on the same implementation.
const authorLibraries = { _, z, YAML, showdown, DOMPurify };
const rootSlashRegistration = slashRegistration(window, runAuthorSlash);
let token = '';
let snapshot: CompatSnapshot;
let rpcSequence = 0;
let schema: MvuSchemaProvider | undefined;
let mvuSchemaDisposers: Array<() => void> = [];
let initialized = false;
function startupStage(stage: string): void {
    if (!initialized || startupCompletedToken !== token || startupCompletedSession !== snapshot?.session) outer.postMessage({ kind: 'compat:stage', token, stage }, '*');
}
let switchingSession = false;
let startupTask: Promise<void> = Promise.resolve();
let startupEventsTask: Promise<void> = Promise.resolve();
let startupCompletedSession = '';
let startupCompletedToken = '';
let startupFinishing: { token: string; promise: Promise<void> } | undefined;
let sessionSwitchTask: Promise<void> = Promise.resolve();
let sessionDataReady: Promise<void> = Promise.resolve();
let loading = false;
let initialScripts: CardScript[] = [];
let transaction: Record<string, any> | undefined;
let transactionTarget: { message: any; swipe: number } | undefined;
let transactionWrites: VariableWrite[] | undefined;
const scriptFailures = new Map<string, { name: string; message: string }>();
class AuthorStartupError extends Error {}
function assertAuthorScriptsReady() {
    if (!scriptFailures.size) return;
    const { name, message } = scriptFailures.values().next().value!;
    throw new AuthorStartupError(`脚本「${name}」未能启动：${message}`);
}
async function initializeAuthorVariables() {
    // Do not initialize or persist variables without the author's validation rules.
    assertAuthorScriptsReady();
    try { await initializeMvuSession(); }
    catch (error) {
        diagnostic('变量初始化', error);
        throw new AuthorStartupError(`初始变量未能加载：${error instanceof Error ? error.message : String(error)}`);
    }
}
function reportStartupFailure(bindingToken: string, error: unknown) {
    if (bindingToken !== token) return;
    if (!(error instanceof AuthorStartupError)) diagnostic('兼容初始化', error);
    outer.postMessage({ kind: 'compat:fault', token, message: `兼容初始化失败：${error instanceof Error ? error.message : String(error)}` }, '*');
}
let pipelineWorker: Worker | undefined;
let pipelineSequence = 0;
const pipelineJobs = new Map<number, { resolve(result: AssembledPromptResult): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
function assemblePrompt(input: AssemblePromptInput): Promise<AssembledPromptResult> {
    if (!pipelineWorker) {
        pipelineWorker = new Worker(new URL('../pipeline/prompt-pipeline.worker.ts', import.meta.url), { type: 'module' });
        pipelineWorker.onmessage = event => {
            const data = event.data; const job = pipelineJobs.get(data.id);
            if (!job) return;
            clearTimeout(job.timer); pipelineJobs.delete(data.id);
            if (data.error) job.reject(new Error(data.error)); else job.resolve(data.result);
        };
        pipelineWorker.onerror = () => stopPipeline(new Error('隔离模板计算线程意外停止'));
    }
    return new Promise((resolve, reject) => {
        const id = ++pipelineSequence;
        const timer = setTimeout(() => stopPipeline(new Error('模板执行超过 20 秒，已终止计算线程')), 20000);
        pipelineJobs.set(id, { resolve, reject, timer });
        try { pipelineWorker!.postMessage({ id, input }); }
        catch (error) { clearTimeout(timer); pipelineJobs.delete(id); reject(error instanceof Error ? error : new Error(String(error))); }
    });
}
function stopPipeline(error: Error) {
    pipelineWorker?.terminate(); pipelineWorker = undefined;
    for (const job of pipelineJobs.values()) { clearTimeout(job.timer); job.reject(error); }
    pipelineJobs.clear();
}
let chat: any[] = [];
let metadata: any = { variables: {} };
let metadataSaveTimer: ReturnType<typeof setTimeout> | undefined;
let openingSession: string | undefined;
let openingSave: Promise<unknown> | undefined;
let openingCommitted = false;
const loadedInterceptors: Array<{ name: string; key: string }> = [];
const baibaiRunning = () => loadedInterceptors.some(entry => entry.key === 'bbs_generateInterceptor');
const extensionPrompts = new Map<string, { value: string; position: number; depth: number; scan: boolean; role: number; filter: (() => boolean | Promise<boolean>) | null }>();
function setExtensionPrompt(key: string, value: unknown, position: number, depth: number, scan = false, role = 0, filter: (() => boolean | Promise<boolean>) | null = null) {
    const text = String(value ?? '');
    if (!text) { extensionPrompts.delete(key); return; }
    extensionPrompts.set(key, { value: text, position: Number(position), depth: Number(depth), scan: !!scan, role: Number(role ?? 0), filter });
}
const extensionPromptsProxy: Record<string, any> = new Proxy({}, {
    get: (_target, key) => typeof key === 'string' ? extensionPrompts.get(key) : undefined,
    set: (_target, key, value) => {
        if (typeof key !== 'string') return false;
        if (!value) { extensionPrompts.delete(key); return true; }
        const entry = typeof value === 'string'
            ? { value, position: 0, depth: 4, scan: false, role: 0, filter: null }
            : { value: String(value.value ?? ''), position: Number(value.position ?? 0), depth: Number(value.depth ?? 4),
                scan: !!value.scan, role: Number(value.role ?? 0), filter: typeof value.filter === 'function' ? value.filter : null };
        if (!entry.value) extensionPrompts.delete(key); else extensionPrompts.set(key, entry);
        return true;
    },
    deleteProperty: (_target, key) => typeof key === 'string' ? (extensionPrompts.delete(key), true) : false,
    has: (_target, key) => typeof key === 'string' && extensionPrompts.has(key),
    ownKeys: () => [...extensionPrompts.keys()],
    getOwnPropertyDescriptor: (_target, key) => typeof key === 'string' && extensionPrompts.has(key)
        ? { configurable: true, enumerable: true, writable: true, value: extensionPrompts.get(key) } : undefined,
});
const extensionSettings: Record<string, any> = {};
const extensionTypes: Record<string, string> = {};
let nativeOaiSettings: Record<string, any> = {};
let nativeOaiBaseline: Record<string, any> = {};
const nativePresetCache: { names: Record<string, number>; presets: Record<string, Record<string, any>>; settings: Record<string, any> } = {
    names: {}, presets: {}, settings: nativeOaiSettings,
};
let lastNotifiedPresetName = '';
let settingsSaveTimer: ReturnType<typeof setTimeout> | undefined;
let chatSaveTimer: ReturnType<typeof setTimeout> | undefined;
function ensureRegexScriptsRef(presetObj: Record<string, any>): Record<string, any>[] {
    if (!presetObj.extensions || typeof presetObj.extensions !== 'object' || Array.isArray(presetObj.extensions)) presetObj.extensions = {};
    if (!Array.isArray(presetObj.extensions.regex_scripts)) presetObj.extensions.regex_scripts = [];
    return presetObj.extensions.regex_scripts;
}
function syncNativePresetState(next: CompatSnapshot) {
    const incoming = structuredClone(next.assetCatalog.inUseNativePreset ?? {});
    for (const key of Object.keys(nativeOaiSettings)) if (!(key in incoming)) delete nativeOaiSettings[key];
    Object.assign(nativeOaiSettings, incoming);
    ensureRegexScriptsRef(nativeOaiSettings);
    nativeOaiBaseline = structuredClone(nativeOaiSettings);
    nativePresetCache.names = {};
    nativePresetCache.presets = {};
    next.assetCatalog.presets.forEach((preset, index) => {
        nativePresetCache.names[preset.name] = index;
        nativePresetCache.presets[String(index)] = preset.name === next.assetCatalog.loadedPresetName
            ? nativeOaiSettings
            : structuredClone(preset.native ?? {});
    });
    nativePresetCache.settings = nativeOaiSettings;
}
const powerUserSettings: Record<string, any> = {
    auto_swipe: false,
    auto_continue: { enabled: false, allow_chat_completions: false, target_length: 0 },
    get persona_description() {
        return snapshot?.personas?.find(persona => persona.avatar_id === snapshot.activePersonaId)?.description ?? '';
    },
};
const ToolManager = {
    tools: Object.freeze([] as Array<Record<string, any>>),
    hasTool: () => false,
    isToolCallingSupported: () => false,
    canPerformToolCalls: () => false,
};
type FormatterStage = 'beforeRegex' | 'afterRegex' | 'afterMarkdown';
type FormatterHookFn = (...args: any[]) => any;
const formatterHooks: Array<{ stage: FormatterStage; fn: FormatterHookFn; order: number; index: number }> = [];
let formatterHookSeq = 0;
function removeFormatterHook(stageOrFn: FormatterStage | FormatterHookFn, maybeFn?: FormatterHookFn) {
    const stage = typeof stageOrFn === 'function' ? undefined : stageOrFn;
    const fn = typeof stageOrFn === 'function' ? stageOrFn : maybeFn;
    for (let i = formatterHooks.length - 1; i >= 0; i--) {
        const hook = formatterHooks[i]!;
        if ((!stage || hook.stage === stage) && (!fn || hook.fn === fn)) formatterHooks.splice(i, 1);
    }
}
const messageFormatter = {
    addHook: (
        stageOrFn: FormatterStage | FormatterHookFn,
        fnOrOptions?: FormatterHookFn | { stage?: FormatterStage; order?: number } | FormatterStage,
        order = 0,
    ) => {
        const fn = typeof stageOrFn === 'function' ? stageOrFn : typeof fnOrOptions === 'function' ? fnOrOptions : undefined;
        if (typeof fn !== 'function') return () => {};
        const stage: FormatterStage = typeof stageOrFn === 'string'
            ? stageOrFn
            : typeof fnOrOptions === 'string'
                ? fnOrOptions
                : (fnOrOptions && typeof fnOrOptions === 'object' ? fnOrOptions.stage : undefined) ?? 'beforeRegex';
        const resolvedOrder = typeof stageOrFn === 'function' && fnOrOptions && typeof fnOrOptions === 'object'
            ? Number(fnOrOptions.order ?? order) || 0
            : Number(order) || 0;
        formatterHooks.push({ stage, fn, order: resolvedOrder, index: formatterHookSeq++ });
        formatterHooks.sort((a, b) => (a.order - b.order) || (a.index - b.index));
        return () => removeFormatterHook(stage, fn);
    },
    removeHook: removeFormatterHook,
};
function hasFormatterStage(stage: FormatterStage): boolean {
    return formatterHooks.some(hook => hook.stage === stage);
}
function runFormatterStage(stage: FormatterStage, text: string, hookContext: { messageId: number; isSystem: boolean; isUser: boolean }): string {
    let current = text;
    for (const hook of formatterHooks) {
        if (hook.stage !== stage) continue;
        try {
            const nextText = hook.fn(current, hookContext);
            if (typeof nextText === 'string') current = nextText;
        } catch (error) {
            diagnostic('消息格式化钩子', error, undefined, 'warning', false);
        }
    }
    return current;
}
function formatMarkdownWithHooks(
    rawText: string,
    floor: number,
    isSystem: boolean,
    isUser: boolean,
    renderHtml: (source: string) => string = renderMessageMarkdown,
): string {
    const role: 'assistant' | 'user' | 'system' = isUser ? 'user' : isSystem ? 'system' : 'assistant';
    if (!formatterHooks.length) return renderHtml(displayedSource(rawText, floor, role));
    const hookContext = { messageId: floor, isSystem, isUser };
    const before = runFormatterStage('beforeRegex', rawText, hookContext);
    const regexed = displayedSource(before, floor, role);
    const afterRegex = runFormatterStage('afterRegex', regexed, hookContext);
    const html = renderHtml(afterRegex);
    return runFormatterStage('afterMarkdown', html, hookContext);
}
const promptManager = {
    get serviceSettings() { return nativeOaiSettings; },
    messages: { collection: [] as any[] },
    tokenUsage: {} as Record<string, any>,
    getPromptById: (id: string) => {
        const prompts = Array.isArray(nativeOaiSettings.prompts) ? nativeOaiSettings.prompts : [];
        return prompts.find((entry: any) => entry?.identifier === id) ?? null;
    },
    getPromptOrderEntry: (character: unknown, identifier: string) => {
        const charId = typeof character === 'number' || typeof character === 'string' ? Number(character) : 100001;
        const orders = Array.isArray(nativeOaiSettings.prompt_order) ? nativeOaiSettings.prompt_order : [];
        const bucket = orders.find((entry: any) => Number(entry?.character_id) === charId)
            ?? orders.find((entry: any) => Number(entry?.character_id) === 100001)
            ?? orders[0];
        const order = Array.isArray(bucket?.order) ? bucket.order : [];
        return order.find((entry: any) => entry?.identifier === identifier) ?? null;
    },
    isPromptDisabledForActiveCharacter: (identifier: string) => {
        const entry = promptManager.getPromptOrderEntry(100001, identifier);
        return entry ? entry.enabled === false : false;
    },
    render: () => [],
};
const waiting = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
const writes = new Set<Promise<unknown>>();
let writeFailure: unknown;
const pendingVariableWrites = new Map<string, { value: Record<string, any>; option: HelperVariableOption; messageKey?: string; swipe?: number }>();
const listeners = new Map<string, Array<{ fn: (...args: any[]) => any; original: (...args: any[]) => any }>>();
const injected = new Map<string, any>();
const externalWorldInfo = new Map<string, any>();
function captureWorldInfoActivation(event: string, args: any[]) {
    if (canonicalEvent(event) !== events.WORLDINFO_FORCE_ACTIVATE) return;
    for (const entry of args[0] ?? []) if (entry && typeof entry.world === 'string' && entry.uid != null) externalWorldInfo.set(`${entry.world}::${entry.uid}`, entry);
}
const shared = new Map<string, any>();
const globalWaiters = new Map<string, Array<() => void>>();
const children = new Set<HTMLIFrameElement>();
const loadedMessageFrames = new WeakSet<HTMLIFrameElement>();
let readingPresentation: ReadingPresentation | undefined;
const childDisposers = new WeakMap<Window, () => void>();
const scriptButtons = new Map<string, Array<{ name: string; visible: boolean }>>();
const scriptInfo = new Map<string, string>();
const variableSchemas = new Map<string, { schema: z.ZodType<any>; owner?: Window }>();
let mvuVariableSchema: z.ZodType<any> | undefined;
function registerVariableSchema(value: z.ZodType<any>, options: { type: string }, owner?: Window): void {
    if (!['global', 'preset', 'character', 'chat', 'message'].includes(options?.type) || !value || typeof value.parseAsync !== 'function') throw new Error('变量管理器结构需要有效作用域和 Zod Schema');
    variableSchemas.set(options.type, { schema: value, owner });
}
const rows = new Map<string, { element: HTMLElement; content: string; swipe: number; incomplete: boolean; identity: string; avatar?: string }>();
let currentFilmToken = '';
const films = createFilmSurface({
    row: id => rows.get(id)?.element,
    onAction: (req, filmToken) => {
        if (snapshot) outer.postMessage({ kind: 'compat:film-action', session: snapshot.session, token: filmToken || currentFilmToken, ...req }, '*');
    },
    onMediaNeed: mediaIds => {
        if (snapshot && mediaIds.length) outer.postMessage({ kind: 'compat:film-media-need', session: snapshot.session, mediaIds }, '*');
    },
    onVisibleChange: visible => {
        if (snapshot) outer.postMessage({ kind: 'compat:film-visible', session: snapshot.session, visible }, '*');
    },
});
let showMessages = new URLSearchParams(location.search).get('view') !== 'worker';
let readingReplyId: string | undefined;
let readingFrame = 0;
let lastReadingPosition = '';
let restoringBookmark: ReadingBookmark | undefined;
let bookmarkNeedsRestore = false;
let bookmarkReleaseTimer: ReturnType<typeof setTimeout> | undefined;
history.scrollRestoration = 'manual';
function stopRestoringBookmark() {
    clearTimeout(bookmarkReleaseTimer);
    restoringBookmark = undefined;
}
function releaseBookmarkAfterLayout() {
    clearTimeout(bookmarkReleaseTimer);
    bookmarkReleaseTimer = setTimeout(stopRestoringBookmark, 400);
}
function restoreReadingPosition() {
    if (!showMessages || !window.innerHeight) return;
    if (!restoringBookmark && !bookmarkNeedsRestore) return;
    bookmarkNeedsRestore = false;
    let row = restoringBookmark && rows.get(restoringBookmark.messageId)?.element;
    if (!row || row.dataset.readingSwipe !== restoringBookmark?.swipeId) {
        const last = snapshot.messages.at(-1);
        row = last && last.floor > 0 ? rows.get(last.id)?.element : undefined;
        restoringBookmark = row && last ? { messageId: last.id, swipeId: readingSwipeId(last), offset: -12 } : undefined;
    }
    if (row && restoringBookmark) {
        const adjustment = readingBookmarkAdjustment(restoringBookmark, row, 0);
        if (Math.abs(adjustment) > 1) window.scrollBy({ top: adjustment, behavior: 'instant' });
        if (startupCompletedSession === snapshot.session) releaseBookmarkAfterLayout();
    } else if (window.scrollY) window.scrollTo({ top: 0, behavior: 'instant' });
}
function prepareReadingBookmark(value: unknown) {
    stopRestoringBookmark();
    restoringBookmark = isReadingBookmark(value) ? value : undefined;
    bookmarkNeedsRestore = true;
}
const readingLayoutObserver = new ResizeObserver(() => { if (initialized && !switchingSession) restoreReadingPosition(); });
readingLayoutObserver.observe(root);
trackReadingBookmark(window, () => {
    if (!showMessages || !initialized || switchingSession || bookmarkNeedsRestore || restoringBookmark || !window.innerHeight) return;
    const messages = snapshot.messages;
    return captureReadingBookmark(0, messages.length, index => rows.get(messages[index].id)?.element);
}, bookmark => outer.postMessage({ kind: 'compat:reading-bookmark', token, session: snapshot.session, bookmark }, '*'));
function reportReplyPosition() {
    readingFrame = 0;
    const lastMessage = snapshot?.messages.at(-1);
    const targetId = readingReplyId ?? lastMessage?.id;
    const row = targetId ? rows.get(targetId) : undefined;
    const loaded = row && [...row.element.querySelectorAll('iframe')].every(frame => {
        try { return frame.contentDocument?.readyState === 'complete'; } catch { return true; }
    });
    const rect = row?.element.getBoundingClientRect();
    const distanceFromBottom = Math.max(0, document.documentElement.scrollHeight - window.innerHeight - window.scrollY);
    const canJumpToReplyStart = Boolean(readingReplyId && row && loaded && !row.incomplete && !snapshot?.generating
        && lastMessage?.id === readingReplyId && lastMessage.floor > 0);
    const mode: ReplyJumpMode = rect
        ? resolveReplyJumpMode({
            replyTop: rect.top,
            replyBottom: rect.bottom,
            replyHeight: rect.height,
            viewportHeight: window.innerHeight,
            distanceFromBottom,
            canJumpToReplyStart,
        })
        : 'none';
    const key = `${snapshot?.session}:${readingReplyId ?? ''}:${mode}`;
    if (key === lastReadingPosition) return;
    lastReadingPosition = key;
    outer.postMessage({ kind: 'compat:reply-position', session: snapshot?.session, replyId: readingReplyId, mode }, '*');
}
function scheduleReadingPosition() {
    if (!readingFrame) readingFrame = requestAnimationFrame(reportReplyPosition);
}
const readingActivity = (activity?: 'scroll' | 'tap') => {
    if (activity !== 'tap') stopRestoringBookmark();
    if (showMessages) outer.postMessage({ kind: 'compat:reading-activity', session: snapshot?.session, activity }, '*');
};
function observeSyncInteraction(win: Window): () => void {
    let last = 0;
    const report = (event: Event) => {
        if (!event.isTrusted || Date.now() - last < 200) return;
        last = Date.now(); outer.postMessage({ kind: 'compat:interaction', token }, '*');
    };
    const events = ['pointerdown', 'keydown', 'input', 'wheel'];
    for (const name of events) win.addEventListener(name, report, { capture: true, passive: true });
    return () => { for (const name of events) win.removeEventListener(name, report, true); };
}
observeSyncInteraction(window);
async function finishStartupForSync(bindingToken: string) {
    if (token !== bindingToken) return;
    if (startupCompletedSession === snapshot.session && startupCompletedToken === bindingToken) { outer.postMessage({ kind: 'compat:startup-complete', token }, '*'); return; }
    if (startupFinishing?.token === bindingToken) return startupFinishing.promise;
    const promise = (async () => {
        assertAuthorScriptsReady();
        await request('runtime.startup');
        if (token !== bindingToken) return;
        // Template rendering can replace frames. Observe the live set, not one early snapshot.
        await new Promise<void>(resolve => {
            const observed = new Set<HTMLIFrameElement>();
            const observer = new MutationObserver(() => check());
            const check = () => {
                const pending = [...children].filter(frame => frame.classList.contains('compat-message-frame') && frame.isConnected && !loadedMessageFrames.has(frame));
                for (const frame of pending) if (!observed.has(frame)) { observed.add(frame); frame.addEventListener('load', check); }
                if (pending.length && bindingToken === token) { startupStage(`等待角色页面载入：${pending.length} 个互动界面`); return; }
                observer.disconnect();
                for (const frame of observed) frame.removeEventListener('load', check);
                resolve();
            };
            observer.observe(root, { childList: true, subtree: true });
            check();
        });
        startupStage('确认故事状态已保存');
        await flush();
        await request('story.seal');
        if (token === bindingToken) {
            startupCompletedSession = snapshot.session;
            startupCompletedToken = bindingToken;
            if (restoringBookmark) releaseBookmarkAfterLayout();
            outer.postMessage({ kind: 'compat:startup-complete', token }, '*');
        }
    })();
    startupFinishing = { token: bindingToken, promise };
    try { await promise; } finally { if (startupFinishing?.promise === promise) startupFinishing = undefined; }
}
observeReadingActivity(window, readingActivity);
window.addEventListener('scroll', scheduleReadingPosition, { passive: true });
window.addEventListener('pointerdown', stopRestoringBookmark, { passive: true });
window.addEventListener('resize', scheduleReadingPosition);
const diagnostics: RuntimeDiagnostic[] = [];
const deferredDeltas: CompatSnapshotDelta[] = [];
const residentTemplates = new ResidentTemplateHost({
    prepare: context => emit('prompt_template_prepare', context),
    echo: text => notify(text),
    slashCommand: executeRegisteredSlashCommand,
    hasSlashCommand: hasRegisteredSlashCommand,
    macroLikes: applyMacroLikes,
    hostMacros: applyHostMacros,
    takeWorldInfoActivations: () => { const entries = [...externalWorldInfo.values()]; externalWorldInfo.clear(); return entries; },
    event: emit,
    hasEvent: name => !!listeners.get(canonicalEvent(name))?.length,
    liveMessages: () => snapshot?.messages,
    globals: { $, console, toastr: Object.fromEntries(['info', 'success', 'warning', 'error'].map(level => [level,
        (message: string, title?: string) => notify(`${title ? title + '：' : ''}${message}`, level)])) },
    mutated: () => scheduleTemplateSave(),
    contextGlobals: runtime => ({ EjsTemplate: templateExports(() => runtime) }),
    idle: () => synchronizeTemplateScopes(),
    fault: error => outer.postMessage({ kind: 'compat:fault', token, message: error.message }, '*'),
}, async runtime => {
    const result: AssembledPromptResult = { ...runtime.changes(), messages: [], activatedLorebookEntries: [], nextTimedStates: runtime.input.timedStates ?? {},
        tokenUsage: { system: 0, lorebook: 0, history: 0, total: 0, budgetRemaining: 0 }, droppedHistoryCount: 0 };
    await request('template.commit', { expected: runtime.input, result });
});
const templateCallbackOwners = new WeakMap<Window, TemplateRuntime>();
let templateSaveScheduled = false;
function synchronizeTemplateScopes(): void {
    if (snapshot && residentTemplates.isIdle && !residentTemplates.current?.hasChanges()) residentTemplates.current?.synchronizeScopes(
        { global: snapshot.scopes.global, chat: metadata.variables }, snapshot.messages);
}
function scheduleTemplateSave(): void {
    if (!residentTemplates.isIdle || templateSaveScheduled) return;
    templateSaveScheduled = true;
    queueMicrotask(() => {
        templateSaveScheduled = false;
        if (residentTemplates.isIdle) void residentTemplates.save().catch(error => diagnostic('模板变量保存', error));
    });
}
const iframeEvents = { MESSAGE_IFRAME_RENDER_STARTED: 'message_iframe_render_started', MESSAGE_IFRAME_RENDER_ENDED: 'message_iframe_render_ended',
    GENERATION_REQUESTED: 'js_generation_requested', GENERATION_STARTED: 'js_generation_started',
    STREAM_TOKEN_RECEIVED_FULLY: 'js_stream_token_received_fully', STREAM_TOKEN_RECEIVED_INCREMENTALLY: 'js_stream_token_received_incrementally',
    REASONING_TOKEN_RECEIVED_FULLY: 'js_reasoning_token_received_fully', REASONING_TOKEN_RECEIVED_INCREMENTALLY: 'js_reasoning_token_received_incrementally',
    GENERATION_BEFORE_END: 'js_generation_before_end', GENERATION_ENDED: 'js_generation_ended' };
const generationTasks = new Map<string, { text: string; reasoning: string; queue: Promise<void>; stopped: boolean; silent: boolean }>();
const helperWorldbookCache = new Map<string, { version: string; entries: any[] }>();
async function readHelperWorldbook(name: string) {
    const cached = helperWorldbookCache.get(name);
    const result = await request('worldbook.read', { name, version: cached?.version });
    const current = result.entries ? result : cached!;
    helperWorldbookCache.set(name, current);
    return current;
}

const escapeScript = (text: string) => text.replace(/<\/script/gi, '<\\/script');
const safeJson = (value: unknown) => JSON.stringify(value).replace(/</g, '\\u003c');
function reportComponent(type: CompatibilityLoadReport['type'], component: Pick<CardScript, 'id' | 'name' | 'version'>,
    state: CompatibilityLoadReport['state'], code?: CompatibilityLoadReport['code'], stage: CompatibilityLoadReport['stage'] = 'load') {
    const { id, name, version } = component;
    outer.postMessage({ kind: 'compat:load-report', token, report: { type, id, name, version, state, stage, code } satisfies CompatibilityLoadReport }, '*');
}
function diagnostic(name: string, error: unknown, scriptId = '', level: 'error' | 'warning' = 'error', logRuntime = true) {
    // Author errors originate in another window, so instanceof Error is unreliable.
    const detail = error as { message?: unknown; stack?: unknown } | null;
    const message = typeof detail?.stack === 'string' ? detail.stack : typeof detail?.message === 'string' ? detail.message : String(error);
    const item = { name, scriptId, message, level };
    diagnostics.push(item);
    if (diagnostics.length > 100) diagnostics.shift();
    if (!(name.startsWith('MVU 命令') && !snapshot?.mvuSettings.notifyError)) outer.postMessage({ kind: 'compat:diagnostic', token, diagnostic: item }, '*');
    if (logRuntime && level === 'error') {
        const script = scriptId && initialScripts.find(item => item.id === scriptId);
        if (script) reportComponent('script', script, 'failed', 'RUNTIME_ERROR', 'runtime');
        else outer.postMessage({ kind: 'compat:runtime-error', token, area: name.startsWith('互动界面') ? 'author' : 'runtime' }, '*');
    }
    appendRuntimeDiagnostic(root, item.name, item.message, level, scriptId);
    console.error(`[兼容运行环境 / ${name}]`, error);
}
function request(method: string, params: Record<string, any> = {}, timeoutMs = 30000): Promise<any> {
    if (residentTemplates.failure) return Promise.reject(residentTemplates.failure);
    // Worldbook RPCs persist independently of the staged MVU variable result.
    // Render/event callbacks may await them during settlement; do not reject or
    // defer them behind the transaction that is awaiting those same callbacks.
    const id = ++rpcSequence;
    startupStage(`等待宿主接口：${method}`);
    const response = new Promise((resolve, reject) => {
        const timer = setTimeout(() => { waiting.delete(id); reject(new Error(`宿主接口超时：${method}`)); }, timeoutMs);
        waiting.set(id, { resolve, reject, timer });
        outer.postMessage({ kind: 'compat:request', token, session: snapshot?.session, branchEpoch: snapshot?.branchEpoch ?? 0, id, method, params }, '*');
    });
    return response;
}
function track<T>(promise: Promise<T>): Promise<T> {
    writes.add(promise);
    void promise.then(() => writes.delete(promise), error => {
        writes.delete(promise); writeFailure = error; diagnostic('状态写入', error);
    });
    return promise;
}
async function flush() {
    if (settingsSaveTimer) await saveSettingsImmediate();
    if (chatSaveTimer) { clearTimeout(chatSaveTimer); chatSaveTimer = undefined; await saveChatMetadata(undefined, true); }
    if (metadataSaveTimer) { clearTimeout(metadataSaveTimer); metadataSaveTimer = undefined; await saveChatMetadata(undefined, chat.length === snapshot.messages.length); }
    while (writes.size) await Promise.allSettled([...writes]);
    if (writeFailure !== undefined) { const error = writeFailure; writeFailure = undefined; throw error; }
}
const legacyChatWrites = new Set<Promise<unknown>>();
let legacySaveQueue: Promise<unknown> = Promise.resolve();
function trackLegacySave(promise: Promise<unknown>) {
    legacyChatWrites.add(promise);
    void promise.then(() => legacyChatWrites.delete(promise), () => legacyChatWrites.delete(promise));
    return track(promise);
}

async function prepareHelperGeneration(options: HelperGenerationConfig = {}, raw = false) {
    if (transaction) throw new Error('MVU 结算事务期间不能启动模型请求');
    if (residentTemplates.isExecuting) throw new Error('模板执行期间不能递归发起另一轮生成，请在模板任务完成后发起');
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('生成配置必须是对象');
    // injects may contain async filter functions, which cannot be structured-cloned.
    const config = _.cloneDeep(options);
    config.generation_id ||= crypto.randomUUID();
    await emit(iframeEvents.GENERATION_REQUESTED, config.generation_id, raw ? 'generateRaw' : 'generate', config);
    const id = config.generation_id!;
    if (typeof id !== 'string' || !id.trim()) throw new Error('generation_id 必须是非空字符串');
    if (generationTasks.has(id)) throw new Error(`生成 ID 已在使用：${id}`);
    const task = { text: '', reasoning: '', queue: Promise.resolve(), stopped: false, silent: config.should_silence === true };
    generationTasks.set(id, task);
    try {
        await initializeNewMvuBindings();
        if (shouldEmitMainGenerationAfterCommands(raw)) {
            await emit(events.GENERATION_AFTER_COMMANDS, helperGenerationCommandType(config), {}, false);
        }
        await emit(iframeEvents.GENERATION_STARTED, id);
        const injections = shouldCollectGlobalInjections(config, raw) ? await collectInjections() : [];
        if (config.injects !== undefined) {
            if (!Array.isArray(config.injects)) throw new Error('injects 必须是数组');
            config.injects = (await resolvePromptInjections(config.injects, (_item, index) => `${id}:${index}`)).map(({ id: _id, ...prompt }) => prompt);
        }
        await flush();
        if (task.stopped) throw new DOMException(`生成 ${id} 已停止`, 'AbortError');
        return { generationConfig: config, injections };
    } catch (error) {
        generationTasks.delete(id);
        throw error;
    }
}
async function finishHelperGeneration(id: string, result: string | Partial<import('../core/platform-bridge').CompletionResult> & { content: string }) {
    const task = generationTasks.get(id);
    if (!task || task.stopped) throw new DOMException(`生成 ${id} 已停止`, 'AbortError');
    try {
        await task.queue;
        const payload = { message: typeof result === 'string' ? result : result.content, reasoning: typeof result === 'string' ? undefined : result.reasoning };
        if (payload.reasoning) payload.reasoning = processRuntimeRegex(payload.reasoning, 'reasoning');
        const features = residentTemplates.current?.features;
        if (features?.enabled && features.render_enabled && features.raw_message_evaluation_enabled) {
            payload.message = await templateApi(runtime => runtime.withEnvironment({ runType: 'render_permanent', generateType: 'custom', isDryRun: false,
                message_id: undefined, swipe_id: undefined, is_last: undefined, is_user: undefined, is_system: undefined, name: undefined }, async () => {
                await runtime.beginStage();
                return runtime.render(payload.message, `custom:${id}`, {}, undefined,
                    { message: true, assistant: true, user: false, system: false, depth: 0, before: true, after: false, html: false }, 'reasoning');
            }));
        }
        await emit(iframeEvents.GENERATION_BEFORE_END, payload, id);
        if (typeof payload.message !== 'string') throw new Error('生成结束事件必须保留字符串正文');
        await emit(iframeEvents.GENERATION_ENDED, payload.message, id, payload.reasoning);
        return typeof result === 'string' ? payload.message : { ...result, content: payload.message, reasoning: payload.reasoning };
    } finally { generationTasks.delete(id); }
}
async function cancelHelperGeneration(id: string) {
    const task = generationTasks.get(id);
    generationTasks.delete(id);
    if (!task?.stopped && shouldEmitGlobalGenerationStopped(Boolean(task?.silent))) await emit(events.GENERATION_STOPPED, id);
}
async function generate(options: HelperGenerationConfig = {}, raw = false) {
    const { generationConfig: config, injections } = await prepareHelperGeneration(options, raw);
    const id = config.generation_id!;
    try {
        const result = await request(raw ? 'generation.generateRaw' : 'generation.generate', { options: config, injections }, 600000);
        return await finishHelperGeneration(id, result);
    } catch (error) {
        await request('generation.stop', { id }).catch(() => {});
        await cancelHelperGeneration(id);
        throw error;
    }
}
async function collectInjections(includeExtensions = false) {
    const injections = await resolvePromptInjections([...injected.values()], item => item?.id);
    if (includeExtensions) for (const [key, prompt] of [...extensionPrompts].sort(([a], [b]) => a.localeCompare(b))) {
        if (!prompt.value.trim() || prompt.filter && !await prompt.filter()) continue;
        const position = ({ [-1]: 'none', 0: 'in_prompt', 1: 'in_chat', 2: 'before_prompt' } as const)[prompt.position as -1 | 0 | 1 | 2];
        if (!position) continue;
        injections.push({ id: `st:${key}`, content: prompt.value, position, depth: prompt.depth, should_scan: prompt.scan,
            role: (['system', 'user', 'assistant'] as const)[prompt.role] ?? 'system' });
    }
    return injections;
}
function stopGenerationById(id: string): boolean {
    const task = generationTasks.get(id);
    if (!task || task.stopped) return false;
    task.stopped = true;
    void request('generation.stop', { id }).catch(error => diagnostic('停止生成', error));
    if (shouldEmitGlobalGenerationStopped(task.silent)) {
        void emit(events.GENERATION_STOPPED, id).catch(error => diagnostic('停止事件', error));
    }
    return true;
}
function eventOn(event: string, fn: (...args: any[]) => any, priority = 0) {
    if (typeof event !== 'string' || typeof fn !== 'function') throw new Error('事件名称或处理函数无效');
    event = canonicalEvent(event);
    const list = listeners.get(event) ?? [];
    const existing = list.findIndex(item => item.original === fn);
    if (existing >= 0 && priority === 0) return Object.assign(() => eventOff(event, fn), { stop: () => eventOff(event, fn) });
    const entry = existing >= 0 ? list.splice(existing, 1)[0] : { fn, original: fn };
    if (priority < 0) list.unshift(entry); else list.push(entry);
    listeners.set(event, list);
    const stop = () => eventOff(event, fn);
    return Object.assign(stop, { stop });
}
function eventOff(event: string, fn: (...args: any[]) => any) {
    event = canonicalEvent(event);
    const list = listeners.get(event);
    if (list) listeners.set(event, list.filter(item => item.original !== fn));
}
function eventOnce(event: string, fn: (...args: any[]) => any) {
    event = canonicalEvent(event);
    const existing = listeners.get(event)?.some(item => item.original === fn);
    const stop = existing ? Object.assign(() => eventOff(event, fn), { stop: () => eventOff(event, fn) }) : eventOn(event, fn);
    if (!existing) {
        const entry = listeners.get(event)!.find(item => item.original === fn)!;
        entry.fn = (...args: any[]) => { stop(); return fn(...args); };
    }
    return stop;
}
async function emit(event: string, ...args: any[]) {
    await dispatchEvent(event, args);
    // The memory extension refreshes its injection one timer tick after CHAT_CHANGED.
    if (event === events.CHAT_CHANGED && baibaiRunning()) {
        await new Promise<void>(resolve => setTimeout(resolve, 0));
        await flush();
    }
}
async function dispatchEvent(event: string, args: any[], alreadySettled = false) {
    event = canonicalEvent(event);
    captureWorldInfoActivation(event, args);
    for (const { fn } of [...(listeners.get(event) ?? [])]) {
        if (alreadySettled && fn === settleExtensionMessage) continue;
        await fn(...args);
    }
    await flush();
}
function emitAndWait(event: string, ...args: any[]): void {
    captureWorldInfoActivation(event, args);
    for (const { fn } of [...(listeners.get(canonicalEvent(event)) ?? [])]) {
        try { void Promise.resolve(fn(...args)).catch(error => diagnostic(`事件 ${event}`, error)); }
        catch (error) { diagnostic(`事件 ${event}`, error); }
    }
    void flush().catch(error => diagnostic(`事件 ${event} 保存`, error));
}
function messageAt(id: any = 'latest'): any {
    const index = id === 'latest' || id === undefined ? chat.length - 1 : Number(id);
    const message = chat.at(index);
    if (!Number.isInteger(index) || !message) throw new Error(`消息楼层不存在：${id}`);
    return message;
}
function variables(option: any = {}): any {
    const type = option.type ?? 'chat';
    if (type === 'message') { const m = messageAt(option.message_id); return m.variables[m.swipe_id] ?? {}; }
    if (type === 'script') {
        if (!option.script_id) throw new Error('脚本变量必须指定 script_id');
        return Object.hasOwn(snapshot.scriptVariables, option.script_id) ? snapshot.scriptVariables[option.script_id] : {};
    }
    if (type === 'extension') {
        return readExtensionVariables(snapshot.extensionVariables, option.extension_id);
    }
    if (type === 'chat') return metadata.variables;
    if (!(type in snapshot.scopes)) throw new Error(`尚未支持的变量作用域：${type}`);
    return snapshot.scopes[type as keyof CompatSnapshot['scopes']];
}
function replaceVariables(value: any, option: any = {}) {
    if (!_.isPlainObject(value)) throw new Error('变量表必须是对象');
    const type = option.type ?? 'chat';
    const data = structuredClone(type === 'chat' || type === 'message' ? normalizeMvuVariables(value).variables : value);
    if (type === 'message') {
        const m = messageAt(option.message_id);
        if (transaction && transactionTarget && m === transactionTarget.message && m.swipe_id === transactionTarget.swipe) {
            for (const key of Object.keys(transaction)) delete transaction[key];
            Object.assign(transaction, data);
            m.variables[m.swipe_id] = transaction;
        } else m.variables[m.swipe_id] = data;
    }
    else if (type === 'chat') metadata.variables = data;
    else if (['global', 'preset', 'character'].includes(type)) snapshot.scopes[type as keyof CompatSnapshot['scopes']] = data;
    else if (type === 'script') {
        if (!option.script_id || !Object.hasOwn(snapshot.scriptVariables, option.script_id)) throw new Error('脚本变量必须指定当前角色内有效的 script_id');
        snapshot.scriptVariables[option.script_id] = data;
    } else if (type === 'extension') {
        writeExtensionVariables(snapshot.extensionVariables, option.extension_id, data);
    }
    else throw new Error(`变量作用域尚未接通：${type}`);
    if (transactionWrites) {
        transactionWrites.push({ variables: data, option: { ...structuredClone(option), ...(type === 'message' ? { message_id: chat.indexOf(messageAt(option.message_id)) } : {}) } });
        return;
    }
    const normalizedOption = { ...option, ...(type === 'message' ? { message_id: chat.indexOf(messageAt(option.message_id)) } : {}) };
    const message = type === 'message' ? messageAt(option.message_id) : undefined;
    const key = `${type}:${normalizedOption.message_id ?? normalizedOption.script_id ?? normalizedOption.extension_id ?? ''}:${message?.swipe_id ?? ''}`;
    const pending = { value: data, option: normalizedOption, messageKey: message?._id, swipe: message?.swipe_id };
    pendingVariableWrites.set(key, pending);
    track(request('variables.replace', { variables: data, option: normalizedOption,
        ...(message ? { messageTarget: { id: message._id, swipe: message.swipe_id } } : {}) }).finally(() => {
        if (pendingVariableWrites.get(key) === pending) pendingVariableWrites.delete(key);
    }).catch(async error => {
        // Remove the optimistic overlay before restoring the authoritative host state.
        await request('runtime.sync').catch(() => {});
        throw error;
    }));
}

function updateVariablesWith(update: (value: any) => any, option: HelperVariableOption = {}): any {
    const result = update(structuredClone(variables(option)));
    const save = (value: any) => { replaceVariables(value, option); return value; };
    return result && typeof result.then === 'function' ? result.then(save) : save(result);
}
function chatRange(range: number | string): { low: number; high: number } | undefined {
    const text = String(range).replace(/\{\{lastMessageId\}\}/gi, String(chat.length - 1));
    const bounds = /^(-?\d+)\s*-\s*(-?\d+)$/.exec(text);
    const index = (n: number) => n < 0 ? chat.length + n : n;
    const a = index(Number(bounds ? bounds[1] : text)), b = index(Number(bounds ? bounds[2] : text));
    if ((!bounds && !/^-?\d+$/.test(text)) || !Number.isInteger(a) || !Number.isInteger(b)) return;
    return { low: Math.max(0, Math.min(a, b)), high: Math.min(chat.length - 1, Math.max(a, b)) };
}
function getChatMessages(range: number | string = `0-${chat.length - 1}`, options: any = {}) {
    const bounds = chatRange(range);
    if (!bounds) return [];
    const result: Array<Record<string, any> & { message_id: number }> = [];
    for (let i = bounds.low; i <= bounds.high; i++) {
        const m = chat[i];
        if (!m || options.role && options.role !== 'all' && options.role !== m.role
            || options.hide_state && options.hide_state !== 'all' && (options.hide_state === 'hidden') !== !!m.is_system) continue;
        const base = { message_id: i, name: m.name, role: m.role, is_hidden: !!m.is_system };
        const swipes = { swipe_id: m.swipe_id, swipes: [...m.swipes], swipes_data: m.swipes.map((_: string, index: number) => structuredClone(m.variables[index] ?? {})) };
        result.push({ ...base, ...swipes, ...(options.include_swipes || options.include_swipe
            ? { swipes_info: m.swipes.map((_: string, index: number) => structuredClone(m.swipe_info[index]?.extra ?? m.swipe_info[index] ?? {})) }
            : { message: m.mes, data: structuredClone(m.variables[m.swipe_id] ?? {}), extra: structuredClone(m.extra ?? {}) }) });
    }
    return result;
}
function applySnapshot(next: CompatSnapshot) {
    if (snapshot && next.session !== snapshot.session && !switchingSession) return;
    if (snapshot && next.revision < snapshot.revision) return;
    const previous = snapshot;
    baibaiStorage.bind(memoryStorageAddress(next));
    const routeChanged = !!previous && (previous.session !== next.session || (previous.branchEpoch ?? 0) !== (next.branchEpoch ?? 0));
    const metadataReset = !previous || routeChanged || previous.session !== next.session;
    if (metadataReset) {
        clearTimeout(metadataSaveTimer); metadataSaveTimer = undefined;
        extensionPrompts.clear();
        for (const key of Object.keys(metadata)) if (key !== 'variables') delete metadata[key];
    }
    if (metadataReset || previous.chatMetadata !== next.chatMetadata) {
        const old = metadataReset ? {} : previous.chatMetadata ?? {}, incoming = next.chatMetadata ?? {};
        for (const key of new Set([...Object.keys(old), ...Object.keys(incoming)])) {
            if (key === 'variables' || key === hostHiddenKey || key === routeMessageDataKey || !metadataReset && !_.isEqual(metadata[key], old[key])) continue;
            if (Object.hasOwn(incoming, key)) Object.defineProperty(metadata, key, { value: structuredClone(incoming[key]), enumerable: true, writable: true, configurable: true });
            else delete metadata[key];
        }
    }
    if (routeChanged) {
        disposePopups();
        for (const row of rows.values()) disposeRow(row.element);
        rows.clear();
        chat.length = 0;
        pendingVariableWrites.clear();
    }
    snapshot = next;
    syncNativePresetState(next);
    composerSendProxy.disabled = next.generating;
    if (!previous || previous.extensionVariables !== next.extensionVariables) {
        const settings = hostExtensionSettings(next);
        const old = previous ? hostExtensionSettings(previous) : {};
        for (const key of new Set([...Object.keys(old), ...Object.keys(settings)])) {
            if (key === 'tavern_helper' && settings.tavern_helper && typeof settings.tavern_helper === 'object' && extensionSettings.tavern_helper && typeof extensionSettings.tavern_helper === 'object'
                && !_.isEqual(extensionSettings.tavern_helper.scripts, settings.tavern_helper.scripts)
                && !_.isEqual(old.tavern_helper?.scripts, settings.tavern_helper.scripts)) {
                extensionSettings.tavern_helper = { ...extensionSettings.tavern_helper, scripts: structuredClone(settings.tavern_helper.scripts) };
            }
            if (!_.isEqual(extensionSettings[key], old[key]) || _.isEqual(old[key], settings[key])) continue;
            if (Object.hasOwn(settings, key)) extensionSettings[key] = structuredClone(settings[key]); else delete extensionSettings[key];
        }
    }
    if (previous?.extensions !== next.extensions) {
        for (const key of Object.keys(extensionTypes)) delete extensionTypes[key];
        Object.assign(extensionTypes, Object.fromEntries(next.extensions.extensions.map(entry => [entry.type === 'system' ? entry.id : `third-party/${entry.id}`, entry.type])));
    }
    if (metadataReset || previous.scopes.chat !== next.scopes.chat) metadata.variables = structuredClone(normalizeMvuVariables(next.scopes.chat).variables);
    if (metadataReset || previous?.messages !== next.messages || previous.chatMetadata?.[hostHiddenKey] !== next.chatMetadata?.[hostHiddenKey] || routeMessages(previous.chatMetadata) !== routeMessages(next.chatMetadata)) {
    chat.length = next.messages.length;
    next.messages.forEach((node, index) => {
        let target = chat[index];
        const old = !metadataReset && previous?.messages[index]?.id === node.id ? previous.messages[index] : undefined;
        const hidden = hostMessageHidden(node, next.chatMetadata);
        if (old === node && target?._id === node.id && hidden === hostMessageHidden(node, previous.chatMetadata) &&
            _.isEqual(routeMessages(next.chatMetadata)?.[routeMessageKey(node)], routeMessages(previous.chatMetadata)?.[routeMessageKey(node)])) return;
        if (!target || target._id !== node.id) target = chat[index] = { _id: node.id };
        const preserve = old && old.activeSwipeIndex === node.activeSwipeIndex;
        const oldExtra = preserve ? messageExtra(old, old.activeSwipeIndex, previous.chatMetadata) : undefined;
        const nextExtra = messageExtra(node, node.activeSwipeIndex, next.chatMetadata);
        const extra = preserve && _.isEqual(oldExtra, nextExtra) ? target.extra ?? nextExtra : nextExtra;
        const swipeVariables = (node.extra?.swipeVariables ?? {}) as Record<string, unknown>;
        const mes = preserve && old.content === node.content ? target.mes ?? node.content : node.content;
        const topLevel = messageTopLevel(node);
        if (old) for (const key of Object.keys(messageTopLevel(old))) if (!(key in topLevel)) delete target[key];
        Object.assign(target, topLevel, { name: node.speakerName, role: node.role, mes, message: mes,
            is_user: node.role === 'user', is_system: preserve && hidden === hostMessageHidden(old, previous.chatMetadata) ? target.is_system : hidden, swipe_id: node.activeSwipeIndex,
            swipes: node.swipes.map((s, i) => i === node.activeSwipeIndex ? mes : typeof s === 'string' ? s : s.content), extra,
            swipe_info: node.swipes.map((_, swipe) => ({ extra: messageExtra(node, swipe, next.chatMetadata) })) });
        target.variables = node.swipes.map((_, swipe) => structuredClone(normalizeMvuVariables((swipeVariables[swipe] ?? {}) as Record<string, unknown>).variables));
        target.variables[node.activeSwipeIndex] = structuredClone(normalizeMvuVariables(node.variables).variables);
        target.variables_initialized = node.swipes.map((_, swipe) => !!(node.extra?.tipsy_template_variables_initialized as Record<string, boolean> | undefined)?.[swipe]);
    });
    }
    // Acknowledgements for older synchronous writes must not erase newer local values.
    for (const pending of pendingVariableWrites.values()) {
        const { type = 'chat', script_id, extension_id } = pending.option;
        if (type === 'message') {
            const message = chat.find(item => item._id === pending.messageKey);
            if (message) message.variables[pending.swipe!] = structuredClone(pending.value);
        } else if (type === 'chat') metadata.variables = structuredClone(pending.value);
        else if (type === 'script') snapshot.scriptVariables[script_id!] = structuredClone(pending.value);
        else if (type === 'extension') writeExtensionVariables(snapshot.extensionVariables, extension_id!, pending.value);
        else snapshot.scopes[type as keyof CompatSnapshot['scopes']] = structuredClone(pending.value);
    }
    if (!switchingSession && (!previous || previous.messages !== next.messages || previous.scopes.chat !== next.scopes.chat || previous.scopes.global !== next.scopes.global)) synchronizeTemplateScopes();
    if (initialized && previous?.scriptTrees !== next.scriptTrees) scheduleScriptRefresh();
    if (!previous || previous.session !== next.session || previous.character.id !== next.character.id || previous.character.name !== next.character.name || previous.userName !== next.userName || previous.assetCatalog.characters !== next.assetCatalog.characters || previous.generating !== next.generating || previous.assetCatalog.loadedPresetName !== next.assetCatalog.loadedPresetName || previous.assetCatalog.inUseNativePreset !== next.assetCatalog.inUseNativePreset) window.dispatchEvent(new Event('tipsy-host-context'));
    if (!previous) lastNotifiedPresetName = next.assetCatalog.loadedPresetName;
    else if (initialized && next.assetCatalog.loadedPresetName !== lastNotifiedPresetName) {
        lastNotifiedPresetName = next.assetCatalog.loadedPresetName;
        void emit(events.OAI_PRESET_CHANGED_AFTER, next.assetCatalog.loadedPresetName).catch(error => diagnostic('预设切换事件', error));
    }
    if (!previous || !_.isEqual(previous.worldbookBindings.names, next.worldbookBindings.names) || !_.isEqual(previous.worldbookBindings.global, next.worldbookBindings.global)) window.dispatchEvent(new Event('tipsy-host-worldbooks'));
    if (initialized && showMessages) {
        const presentationChanged = !previous || routeChanged || previous.session !== next.session ||
            previous.character.id !== next.character.id || previous.character.name !== next.character.name ||
            previous.userName !== next.userName || previous.assetCatalog.characters !== next.assetCatalog.characters ||
            previous.personas !== next.personas || previous.activePersonaId !== next.activePersonaId ||
            previous.helperRenderDepth !== next.helperRenderDepth;
        if (presentationChanged || previous?.messages !== next.messages) renderMessages(presentationChanged ? undefined : previous);
        if (previous?.generating !== next.generating || previous?.nativeMessageMenu !== next.nativeMessageMenu || previous?.messages.at(-1)?.id !== next.messages.at(-1)?.id) {
            for (const row of rows.values()) messageActionUpdates.get(row.element)?.();
            scheduleReadingPosition();
        }
    }
}
function applyDelta(delta: CompatSnapshotDelta) {
    if (!snapshot || delta.session !== snapshot.session && !switchingSession || delta.revision < snapshot.revision) return;
    let nextMessages = snapshot.messages;
    if (delta.messages.length || delta.order.length !== nextMessages.length || delta.order.some((id, index) => id !== nextMessages[index]?.id)) {
        const messages = new Map(nextMessages.map(m => [m.id, m]));
        delta.messages.forEach(m => messages.set(m.id, m));
        nextMessages = delta.order.map(id => messages.get(id)!);
    }
    applySnapshot({ ...snapshot, ...delta, chatMetadata: delta.chatMetadata === null ? undefined : delta.chatMetadata ?? snapshot.chatMetadata, scopes: { ...snapshot.scopes, ...delta.scopes },
        assetCatalog: { ...snapshot.assetCatalog, ...delta.assetCatalog }, worldbooks: delta.worldbooks ?? snapshot.worldbooks, messages: nextMessages });
}
function saveChatMetadata(withMetadata?: Record<string, unknown>, explicitSave = false) {
    clearTimeout(metadataSaveTimer); metadataSaveTimer = undefined;
    if (transactionWrites) {
        if (explicitSave) chat.forEach((m, i) => transactionWrites!.push({ variables: structuredClone(m.variables[m.swipe_id] ?? {}), option: { type: 'message', message_id: i } }));
        transactionWrites.push({ variables: structuredClone(metadata.variables), option: { type: 'chat' } });
        return Promise.resolve();
    }
    if (openingSave) return openingSave;
    if (openingSession === snapshot.session) {
        if (openingCommitted || !explicitSave) return Promise.resolve();
        const { variables, ...values } = { ...metadata, ...withMetadata };
        const rows = chat.map(({ name, role, is_user, is_system, mes, extra, send_date, swipe_id, swipes, swipe_info, variables, variables_initialized }) =>
            ({ name, role, is_user, is_system, mes, extra, send_date, swipe_id, swipes, swipe_info, variables, variables_initialized }));
        const session = openingSession;
        const saved = request('legacy.commitOpening', { rows, variables, metadata: values }).then(() => {
            if (openingSession === session) openingCommitted = true;
        }).finally(() => { if (openingSave === saved) openingSave = undefined; });
        openingSave = saved;
        return saved;
    }
    const currentSession = snapshot.session;
    const run = legacySaveQueue.then(async () => {
        if (snapshot.session !== currentSession) return;
        const baseline = snapshot.chatMetadata ?? {};
        if (explicitSave && (chat.length !== snapshot.messages.length || chat.some((row, index) => row._id !== snapshot.messages[index]?.id || row.swipe_id !== snapshot.messages[index]?.activeSwipeIndex))) {
            throw new Error('此接口目前不支持直接改变聊天结构或切换回复版本');
        }
        const savedMetadata = { ...metadata, ...withMetadata };
        const values = Object.fromEntries(Object.entries(savedMetadata).filter(([key, value]) => key !== 'variables' && !_.isEqual(value, baseline[key])));
        const removed = Object.keys(baseline).filter(key => key !== hostHiddenKey && key !== routeMessageDataKey && !Object.hasOwn(savedMetadata, key));
        const variables = !_.isEqual(savedMetadata.variables, normalizeMvuVariables(snapshot.scopes.chat).variables) ? savedMetadata.variables : undefined;
        const baseRowKeys = new Set(['_id', 'name', 'role', 'mes', 'message', 'is_user', 'is_system', 'swipe_id', 'swipes', 'extra', 'swipe_info', 'variables', 'variables_initialized', 'send_date']);
        const messageState = chat.flatMap((row, index) => {
            const node = snapshot.messages[index];
            if (!node || node.id !== row._id || node.activeSwipeIndex !== row.swipe_id) return [];
            const mes = typeof row.mes === 'string' && row.mes !== node.content ? row.mes : undefined;
            const extra = _.isEqual(row.extra, messageExtra(node, node.activeSwipeIndex, snapshot.chatMetadata)) ? undefined : row.extra;
            const hidden = Boolean(row.is_system) === hostMessageHidden(node, snapshot.chatMetadata) ? undefined : Boolean(row.is_system);
            const current = row.variables[row.swipe_id];
            const variables = _.isEqual(current, normalizeMvuVariables(node.variables).variables) ? undefined : current;
            const swipeInfo: Record<number, Record<string, unknown>> = {};
            const swipeCount = Array.isArray(row.swipes) ? row.swipes.length : node.swipes.length;
            for (let s = 0; s < swipeCount; s++) {
                const rawSwipe = row.swipe_info?.[s];
                const swipeExtra = rawSwipe && typeof rawSwipe === 'object' && 'extra' in rawSwipe ? rawSwipe.extra : rawSwipe;
                if (swipeExtra && typeof swipeExtra === 'object' && !_.isEqual(swipeExtra, messageExtra(node, s, snapshot.chatMetadata))) {
                    swipeInfo[s] = structuredClone(swipeExtra);
                }
            }
            const nextTopLevel = Object.fromEntries(Object.entries(row).filter(([key, value]) => !baseRowKeys.has(key) && value !== undefined));
            const topLevel = _.isEqual(nextTopLevel, messageTopLevel(node)) ? undefined : nextTopLevel;
            return mes === undefined && extra === undefined && hidden === undefined && variables === undefined && !Object.keys(swipeInfo).length && topLevel === undefined
                ? []
                : [{ id: node.id, swipe: row.swipe_id, content: node.content, mes, extra, hidden, variables,
                    ...(Object.keys(swipeInfo).length ? { swipeInfo } : {}),
                    ...(topLevel !== undefined ? { topLevel } : {}) }];
        });
        if (!messageState.length && !variables && !removed.length && !Object.keys(values).length) return;
        await request('legacy.save', { messageState, variables, metadata: { values, removed } });
        if (snapshot.session === currentSession) await request('runtime.sync');
    });
    legacySaveQueue = run.catch(() => {});
    return trackLegacySave(run);
}
async function generateTavernRaw(options: { prompt?: string | unknown[]; responseLength?: number; signal?: AbortSignal } = {}) {
    const messages = Array.isArray(options.prompt) ? options.prompt : [{ role: 'user', content: options.prompt ?? '' }];
    const body: Record<string, unknown> = { messages, max_tokens: options.responseLength ?? snapshot.modelSettings.maxResponse, stream: false };
    await emit(events.CHAT_COMPLETION_SETTINGS_READY, body);
    const response = await tavernCompletionResponse(window, request, '/api/backends/chat-completions/generate', body, options.signal, true);
    const payload = await response.json();
    if (!response.ok || payload.error) throw new Error(payload.error?.message ?? payload.error ?? `HTTP ${response.status}`);
    return String(payload.choices?.[0]?.message?.content ?? '');
}
const worldInfoCache = createWorldInfoCache();
const chatCompletionService = createChatCompletionService(name => {
    const settings = name === snapshot.assetCatalog.loadedPresetName ? snapshot.assetCatalog.inUsePreset.settings
        : snapshot.assetCatalog.presets.find(preset => preset.name === name)?.data.settings;
    if (!settings) return;
    const sampler = Object.fromEntries(['temperature', 'top_p', 'top_k', 'frequency_penalty', 'presence_penalty', 'repetition_penalty', 'min_p', 'seed', 'stop']
        .filter(key => settings[key] !== undefined).map(key => [key, settings[key]]));
    return { ...sampler, max_tokens: settings.max_completion_tokens, stream: settings.should_stream };
});
async function checkWorldInfo(chat: string[], maxContext: number, isDryRun = false, globalScanData?: Record<string, unknown>) {
    const additionalScanText = (await collectInjections(true)).filter(prompt => prompt.should_scan).map(prompt => prompt.content);
    const entries = await request('worldbook.scan', { chat, maxContext, isDryRun, globalScanData, additionalScanText });
    return (await import('./worldbook-scan-format')).formatCompatibilityWorldbooks(entries);
}
async function getWorldInfoPrompt(...args: Parameters<typeof checkWorldInfo>) {
    const { worldInfoBefore, worldInfoAfter, WIDepthEntries, ANBeforeEntries, ANAfterEntries, EMEntries, outletEntries, allActivatedEntries } = await checkWorldInfo(...args);
    if (!args[2] && allActivatedEntries.size) await emit(events.WORLD_INFO_ACTIVATED, [...allActivatedEntries]);
    return { worldInfoString: worldInfoBefore + worldInfoAfter, worldInfoBefore, worldInfoAfter, worldInfoDepth: WIDepthEntries,
        anBefore: ANBeforeEntries, anAfter: ANAfterEntries, worldInfoExamples: EMEntries, outletEntries };
}
function displayedSource(text: string, floor: number, role: 'assistant' | 'user' | 'system'): string {
    const depth = Math.max(0, chat.length - floor - 1);
    const regexed = role === 'system' ? helper.substitudeMacros(text) : helper.formatAsTavernRegexedString(text, role === 'user' ? 'user_input' : 'ai_output', 'display', { depth });
    return role === 'system' ? regexed : applyMacroLikes(regexed, { message_id: floor, role });
}
function modelSettingsOverlay(): Record<string, any> {
    return {
        ...snapshot.assetCatalog.inUsePreset,
        preset_settings_openai: snapshot.assetCatalog.loadedPresetName,
        chat_completion_source: snapshot.modelSettings.source,
        openai_model: snapshot.modelSettings.model,
        claude_model: snapshot.modelSettings.model,
        google_model: snapshot.modelSettings.model,
        stream_openai: snapshot.modelSettings.stream,
        openai_max_context: snapshot.modelSettings.maxContext,
        openai_max_tokens: snapshot.modelSettings.maxResponse,
        proxies: (snapshot.proxyPresets ?? []).map(({ name, model }) => ({ name, model, url: '', password: '' })),
    };
}
const chatCompletionSettingsProxy = new Proxy({} as Record<string, any>, {
    get: (_target, key) => {
        if (typeof key !== 'string') return undefined;
        if (key in nativeOaiSettings) return nativeOaiSettings[key];
        return modelSettingsOverlay()[key];
    },
    set: (_target, key, value) => {
        if (typeof key !== 'string') return false;
        nativeOaiSettings[key] = value;
        return true;
    },
    has: (_target, key) => typeof key === 'string' && (key in nativeOaiSettings || key in modelSettingsOverlay()),
    ownKeys: () => [...new Set([...Object.keys(modelSettingsOverlay()), ...Object.keys(nativeOaiSettings)])],
    getOwnPropertyDescriptor: (_target, key) => {
        if (typeof key !== 'string') return undefined;
        const overlay = modelSettingsOverlay();
        if (!(key in nativeOaiSettings) && !(key in overlay)) return undefined;
        return { configurable: true, enumerable: true, writable: true, value: key in nativeOaiSettings ? nativeOaiSettings[key] : overlay[key] };
    },
});
function resolveRenderedMessageContent(node: CompatSnapshot['messages'][number], overrideMes?: string): string {
    const role: 'assistant' | 'user' | 'system' = node.role === 'user' ? 'user' : node.isHidden ? 'system' : 'assistant';
    const raw = typeof overrideMes === 'string' ? overrideMes : (chat[node.floor]?.mes ?? node.content);
    const hookContext = { messageId: node.floor, isSystem: Boolean(node.isHidden), isUser: node.role === 'user' };
    let base = node.formatted;
    if (typeof overrideMes === 'string' && overrideMes !== node.content) {
        const before = hasFormatterStage('beforeRegex') ? runFormatterStage('beforeRegex', raw, hookContext) : raw;
        base = displayedSource(before, node.floor, role);
    } else if (hasFormatterStage('beforeRegex')) {
        const before = runFormatterStage('beforeRegex', raw, hookContext);
        if (before !== raw) base = displayedSource(before, node.floor, role);
    }
    return hasFormatterStage('afterRegex') ? runFormatterStage('afterRegex', base, hookContext) : base;
}
function repaintMessageBlock(floor: number, overrideMes?: string) {
    const node = snapshot?.messages[floor];
    const row = node ? rows.get(node.id) : undefined;
    const rowEl = (row?.element.querySelector('.mes_text') ?? document.querySelector(`.mes[mesid="${floor}"] .mes_text`)) as HTMLElement | null;
    if (!node || !rowEl || node.streamPreview || node.templatePending) return;
    const nextContent = resolveRenderedMessageContent(node, overrideMes);
    const incomplete = !!node.extra?.tipsy_generation_incomplete || !!node.templatePending;
    if (row && row.content === nextContent && rowEl.childNodes.length > 0 && !hasFormatterStage('afterMarkdown')) return;
    const restore = preserveReadingAnchor(rowEl);
    reconcileMessageBody(rowEl, node, nextContent, incomplete, snapshot.messages.length);
    if (row) { row.content = nextContent; row.incomplete = incomplete; }
    films.sync();
    restore();
    scheduleReadingPosition();
}
const context = () => {
    const session = snapshot.session;
    const ensureSession = () => { if (snapshot.session !== session) throw new Error('操作所属聊天已切换'); };
    return { ...hostPopupApi, chat, chatId: session, name1: snapshot.userName, name2: snapshot.character.name,
    ChatCompletionService: chatCompletionService,
    messageFormatter,
    ToolManager,
    powerUserSettings,
    promptManager,
    messageFormatting: (text: string, _name: string, isSystem: boolean, isUser: boolean, floor = chat.length - 1) =>
        formatMarkdownWithHooks(text, floor, isSystem, isUser, formatTemplateMarkdown),
    setExtensionPrompt,
    extension_prompt_types: { NONE: -1, IN_PROMPT: 0, IN_CHAT: 1, BEFORE_PROMPT: 2 },
    extension_prompt_roles: { SYSTEM: 0, USER: 1, ASSISTANT: 2 },
    get extensionPrompts() { return extensionPromptsProxy; },
    generateRaw: generateTavernRaw,
    doNewChat: async (options: { deleteCurrentChat?: boolean } = {}) => {
        ensureSession();
        await flush();
        await saveChatMetadata(undefined, true);
        await request('legacy.newChat', options);
    },
    getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
    selectCharacterById: (id: number | string) => request('host.character.select', { id }),
    reloadCurrentChat: async () => {
        ensureSession();
        if (openingSession === snapshot.session) {
            await openingSave;
            await request('legacy.finishOpening');
            return;
        }
        if (chat.length === 1 && snapshot.messages[0]?.extra?.tipsy_mvu_initialization_pending) await initializeMvuSession();
        await helper.builtin.reloadChatWithoutEvents();
        await emit(events.CHAT_CHANGED, snapshot.session);
    },
    reloadWorldInfoEditor: () => request('runtime.sync'),
    getPresetManager: (apiId = 'openai') => ({
        apiId,
        getSelectedPresetName: () => snapshot.assetCatalog.loadedPresetName,
        getPresetList: () => nativePresetCache,
        getCompletionPresetByName: (name?: string) => {
            const targetName = name ?? snapshot.assetCatalog.loadedPresetName;
            const idx = nativePresetCache.names[targetName];
            return idx !== undefined ? nativePresetCache.presets[String(idx)] : snapshot.assetCatalog.presets.find(preset => preset.name === targetName)?.native;
        },
        savePreset: async (name?: string, presetData?: Record<string, unknown>, _options?: { skipUpdate?: boolean }) => {
            const targetName = name || snapshot.assetCatalog.loadedPresetName;
            const payload = structuredClone(presetData ?? nativeOaiSettings);
            await track(request('asset.preset.saveNative', { name: targetName, preset: payload }));
            if (targetName === snapshot.assetCatalog.loadedPresetName) {
                for (const key of Object.keys(nativeOaiSettings)) if (!(key in payload)) delete nativeOaiSettings[key];
                Object.assign(nativeOaiSettings, structuredClone(payload));
                ensureRegexScriptsRef(nativeOaiSettings);
                nativeOaiBaseline = structuredClone(nativeOaiSettings);
                await emit(events.OAI_PRESET_CHANGED_AFTER, targetName);
            }
            return targetName;
        },
        selectPreset: async (nameOrIndex: string | number) => {
            const targetName = typeof nameOrIndex === 'number'
                ? Object.entries(nativePresetCache.names).find(([, idx]) => idx === nameOrIndex)?.[0]
                : nameOrIndex;
            if (!targetName) return;
            helper.loadPreset(targetName);
        },
        readPresetExtensionField: ({ path }: { path: string }) =>
            structuredClone(_.get(snapshot.assetCatalog.inUsePreset.extensions, path) ?? _.get(nativeOaiSettings.extensions, path)),
        writePresetExtensionField: async ({ path, value }: { path: string; value: unknown }) => {
            _.set(nativeOaiSettings.extensions ??= {}, path, structuredClone(value));
            await saveSettingsImmediate();
        },
    }),
    getRegexScriptsByType: (type: number | string, options?: { allowedOnly?: boolean }) => {
        if (options?.allowedOnly && extensionSettings.disabledExtensions?.includes('regex')) return [];
        if (type === 2 || type === 'preset') return ensureRegexScriptsRef(nativeOaiSettings);
        if (type === 0 || type === 'global') return snapshot.regexCatalog.global.map(serializeRegexRule);
        if (type === 1 || type === 'scoped' || type === 'character') {
            const card = snapshot.regexCatalog.characters.find(entry => entry.id === snapshot.character.id);
            return (card?.rules ?? []).map(serializeRegexRule);
        }
        return [];
    },
    getOneCharacter: async (avatar: string) => {
        await request('runtime.sync');
        const character = snapshot.assetCatalog.characters.find(card => card.avatar === avatar || card.id === avatar);
        if (!character) throw new Error(`找不到角色：${avatar}`);
        return character.raw;
    },
    mainApi: 'openai', getChatCompletionModel: () => snapshot.modelSettings.model,
    getTokenizerModel: () => snapshot.modelSettings.model,
    getTokenCountAsync: async (text: string) => estimateTokenCount(String(text ?? '')),
    generate: async (_type = 'normal', _options?: Record<string, unknown>, _dryRun = false) => {
        if (snapshot.generating) return;
        await flush();
        const text = composerProxy.value;
        if (text.trim()) await request('composer.send', { text }, 600000);
        else await request('slash.generate', { text: '' }, 600000);
    },
    chatCompletionSettings: chatCompletionSettingsProxy,
    registerMacro: registerHostMacro, unregisterMacro: unregisterHostMacro,
    substituteParams: (text: string) => helper.substitudeMacros(text),
    substituteParamsExtended: (text: string) => helper.substitudeMacros(text),
    ...rootSlashRegistration,
    executeSlashCommands: (command: string) => runAuthorSlashWithResult(command),
    executeSlashCommandsWithOptions: (command: string, options: SlashExecutionOptions = {}) => {
        const match = /^\s*\/(hide|unhide)\s+(-?\d+(?:\s*-\s*-?\d+)?)\s*$/.exec(command);
        if (!match) return runAuthorSlashWithResult(command, options);
        const bounds = chatRange(match[2]);
        const messageState: Array<{ id: string; swipe: number; content: string; hidden: boolean }> = [];
        const hidden = match[1] === 'hide';
        for (let i = bounds?.low ?? 0; i <= (bounds?.high ?? -1); i++) {
            const row = chat[i], node = snapshot.messages[i];
            if (!row || !node || row._id !== node.id || row.is_system === hidden) continue;
            row.is_system = hidden;
            messageState.push({ id: node.id, swipe: row.swipe_id, content: node.content, hidden });
        }
        if (!messageState.length) return Promise.resolve({ pipe: '' });
        return trackLegacySave(request('legacy.save', { messageState })).then(() => ({ pipe: '' }));
    },
    characterId: String(snapshot.assetCatalog.characters.findIndex(card => card.id === snapshot.character.id)), characterUuid: snapshot.character.id,
    characters: snapshot.assetCatalog.characters.map(card => card.raw),
    setUserAvatar: (name: string) => track(request('persona.select', { name })),
    extensionSettings, extension_settings: extensionSettings, extensionTypes,
    saveSettings: saveSettingsImmediate,
    saveSettingsDebounced,
    findExtension: (id: string) => findCompatibilityExtension(snapshot.extensions, id) ?? null,
    loadWorldInfo: async (name: string) => {
        if (!name) return null;
        const data = await request('worldbook.native.load', { name });
        if (data) worldInfoCache.set(name, data);
        return data ? structuredClone(data) : null;
    },
    saveWorldInfo: async (name: string, data: unknown, _immediately = false) => {
        if (!name || !data) return;
        worldInfoCache.set(name, structuredClone(data));
        await track(request('worldbook.native.save', { name, data }));
        await emit(events.WORLDINFO_UPDATED, name, data);
    },
    worldInfoCache,
    originalWIDataKeyMap,
    createWorldInfoEntry,
    setWIOriginalDataValue,
    deleteWIOriginalDataValue,
    updateWorldInfoList: async () => { await request('runtime.sync'); return [...snapshot.worldbookBindings.names]; },
    writeExtensionField: async (characterId: string | number, key: string, value: unknown) => {
        const index = Number(characterId);
        const card = Number.isInteger(index) && index >= 0 ? snapshot.assetCatalog.characters[index]
            : snapshot.assetCatalog.characters.find(item => item.id === characterId || item.avatar === characterId);
        if (!card) throw new Error(`找不到角色：${characterId}`);
        await track(request('host.http', { path: '/api/characters/merge-attributes', body: { avatar: card.avatar, data: { extensions: { [key]: value } } } }));
        await request('runtime.sync');
    },
    updateMessageBlock: async (messageId: number, message?: Record<string, any>) => {
        ensureSession();
        if (!chat[messageId]) return;
        const nextMes = typeof message?.mes === 'string' ? message.mes : chat[messageId].mes;
        if (typeof nextMes !== 'string') return;
        repaintMessageBlock(messageId, nextMes);
    },
    addOneMessage: async (message: Record<string, any>, options?: { insertAfter?: number }) => {
        ensureSession();
        const role = message.is_user ? 'user' : message.is_system ? 'system' : 'assistant';
        await helper.createChatMessages([{ role, name: message.name, message: String(message.mes ?? ''), is_hidden: Boolean(message.is_system) }],
            options?.insertAfter !== undefined ? { insert_before: options.insertAfter + 1 } : {});
    },
    groupId: null as string | null,
    get isGenerating() { return Boolean(snapshot.generating); },
    get is_send_press() { return Boolean(snapshot.generating); },
    get streamingProcessor() { return snapshot.generating ? {} : null; },
    shouldSendOnEnter: () => true,
    getVariables: helper.getVariables,
    worldInfoNames: snapshot.worldbookBindings.names, selectedWorldInfo: snapshot.worldbookBindings.global,
    get worldInfo() { return { globalSelect: [...snapshot.worldbookBindings.global] }; },
    getWorldInfoSettings: () => structuredClone({ ...snapshot.worldinfoSettings, world_info: { globalSelect: [...snapshot.worldbookBindings.global] } }),
    getWorldInfoNames: () => [...snapshot.worldbookBindings.names], checkWorldInfo, getWorldInfoPrompt,
    getCharacterCardFields: () => { const raw = snapshot.assetCatalog.characters.find(card => card.id === snapshot.character.id)?.raw as any; return structuredClone(raw?.data ?? raw ?? {}); },
    chatMetadata: metadata, eventTypes: events, event_types: events, getCurrentChatId: () => snapshot.session,
    eventSource: { on: eventOn, makeFirst: (e: string, f: any) => eventOn(e, f, -1), makeLast: (e: string, f: any) => eventOn(e, f, 1), removeListener: eventOff, emit },
    saveChat: async (options?: { chatName?: string; withMetadata?: Record<string, unknown>; mesId?: number }) => {
        ensureSession();
        if (options?.chatName && options.chatName !== snapshot.session || options?.mesId != null && options.mesId >= 0 && options.mesId < chat.length - 1) {
            throw new Error('此接口目前只保存当前活动路线，不支持另存或截断聊天');
        }
        await saveChatMetadata(options?.withMetadata, true);
    },
    saveChatDebounced,
    saveMetadata: () => { ensureSession(); return saveChatMetadata(); },
    saveMetadataDebounced: () => {
        ensureSession();
        clearTimeout(metadataSaveTimer);
        metadataSaveTimer = setTimeout(() => void saveChatMetadata().catch(() => {}), 300);
    },
    };
};
async function saveExtensionSettings(): Promise<void> {
    const baseline = hostExtensionSettings(snapshot);
    const settings = Object.fromEntries(Object.entries(extensionSettings).filter(([key, value]) => !_.isEqual(value, baseline[key])));
    const removed = Object.keys(baseline).filter(key => !Object.hasOwn(extensionSettings, key));
    if (Object.keys(settings).length || removed.length) await track(request('extensions.settings', { settings: structuredClone(settings), removed }));
}
async function saveSettingsImmediate(): Promise<void> {
    clearTimeout(settingsSaveTimer); settingsSaveTimer = undefined;
    await saveExtensionSettings();
    if (!_.isEqual(nativeOaiSettings, nativeOaiBaseline)) {
        const nextPreset = structuredClone(nativeOaiSettings);
        await track(request('asset.preset.saveWorkingNative', { preset: nextPreset }));
        nativeOaiBaseline = structuredClone(nativeOaiSettings);
    }
    await emit(events.SETTINGS_UPDATED);
}
function saveSettingsDebounced(): void {
    clearTimeout(settingsSaveTimer);
    settingsSaveTimer = setTimeout(() => { void saveSettingsImmediate().catch(error => diagnostic('设置保存', error)); }, 200);
}
function saveChatDebounced(): void {
    if (!snapshot?.session) return;
    clearTimeout(chatSaveTimer);
    chatSaveTimer = setTimeout(() => { void saveChatMetadata(undefined, true).catch(error => diagnostic('聊天保存', error)); }, 200);
}
function sillyTavernApi(readContext: () => any) {
    return new Proxy({ getContext: readContext }, {
        get: (target, key) => key === 'getContext' ? target.getContext : readContext()[key],
        has: (_target, key) => key === 'getContext' || key in readContext(),
        ownKeys: () => [...new Set(['getContext', ...Reflect.ownKeys(readContext())])],
        getOwnPropertyDescriptor: (_target, key) => ({ configurable: true, enumerable: true, value: key === 'getContext' ? readContext : readContext()[key] }),
    });
}
function hostExtensionSettings(value: CompatSnapshot): Record<string, any> {
    const { tipsy_host_settings, ...ordinary } = value.extensionVariables;
    const result = { ...ordinary, ...(tipsy_host_settings?.values as object ?? {}) };
    for (const key of (tipsy_host_settings?.removed as string[] ?? [])) delete result[key];
    return result;
}
function initializeGlobal(key: string, value: any) {
    if (typeof key !== 'string' || !key || _.toPath(key).some((part: string) => ['__proto__', 'prototype', 'constructor'].includes(part))) throw new Error('共享接口路径无效');
    shared.set(key, value); _.set(globals, key, value);
    for (const child of children) {
        try { _.set(child.contentWindow, key, value); } catch { /* disposed child */ }
    }
    for (const resolve of globalWaiters.get(key) ?? []) resolve();
    globalWaiters.delete(key);
    void emit(`global_${key}_initialized`).catch(error => diagnostic('共享接口初始化事件', error));
}
function waitGlobalInitialized(key: string) {
    if (shared.has(key) || _.has(globals, key)) return Promise.resolve();
    return new Promise<void>(resolve => { const list = globalWaiters.get(key) ?? []; list.push(resolve); globalWaiters.set(key, list); });
}
function templateExports(nested: () => TemplateRuntime | undefined = () => undefined) {
    const invoke = <T>(run: (runtime: TemplateRuntime) => Promise<T>, refresh = false, context?: unknown) => templateApi(run, refresh,
        nested() ?? (residentTemplates.current?.ownsContext(context) ? residentTemplates.current : undefined));
    const api = {
    evalTemplate: (code: string, context?: Record<string, any> | null, options: Record<string, any> = {}) =>
        invoke(runtime => runtime.evaluateExternal(code, context, options), false, context),
    evaltemplate: (code: string, context?: Record<string, any> | null, options: Record<string, any> = {}) => api.evalTemplate(code, context, options),
    prepareContext: (additional: Record<string, any> = {}, end = -1) => invoke(runtime => runtime.prepareContext(additional, end)),
    compileTemplate: (source: string, options?: Parameters<typeof compileAuthorTemplate>[1], context?: Record<string, any>) => compileAuthorTemplate(source, options, context, true),
    finalization: typeof FinalizationRegistry === 'function' ? new FinalizationRegistry<{ destroyIframe?(): void }>(value => {
        if (typeof value?.destroyIframe === 'function') value.destroyIframe();
    }) : null,
    getSyntaxErrorInfo: templateSyntaxError,
    parseJSON: parseTemplateJSON,
    jsonPatch: patchTemplateJSON,
    get defines() { return residentTemplates.defines; },
    get initialVariables() { return residentTemplates.initialVariables; },
    allVariables: (end?: number, swipe?: number) => residentTemplates.current?.allVariables(end, swipe)
        ?? Object.assign({}, snapshot.scopes.global, residentTemplates.initialVariables, metadata.variables,
            chat.at(end ?? -1)?.variables[swipe ?? chat.at(end ?? -1)?.swipe_id] ?? {}),
    saveVariables: async (force = false) => {
        // An active task's writes are committed by its outer boundary. Awaiting the
        // same queue here would deadlock an author template that calls saveVariables.
        if (residentTemplates.isExecuting && nested() === residentTemplates.current) return;
        await residentTemplates.save();
        if (force || api.getFeatures().autosave_enabled) await request('template.save');
    },
    refreshWorldInfo: () => invoke(async () => undefined, true),
    getFeatures: () => normalizeTemplateFeatures(readExtensionVariables(snapshot.extensionVariables, 'EjsTemplate')),
    setFeatures: (features: Record<string, unknown>) => {
        if (!features || typeof features !== 'object' || Array.isArray(features)) throw new Error('提示词模板设置必须为对象');
        const previous = readExtensionVariables(snapshot.extensionVariables, 'EjsTemplate');
        const next = normalizeTemplateFeatures({ ...previous, ...features });
        replaceVariables({ ...previous, ...features, ...next }, { type: 'extension', extension_id: 'EjsTemplate' });
    },
    resetFeatures: () => replaceVariables({ ...defaultTemplateFeatures }, { type: 'extension', extension_id: 'EjsTemplate' }),
    };
    return api;
}
const EjsTemplate = templateExports();
async function templateApi<T>(run: (runtime: TemplateRuntime) => Promise<T>, refresh = false, nested?: TemplateRuntime): Promise<T> {
    if (transaction) throw new Error('MVU 结算期间不能提交独立模板任务');
    if (residentTemplates.isExecuting && nested === residentTemplates.current && nested) {
        if (refresh) throw new Error('模板正在执行时不能递归刷新预加载');
        return run(nested);
    }
    return residentTemplates.api(async () => {
        await flush();
        const input: AssemblePromptInput = await request('template.input');
        input.templateApi = true;
        if (refresh) { input.templateTask = { type: 'preload' }; input.templateForcePreload = true; }
        return input;
    }, run);
}
class RawCharacter {
    constructor(private data: any) {}
    static findIndex(name = 'current') { return snapshot.assetCatalog.characters.findIndex(card => name === 'current' ? card.id === snapshot.character.id : [card.name, card.avatar, card.id].some(value => value.toLowerCase() === name.toLowerCase())); }
    static find({ name = 'current' } = {}) { return snapshot.assetCatalog.characters[this.findIndex(name)]?.raw ?? null; }
    static getChatsFromFiles(data: any[], isGroupChat = false) { if (isGroupChat) return Promise.reject(new Error('当前工作区尚未支持群聊归档')); return request('chat.archives', { files: data.map(item => item.file_name) }); }
    getCardData() { return this.data; }
    getAvatarId() { return this.data.avatar ?? ''; }
    getRegexScripts() { return this.data.data?.extensions?.regex_scripts ?? []; }
    getCharacterBook() { return this.data.data?.character_book ?? null; }
    getWorldName() { return this.data.data?.extensions?.world ?? ''; }
}
const helper: Record<string, any> = {
    ...createExtensionApi(() => snapshot.extensions, (method, params) => request(method, params, 600000)),
    registerMacroLike, unregisterMacroLike,
    substitudeMacros: (text: string) => applyMacroLikes(evaluateMacros(applyHostMacros(text), { userName: snapshot.userName, charName: snapshot.character.name,
        chatId: snapshot.session, modelName: snapshot.modelSettings.model, maxContextTokens: snapshot.modelSettings.maxContext, maxResponseTokens: snapshot.modelSettings.maxResponse,
        messageCount: chat.length, currentSwipe: chat.at(-1)?.swipe_id, swipeCount: chat.at(-1)?.swipes?.length, lastMessageTime: snapshot.messages.at(-1)?.createdAt,
        ...(() => { const raw = snapshot.assetCatalog.characters.find(card => card.id === snapshot.character.id)?.raw as any; const card = raw?.data ?? raw ?? {};
            return { characterDescription: card.description, characterPersonality: card.personality, scenario: card.scenario, characterPrompt: card.system_prompt,
                characterJailbreak: card.post_history_instructions, examples: card.mes_example, personaDescription: snapshot.personas.find(persona => persona.avatar_id === snapshot.activePersonaId)?.description }; })(),
        lastMessageId: chat.length - 1, lastMessage: chat.at(-1)?.mes, lastUserMessage: [...chat].reverse().find(message => message.is_user)?.mes,
        lastCharMessage: [...chat].reverse().find(message => !message.is_user && !message.is_system)?.mes,
        variables: metadata.variables, globalVariables: snapshot.scopes.global,
        variableScopes: { ...snapshot.scopes, chat: metadata.variables, message: chat.at(-1)?.variables?.[chat.at(-1)?.swipe_id] ?? {} } })),
    errorCatched: (fn: (...args: any[]) => any) => (...args: any[]) => {
        const report = (error: unknown): never => { diagnostic(fn.name || '作者函数', error); throw error; };
        try { const result = fn(...args); return result && typeof result.then === 'function' ? Promise.resolve(result).catch(report) : result; }
        catch (error) { return report(error); }
    },
    builtin: {
        getImageTokenCost, getVideoTokenCost,
        uuidv4: () => crypto.randomUUID(), renderMarkdown: formatTemplateMarkdown,
        copyText: (text: string) => {
            if (navigator.clipboard?.writeText) {
                void navigator.clipboard.writeText(text).catch(() => void request('ui.copy', { text }).catch(error => diagnostic('剪贴板', error)));
                return;
            }
            void request('ui.copy', { text }).catch(error => diagnostic('剪贴板', error));
        },
        duringGenerating: () => snapshot.generating || generationTasks.size > 0,
        parseRegexFromString: (value: string) => { try { const match = /^\/([\s\S]*)\/([dgimsuvy]*)$/.exec(value); return match ? new RegExp(match[1], match[2]) : new RegExp(value); } catch { return null; } },
        saveSettings: async () => { await saveExtensionSettings(); await flush(); await request('template.save'); },
        reloadChatWithoutEvents: async () => { await request('runtime.refresh'); for (const row of rows.values()) disposeRow(row.element); rows.clear(); renderMessages(); },
        reloadAndRenderChatWithoutEvents: async () => {
            await helper.builtin.reloadChatWithoutEvents();
            for (const message of snapshot.messages) await emit(message.role === 'user' ? events.USER_MESSAGE_RENDERED : events.CHARACTER_MESSAGE_RENDERED, message.floor);
        },
        reloadEditor: () => request('runtime.sync'), reloadEditorDebounced: _.debounce(() => request('runtime.sync'), 100),
        renderPromptManager: () => request('runtime.sync'), renderPromptManagerDebounced: _.debounce(() => request('runtime.sync'), 100),
        promptManager: {
            render: () => request('runtime.sync'),
            renderDebounced: _.debounce(() => request('runtime.sync'), 100),
            get messages() { return [{ identifier: 'tipsy-assembled', collection: snapshot.assembledMessages.map(message => ({ identifier: message.sourceId, role: message.role, content: message.content, tokens: message.tokens })) }]; },
            getPromptCollection: () => ({ collection: [...snapshot.assetCatalog.inUsePreset.prompts, ...snapshot.assetCatalog.inUsePreset.prompts_unused].map(prompt => ({
                identifier: prompt.id, name: prompt.name, enabled: prompt.enabled, role: prompt.role, content: prompt.content ?? '',
                injection_position: prompt.position?.type === 'in_chat' ? 1 : 0, injection_depth: prompt.position?.depth ?? 4, injection_order: prompt.position?.order ?? 100,
                system_prompt: systemPromptIds.includes(prompt.id) || placeholderPromptIds.includes(prompt.id), marker: placeholderPromptIds.includes(prompt.id), extra: prompt.extra,
            })) }),
        },
        addOneMessage: (message: any, options: any = {}) => {
            const floor = options.forceId ?? chat.length;
            const article = document.createElement('article'); article.className = `mes is-${message.is_user ? 'user' : 'assistant'}`; article.setAttribute('mesid', String(floor));
            const heading = document.createElement('header'); heading.textContent = String(message.name ?? ''); article.append(heading);
            const body = document.createElement('div'); body.className = 'mes_text';
            const source = displayedSource(String(message.extra?.display_text ?? message.mes ?? ''), floor, message.is_user ? 'user' : message.is_system ? 'system' : 'assistant');
            for (const block of extractHtmlSandboxBlocks(source)) {
                if (block.type === 'markdown') { const prose = document.createElement('div'); prose.className = 'compat-prose message-markdown'; prose.innerHTML = renderMessageMarkdown(block.content); body.append(prose); }
                else body.append(createChild(block.type === 'mixed' ? renderMixedMessage(block.content) : block.content, floor));
            }
            article.append(body);
            const before = options.insertBefore == null ? null : root.querySelector(`.mes[mesid="${Number(options.insertBefore)}"]`);
            const after = options.insertAfter == null ? null : root.querySelector(`.mes[mesid="${Number(options.insertAfter)}"]`);
            if (before) before.before(article); else if (after) after.after(article); else root.append(article);
            if (options.scroll !== false) article.scrollIntoView({ block: 'end' });
        },
    },
    getLorebookSettings: () => structuredClone(snapshot.worldinfoSettings),
    setLorebookSettings: (settings: Record<string, unknown>) => {
        snapshot.worldinfoSettings = { ...snapshot.worldinfoSettings, ...settings };
        track(request('worldbook.settings', { settings }));
    },
    getProxyPresetNames: () => (snapshot?.proxyPresets ?? []).map(({ name }) => name),
    __tipsyBindAvsProxyPanel: (panel: Parameters<typeof bindAvsProxyPanel>[0]) => bindAvsProxyPanel(panel,
        name => snapshot?.proxyPresets?.find(preset => preset.name === name)?.model ?? '',
        name => request('generation.models', { api: { proxy_preset: name } })),
    getModelList: (api: { apiurl?: string; key?: string; source?: string; proxy_preset?: string }) => request('generation.models', { api }),
    ...createAudioRuntime(() => readExtensionVariables(snapshot.extensionVariables, 'tipsy_audio'), value => replaceVariables(value, { type: 'extension', extension_id: 'tipsy_audio' }), error => diagnostic('音频', error)),
    getTavernFile: async (filename: string) => {
        if (/^(?:https?:|data:|blob:)/i.test(filename)) return fetch(filename);
        const file = await request('file.get', { filename });
        if (!file) return new Response('File not found', { status: 404 });
        return new Response(Uint8Array.from(atob(file.base64), char => char.charCodeAt(0)), { headers: { 'Content-Type': file.contentType } });
    },
    uploadTavernFile: (filename: string, base64: string) => track(request('file.upload', { filename, base64 })),
    deleteTavernFile: (filename: string) => track(request('file.delete', { filename })),
    getPersonaNames: () => snapshot.personas.map(persona => persona.name),
    getPersonaIds: () => snapshot.personas.map(persona => persona.avatar_id),
    getCurrentPersonaName: () => snapshot.personas.find(persona => persona.avatar_id === snapshot.activePersonaId)?.name ?? null,
    getCurrentPersonaId: () => snapshot.activePersonaId,
    getPersona: (name = 'current') => {
        const found = snapshot.personas.filter(persona => name === 'current' ? persona.avatar_id === snapshot.activePersonaId : persona.avatar_id === name || persona.name.toLowerCase() === name.toLowerCase());
        if (found.length !== 1) throw new Error(`persona 不存在或名称不唯一：${name}`);
        const { image: _image, ...value } = found[0]; return structuredClone(value);
    },
    getPersonaAvatarPath: (name = 'current') => {
        try { const persona = helper.getPersona(name); return snapshot.personas.find(item => item.avatar_id === persona.avatar_id)?.image || null; } catch { return null; }
    },
    createPersona: (name: string, value?: any, options?: any) => track(request('persona.create', { name, value, options })),
    createOrReplacePersona: (name: string, value?: any, options?: any) => track(request('persona.upsert', { name, value, options })),
    replacePersona: (name: string, value: any, options?: any) => track(request('persona.replace', { name, value, options })),
    deletePersona: (name: string) => track(request('persona.delete', { name })),
    updatePersonaWith: async (name: string, updater: (value: any) => any, options?: any) => {
        const value = await updater(helper.getPersona(name)); await helper.replacePersona(name, value, options); return helper.getPersona(name);
    },
    RawCharacter,
    getCharData: (name = 'current') => RawCharacter.find({ name }),
    getCharAvatarPath: (name = 'current') => snapshot.assetCatalog.characters[RawCharacter.findIndex(name)]?.image ?? null,
    getChatHistoryBrief: (name = 'current') => {
        const card = snapshot.assetCatalog.characters[RawCharacter.findIndex(name)];
        return card ? request('chat.archives', { characterId: card.id }) : Promise.resolve(null);
    },
    getChatHistoryDetail: (data: any[], isGroupChat = false) => RawCharacter.getChatsFromFiles(data, isGroupChat),
    importRawCharacter: async (name: string, content: Blob) => {
        await track(request('asset.import.character', { name, content })); return new Response(JSON.stringify({ file_name: name.replace(/\.(png|json)$/i, '') + '.png' }), { headers: { 'Content-Type': 'application/json' } });
    },
    importRawChat: async (_name: string, content: string) => {
        const id = await track(request('chat.import', { content })); return new Response(JSON.stringify({ res: true, file_name: `${id}.jsonl` }), { headers: { 'Content-Type': 'application/json' } });
    },
    importRawPreset: (name: string, content: string) => track(request('asset.import.preset', { name, content })).then(() => true, () => false),
    importRawWorldbook: (name: string, content: string) => track(request('asset.import.worldbook', { name, content })).then(() => true, () => false),
    importRawTavernRegex: (name: string, content: string) => {
        const raw = JSON.parse(content); if (typeof raw.findRegex !== 'string') return false;
        const rule = normalizeRegexScripts([{ ...raw, id: crypto.randomUUID(), scriptName: name }])[0];
        const rules = [...snapshot.regexCatalog.global, rule]; snapshot.regexCatalog = { ...snapshot.regexCatalog, global: rules };
        track(request('regex.replace', { regexes: rules.map(toTavernRegex), option: { type: 'global' } })); return true;
    },
    getScriptTrees: (option: { type: ScriptScope }) => {
        if (!snapshot.scriptTrees[option?.type]) throw new Error('脚本作用域必须为 global、preset 或 character');
        return structuredClone(snapshot.scriptTrees[option.type]);
    },
    replaceScriptTrees: (values: any[], option: { type: ScriptScope }) => {
        if (!snapshot.scriptTrees[option?.type]) throw new Error('脚本作用域必须为 global、preset 或 character');
        const trees = normalizeScriptTrees(values);
        snapshot.scriptTrees = { ...snapshot.scriptTrees, [option.type]: trees };
        track(request('scripts.replace', { trees, type: option.type }));
    },
    updateScriptTreesWith: (updater: (trees: any[]) => any, option: { type: ScriptScope }) => {
        const value = updater(helper.getScriptTrees(option));
        const commit = (trees: any[]) => { helper.replaceScriptTrees(trees, option); return helper.getScriptTrees(option); };
        return value && typeof value.then === 'function' ? value.then(commit) : commit(value);
    },
    retrieveDisplayedMessage: (floor: number) => $(`.mes[mesid="${Number(floor)}"] .mes_text`),
    formatAsDisplayedMessage: (text: string, option: any = {}) => {
        const target = option.message_id ?? 'last';
        const lastRole = (role: string) => { for (let index = chat.length - 1; index >= 0; index--) if (chat[index].role === role) return index; return -1; };
        const floor = target === 'last' ? chat.length - 1 : target === 'last_user' ? lastRole('user') : target === 'last_char' ? lastRole('assistant') : Number(target);
        if (!Number.isInteger(floor) || !chat[floor]) throw new Error('消息楼层不存在');
        return formatMarkdownWithHooks(text, floor, Boolean(chat[floor].is_system), chat[floor].role === 'user', formatTemplateMarkdown);
    },
    refreshOneMessage: async (floor: number, target?: ReturnType<typeof $>) => {
        const node = snapshot.messages[floor];
        if (!node || !rows.has(node.id)) return;
        if (target?.length) {
            const rendered = resolveRenderedMessageContent(node);
            let html = formatTemplateMarkdown(rendered);
            if (hasFormatterStage('afterMarkdown')) {
                html = runFormatterStage('afterMarkdown', html, { messageId: floor, isSystem: Boolean(node.isHidden), isUser: node.role === 'user' });
            }
            target.find('.mes_text').html(html); return;
        }
        repaintMessageBlock(floor);
    },
    getCharacterNames: () => snapshot.assetCatalog.characters.map(card => card.name),
    getCharacterIds: () => snapshot.assetCatalog.characters.map(card => card.avatar),
    getCurrentCharacterName: () => snapshot.character.name || null,
    getCurrentCharacterId: () => snapshot.assetCatalog.characters.find(card => card.id === snapshot.character.id)?.avatar ?? null,
    getCharacter: (name: string) => track(request('asset.character.get', { name })),
    createCharacter: (name: string, value?: any) => track(request('asset.character.create', { name, value })),
    createOrReplaceCharacter: (name: string, value?: any, options?: any) => track(request('asset.character.upsert', { name, value, options })),
    deleteCharacter: (name: string, options?: any) => track(request('asset.character.delete', { name, options })),
    replaceCharacter: (name: string, value: any, options?: any) => track(request('asset.character.replace', { name, value, options })),
    updateCharacterWith: async (name: string, updater: (value: any) => any, options?: any) => {
        const value = await updater(await helper.getCharacter(name)); await helper.replaceCharacter(name, value, options); return helper.getCharacter(name);
    },
    default_preset: structuredClone(defaultHelperPreset),
    isPresetSystemPrompt: (prompt: any) => systemPromptIds.includes(prompt.id),
    isPresetPlaceholderPrompt: (prompt: any) => placeholderPromptIds.includes(prompt.id),
    isPresetNormalPrompt: (prompt: any) => !systemPromptIds.includes(prompt.id) && !placeholderPromptIds.includes(prompt.id),
    getPresetNames: () => ['in_use', ...snapshot.assetCatalog.presets.map(preset => preset.name)],
    getLoadedPresetName: () => snapshot.assetCatalog.loadedPresetName,
    getPreset: (name: string) => {
        const value = name === 'in_use' ? snapshot.assetCatalog.inUsePreset : snapshot.assetCatalog.presets.find(preset => preset.name === name)?.data;
        if (!value) throw new Error(`找不到预设：${name}`); return structuredClone(value);
    },
    loadPreset: (name: string) => {
        const selected = snapshot.assetCatalog.presets.find(preset => preset.name === name);
        if (!selected || name === 'in_use') return false;
        // The upstream call is synchronous; publish the selection locally before the RPC round trip.
        snapshot.assetCatalog = { ...snapshot.assetCatalog, loadedPresetName: name, inUsePreset: structuredClone(selected.data),
            ...(selected.native ? { inUseNativePreset: structuredClone(selected.native) } : {}) };
        syncNativePresetState(snapshot);
        snapshot.regexCatalog = { ...snapshot.regexCatalog, presetId: selected.id,
            inUse: snapshot.regexCatalog.presets.find(preset => preset.id === selected.id)?.rules ?? [] };
        lastNotifiedPresetName = name;
        void emit(events.OAI_PRESET_CHANGED_AFTER, name).catch(error => diagnostic('预设切换事件', error));
        track(request('asset.preset.load', { name })); return true;
    },
    createPreset: (name: string, value?: any) => track(request('asset.preset.create', { name, value })),
    createOrReplacePreset: (name: string, value?: any, options?: any) => track(request('asset.preset.upsert', { name, value, options })),
    deletePreset: (name: string) => track(request('asset.preset.delete', { name })),
    renamePreset: (name: string, newName: string) => track(request('asset.preset.rename', { name, newName })),
    replacePreset: (name: string, value: any, options?: any) => track(request('asset.preset.replace', { name, value, options })),
    updatePresetWith: async (name: string, updater: (value: any) => any, options?: any) => {
        const value = await updater(helper.getPreset(name)); await helper.replacePreset(name, value, options); return helper.getPreset(name);
    },
    setPreset: async (name: string, patch: any, options?: any) => {
        const value = _.mergeWith(helper.getPreset(name), patch, (_old: any, next: any) => Array.isArray(next) ? next : undefined);
        await helper.replacePreset(name, value, options); return helper.getPreset(name);
    },
    isCharacterTavernRegexesEnabled: () => true,
    getTavernRegexes: (option: any = {}) => {
        const catalog = snapshot.regexCatalog;
        const select = (type: string) => {
            if (type === 'global') return catalog.global;
            if (type === 'character') {
                const card = catalog.characters.find(card => !option.name || option.name === 'current' ? card.id === snapshot.character.id : [card.id, card.name, card.avatar].includes(option.name));
                if (!card) throw new Error(`找不到角色：${option.name}`); return card.rules;
            }
            if (type === 'preset') {
                if (!option.name || option.name === 'in_use') return catalog.inUse;
                const preset = catalog.presets.find(preset => !option.name || option.name === 'in_use' ? preset.id === catalog.presetId : preset.name === option.name || preset.id === option.name);
                if (!preset) throw new Error(`找不到预设：${option.name}`); return preset.rules;
            }
            throw new Error(`未知正则类型：${type}`);
        };
        if (option.type) return select(option.type).map(toTavernRegex);
        const scope = option.scope ?? 'all'; const enabled = option.enable_state ?? 'all';
        if (!['all', 'global', 'character'].includes(scope) || !['all', 'enabled', 'disabled'].includes(enabled)) throw new Error('正则 scope 或 enable_state 无效');
        return ['global', 'character'].filter(type => scope === 'all' || scope === type).flatMap(type => select(type).map(rule => ({ ...toTavernRegex(rule), scope: type })))
            .filter(rule => enabled === 'all' || rule.enabled === (enabled === 'enabled'));
    },
    replaceTavernRegexes: async (regexes: any[], option: any = {}) => {
        await track(request('regex.replace', { regexes, option }));
        await emit(events.CHAT_CHANGED, snapshot.session);
    },
    updateTavernRegexesWith: async (updater: (rules: any[]) => any, option: any = {}) => {
        const next = await updater(helper.getTavernRegexes(option)); await helper.replaceTavernRegexes(next, option); return next;
    },
    formatAsTavernRegexedString: (text: string, source: typeof regexSources[number], destination: string, option: any = {}) => {
        if (!regexSources.includes(source) || !['display', 'prompt'].includes(destination)) throw new Error('正则来源或目标无效');
        const catalog = snapshot.regexCatalog;
        const card = catalog.characters.find(card => option.character_name ? [card.name, card.id, card.avatar].includes(option.character_name) : card.id === snapshot.character.id);
        const rules = orderedRegexScripts(catalog.global, catalog.inUse, card?.rules);
        const macro = { userName: snapshot.userName, charName: card?.name ?? snapshot.character.name, variables: metadata.variables, globalVariables: snapshot.scopes.global,
            variableScopes: { ...snapshot.scopes, chat: metadata.variables, message: chat.at(-1)?.variables?.[chat.at(-1)?.swipe_id] ?? {} },
            lastMessageId: chat.length - 1, lastMessage: chat.at(-1)?.mes };
        return evaluateMacros(applyRegexScripts(text, rules, { stage: source, role: source === 'user_input' ? 'user' : source === 'ai_output' ? 'assistant' : 'system',
            isPrompt: destination === 'prompt', isMarkdown: destination === 'display', depth: option.depth, ignoreDepth: option.depth === undefined, macroContext: macro }), macro);
    },
    registerVariableSchema,
    getVariables: (option: any) => structuredClone(variables(option)), replaceVariables,
    insertOrAssignVariables: (value: any, option: any) => updateVariablesWith((old: any) => _.mergeWith(old, value, (_a: any, b: any) => Array.isArray(b) ? b : undefined), option),
    insertVariables: (value: any, option: any) => updateVariablesWith((old: any) => _.mergeWith({}, value, old, (_a: any, b: any) => Array.isArray(b) ? b : undefined), option),
    updateVariablesWith,
    deleteVariable: (path: string, option: any) => {
        if (_.toPath(path).some((part: string) => ['__proto__', 'prototype', 'constructor'].includes(part))) throw new Error('无效变量路径');
        let delete_occurred = false;
        const value = updateVariablesWith((old: any) => { delete_occurred = _.unset(old, path); return old; }, option);
        return { variables: value, delete_occurred };
    },
    getChatMessages,
    setChatMessage: async (message: string | { message?: string; data?: Record<string, any> }, floor: any = chat.length - 1, options: any = {}) => {
        if (transaction) throw new Error('MVU 结算期间请通过 BEFORE_MESSAGE_UPDATE 修改正文');
        const result = await track(request('chat.setMessage', { message, floor, options }));
        if (chat.length === 1 && snapshot.messages[0]?.extra?.tipsy_mvu_initialization_pending) await initializeMvuSession();
        const resolvedFloor = floor === undefined ? chat.length - 1 : Number(floor) < 0 ? chat.length + Number(floor) : Number(floor);
        if (options.refresh === 'display_and_render_current' && Number.isInteger(resolvedFloor) && chat[resolvedFloor]) {
            await emit(chat[resolvedFloor].role === 'user' ? events.USER_MESSAGE_RENDERED : events.CHARACTER_MESSAGE_RENDERED, resolvedFloor);
        }
        return result;
    },
    setChatMessages: async (messages: any[], options: any = {}) => {
        if (transaction) throw new Error('MVU 结算期间请通过 BEFORE_MESSAGE_UPDATE 修改正文');
        const affected = await track(request('chat.setMessages', { messages, options }));
        if (chat.length === 1 && snapshot.messages[0]?.extra?.tipsy_mvu_initialization_pending) await initializeMvuSession();
        await refreshHelperMessages(affected, options.refresh);
    },
    createChatMessages: async (messages: any[], options: any = {}) => {
        if (transaction) throw new Error('MVU 结算期间不能改变消息结构');
        const affected = await track(request('chat.createMessages', { messages, options }));
        // Authors using refresh:none publish their own events after preparing message data.
        // refresh:all reloads the chat instead of emitting per-message lifecycle events.
        if ((options.refresh ?? 'affected') === 'affected') {
            for (const message of affected) await emit(message.role === 'user' ? events.MESSAGE_SENT : events.MESSAGE_RECEIVED, message.message_id, 'extension');
        }
        await refreshHelperMessages(affected, options.refresh);
    },
    deleteChatMessages: async (ids: number[], options: any = {}) => {
        if (transaction) throw new Error('MVU 结算期间不能改变消息结构');
        await refreshHelperMessages(await track(request('chat.deleteMessages', { ids, options })), options.refresh);
    },
    rotateChatMessages: async (begin: number, middle: number, end: number, options: any = {}) => {
        if (transaction) throw new Error('MVU 结算期间不能改变消息结构');
        await refreshHelperMessages(await track(request('chat.rotateMessages', { begin, middle, end, options })), options.refresh);
    },
    triggerSlash: (command: string) => runAuthorSlash(command),
    triggerSlashWithResult: (command: string) => helper.triggerSlash(command),
    generate: (options: HelperGenerationConfig = {}) => generate(options),
    generateRaw: (options: HelperGenerationConfig = {}) => generate(options, true),
    stopGenerationById,
    stopAllGeneration: () => { for (const id of generationTasks.keys()) stopGenerationById(id); return true; },
    placeholder_prompt_default_order: [...placeholderPromptDefaultOrder], builtin_prompt_default_order: [...placeholderPromptDefaultOrder],
    getCurrentMessageId: () => chat.length - 1, getCurrentChatId: () => snapshot.session,
    getLastMessageId: () => chat.length - 1, getScriptId: () => '',
    getWorldbookNames: () => [...snapshot.worldbookBindings.names],
    getGlobalWorldbookNames: () => [...snapshot.worldbookBindings.global],
    rebindGlobalWorldbooks: (names: string[]) => track(request('worldbook.bindGlobal', { names })),
    getCharWorldbookNames: (character = 'current') => {
        const match = snapshot.worldbookBindings.characters.filter(card => character === 'current' ? card.id === snapshot.character.id : [card.id, card.name, card.avatar].includes(character));
        if (match.length !== 1) throw new Error(`角色不存在或名称不唯一：${character}`);
        return structuredClone(match[0].books);
    },
    rebindCharWorldbooks: (character: string, books: any) => track(request('worldbook.bindCharacter', { character, books })),
    getChatWorldbookName: (chat = 'current') => { if (chat !== 'current') throw new Error('目前仅支持当前聊天世界书'); return snapshot.worldbookBindings.chat; },
    rebindChatWorldbook: (chat: string, name: string) => track(request('worldbook.bindChat', { chat, name })),
    getOrCreateChatWorldbook: (chat: string, name?: string) => track(request('worldbook.getOrCreateChat', { chat, name })),
    getWorldbook: async (name: string) => structuredClone((await readHelperWorldbook(name)).entries),
    createWorldbook: (name: string, entries: any[] = []) => track(request('worldbook.create', { name, entries })),
    createOrReplaceWorldbook: (name: string, entries: any[] = [], options?: any) => track(request('worldbook.createOrReplace', { name, entries, options })),
    deleteWorldbook: (name: string) => track(request('worldbook.delete', { name })),
    replaceWorldbook: (name: string, entries: any[], options?: any) => track(request('worldbook.replace', { name, entries, options }).then(() => undefined)),
    updateWorldbookWith: async (name: string, fn: any, options?: any) => {
        if (typeof fn !== 'function') throw new Error('世界书 updater 必须是函数');
        const { entries, version } = await readHelperWorldbook(name);
        const next = await fn(structuredClone(entries));
        if (!Array.isArray(next) || next.length !== entries.length || next.some((entry, index) => entry?.uid !== entries[index].uid)) {
            const result = await track(request('worldbook.replace', { name, entries: next, options, version }));
            helperWorldbookCache.delete(name);
            return result;
        }
        const changes = next.flatMap((entry, index) => {
            const previous = entries[index];
            const fields = Object.fromEntries(Object.entries(entry).filter(([key, value]) => !Object.hasOwn(previous, key) || !_.isEqual(value, previous[key])));
            const removed = Object.keys(previous).filter(key => !Object.hasOwn(entry, key));
            return Object.keys(fields).length || removed.length ? [{ index, uid: entry.uid, fields, removed }] : [];
        });
        const result = await track(request('worldbook.update', { name, changes, options, version }));
        const updated = [...entries];
        for (const change of result.changes) updated[change.index] = change.entry;
        helperWorldbookCache.set(name, { version: result.version, entries: updated });
        return structuredClone(updated);
    },
    createWorldbookEntries: (name: string, entries: any[], options?: any) => track(request('worldbook.append', { name, entries, options })),
    deleteWorldbookEntries: async (name: string, predicate: any, options?: any) => {
        if (typeof predicate !== 'function') throw new Error('世界书 predicate 必须是函数');
        const current = await readHelperWorldbook(name);
        const entries = structuredClone(current.entries), version = current.version;
        const deleted_entries = _.remove(entries, predicate);
        const worldbook = await track(request('worldbook.replace', { name, entries, options, version }));
        return { worldbook, deleted_entries };
    },
    getLorebooks: () => helper.getWorldbookNames(),
    createLorebook: (name: string) => helper.createWorldbook(name), deleteLorebook: (name: string) => helper.deleteWorldbook(name),
    getCharLorebooks: (options: { name?: string } = {}) => helper.getCharWorldbookNames(options.name ?? 'current'),
    getCurrentCharPrimaryLorebook: () => helper.getCharWorldbookNames('current').primary,
    setCurrentCharLorebooks: (books: any) => helper.rebindCharWorldbooks('current', { ...helper.getCharWorldbookNames('current'), ...books }),
    getChatLorebook: () => helper.getChatWorldbookName('current'),
    setChatLorebook: (name: string | null) => helper.rebindChatWorldbook('current', name),
    getOrCreateChatLorebook: (name?: string) => {
        const current = helper.getChatWorldbookName('current');
        if (current) return Promise.resolve(current);
        if (name && helper.getWorldbookNames().includes(name)) return Promise.reject(new Error(`聊天世界书「${name}」已存在`));
        return helper.getOrCreateChatWorldbook('current', name ?? `Chat Book ${snapshot.session}`.replace(/[^a-z0-9]/gi, '_').replace(/_{2,}/g, '_').slice(0, 64));
    },
    getLorebookEntries: async (name: string, options: any = {}) => (await request('worldbook.legacy.read', { name, filter: options.filter })).entries,
    replaceLorebookEntries: async (name: string, entries: any[]) => { await track(request('worldbook.legacy.replace', { name, entries })); },
    updateLorebookEntriesWith: async (name: string, updater: any) => {
        if (typeof updater !== 'function') throw new Error('旧版世界书 updater 必须为函数');
        const before = await request('worldbook.legacy.read', { name });
        return (await track(request('worldbook.legacy.replace', { name, entries: await updater(before.entries), version: before.version }))).entries;
    },
    setLorebookEntries: async (name: string, entries: any[]) => (await track(request('worldbook.legacy.set', { name, entries }))).entries,
    createLorebookEntries: async (name: string, entries: any[]) => {
        const result = await track(request('worldbook.legacy.append', { name, entries }));
        return { entries: result.entries, new_uids: result.new_uids };
    },
    deleteLorebookEntries: async (name: string, uids: number[]) => {
        const result = await track(request('worldbook.legacy.delete', { name, uids }));
        return { entries: result.entries, delete_occurred: result.delete_occurred };
    },
    createLorebookEntry: async (name: string, entry: any) => (await helper.createLorebookEntries(name, [entry])).new_uids[0],
    deleteLorebookEntry: async (name: string, uid: number) => (await helper.deleteLorebookEntries(name, [uid])).delete_occurred,
    eventOn: (e: string, f: any) => ({ stop: eventOn(e, f) }),
    eventOff,
    eventMakeFirst: (e: string, f: any) => ({ stop: eventOn(e, f, -1) }),
    eventMakeLast: (e: string, f: any) => ({ stop: eventOn(e, f, 1) }), eventRemoveListener: eventOff,
    eventOnce: (e: string, f: any) => ({ stop: eventOnce(e, f) }), eventEmit: emit, eventEmitAndWait: emitAndWait,
    saveChatDebounced,
    eventClearEvent: (event: string) => { listeners.delete(canonicalEvent(event)); },
    eventClearListener: (fn: (...args: any[]) => any) => { for (const event of listeners.keys()) eventOff(event, fn); },
    eventClearAll: () => listeners.clear(),
    initializeGlobal, waitGlobalInitialized,
    getButtonEvent: (name: string) => `compat:button:${name}`,
    getScriptButtons: () => initialScripts.flatMap(script => script.buttons),
    getAllEnabledScriptButtons: () => Object.fromEntries([...scriptButtons].map(([id, buttons]) => [id,
        buttons.filter(button => button.visible).map(button => ({ button_id: buttonEvent(id, button.name), button_name: button.name }))])),
    injectPrompts: (items: any[], options?: any) => {
        if (!Array.isArray(items)) throw new Error('提示词注入必须是数组');
        const prompts = items.map(item => ({ ...normalizePromptInjection(item, item?.id ?? crypto.randomUUID(), true), filter: item.filter }));
        for (const prompt of prompts) injected.set(prompt.id, prompt);
        let removed = false;
        const unsubscribes: Array<() => void> = [];
        const remove = () => {
            if (removed) return;
            removed = true;
            for (const prompt of prompts) if (injected.get(prompt.id) === prompt) injected.delete(prompt.id);
            for (const unsubscribe of unsubscribes) unsubscribe();
            window.removeEventListener('pagehide', remove);
        };
        if (options?.once) {
            for (const event of [events.GENERATION_ENDED, events.GENERATION_STOPPED]) unsubscribes.push(eventOn(event, remove));
            unsubscribes.push(eventOn(iframeEvents.GENERATION_ENDED, (_text: unknown, generationId?: string) => {
                const silent = Boolean(generationId && generationTasks.get(generationId)?.silent);
                if (shouldRemoveOnceInjectionsOnIframeGenerationEnded(silent)) remove();
            }));
        }
        window.addEventListener('pagehide', remove, { once: true });
        return Object.assign(remove, { uninject: remove });
    },
    uninjectPrompts: (ids: string[]) => ids.forEach(id => injected.delete(id)),
    registerMvuSchema,
};
const quickReplies = createQuickReplyRuntime({
    read: () => readExtensionVariables(snapshot.extensionVariables, 'quickReplyV2'),
    write: value => replaceVariables(value, { type: 'extension', extension_id: 'quickReplyV2' }),
    session: () => ({ chat: snapshot.session, character: snapshot.character.id }),
    slash: (source, scope) => runAuthorSlash(source, { scope }), expand: text => helper.substitudeMacros(text),
    input: text => request('composer.input', { text }),
    choice: (text, placement) => request('composer.choice', { text, placement, separator: ' ' }),
    send: async text => { await flush(); return request('slash.generate', { text }, 600000); },
    save: flush, report: error => diagnostic('自动快捷回复', error),
});
function processRuntimeRegex(text: string, stage: 'slash_command' | 'reasoning', character?: string): string {
    const catalog = snapshot.regexCatalog;
    const card = catalog.characters.find(card => character ? [card.id, card.name, card.avatar].includes(character) : card.id === snapshot.character.id);
    return applyRegexScripts(text, orderedRegexScripts(catalog.global, catalog.inUse, card?.rules), { stage, role: 'assistant',
        macroContext: { userName: snapshot.userName, charName: card?.name ?? snapshot.character.name, variables: metadata.variables, globalVariables: snapshot.scopes.global } });
}

async function interceptGenerationHistory(type: string): Promise<{ aborted: boolean; history?: InterceptedHistoryMessage[] }> {
    const interceptors = loadedInterceptors.filter(({ key }) => typeof globals[key] === 'function');
    if (!interceptors.length) return { aborted: false };
    const source = await request('extension.interceptorInput') as Pick<AssemblePromptInput, 'globalRegexScripts' | 'initialVariables' | 'initialGlobalVariables'> & { presetRegex: AssemblePromptInput['preset']['regexScripts']; characterRegex: AssemblePromptInput['character']['regexScripts'] };
    const rules = orderedRegexScripts(source.globalRegexScripts, source.presetRegex, source.characterRegex);
    const visible = chat.filter(message => !message.is_system);
    const coreChat = visible.map((row, index) => {
        const role = row.is_user ? 'user' : row.role === 'system' ? 'system' : 'assistant';
        const mes = applyRegexScripts(row.mes, rules, { stage: 'prompt', isPrompt: true, role, depth: visible.length - index - 1,
            macroContext: { userName: snapshot.userName, charName: snapshot.character.name,
                variables: { ...source.initialVariables, ...row.variables[row.swipe_id] }, globalVariables: source.initialGlobalVariables } });
        const titles = [row.extra, ...(Array.isArray(row.extra?.media) ? row.extra.media : [])]
            .flatMap(item => item?.append_title && item.title ? [String(item.title)] : []);
        return { ...structuredClone(row), mes: titles.length ? `${mes}\n\n${titles.join('\n\n')}` : mes, index };
    });
    const known = new Set(visible.map(row => row._id));
    const history = () => coreChat.map(row => ({ messageId: known.has(row._id) ? row._id : undefined,
        role: row.is_user ? 'user' as const : row.is_system || row.role === 'system' ? 'system' as const : 'assistant' as const,
        content: String(row.mes ?? ''), speakerName: String(row.name ?? '') }));
    const before = history();
    let aborted = false, immediately = false;
    const abort = (exit = false) => { aborted = true; immediately = exit; };
    for (const { name, key } of interceptors) {
        try { await globals[key](coreChat, snapshot.modelSettings.maxContext, abort, type); }
        catch (error) { diagnostic(name, error); }
        if (immediately) break;
    }
    if (aborted) return { aborted };
    const after = history();
    return { aborted, history: _.isEqual(before, after) ? undefined : after };
}
installHostSlashCommands({ helper, register: rootSlashRegistration.SlashCommandParser.addCommandObject,
    request: (method, params) => request(method, params, ['slash.generate', 'mvu.reprocess', 'mvu.repair'].includes(method) ? 600000 : 30000),
    expand: text => helper.substitudeMacros(text), regex: (text, character) => processRuntimeRegex(text, 'slash_command', character),
    isTemplateExecuting: () => residentTemplates.isExecuting });
for (const name of ['qr', 'qr-arg', 'qr-set', 'qr-set-on', 'qr-set-off', 'qr-chat-set', 'qr-chat-set-on', 'qr-chat-set-off',
    'qr-set-list', 'qr-list', 'qr-get', 'qr-create', 'qr-update', 'qr-delete', 'qr-contextadd', 'qr-contextdel', 'qr-contextclear', 'qr-set-create', 'qr-set-update', 'qr-set-delete']) {
    rootSlashRegistration.SlashCommandParser.addCommandObject({ name, callback: (args: any, value: unknown) => quickReplies.command(name, args, value, args._scope) });
}
async function runAuthorSlash(command: string, options: SlashExecutionOptions = {}, interaction = false): Promise<string> {
    if (!interaction && residentTemplates.isExecuting) return residentTemplates.current!.executeCommand(command, options);
    const session = snapshot.session;
    try {
        return await executeSlashPipeline(command, {
            hasCommand: hasRegisteredSlashCommand,
            variables: {
                get: (key, global) => variables({ type: global ? 'global' : 'chat' })[key],
                set: (key, value, global) => { const option = { type: global ? 'global' as const : 'chat' as const }; replaceVariables({ ...variables(option), [key]: value }, option); },
                delete: (key, global) => { const option = { type: global ? 'global' as const : 'chat' as const }; const next = { ...variables(option) }; delete next[key]; replaceVariables(next, option); },
            },
            expand: text => evaluateMacros(text, { userName: snapshot.userName, charName: snapshot.character.name, variables: metadata.variables,
                globalVariables: snapshot.scopes.global, lastMessageId: chat.length - 1 }),
            echo: notify,
            send: async text => { await flush(); await helper.createChatMessages([{ role: 'user', message: text }]); },
            system: async text => { await flush(); await helper.createChatMessages([{ role: 'system', message: text }]); },
            generate: async text => { await flush(); return request('slash.generate', { text }, 600000); },
            quickReply: name => findExecutableQuickReply(quickReplies.config(), name),
            executeQuickReply: (reply, args, scope) => quickReplies.execute(reply, args, { isRun: true, scope }),
            command: async (name, args, value, scope) => {
                if (interaction) {
                    await residentTemplates.whenIdle();
                    if (snapshot.session !== session) throw new Error('指令所属聊天已切换');
                }
                if (name === 'ejs') return templateApi(async runtime => {
                    const data = typeof args.ctx === 'string' ? JSON.parse(args.ctx || '{}') : args.ctx ?? {};
                    return runtime.withEnvironment({ runType: 'command', isDryRun: false }, async () => {
                        const context = await runtime.prepareContext({ runType: 'command', isDryRun: false, ...data });
                        return runtime.evaluateExternal(args.block ? `<%= ${value} %>` : String(value), context);
                    });
                });
                if (name === 'ejs-refresh') { await EjsTemplate.refreshWorldInfo(); return ''; }
                return executeRegisteredSlashCommand(name, args, value, scope);
            },
        }, options);
    } finally { await flush(); }
}
async function runAuthorSlashWithResult(command: string, options: SlashExecutionOptions = {}): Promise<SlashCommandClosureResult> {
    const result = new SlashCommandClosureResult();
    await runAuthorSlash(command, { ...options, handleExecutionErrors: options.handleExecutionErrors ?? true, result });
    return result;
}
function registerMvuSchema(value: MvuSchemaProvider): void {
    const resolved = resolveMvuSchema(value);
    for (const dispose of mvuSchemaDisposers) dispose();
    schema = value;
    mvuVariableSchema = z.object({ stat_data: resolved });
    registerVariableSchema(mvuVariableSchema, { type: 'message' });
    mvuSchemaDisposers = [
        eventOn(mvuEvents.VARIABLE_INITIALIZED, async (variables: Record<string, any>) => {
            Object.assign(variables, await parseMvuVariables(variables, value));
        }),
        eventOn(`${mvuEvents.COMMAND_PARSED}_for_zod`, async (variables: Record<string, any>, commands: any[], _text: string, report?: (message: string) => void) => {
            await applyMvuSchemaCommands(variables, commands, value, (command, error) => {
                if (report) report(`${command?.full_match ?? ''}: ${error instanceof Error ? error.message : String(error)}`);
                else diagnostic(`MVU Zod ${command?.full_match ?? ''}`, error, '', 'warning');
            });
        }),
        eventOn(`${mvuEvents.COMMAND_PARSED}_ended_for_zod`, (_variables: unknown, commands: unknown[]) => { commands.length = 0; }),
        eventOn(`${mvuEvents.VARIABLE_UPDATE_ENDED}_for_zod`, (variables: Record<string, any>) => {
            variables.schema = '没有用别管这个'; delete variables.display_data; delete variables.delta_data;
        }),
    ];
}
async function refreshHelperMessages(affected: Array<{ message_id: number; role: string }>, refresh = 'affected'): Promise<void> {
    if (refresh === 'none') return;
    if (refresh === 'all') { await emit(events.CHAT_CHANGED, snapshot.session); return; }
    // Emit within the requesting author execution, avoiding a round trip queued
    // behind the event handler that is itself awaiting setChatMessages().
    for (const message of affected) await emit(message.role === 'user' ? events.USER_MESSAGE_RENDERED : events.CHARACTER_MESSAGE_RENDERED, message.message_id);
}
const Mvu = {
    events: mvuEvents,
    getMvuData: (option: any = {}) => structuredClone(variables(option)),
    replaceMvuData: async (value: any, option: any = {}) => { replaceVariables(value, option); await flush(); },
    parseMessage: async (text: string, before?: any) => (await settle(text, before ?? currentVariables(), true, true)).variables,
    reloadInitVar: async (value: Record<string, any>) => loadMvuInitialVariables(value, mvuInitialBooks(), text => mvuInitialMacros(text)),
    getCurrentMvuData: () => structuredClone(variables({ type: 'message', message_id: 'latest' })),
    replaceCurrentMvuData: async (value: any) => { replaceVariables(value, { type: 'message', message_id: 'latest' }); await flush(); },
    setMvuVariable: (value: any, path: string, next: any, options: { reason?: string; is_recursive?: boolean } = {}) =>
        setMvuVariable(value.stat_data, path, next, options.reason, options.is_recursive, (root, key, old, updated) => emit(mvuEvents.SINGLE_VARIABLE_UPDATED, root, key, old, updated)),
    getMvuVariable: (value: any, path: string, options: { category?: 'stat' | 'display' | 'delta'; default_value?: any } = {}) => {
        const result = _.get(Mvu.getRecordFromMvuData(value, options.category ?? 'stat'), mvuPathParts(path), options.default_value);
        return Array.isArray(result) && result.length === 2 && typeof result[1] === 'string' ? result[0] : result;
    },
    getRecordFromMvuData: (value: any, category: 'stat' | 'display' | 'delta') => value[`${category}_data`],
    isDuringExtraAnalysis: () => snapshot.mvuExtraAnalysisActive || residentTemplates.isExecuting && residentTemplates.current?.input.mvuExtraAnalysis === true,
};
function mvuInitialBooks() {
    const bindings = snapshot.worldbookBindings;
    const character = bindings.characters.find(item => item.id === snapshot.character.id)?.books;
    const names = [...new Set([...bindings.global, character?.primary, ...(character?.additional ?? [])])];
    return names.flatMap(name => snapshot.worldbooks.find(book => book.name === name) ?? []);
}
function mvuInitialMacros(text: string) {
    return evaluateMacros(text, { userName: snapshot.userName, charName: snapshot.character.name,
        variables: structuredClone(metadata.variables), globalVariables: structuredClone(snapshot.scopes.global),
        variableScopes: { ...snapshot.scopes, chat: metadata.variables, message: chat.at(-1)?.variables?.[chat.at(-1)?.swipe_id] ?? {} } });
}
async function initializeNewMvuBindings(): Promise<void> {
    const current = currentVariables();
    if (!current.stat_data && !schema) return;
    const initializedBooks = current.initialized_lorebooks ?? {};
    if (mvuInitialBooks().some(book => !Object.hasOwn(initializedBooks, book.name))) await initializeMvuSession();
}
async function initializeMvuSession(): Promise<void> {
    const first = snapshot.messages[0];
    if (!first) return;
    const source = currentVariables();
    const changed = loadMvuInitialVariables(source, mvuInitialBooks(), text => mvuInitialMacros(text));
    const isOpening = chat.length === 1 && first.extra?.tipsy_mvu_initialization_pending === true;
    if (!source.stat_data && !schema && !chat[0].swipes.some((text: string) => /<initvar\b/i.test(text))) return;
    const needsInitialization = isOpening || chat.length === 1 && !first.extra?.tipsy_mvu_initialized;
    if (!needsInitialization) {
        if (changed) {
            const current = currentVariables();
            loadMvuInitialVariables(current, mvuInitialBooks(), text => mvuInitialMacros(text));
            if (snapshot.mvuSettings.updateChat) replaceVariables(source, { type: 'chat' });
            replaceVariables(current, { type: 'message' }); await flush();
        }
        return;
    }
    const expected = { session: snapshot.session, messageId: first.id, swipes: [...chat[0].swipes], swipe: first.activeSwipeIndex,
        variables: structuredClone(metadata.variables),
        messageVariables: structuredClone(chat[0].variables), scopes: structuredClone(snapshot.scopes),
        scriptVariables: structuredClone(snapshot.scriptVariables), extensionVariables: structuredClone(snapshot.extensionVariables) };
    const candidates: Record<string, any>[] = []; const staged: VariableWrite[] = [];
    // Prepare inactive candidates without live UPDATE_ENDED side effects, then
    // initialize the selected opening last so its worldbook changes remain active.
    const swipeOrder = first.swipes.map((_, index) => index).filter(index => index !== first.activeSwipeIndex).concat(first.activeSwipeIndex);
    for (const swipe of swipeOrder) {
        outer.postMessage({ kind: 'compat:progress', token }, '*');
        let value = { ...structuredClone(source), ...structuredClone(chat[0].variables[swipe] ?? {}) };
        loadMvuInitialVariables(value, mvuInitialBooks(), text => mvuInitialMacros(text));
        if (isOpening || !value.stat_data) {
            const override = readMvuGreetingVariables(mvuInitialMacros(expected.swipes[swipe]));
            if (override) {
                value.stat_data = override;
                const primary = snapshot.worldbookBindings.characters.find(item => item.id === snapshot.character.id)?.books.primary;
                value.initialized_lorebooks = primary ? Object.fromEntries([[primary, []]]) : {};
                loadMvuInitialVariables(value, mvuInitialBooks(), text => mvuInitialMacros(text));
            }
        }
        value.stat_data ??= {};
        const result = await settle(isOpening ? expected.swipes[swipe] : '', value, isOpening, true,
            { message: chat[0], swipe, initialize: true, inactiveOpening: swipe !== first.activeSwipeIndex });
        candidates[swipe] = result.variables;
        if (swipe === first.activeSwipeIndex) staged.push(...result.writes ?? []);
    }
    await track(request('mvu.initialize', { expected, candidates, writes: staged }));
    await flush();
    if (snapshot.mvuSettings.notifyInitialized) notify('MVU 变量初始化完成。', 'success');
}
function currentVariables(): Record<string, any> {
    const latest = [...chat].reverse().find(m => m.variables?.[m.swipe_id]?.stat_data);
    return structuredClone(latest?.variables[latest.swipe_id] ?? metadata.variables);
}
async function settle(text: string, before: Record<string, any>, emitEnded: boolean, parseOnly = false,
    target?: { message: any; swipe: number; initialize?: boolean; skipMessageUpdate?: boolean; inactiveOpening?: boolean }, strict = false, messageContent = text) {
    if (transaction) throw new Error('MVU 结算期间不能递归执行另一轮结算');
    before = normalizeMvuVariables(before).variables;
    const next = structuredClone(before);
    transaction = next;
    transactionTarget = target ?? (chat.length ? { message: chat.at(-1), swipe: chat.at(-1).swipe_id } : undefined);
    transactionWrites = [];
    const previousMetadata = structuredClone(metadata.variables);
    const previousMessages = chat.map(m => structuredClone(m.variables));
    const previousScopes = structuredClone(snapshot.scopes);
    const previousScriptVariables = structuredClone(snapshot.scriptVariables);
    const previousExtensionVariables = structuredClone(snapshot.extensionVariables);
    const latest = transactionTarget?.message;
    const originalSwipe = latest?.swipe_id;
    const replaceNext = (value: Record<string, any>) => {
        const copy = structuredClone(value);
        for (const key of Object.keys(next)) delete next[key];
        Object.assign(next, copy);
    };
    try {
        if (latest) { latest.swipe_id = transactionTarget!.swipe; latest.variables[latest.swipe_id] = next; }
        next.stat_data ??= {};
        if (!_.isPlainObject(next.stat_data)) throw new Error('MVU stat_data 必须为对象');
        if (target?.initialize) await emit(mvuEvents.VARIABLE_INITIALIZED, next, target.swipe);
        if (target?.initialize && !emitEnded) {
            replaceNext(normalizeMvuVariables(next).variables);
            next.stat_data = mvuJsonValue(next.stat_data);
            await flush();
            return { variables: next, messageContent: text, writes: transactionWrites };
        }
        const hadMvuData = Object.hasOwn(before, 'stat_data') || !!schema || !!target?.initialize;
        const macroGlobals = structuredClone(snapshot.scopes.global);
        const macroChat = structuredClone(metadata.variables);
        const processedText = evaluateMacros(text, { userName: snapshot.userName, charName: snapshot.character.name,
            lastMessage: chat.at(-1)?.mes, lastUserMessage: [...chat].reverse().find(message => message.is_user)?.mes,
            lastCharMessage: [...chat].reverse().find(message => !message.is_user)?.mes,
            variables: macroChat, globalVariables: macroGlobals,
            variableScopes: { ...snapshot.scopes, chat: macroChat, message: next, global: macroGlobals },
            onSetVariable: () => replaceVariables(macroChat, { type: 'chat' }),
            onSetGlobalVariable: () => replaceVariables(macroGlobals, { type: 'global' }) });
        let plan: ReturnType<typeof readMvuCommands>;
        try {
            plan = readMvuCommands(processedText);
        } catch (error) {
            if (hadMvuData || strict) throw error;
            diagnostic('MVU 变量解析', error, '', 'warning');
            plan = { commands: [], patches: new WeakMap() };
        }
        if (!hadMvuData && !plan.commands.length) {
            delete next.stat_data;
            await flush();
            return { variables: next, messageContent: text, writes: parseOnly ? [] : transactionWrites };
        }
        next.stat_data.$internal = { display_data: structuredClone(next.stat_data), delta_data: {} };
        await emit(mvuEvents.VARIABLE_UPDATE_STARTED, next);
        await emit(mvuEvents.COMMAND_PARSED, next, plan.commands, text);
        const errors: string[] = [];
        await emit(`${mvuEvents.COMMAND_PARSED}_for_zod`, next, plan.commands, text, strict ? (message: string) => errors.push(message) : undefined);
        if (errors.length) throw new Error(`MVU 校正无效：${errors.join('；')}`);
        await emit(`${mvuEvents.COMMAND_PARSED}_ended_for_zod`, next, plan.commands, text);
        await applyMvuCommands(next, plan, {
            updated: (root, path, old, value) => emit(mvuEvents.SINGLE_VARIABLE_UPDATED, root, path, old, value),
            warning: (command, error) => {
                if (strict) throw error;
                diagnostic(`MVU 命令 ${command?.full_match ?? command?.type ?? ''}`, error, '', 'warning');
            },
        });
        const internal = next.stat_data.$internal;
        next.display_data = internal?.display_data ?? structuredClone(next.stat_data);
        next.delta_data = internal?.delta_data ?? {};
        if (emitEnded && !target?.inactiveOpening) await emit(mvuEvents.VARIABLE_UPDATE_ENDED, next, before);
        delete next.stat_data.$internal;
        if (!_.isEqual(next.stat_data, before.stat_data)) replaceNext(reconcileMvuVariables(next));
        if (emitEnded) await emit(`${mvuEvents.VARIABLE_UPDATE_ENDED}_for_zod`, next, before);
        // Registered Zod handled each command before UPDATE_ENDED. Running its
        // transforms again here would double-apply non-idempotent author logic.
        replaceNext(normalizeMvuVariables(next).variables);
        const message = { variables: next, message_content: messageContent };
        if (!parseOnly && !target?.skipMessageUpdate) await emit(mvuEvents.BEFORE_MESSAGE_UPDATE, message, before);
        if (typeof message.message_content !== 'string') throw new Error('BEFORE_MESSAGE_UPDATE 必须返回字符串消息内容');
        // MVU owns this marker: cards use display regexes to turn it into their
        // status panel even when the model did not emit a variable update block.
        if (!parseOnly && !target?.skipMessageUpdate && !latest?.is_user) {
            if (!message.message_content.includes('<StatusPlaceHolderImpl/>')) message.message_content += '\n\n<StatusPlaceHolderImpl/>';
            message.message_content = message.message_content.replace(/<(status_current_variable)>(?:(?!<\1>).)*<\/\1?>/gis, '');
        }
        replaceNext(normalizeMvuVariables(message.variables).variables);
        // Reject values the persistence layer would otherwise silently corrupt (NaN/undefined/functions).
        next.stat_data = mvuJsonValue(next.stat_data);
        await flush();
        return { variables: next, messageContent: message.message_content, writes: parseOnly && !target?.initialize ? [] : transactionWrites };
    } finally {
        // Results are staged until the host commits them. Cancellation must not leave a shadow commit here.
        metadata.variables = previousMetadata;
        chat.forEach((m, i) => { m.variables = previousMessages[i]; });
        snapshot.scopes = previousScopes;
        snapshot.scriptVariables = previousScriptVariables;
        snapshot.extensionVariables = previousExtensionVariables;
        if (latest) latest.swipe_id = originalSwipe;
        transaction = undefined; transactionTarget = undefined; transactionWrites = undefined;
        for (const delta of deferredDeltas.splice(0)) applyDelta(delta);
    }
}
async function settleSentMessage(floor: number): Promise<void> {
    const message = chat[floor];
    if (!message || message.is_system || message.role !== 'user') return;
    const previous = chat.slice(0, floor).reverse().find(item => item.variables?.[item.swipe_id]?.stat_data);
    const source = previous?.variables[previous.swipe_id] ?? metadata.variables;
    if (!source.stat_data) return;
    const expected = { session: snapshot.session, id: message._id, swipe: message.swipe_id, content: message.mes };
    const before = { ...structuredClone(message.variables[message.swipe_id] ?? {}), ...structuredClone(source) };
    const result = await settle(message.mes, before, true, false, { message, swipe: message.swipe_id, skipMessageUpdate: true });
    await request('mvu.message.commit', { expected, result });
}
async function settleExtensionMessage(floor: number): Promise<void> {
    // Author-owned generation may explicitly emit MESSAGE_RECEIVED with any public source.
    // Only the native pipeline's already-settled notification bypasses this listener.
    const message = chat[floor];
    if (!message || message.is_system || message.is_user || floor === 0 || message.mes.length < 5) return;
    if (!snapshot.mvuSettings.sendasAssistant && message.name !== snapshot.character.name) return;
    const previous = chat.slice(0, floor).reverse().find(item => item.variables?.[item.swipe_id]?.stat_data);
    const before = { ...structuredClone(message.variables[message.swipe_id] ?? {}), ...structuredClone(previous?.variables[previous.swipe_id] ?? metadata.variables) };
    if (!before.stat_data) return;
    const expected = { session: snapshot.session, id: message._id, swipe: message.swipe_id, content: message.mes };
    const content = await request('mvu.message.analyze', { expected, before }, 600000);
    const current = chat.find(item => item._id === expected.id);
    if (snapshot.session !== expected.session || !current || current.swipe_id !== expected.swipe || current.mes !== expected.content) throw new Error('额外解析期间消息已改变');
    const result = await settle(content, before, true, false, { message: current, swipe: expected.swipe });
    await request('mvu.message.commit', { expected, result });
}
function installApi(win: any, floor?: number, scriptId?: string) {
    installGallery(win);
    if (readingPresentation && win.document?.documentElement) applyReadingPresentation(readingPresentation, win.document);
    childDisposers.get(win)?.();
    if (scriptId && !scriptButtons.has(scriptId)) {
        const script = initialScripts.find(item => item.id === scriptId);
        if (script) {
            scriptButtons.set(scriptId, script.buttons.map(button => ({ name: button.name, visible: button.visible !== false })));
            scriptInfo.set(scriptId, script.info); renderButtons();
        }
    }
    const api = { ...helper };
    api.triggerSlash = async (command: string) => {
        try {
            const owner = templateCallbackOwners.get(win);
            return owner ? await owner.executeCommand(command) : await runAuthorSlash(command, {}, true);
        } catch (error) { diagnostic('角色互动指令', error, scriptId); throw error; }
    };
    api.triggerSlashWithResult = api.triggerSlash;
    const owned = new Map<string, Map<(...args: any[]) => any, { wrapper: (...args: any[]) => any; stop: () => void }>>();
    const cleanups = new Set<() => void>();
    const childPopupApi = popupApi(win);
    cleanups.add(() => disposePopups(win));
    if (scriptId && win.frameElement) {
        const expose = () => { if (!disposed) cleanups.add(exposeScriptSurface(win.frameElement)); };
        win.addEventListener('DOMContentLoaded', expose, { once: true });
        cleanups.add(() => win.removeEventListener('DOMContentLoaded', expose));
    }
    if (floor !== undefined) cleanups.add(observeReadingActivity(win, readingActivity));
    cleanups.add(observeSyncInteraction(win));
    const childSlashRegistration = slashRegistration(win, runAuthorSlash);
    cleanups.add(() => disposeSlashCommands(win));
    api.registerMacroLike = (regex: RegExp, replace: any) => registerMacroLike(regex, replace, win);
    cleanups.add(() => disposeMacroLikes(win));
    let disposed = false;
    const clearOwned = (event?: string, fn?: (...args: any[]) => any) => {
        if (event !== undefined) event = canonicalEvent(event);
        for (const [name, registrations] of owned) {
            if (event !== undefined && name !== event) continue;
            for (const [listener, registration] of registrations) if (!fn || fn === listener) registration.stop();
            if (!registrations.size) owned.delete(name);
        }
    };
    for (const name of ['eventOn', 'eventMakeFirst', 'eventMakeLast', 'eventOnce']) api[name] = (event: string, fn: (...args: any[]) => any) => {
        event = canonicalEvent(event);
        if (disposed) throw new Error('脚本文档已卸载，不能继续注册事件');
        if (typeof fn !== 'function') throw new Error('事件处理器必须为函数');
        const registrations = owned.get(event) ?? new Map();
        const existing = registrations.get(fn);
        const priority = name === 'eventMakeFirst' ? -1 : name === 'eventMakeLast' ? 1 : 0;
        if (existing) {
            // Reposition the original registration, retaining its once wrapper and stop handle.
            if (priority) eventOn(event, existing.wrapper, priority);
            return { stop: existing.stop };
        }
        const wrapper = (...args: any[]) => {
            const ownerName = scriptId ? initialScripts.find(script => script.id === scriptId)?.name || scriptId : `消息 #${floor}`;
            startupStage(`执行脚本回调：${ownerName} · ${event}`);
            if (name === 'eventOnce') clearOwned(event, fn);
            const runtime = residentTemplates.isExecuting && (event !== 'prompt_template_prepare' || residentTemplates.current?.ownsContext(args[0])) ? residentTemplates.current : undefined;
            if (!runtime) return fn(...args);
            const previous = templateCallbackOwners.get(win);
            templateCallbackOwners.set(win, runtime);
            return Promise.resolve().then(() => fn(...args)).finally(() => {
                if (previous) templateCallbackOwners.set(win, previous); else templateCallbackOwners.delete(win);
            });
        };
        const handle = eventOn(event, wrapper, priority);
        const stop = () => { handle(); registrations.delete(fn); if (!registrations.size) owned.delete(event); };
        registrations.set(fn, { wrapper, stop }); owned.set(event, registrations);
        return { stop };
    };
    api.eventRemoveListener = (event: string, fn: (...args: any[]) => any) => clearOwned(event, fn);
    api.eventClearEvent = (event: string) => clearOwned(event);
    api.eventClearListener = (fn: (...args: any[]) => any) => clearOwned(undefined, fn);
    api.eventClearAll = () => clearOwned();
    const dispose = () => {
        if (disposed) return;
        disposed = true; clearOwned();
        for (const cleanup of cleanups) cleanup();
        cleanups.clear(); childDisposers.delete(win);
    };
    childDisposers.set(win, dispose);
    win.addEventListener('pagehide', dispose, { once: true });
    api.registerVariableSchema = (value: z.ZodType<any>, options: { type: string }) => registerVariableSchema(value, options, win);
    let ownedMvuSchema: MvuSchemaProvider | undefined;
    api.registerMvuSchema = (value: MvuSchemaProvider) => { registerMvuSchema(value); ownedMvuSchema = value; };
    cleanups.add(() => {
        if (ownedMvuSchema && schema === ownedMvuSchema) {
            mvuSchemaDisposers.forEach(dispose => dispose()); mvuSchemaDisposers = []; schema = undefined;
            if (variableSchemas.get('message')?.schema === mvuVariableSchema) variableSchemas.delete('message');
            mvuVariableSchema = undefined;
        }
    });
    cleanups.add(() => { for (const [scope, entry] of variableSchemas) if (entry.owner === win) variableSchemas.delete(scope); });
    const option = (value: HelperVariableOption = {}): HelperVariableOption => ({ ...value,
        ...(value.type === 'script' && !value.script_id ? { script_id: scriptId } : {}),
        ...(floor !== undefined && value.type === 'message' && value.message_id === undefined ? { message_id: floor } : {}) });
    api.getVariables = (value: any) => helper.getVariables(option(value));
    for (const name of ['replaceVariables', 'insertVariables', 'insertOrAssignVariables', 'updateVariablesWith', 'deleteVariable']) {
        api[name] = (value: any, opt: any) => helper[name](value, option(opt));
    }
    api.getAllVariables = () => structuredClone(Object.assign({}, snapshot.scopes.global, snapshot.scopes.character,
        floor === undefined && scriptId ? snapshot.scriptVariables[scriptId] : {}, metadata.variables,
        ...chat.slice(0, floor === undefined ? chat.length : floor + 1).map(message => message.variables[message.swipe_id])));
    api.getCurrentMessageId = () => { if (floor === undefined) throw new Error('getCurrentMessageId 只能在消息 iframe 使用'); return floor; };
    api.getScriptId = () => { if (!scriptId) throw new Error('getScriptId 只能在脚本 iframe 使用'); return scriptId; };
    api.getIframeName = () => win.frameElement?.id || win.name;
    api.getMessageId = (name: string) => {
        const match = /^TH-message--(\d+)--\d+(?:_\d+)?$/.exec(name);
        if (!match) throw new Error('该 iframe 不是消息楼层');
        return Number(match[1]);
    };
    api.reloadIframe = () => { dispose(); win.location.reload(); };
    const ownScript = () => { if (!scriptId) throw new Error('此接口只能在脚本 iframe 使用'); return scriptId; };
    api.getButtonEvent = (name: string) => buttonEvent(ownScript(), name);
    api.eventOnButton = (name: string, fn: (...args: any[]) => any) => api.eventOn(api.getButtonEvent(name), fn);
    api.getScriptButtons = () => structuredClone(scriptButtons.get(ownScript()) ?? []);
    api.replaceScriptButtons = (first: string | any[], second?: any[]) => {
        const id = ownScript(); const buttons = typeof first === 'string' ? second : first;
        if (!Array.isArray(buttons) || buttons.some(button => !button || typeof button.name !== 'string' || typeof button.visible !== 'boolean')) throw new Error('脚本按钮必须包含字符串 name 和布尔值 visible');
        scriptButtons.set(id, structuredClone(buttons)); renderButtons();
    };
    api.updateScriptButtonsWith = (updater: (buttons: any[]) => any) => {
        if (typeof updater !== 'function') throw new Error('脚本按钮 updater 必须是函数');
        const next = updater(api.getScriptButtons());
        const commit = (buttons: any[]) => { api.replaceScriptButtons(buttons); return buttons; };
        return next && typeof next.then === 'function' ? next.then(commit) : commit(next);
    };
    api.appendInexistentScriptButtons = (first: string | any[], second?: any[]) => {
        const buttons = typeof first === 'string' ? second : first;
        if (!Array.isArray(buttons)) throw new Error('脚本按钮必须为数组');
        api.updateScriptButtonsWith((current: any[]) => [...current, ...buttons.filter(button => !current.some(existing => existing.name === button.name))]);
    };
    api.getScriptName = () => initialScripts.find(script => script.id === ownScript())?.name ?? '';
    api.getScriptInfo = () => scriptInfo.get(ownScript()) ?? '';
    api.replaceScriptInfo = (info: string) => { if (typeof info !== 'string') throw new Error('作者注释必须为字符串'); scriptInfo.set(ownScript(), info); };
    if (scriptId) cleanups.add(() => { scriptButtons.delete(scriptId); scriptInfo.delete(scriptId); renderButtons(); });
    api.injectPrompts = (items: any[], options?: any) => {
        if (disposed) throw new Error('脚本文档已卸载，不能继续注入提示词');
        const result = helper.injectPrompts(items, options);
        cleanups.add(result.uninject);
        return result;
    };
    const childContext = () => ({ ...context(), ...childPopupApi, ...childSlashRegistration,
        registerMacro: (name: string, value: string | ((nonce: string) => string)) => registerHostMacro(name, value, win),
        eventSource: { on: api.eventOn, makeFirst: api.eventMakeFirst, makeLast: api.eventMakeLast, removeListener: api.eventRemoveListener, emit } });
    if (win !== window) for (const eventName of ['tipsy-host-context', 'tipsy-host-worldbooks']) {
        const forward = () => win.dispatchEvent(new win.Event(eventName));
        window.addEventListener(eventName, forward); cleanups.add(() => window.removeEventListener(eventName, forward));
    }
    Object.assign(win, authorLibraries, api, childSlashRegistration, { TavernHelper: api, SillyTavern: sillyTavernApi(childContext), tavern_events: events, iframe_events: iframeEvents, Mvu,
        __VUE_PROD_DEVTOOLS__: true, __VUE_OPTIONS_API__: true, __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: false,
        __tipsyHostWindow: window,
        __tipsySafeWindow: clampAuthorWindow,
        __tipsyHostContext: childContext,
        quickReplyApi: quickReplies.api, executeQuickReplyByName: quickReplies.executeByName,
        EjsTemplate: templateExports(() => templateCallbackOwners.get(win)) });
    installHostFetch(win, request);
    for (const [key, value] of shared) _.set(win, key, value);
    win.Mvu = { ...Mvu,
        getMvuData: (opt: any = {}) => structuredClone(variables(option(opt))),
        replaceMvuData: async (value: any, opt: any = {}) => { replaceVariables(value, option(opt)); await flush(); },
        getCurrentMvuData: () => structuredClone(variables({ type: 'message', message_id: api.getCurrentMessageId() })),
        replaceCurrentMvuData: async (value: any) => { replaceVariables(value, { type: 'message', message_id: api.getCurrentMessageId() }); await flush(); },
    };
    if (win !== window) {
        const jq = jQueryFactory(win);
        const readyQueue: Array<(this: Document, jquery: any) => any> = [];
        let ready = false;
        const wrapper = (arg: any, ...rest: any[]) => {
            if (typeof arg !== 'function') return jq(arg, ...rest);
            if (ready) Promise.resolve().then(() => arg.call(win.document, wrapper)).catch(error => win.__compatReport(error)); else readyQueue.push(arg);
            return jq(win.document);
        };
        Object.assign(wrapper, jq); wrapper.fn = jq.fn;
        win.$ = win.jQuery = wrapper;
        win.__compatReady = async () => {
            ready = true;
            // jQuery ready dispatch does not await callback promises. A callback may
            // wait for another script or APP_READY, which runs after script loading.
            for (const fn of readyQueue.splice(0)) {
                try { Promise.resolve(fn.call(win.document, wrapper)).catch(error => win.__compatReport(error)); }
                catch (error) { win.__compatReport(error); }
            }
        };
    }
    win.toastr = Object.fromEntries(['info', 'success', 'warning', 'error'].map(level => [level, (message: string, title?: string) => notify(`${title ? title + '：' : ''}${message}`, level)]));
    win.__compatReport = (error: unknown) => diagnostic(scriptId ? initialScripts.find(script => script.id === scriptId)?.name ?? scriptId : `互动界面 #${floor}`,
        error, scriptId, 'error', !scriptJobs.has(win.frameElement?.dataset.compatChild ?? ''));
    const resizeNested = (event: MessageEvent) => {
        if (event.data?.type !== 'tipsy-template-resize' || typeof event.data.id !== 'string' || !Number.isFinite(event.data.height)) return;
        const frame = win.document.getElementById(event.data.id);
        if (frame?.tagName === 'IFRAME' && event.source === frame.contentWindow) setFrameHeight(frame, event.data.height, 40);
    };
    win.addEventListener('message', resizeNested);
    cleanups.add(() => win.removeEventListener('message', resizeNested));
}
function notify(message: string, level = 'info') {
    const text = document.createElement('template'); text.innerHTML = String(message);
    outer.postMessage({ kind: 'compat:notice', token, message: text.content.textContent || String(message), level }, '*');
}
function buttonEvent(scriptId: string, name: string): string { return `tipsy-script-button:${scriptId.length}:${scriptId}:${name}`; }
function visibleScriptButtons() {
    return [...scriptButtons].flatMap(([scriptId, buttons]) => buttons.filter(button => button.visible)
        .map(button => ({ id: buttonEvent(scriptId, button.name), name: button.name })));
}
function renderButtons() {
    outer.postMessage({ kind: 'compat:script-buttons', token, session: snapshot?.session, buttons: visibleScriptButtons() }, '*');
}
async function runScriptButton(id: string) {
    const button = visibleScriptButtons().find(item => item.id === id);
    if (!button) return;
    if (!listeners.get(id)?.length) throw new Error(`${button.name}：脚本没有注册这个按钮的操作`);
    await emit(id);
}
// Imported scripts keep their own module scope. The enclosing compatibility document is their shared host.
function importMap(source: string) {
    const imports: Record<string, string> = {};
    const slashModules: Record<string, string[]> = {
        'SlashCommand': ['SlashCommand'], 'SlashCommandArgument': ['SlashCommandArgument', 'SlashCommandNamedArgument', 'ARGUMENT_TYPE'],
        'SlashCommandScope': ['SlashCommandScope'], 'SlashCommandClosure': ['SlashCommandClosure'], 'SlashCommandParser': ['SlashCommandParser'],
        'SlashCommandAbortController': ['SlashCommandAbortController', 'SlashCommandAbortSignal'],
        'SlashCommandBreakController': ['SlashCommandBreakController'], 'SlashCommandClosureResult': ['SlashCommandClosureResult'],
    };
    for (const match of source.matchAll(/["']((?:https?:\/\/|\.{1,2}\/|\/|@sillytavern\/)[^\s"']+)["']/g)) {
        const url = match[1]!;
        const slash = /(?:^|\/)slash-commands\/(\w+)(?:\.js)?(?:\?|$)/.exec(url);
        if (slash && slashModules[slash[1]]) imports[url] = `data:text/javascript,${encodeURIComponent(slashModules[slash[1]].map(name => `export const ${name}=globalThis.${name};`).join(''))}`;
        else if (/(?:^|\/)scripts\/popup\.js(?:[?#]|$)/.test(url)) imports[url] = '/scripts/popup.js';
        else if (/(?:^|\/)scripts\/world-info\.js(?:[?#]|$)/.test(url)) imports[url] = '/scripts/world-info.js';
        else if (/(?:^|\/)scripts\/openai\.js(?:[?#]|$)/.test(url)) imports[url] = '/scripts/openai.js';
        else if (/(?:^|\/)scripts\/slash-commands(?:\.js)?(?:\?|$)/.test(url)) imports[url] = `data:text/javascript,${encodeURIComponent('const c=globalThis.SillyTavern.getContext();export const executeSlashCommands=c.executeSlashCommands;export const executeSlashCommandsWithOptions=c.executeSlashCommandsWithOptions;export const registerSlashCommand=c.registerSlashCommand;')}`;
        else if (/(?:^|\/)extensions\/quick-reply\/index\.js(?:\?|$)/.test(url)) imports[url] = `data:text/javascript,${encodeURIComponent('export const quickReplyApi=globalThis.quickReplyApi;')}`;
        else if (/\/mvu_zod\.js(?:\?|$)/i.test(url)) imports[url] = `data:text/javascript,${encodeURIComponent('export const registerMvuSchema=(...a)=>globalThis.registerMvuSchema(...a);')}`;
        else if (/\/(?:MagVarUpdate(?:@[^/]+)?\/artifact\/bundle|MVU-offline@[^/]+\/mvu_bundle_full)\.js(?:[?#]|$)/i.test(url)) imports[url] = `data:text/javascript,${encodeURIComponent('export const Mvu=globalThis.Mvu;export default Mvu;')}`;
    }
    return Object.keys(imports).length ? `<script type="importmap">${safeJson({ imports })}</script>` : '';
}
function createChild(html: string, floor?: number, script?: CardScript, componentTargets?: Array<{ key: string; selector: string }>): HTMLIFrameElement {
    html = galleryMarkup(html);
    if (!script && componentTargets?.length) html += `<script>addEventListener('DOMContentLoaded',()=>{(${observeComponentSizes.toString()})(${safeJson(componentTargets)},values=>parent.__compatMeasureComponents(values))},{once:true});</script>`;
    const frame = document.createElement('iframe');
    frame.className = script ? 'compat-script' : 'compat-message-frame';
    frame.allowFullscreen = true;
    frame.title = script ? `脚本：${script.name}` : `互动界面 #${floor}`;
    const id = crypto.randomUUID(); frame.dataset.compatChild = id;
    frame.id = script ? `TH-script--${script.name}--${script.id}` : `TH-message--${floor}--${[...children].filter(child => child.id.startsWith(`TH-message--${floor}--`)).length}`;
    frame.name = frame.id;
    if (!script) void emit(iframeEvents.MESSAGE_IFRAME_RENDER_STARTED, frame.id).catch(error => diagnostic('前端界面渲染开始', error));
    const bootstrap = `<script>parent.__compatInstall(window,${floor ?? 'undefined'},${safeJson(script?.id ?? '')});window.addEventListener('error',e=>{if(!e.error&&/^ResizeObserver loop (?:limit exceeded|completed with undelivered notifications[.])$/.test(e.message)){console.warn(e.message);return;}__compatReport(e.error||[e.message,e.filename&&e.filename+':'+e.lineno+':'+e.colno].filter(Boolean).join('\\n'));parent.__compatScriptDone(${safeJson(id)},e.message||'脚本加载失败');});window.addEventListener('unhandledrejection',e=>{__compatReport(e.reason);parent.__compatScriptDone(${safeJson(id)},String(e.reason));});<\/script>`;
    // Vue's DOM renderer captures document at load time. Load the official full
    // browser build in each child realm; sharing the parent's Vue breaks mount()
    // selectors and runtime template compilation in message/script iframes.
    const vueRuntime = `${authorBrowserRuntime}<script src="${vueBrowserRuntimeUrl}"></script>`;
    const head = `<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>@layer tipsy-reader {:where(html){font-size:16px;-webkit-text-size-adjust:100%;text-size-adjust:100%}:where(body){margin:0;background:transparent;color:var(--reader-text,#252d3b);font-family:var(--reader-font,system-ui);font-size:var(--reader-size,16px);line-height:var(--reader-leading,1.9);overflow-wrap:normal;overflow-x:hidden}:where(body > *){min-width:0}}</style>${bootstrap}${vueRuntime}${importMap(script?.content ?? html)}`;
    const content = script ? `<script type="module" onerror="parent.__compatScriptDone('${id}','脚本模块加载失败')">\n${escapeScript(script.content)}\n;await __compatReady();parent.__compatScriptDone(${safeJson(id)});</script>` : html;
    const ready = script ? '' : `<script>window.addEventListener('DOMContentLoaded',()=>{__compatReady().catch(__compatReport);(${observeFrameHeight.toString()})(height=>parent.__compatResize(${safeJson(id)},height),parent);},{once:true});</script>`;
    if (script) {
        frame.srcdoc = `<!doctype html><html><head>${head}</head><body>${content}</body></html>`;
    } else if (/<script\b/i.test(content) && needsAuthorWindowAdapt(content)) {
        void adaptAuthorHtml(content).then(adapted => {
            if (children.has(frame)) frame.srcdoc = authorDocument(adapted, head, ready);
        });
    } else {
        frame.srcdoc = authorDocument(content, head, ready);
    }
    children.add(frame);
    if (!script) messageFrames.set(id, frame);
    frame.addEventListener('load', () => {
        if (!frame.getAttribute('srcdoc')) return;
        loadedMessageFrames.add(frame);
        films.sync();
        requestAnimationFrame(() => films.sync());
        scheduleReadingPosition();
        if (readingPresentation && frame.contentDocument) applyReadingPresentation(readingPresentation, frame.contentDocument);
        if (!script) void emit(iframeEvents.MESSAGE_IFRAME_RENDER_ENDED, frame.id).catch(error => diagnostic('前端界面渲染完成', error));
        if (!script && initialized && floor !== undefined) void emit(events.MESSAGE_RENDERED, floor).catch(error => diagnostic('消息渲染事件', error));
    });
    return frame;
}
const scriptJobs = new Map<string, { resolve(): void; reject(error: Error): void }>();
const runningScripts = new Map<string, { frame: HTMLIFrameElement; source: CardScript }>();
let scriptRefreshScheduled = false;
let scriptRefreshRunning = false;
let scriptRefreshTask: Promise<void> = Promise.resolve();
function scheduleScriptRefresh() {
    if (switchingSession || scriptRefreshScheduled || scriptRefreshRunning) return;
    scriptRefreshScheduled = true;
    setTimeout(() => {
        scriptRefreshScheduled = false;
        if (switchingSession) return;
        if (transaction || !residentTemplates.isIdle) { scheduleScriptRefresh(); return; }
        scriptRefreshRunning = true;
        scriptRefreshTask = refreshScripts().catch(error => diagnostic('脚本库更新', error)).finally(() => {
            scriptRefreshRunning = false;
            if (snapshot.scriptTrees !== reconciledScriptTrees) scheduleScriptRefresh();
        });
    }, 50);
}
let reconciledScriptTrees: CompatSnapshot['scriptTrees'] | undefined;
async function refreshScripts() {
    const refreshToken = token;
    const trees = snapshot.scriptTrees;
    const desired = [...new Map([...scriptsFromTrees(trees.global), ...scriptsFromTrees(trees.preset), ...scriptsFromTrees(trees.character)].map(script => [script.id, script])).values()]
        .filter(script => !isRemoteSPresetInjectorScript(script));
    initialScripts = desired;
    const enabled = new Map(desired.filter(script => script.enabled).map(script => [script.id, script]));
    for (const [id, failure] of scriptFailures) if (!enabled.has(id)) {
        reportComponent('script', { id, name: failure.name }, 'removed'); scriptFailures.delete(id);
    }
    for (const [id, running] of runningScripts) {
        const next = enabled.get(id);
        if (!next || running.source.content !== next.content || running.source.name !== next.name) {
            if (running.frame.contentWindow) {
                running.frame.contentWindow.dispatchEvent(new Event('pagehide'));
                childDisposers.get(running.frame.contentWindow)?.();
            }
            children.delete(running.frame); running.frame.remove(); runningScripts.delete(id); scriptFailures.delete(id); scriptButtons.delete(id); scriptInfo.delete(id);
            reportComponent('script', running.source, 'removed');
        } else {
            if (!_.isEqual(next.buttons, running.source.buttons)) scriptButtons.set(id, next.buttons.map(button => ({ name: button.name, visible: button.visible !== false })));
            if (next.info !== running.source.info) scriptInfo.set(id, next.info);
            running.source = next;
        }
    }
    await loadScripts([...enabled.values()].filter(script => !runningScripts.has(script.id)), refreshToken);
    reconciledScriptTrees = trees; renderButtons();
}
async function mountScript(script: CardScript): Promise<{ completion: Promise<void> }> {
    startupStage(`加载作者脚本：${script.name}`);
    scriptButtons.set(script.id, script.buttons.map(button => ({ name: button.name, visible: button.visible !== false })));
    scriptInfo.set(script.id, script.info); renderButtons();
    const unwrapped = adaptAvsProxyPanel(unwrapAuthorScript(script.content));
    const frame = createChild('', undefined, { ...script, content: await adaptAuthorWindow(unwrapped) });
    const id = frame.dataset.compatChild!;
    const promise = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { scriptJobs.delete(id); reject(new DOMException(`脚本初始化超时：${script.name}`, 'TimeoutError')); }, 20000);
        scriptJobs.set(id, { resolve: () => { clearTimeout(timer); resolve(); }, reject: error => { clearTimeout(timer); reject(error); } });
    });
    void promise.catch(() => {});
    document.body.append(frame);
    runningScripts.set(script.id, { frame, source: script });
    return { completion: promise };
}
async function loadScripts(scripts: CardScript[], bindingToken: string): Promise<void> {
    const completions: Promise<void>[] = [];
    const recordFailure = async (script: CardScript, error: unknown) => {
        if (token !== bindingToken) return;
        const message = await explainAuthorScriptFailure(unwrapAuthorScript(script.content), error).catch(() => String(error));
        if (token !== bindingToken) return;
        scriptFailures.set(script.id, { name: script.name, message });
        reportComponent('script', script, 'failed', error instanceof Error && error.name === 'TimeoutError' ? 'TIMEOUT' : 'LOAD_ERROR');
        diagnostic(script.name, message, script.id, 'error', false);
    };
    // Mount in declared order, but allow modules awaiting another script's shared
    // globals to settle after that provider has mounted.
    for (const script of scripts) {
        if (token !== bindingToken) return;
        outer.postMessage({ kind: 'compat:progress', token }, '*');
        try {
            const { completion } = await mountScript(script);
            completions.push(completion.then(() => {
                if (token !== bindingToken) return;
                scriptFailures.delete(script.id);
                reportComponent('script', script, 'ready');
                appendRuntimeDiagnostic(root, script.name, '', 'entry', script.id);
            }, error => recordFailure(script, error)));
        } catch (error) { completions.push(recordFailure(script, error)); }
    }
    await Promise.all(completions);
    startupStage('作者脚本入口已完成');
}
const streamViews = new WeakMap<HTMLElement, StreamingView>();
const authorLoaders = new WeakMap<HTMLIFrameElement, () => void>();
const deferredAuthorPages = new Map<Element, () => void>();
const authorPageObserver = new IntersectionObserver(entries => {
    if (!showMessages || !window.innerHeight) return;
    for (const entry of entries) if (entry.isIntersecting) loadDeferredAuthorPage(entry.target);
}, { root: document, rootMargin: '100% 0px' });
function loadDeferredAuthorPage(slot: Element) {
    const load = deferredAuthorPages.get(slot);
    authorPageObserver.unobserve(slot);
    deferredAuthorPages.delete(slot);
    if (slot.isConnected) load?.();
}
const messageActionUpdates = new WeakMap<HTMLElement, () => void>();
const messageFrames = new Map<string, HTMLIFrameElement>();
const pendingFrameSizes = new Map<HTMLIFrameElement, number>();
let frameSizingTick = 0;
function publishFrameSize(id: string, height: number) {
    const frame = messageFrames.get(id);
    if (!frame || !Number.isFinite(height)) return;
    pendingFrameSizes.set(frame, height);
    if (frameSizingTick) return;
    frameSizingTick = requestAnimationFrame(() => {
        frameSizingTick = 0;
        const changed = [...pendingFrameSizes].filter(([item, value]) => item.isConnected && item.style.height !== `${Math.max(80, Math.ceil(value))}px`);
        pendingFrameSizes.clear();
        if (!changed.length) return;
        const first = changed.reduce((earliest, [item]) => earliest.compareDocumentPosition(item) & Node.DOCUMENT_POSITION_PRECEDING ? item : earliest, changed[0][0]);
        const restore = first.getBoundingClientRect().top < 0 ? preserveReadingAnchor(first) : undefined;
        for (const [item, value] of changed) setFrameHeight(item, value, 80);
        restore?.();
        films.schedule();
        scheduleReadingPosition();
    });
}
function renderMessages(previous?: CompatSnapshot) {
    if (!showMessages) return;
    const restoreAnchors: Array<() => void> = [];
    const characterAvatar = snapshot.assetCatalog.characters.find(card => card.id === snapshot.character.id)?.image;
    const userAvatar = snapshot.personas.find(item => item.avatar_id === snapshot.activePersonaId)?.image;
    const messages = snapshot.messages;
    const prior = previous?.messages;
    const samePrefix = !!prior && rows.size === prior.length && prior.length <= messages.length && prior.every((node, index) => node.id === messages[index].id);
    if (!samePrefix) {
        const activeIds = new Set(messages.map(message => message.id));
        for (const [id, row] of rows) {
            if (!activeIds.has(id)) { disposeRow(row.element); rows.delete(id); }
        }
    }
    let canRetry = false;
    for (const [index, node] of messages.entries()) {
        if (node.role === 'assistant') canRetry = node.floor > 0;
        const oldNode = samePrefix ? prior[index] : undefined;
        const oldRow = rows.get(node.id);
        if (oldRow && oldNode !== node) {
            oldRow.element.dataset.readingSwipe = readingSwipeId(node);
            syncRowMetrics(oldRow.element, node);
        }
        const openingSelector = node.floor === 0 && messages.length === 1 && node.swipes.length > 1;
        if (oldNode === node && oldRow && canRetry === oldRow.element.hasAttribute('data-can-retry') &&
            (index !== 0 || (prior!.length === 1) === (messages.length === 1))) continue;
        const content = resolveRenderedMessageContent(node);
        const incomplete = !!node.extra?.tipsy_generation_incomplete || !!node.templatePending;
        const avatar = node.role === 'assistant' ? characterAvatar : node.role === 'user' ? userAvatar : undefined;
        const speakerName = node.role === 'user' ? snapshot.userName : node.role === 'assistant' ? storySpeakerName(node.speakerName, snapshot.character.name) : node.speakerName;
        const identity = JSON.stringify([speakerName, node.role, node.isHidden, node.floor, node.swipes.length, node.routeCount, node.streamStatus, openingSelector, canRetry]);
        const old = oldRow;
        if (old && node.streamPreview && streamViews.has(old.element) && old.swipe === node.activeSwipeIndex && old.avatar === avatar) {
            streamViews.get(old.element)!.update(node.streamPreview, true);
            syncRowMetrics(old.element, node);
            old.content = content; old.identity = identity; old.incomplete = incomplete;
            continue;
        }
        if (old?.content === content && old.swipe === node.activeSwipeIndex && old.incomplete === incomplete && old.identity === identity && old.avatar === avatar) continue;
        const buildHeader = (targetEl: HTMLElement) => {
            const header = document.createElement('header');
            const speaker = document.createElement('div'); speaker.className = 'compat-message-identity';
            const portrait = document.createElement('span'); portrait.className = 'compat-message-avatar'; portrait.setAttribute('aria-hidden', 'true'); portrait.textContent = speakerName.slice(0, 1);
            if (avatar && avatar !== 'default.png') {
                const image = document.createElement('img'); image.src = avatar; image.alt = '';
                image.onerror = () => image.remove(); portrait.append(image);
            }
            const name = document.createElement('strong'); name.textContent = speakerName;
            const floorLabel = document.createElement('small'); floorLabel.textContent = `#${node.floor}`;
            speaker.append(portrait, name, floorLabel); header.append(speaker);
            const toolbar = document.createElement('div'); toolbar.className = 'compat-message-toolbar';
            const swipes = document.createElement('div'); swipes.className = 'compat-message-swipes';
            const menu = document.createElement('details'); menu.className = 'compat-message-menu';
            const toggle = document.createElement('summary'); toggle.setAttribute('aria-label', `${speakerName} 第 ${node.floor} 层消息操作`); toggle.title = '消息操作';
            toggle.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg>';
            const actions = document.createElement('div'); actions.className = 'compat-message-actions'; actions.setAttribute('role', 'group'); actions.setAttribute('aria-label', '消息操作');
            const actionUpdates: Array<() => void> = [];
            messageActionUpdates.set(targetEl, () => actionUpdates.forEach(update => update()));
            const button = (title: string, action: () => any, disabled: boolean | (() => boolean) = false) => {
                const b = document.createElement('button'); b.type = 'button';
                const update = () => { b.disabled = typeof disabled === 'function' ? disabled() : disabled; };
                update(); actionUpdates.push(update);
                if (title === '‹' || title === '›') {
                    b.setAttribute('aria-label', title === '‹' ? '上一个开场' : '下一个开场');
                    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
                    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('width', '13'); svg.setAttribute('height', '13'); svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '1.7'); svg.setAttribute('aria-hidden', 'true');
                    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path'); path.setAttribute('d', title === '‹' ? 'm15 5-7 7 7 7' : 'm9 5 7 7-7 7'); svg.append(path); b.append(svg);
                } else b.textContent = title;
                b.onclick = () => { menu.open = false; Promise.resolve().then(action).catch(error => diagnostic('消息操作', error)); };
                (title === '‹' || title === '›' ? swipes : actions).append(b);
                return b;
            };
            if (node.floor > 0) {
                const branch = document.createElement('button'); branch.type = 'button';
                branch.className = 'compat-route-button'; branch.textContent = `路线 · ${node.routeCount ?? 1}`;
                branch.setAttribute('aria-label', `查看第 ${node.floor} 楼的故事路线`);
                branch.onclick = () => void request('story.routes', { id: node.id });
                speaker.append(branch);
            }
            if (openingSelector) {
                swipes.setAttribute('role', 'group'); swipes.setAttribute('aria-label', '切换开场');
                button('‹', () => request('chat.swipe', { floor: node.floor, direction: 'prev' }), () => snapshot.generating || node.activeSwipeIndex === 0);
                const count = document.createElement('small'); count.textContent = `开场 ${node.activeSwipeIndex + 1} / ${node.swipes.length}`; swipes.append(count);
                button('›', () => request('chat.swipe', { floor: node.floor, direction: 'next' }), () => snapshot.generating || node.activeSwipeIndex === node.swipes.length - 1);
                toolbar.append(swipes);
            }
            button('复制', () => request('ui.copy', { text: chat[node.floor]?.mes ?? node.content }));
            button('修改', () => request('chat.edit', { id: node.id }), () => snapshot.generating || !!snapshot.messages.find(m => m.id === node.id)?.extra?.tipsy_generation_incomplete);
            if (canRetry) button('从这里重新选择', () => request('story.retry', { id: node.id }), () => snapshot.generating);
            if (node.role === 'assistant' && !incomplete) {
                const illustration = button('本楼配图', () => request('extension.illustration.open', { id: node.id }));
                const update = () => { illustration.hidden = typeof globals.STBaiBaiImage?.generate !== 'function'; };
                actionUpdates.push(update); update();
            }
            if (node.isHidden) { const notice = document.createElement('small'); notice.textContent = '已从模型上下文隐藏'; actions.append(notice); }
            const plugins = button('本楼插件', () => {
                const current = snapshot.messages.find(message => message.id === node.id);
                if (current) return request('nativePlugins.message', { id: current.id, swipe: swipeId(current), updatedAt: current.updatedAt });
            }, () => snapshot.generating);
            const updatePlugins = () => {
                plugins.hidden = incomplete || !!node.extra?.tipsy_generation_terminal || !snapshot.nativeMessageMenu?.some(item => (!item.role || item.role === node.role)
                    && (!item.latestOnly || node.id === snapshot.messages.at(-1)?.id));
            };
            plugins.addEventListener('click', event => { if (!event.isTrusted) event.stopImmediatePropagation(); }, { capture: true });
            actionUpdates.push(updatePlugins); updatePlugins();
            button('删除', () => request('chat.delete', { floor: node.floor }));
            menu.append(toggle, actions); toolbar.append(menu); header.append(toolbar);
            menu.addEventListener('keydown', event => { if (event.key === 'Escape') { menu.open = false; toggle.focus(); } });
            return header;
        };
        if (old && !node.streamPreview && !streamViews.has(old.element) && old.swipe === node.activeSwipeIndex) {
            if (old.identity !== identity || old.avatar !== avatar || old.incomplete !== incomplete) {
                old.element.setAttribute('mesid', String(node.floor));
                old.element.toggleAttribute('data-can-retry', canRetry);
                old.element.querySelector(':scope > header')?.replaceWith(buildHeader(old.element));
            }
            if (old.content !== content || old.incomplete !== incomplete) {
                const bodyEl = old.element.querySelector<HTMLElement>(':scope > .mes_text');
                if (bodyEl) {
                    const restore = bodyEl.getBoundingClientRect().top < 0 ? preserveReadingAnchor(bodyEl) : undefined;
                    reconcileMessageBody(bodyEl, node, content, incomplete, messages.length);
                    if (restore) restoreAnchors.push(restore);
                }
            }
            syncRowMetrics(old.element, node);
            old.content = content; old.identity = identity; old.incomplete = incomplete; old.avatar = avatar;
            continue;
        }
        const nextSibling = samePrefix ? old?.element.nextSibling ?? null : null;
        if (old) { if (streamViews.has(old.element)) restoreAnchors.push(preserveReadingAnchor(old.element)); disposeRow(old.element); }
        const element = document.createElement('article'); element.className = `mes is-${node.role}`;
        element.dataset.messageId = node.id;
        element.dataset.readingSwipe = readingSwipeId(node);
        element.setAttribute('mesid', String(node.floor));
        element.toggleAttribute('data-can-retry', canRetry);
        element.append(buildHeader(element));
        element.addEventListener('contextmenu', event => {
            if (matchMedia('(any-pointer: coarse)').matches || window.getSelection()?.toString()
                || (event.target as HTMLElement).closest('input, textarea, select, a, button, [contenteditable]')) return;
            event.preventDefault();
            const menu = element.querySelector<HTMLDetailsElement>(':scope > header .compat-message-menu');
            const toggle = menu?.querySelector<HTMLElement>(':scope > summary');
            if (menu) { menu.open = true; toggle?.focus(); }
        });
        const body = document.createElement('div'); body.className = node.streamPreview ? 'compat-stream-body' : 'mes_text';
        if (node.streamPreview) {
            body.classList.add('compat-stream-body');
            const view = new StreamingView(body, () => readingPresentation?.streamLoadingSprite ?? '');
            streamViews.set(element, view); view.update(node.streamPreview);
        } else {
            reconcileMessageBody(body, node, content, incomplete, messages.length);
        }
        element.append(body); syncRowMetrics(element, node); rows.set(node.id, { element, content, swipe: node.activeSwipeIndex, incomplete, identity, avatar });
        if (samePrefix) root.insertBefore(element, nextSibling);
    }
    // Re-appending an existing iframe's ancestor reloads its document. Unchanged
    // snapshots must leave interactive messages and their author scripts mounted.
    let cursor = root.firstElementChild;
    for (const node of samePrefix ? [] : messages) {
        const element = rows.get(node.id)!.element;
        if (element === cursor) cursor = cursor.nextElementSibling;
        else root.insertBefore(element, cursor);
    }
    restoreAnchors.forEach(restore => restore());
    films.sync();
    restoreReadingPosition();
    scheduleReadingPosition();
}
type BlockEntry = { key: string; type: 'markdown' | 'html' | 'mixed'; element: HTMLElement; isDeferred?: boolean };
const bodyBlockEntries = new WeakMap<HTMLElement, BlockEntry[]>();
function reconcileMessageBody(
    body: HTMLElement,
    node: CompatSnapshot['messages'][number],
    content: string,
    incomplete: boolean,
    totalMessages: number,
) {
    const extracted = node.streamStatus ? [] : extractHtmlSandboxBlocks(content);
    body.classList.remove('compat-defer-paint');
    body.style.removeProperty('--compat-row-estimate');
    if (node.floor > 0 && !incomplete && !node.streamStatus && extracted.every(block => block.type === 'markdown')) {
        body.classList.add('compat-defer-paint');
        body.style.setProperty('--compat-row-estimate', `${Math.max(72, Math.ceil(content.length / 44) * 24 + 48)}px`);
    }
    if (node.templatePending) {
        disposeRowBody(body);
        body.replaceChildren();
        const pending = document.createElement('p'); pending.setAttribute('role', 'status'); pending.textContent = '正在渲染消息模板…'; body.append(pending);
        return;
    }
    if (incomplete && !extracted.every(block => block.type === 'markdown')) {
        disposeRowBody(body);
        body.replaceChildren();
        const notice = document.createElement('p'); notice.setAttribute('role', 'status');
        notice.textContent = '正在生成互动内容…';
        body.append(notice);
        return;
    }
    const hookContext = { messageId: node.floor, isSystem: Boolean(node.isHidden), isUser: node.role === 'user' };
    const hasAfterMarkdown = hasFormatterStage('afterMarkdown');
    const occurrences = new Map<string, number>();
    const desired = extracted.map((block) => {
        const base = `${block.type}:${block.content}`;
        const occ = occurrences.get(base) ?? 0;
        occurrences.set(base, occ + 1);
        const rawKey = blockContentKey(block.type, block.content, occ);
        const matchKey = block.type === 'markdown' && hasAfterMarkdown ? `${rawKey}:afterMd` : rawKey;
        return { block, key: rawKey, matchKey };
    });
    const existing = bodyBlockEntries.get(body) ?? [];
    const oldKeys = existing.map((entry, idx) => entry.type === 'markdown' && hasAfterMarkdown ? `stale:${idx}` : entry.key);
    const { keepOld, keepNew } = computeKeptBlockIndices(oldKeys, desired.map((d) => d.matchKey));
    if (!existing.length) {
        disposeRowBody(body);
        body.replaceChildren();
    } else {
        for (let i = 0; i < existing.length; i++) {
            if (!keepOld.has(i)) {
                disposeElementResources(existing[i].element);
                existing[i].element.remove();
            }
        }
    }
    const nextKeptAfter: Array<Element | null> = new Array(desired.length).fill(null);
    let anchor: Element | null = null;
    for (let i = desired.length - 1; i >= 0; i--) {
        nextKeptAfter[i] = anchor;
        const oldIdx = keepNew.get(i);
        if (oldIdx !== undefined) anchor = existing[oldIdx].element;
    }
    const nextEntries: BlockEntry[] = [];
    for (let i = 0; i < desired.length; i++) {
        const { block, key } = desired[i];
        const oldIdx = keepNew.get(i);
        if (oldIdx !== undefined) {
            const kept = existing[oldIdx];
            nextEntries.push(kept);
            if (kept.isDeferred && preloadsMessageHtml(node.floor, totalMessages, snapshot.helperRenderDepth)) {
                loadDeferredAuthorPage(kept.element);
            }
            continue;
        }
        const entry: BlockEntry = { key, type: block.type, element: document.createElement('div') };
        if (block.type === 'markdown') {
            const prose = entry.element;
            prose.className = 'compat-prose message-markdown';
            const html = renderMessageMarkdown(block.content);
            prose.innerHTML = hasAfterMarkdown ? runFormatterStage('afterMarkdown', html, hookContext) : html;
        } else {
            const mount = () => {
                const frame = createChild(block.type === 'mixed' ? renderMixedMessage(block.content) : block.content, node.floor, undefined, node.componentTargets);
                frame.dataset.blockType = block.type;
                const loader = mountAuthorLoading(frame, node.componentTargets, () => readingPresentation?.streamLoadingSprite ?? '', () => films.schedule());
                authorLoaders.set(frame, loader.dispose);
                loader.wrapper.dataset.blockType = block.type;
                return loader.wrapper;
            };
            if (preloadsMessageHtml(node.floor, totalMessages, snapshot.helperRenderDepth)) {
                entry.element = mount();
            } else {
                const slot = document.createElement('p');
                slot.className = 'compat-deferred-author'; slot.textContent = '正在加载互动内容…';
                entry.element = slot;
                entry.isDeferred = true;
                deferredAuthorPages.set(slot, () => {
                    const mounted = mount();
                    entry.element = mounted;
                    entry.isDeferred = false;
                    const restore = preserveReadingAnchor(slot);
                    slot.replaceWith(mounted);
                    restore();
                });
                authorPageObserver.observe(slot);
            }
        }
        const refEl = nextKeptAfter[i];
        if (refEl && refEl.parentNode === body) body.insertBefore(entry.element, refEl);
        else body.append(entry.element);
        nextEntries.push(entry);
    }
    bodyBlockEntries.set(body, nextEntries);
}
function disposeElementResources(container: Element) {
    if (container.classList.contains('compat-deferred-author')) {
        authorPageObserver.unobserve(container); deferredAuthorPages.delete(container);
    }
    for (const slot of container.querySelectorAll('.compat-deferred-author')) {
        authorPageObserver.unobserve(slot); deferredAuthorPages.delete(slot);
    }
    const frames = container.tagName === 'IFRAME' ? [container as HTMLIFrameElement] : [...container.querySelectorAll('iframe')];
    for (const frame of frames) {
        if (frame.contentWindow) childDisposers.get(frame.contentWindow)?.();
        authorLoaders.get(frame)?.(); authorLoaders.delete(frame);
        if (frame.dataset.compatChild) messageFrames.delete(frame.dataset.compatChild);
        pendingFrameSizes.delete(frame);
        children.delete(frame);
    }
}
function disposeRowBody(container: HTMLElement) {
    bodyBlockEntries.delete(container);
    disposeElementResources(container);
}
const liveMetricTargets = new Map<HTMLElement, { startedAt: number; durationValueEl: HTMLElement }>();
let liveMetricsTimer: ReturnType<typeof setInterval> | undefined;

function refreshLiveMetricsTimer() {
    if (!liveMetricTargets.size) {
        if (liveMetricsTimer !== undefined) { clearInterval(liveMetricsTimer); liveMetricsTimer = undefined; }
        return;
    }
    if (liveMetricsTimer !== undefined) return;
    liveMetricsTimer = setInterval(() => {
        const now = Date.now();
        for (const [element, entry] of liveMetricTargets) {
            if (!element.isConnected) { liveMetricTargets.delete(element); continue; }
            entry.durationValueEl.textContent = formatReplyDuration(Math.max(0, now - entry.startedAt), true) ?? '0s';
        }
        if (!liveMetricTargets.size && liveMetricsTimer !== undefined) { clearInterval(liveMetricsTimer); liveMetricsTimer = undefined; }
    }, 1000);
}

function metricSvg(path: string): SVGSVGElement {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('width', '11'); svg.setAttribute('height', '11');
    svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.9'); svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round'); svg.setAttribute('aria-hidden', 'true');
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path'); p.setAttribute('d', path);
    svg.append(p);
    return svg;
}

function syncRowMetrics(element: HTMLElement, node: CompatSnapshot['messages'][number]) {
    const metrics = readMessageMetrics(node);
    const existing = element.querySelector(':scope > .compat-msg-metrics') as HTMLElement | null;
    const isUser = node.role === 'user';
    const tokenRaw = isUser ? metrics?.promptTokens : metrics?.outputTokens;
    const tokenText = formatApproxTokens(tokenRaw);
    const hasLiveDuration = Boolean(metrics?.isLive && metrics.startedAt !== undefined);
    const durationText = hasLiveDuration ? undefined : formatReplyDuration(metrics?.durationMs, false);

    if (!metrics || (!tokenText && !durationText && !hasLiveDuration)) {
        liveMetricTargets.delete(element);
        refreshLiveMetricsTimer();
        existing?.remove();
        return;
    }

    const bar = existing ?? document.createElement('div');
    let pill = bar.firstElementChild as HTMLElement | null;
    if (!existing || !pill) {
        bar.replaceChildren();
        pill = document.createElement('span'); pill.className = 'compat-msg-metrics-pill';
        bar.append(pill);
        element.append(bar);
    }
    bar.className = `compat-msg-metrics is-${node.role}${hasLiveDuration ? ' is-live' : ''}`;

    const titleParts: string[] = [];
    if (durationText) titleParts.push(`回复耗时 ${durationText}`);
    else if (hasLiveDuration) titleParts.push('正在实时计时');
    if (tokenRaw && tokenRaw > 0) {
        titleParts.push(isUser
            ? `本轮向模型共发送约 ${tokenRaw.toLocaleString()} tokens`
            : `本楼模型输出${metrics.estimatedFallback ? '约 ' : ' '}${tokenRaw.toLocaleString()} tokens`);
    }
    bar.title = titleParts.join(' · ');

    const showDuration = hasLiveDuration || !!durationText;
    const desiredSignature = `${isUser ? 'u' : 'a'}|${hasLiveDuration ? '1' : '0'}|${showDuration ? '1' : '0'}|${tokenText ? '1' : '0'}`;
    if (pill.dataset.sig !== desiredSignature) {
        pill.dataset.sig = desiredSignature;
        pill.replaceChildren();
        if (showDuration) {
            const item = document.createElement('span'); item.className = 'compat-msg-metric-item is-duration';
            if (hasLiveDuration) {
                const dot = document.createElement('span'); dot.className = 'compat-msg-metric-live-dot'; dot.setAttribute('aria-hidden', 'true');
                item.append(dot);
            } else {
                item.append(metricSvg('M12 7v5l3 2M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18'));
            }
            const value = document.createElement('span'); value.className = 'compat-msg-metric-val';
            item.append(value);
            pill.append(item);
        }
        if (showDuration && tokenText) {
            const sep = document.createElement('span'); sep.className = 'compat-msg-metric-sep'; sep.setAttribute('aria-hidden', 'true');
            pill.append(sep);
        }
        if (tokenText) {
            const item = document.createElement('span'); item.className = 'compat-msg-metric-item is-tokens';
            item.append(metricSvg(isUser ? 'M12 19V5m-6 6 6-6 6 6' : 'M12 3l1.9 5.3L19 10.2l-5.1 1.9L12 17.5l-1.9-5.4L5 10.2l5.1-1.9Z'));
            const value = document.createElement('span'); value.className = 'compat-msg-metric-val';
            item.append(value);
            pill.append(item);
        }
    }

    const durationVal = pill.querySelector('.is-duration .compat-msg-metric-val') as HTMLElement | null;
    if (durationVal) {
        if (hasLiveDuration) {
            durationVal.textContent = formatReplyDuration(Math.max(0, Date.now() - metrics.startedAt!), true) ?? '0s';
            liveMetricTargets.set(element, { startedAt: metrics.startedAt!, durationValueEl: durationVal });
        } else {
            liveMetricTargets.delete(element);
            durationVal.textContent = durationText ?? '';
        }
    } else {
        liveMetricTargets.delete(element);
    }
    refreshLiveMetricsTimer();

    const tokenVal = pill.querySelector('.is-tokens .compat-msg-metric-val') as HTMLElement | null;
    if (tokenVal && tokenText) {
        tokenVal.textContent = isUser ? `发送 ${tokenText} tok` : `输出 ${tokenText} tok`;
    }
}

function disposeRow(element: HTMLElement) {
    liveMetricTargets.delete(element);
    refreshLiveMetricsTimer();
    streamViews.get(element)?.dispose(); streamViews.delete(element);
    disposeRowBody(element);
    element.remove();
}
Object.assign(globals, { __compatInstall: installApi, __tipsyHostContext: context,
    __compatScriptDone: (id: string, error?: string) => { const job = scriptJobs.get(id); scriptJobs.delete(id); if (error) job?.reject(new Error(error)); else job?.resolve(); },
    __compatMeasureComponents: (values: Array<{ key: string; width: number; height: number }>) => values.forEach(value => rememberComponentSize(value.key, value.width, value.height)),
    __compatResize: publishFrameSize,
});
Object.assign(globals, authorLibraries, helper, rootSlashRegistration, { TavernHelper: helper, SillyTavern: sillyTavernApi(context), tavern_events: events, iframe_events: iframeEvents, $, jQuery: $, Mvu, EjsTemplate,
    quickReplyApi: quickReplies.api, executeQuickReplyByName: quickReplies.executeByName,
    toastr: Object.fromEntries(['info', 'success', 'warning', 'error'].map(level => [level, (message: string, title?: string) => notify(`${title ? title + '：' : ''}${message}`, level)])) });
preserveScriptFrameMoves(window);
const memoryStorageAddress = (state: CompatSnapshot) => JSON.stringify([state.character.id, state.session, state.routeId]);
const baibaiStorage = installBaibaiFrameStorage(() => snapshot && !openingSession ? {
    route: memoryStorageAddress(snapshot), rows: chat, metadata,
    get fallbackBlocked() {
        const entries = routeMessages(snapshot.chatMetadata);
        return snapshot.routeReplacing || !!entries && snapshot.messages.some((node, i) => {
            const base = entries[routeMessageKey(node)]?.memoryBody;
            return base !== undefined && base !== baibaiHash(baibaiBody(chat[i]?.mes ?? node.content));
        });
    },
} : undefined, error => diagnostic('柏宝书本地索引或缓存', error));
installHostFetch(window, request, {
    revision: () => snapshot && [snapshot.session, snapshot.branchEpoch ?? 0, snapshot.routeId].join('\0'),
    beforeVector: action => action === 'vec/bundle/create' ? saveChatMetadata(undefined, true) : undefined,
    vectorResult: (action, body) => {
        if (action === 'status') baibaiStorage.probe(body?.data?.driver?.available === true);
        else if (['vec/clear-scope', 'vec/delete', 'vec/reconcile'].includes(action) && body?.data?.deleted > 0) baibaiStorage.invalidate();
    },
    onWorldInfoEdited: (name, data) => {
        worldInfoCache.set(name, structuredClone(data));
        void emit(events.WORLDINFO_UPDATED, name, data);
    },
});
installGallery(window);
eventOn(events.APP_READY, () => snapshot.branchEpoch ? undefined : quickReplies.automatic('executeOnStartup'));
eventOn(events.CHAT_CHANGED, () => snapshot.branchEpoch ? undefined : quickReplies.automatic('executeOnChatChange'));
eventOn(events.CHAT_CREATED, () => quickReplies.automatic('executeOnNewChat'));
eventOn(events.USER_MESSAGE_RENDERED, () => quickReplies.automatic('executeOnUser'), -1);
eventOn(events.CHARACTER_MESSAGE_RENDERED, (floor: number) => chat[floor]?.mes === '...' ? undefined : quickReplies.automatic('executeOnAi'), -1);
eventOn(events.GENERATION_AFTER_COMMANDS, (_type: string, _options: unknown, dryRun = false) => dryRun ? undefined : quickReplies.automatic('executeBeforeGeneration'));
eventOn(events.WORLD_INFO_ACTIVATED, (entries: any[]) => {
    const ids = entries.map(entry => entry.automationId).filter(Boolean);
    return ids.length ? quickReplies.automatic('', ids) : undefined;
});
eventOn(events.MESSAGE_SENT, settleSentMessage);
eventOn(events.MESSAGE_RECEIVED, settleExtensionMessage);
helper.updatelorebookEntriesWith = helper.updateLorebookEntriesWith;
globals.updatelorebookEntriesWith = helper.updateLorebookEntriesWith;
eventOn('mag_invoke_mvu', async (text: string, info: { old_variables?: Record<string, any>; new_variables?: Record<string, any> }) => {
    if (info.old_variables !== undefined) info.new_variables = await Mvu.parseMessage(text, info.old_variables);
});
eventOn('mag_update_variable', (root: Record<string, any>, path: string, value: any, reason?: string, recursive?: boolean) =>
    setMvuVariable(root, path, value, reason, recursive, (data, key, old, updated) => emit(mvuEvents.SINGLE_VARIABLE_UPDATED, data, key, old, updated)));
initializeGlobal('Mvu', Mvu);
async function loadInstalledExtensions(): Promise<void> {
    const pending = snapshot.extensions.extensions.filter(entry => !entry.integrated && entry.enabled);
    const loaded = new Set(snapshot.extensions.extensions.filter(entry => entry.integrated).map(entry => entry.id));
    const install = async (extension: CompatibilityExtension) => {
        if (extension.error) throw new Error(extension.error);
        if (extension.requires?.length) throw new Error(`扩展需要尚未提供的原酒馆服务模块：${extension.requires.join('、')}`);
        if (extension.css) {
            const style = document.createElement('link'); style.rel = 'stylesheet'; style.href = extension.css; document.head.append(style);
        }
        if (extension.js) await import(/* @vite-ignore */ extension.js);
    };
    while (pending.length) {
        const index = pending.findIndex(entry => (entry.dependencies ?? []).every(id => loaded.has(id.replace(/^third-party\//, ''))));
        if (index < 0) {
            for (const entry of pending) {
                reportComponent('extension', entry, 'failed', 'DEPENDENCY_MISSING');
                diagnostic(entry.name, new Error(`扩展依赖缺失或未能加载：${entry.dependencies?.join('、')}`), entry.id, 'error', false);
            }
            break;
        }
        const [extension] = pending.splice(index, 1);
        outer.postMessage({ kind: 'compat:progress', token }, '*');
        try {
            await install(extension); loaded.add(extension.id);
            reportComponent('extension', extension, 'ready');
            if (extension.generateInterceptor) {
                if (typeof globals[extension.generateInterceptor] === 'function') loadedInterceptors.push({ name: extension.name, key: extension.generateInterceptor });
                else diagnostic(`扩展 ${extension.name}`, new Error(`未注册生成拦截器 ${extension.generateInterceptor}`), extension.id, 'warning');
            }
        }
        catch (error) {
            reportComponent('extension', extension, 'failed', extension.error ? 'CATALOG_ERROR' : extension.requires?.length ? 'UNSUPPORTED_MODULE' : 'LOAD_ERROR');
            diagnostic(`扩展 ${extension.name}`, error, extension.id, 'error', false);
        }
    }
}
let commandQueue = Promise.resolve();
async function switchCompatibilitySession(next: CompatSnapshot, scripts: CardScript[], bindingToken: string, bookmark: unknown): Promise<void> {
    if (token !== bindingToken) return;
    startupCompletedSession = ''; startupCompletedToken = '';
    let releaseSessionData!: () => void;
    sessionDataReady = new Promise(resolve => { releaseSessionData = resolve; });
    switchingSession = true; initialized = false;
    disposePopups();
    const error = new Error('聊天已切换，旧任务已取消');
    for (const job of waiting.values()) { clearTimeout(job.timer); job.reject(error); }
    waiting.clear();
    for (const task of generationTasks.values()) task.stopped = true;
    stopPipeline(error);
    const resetTemplates = residentTemplates.resetSession();
    await commandQueue;
    await startupTask;
    await scriptRefreshTask;
    await Promise.allSettled([...writes]);
    await resetTemplates;
    if (token !== bindingToken) { releaseSessionData(); return; }
    pendingVariableWrites.clear(); externalWorldInfo.clear(); deferredDeltas.length = 0; writeFailure = undefined;
    helperWorldbookCache.clear();
    worldInfoCache.clear();
    extensionOverlayVisible = false;
    lastPublishedOverlay = false;
    document.documentElement.toggleAttribute('data-compat-popup', nativePopupVisible);
    for (const row of rows.values()) disposeRow(row.element); rows.clear();
    films.sync([], '');
    const retained = new Set(scriptsFromTrees(next.scriptTrees.global).filter(script => script.enabled).map(script => script.id));
    if (snapshot.assetCatalog.loadedPresetName === next.assetCatalog.loadedPresetName) {
        for (const script of scriptsFromTrees(next.scriptTrees.preset)) if (script.enabled) retained.add(script.id);
    }
    for (const [id, running] of runningScripts) {
        if (retained.has(id)) continue;
        if (running.frame.contentWindow) {
            running.frame.contentWindow.dispatchEvent(new Event('pagehide'));
            childDisposers.get(running.frame.contentWindow)?.();
        }
        children.delete(running.frame); running.frame.remove(); runningScripts.delete(id);
        reportComponent('script', running.source, 'removed');
        scriptButtons.delete(id); scriptInfo.delete(id);
    }
    for (const [id, failure] of scriptFailures) if (!retained.has(id)) {
        reportComponent('script', { id, name: failure.name }, 'removed'); scriptFailures.delete(id);
    }
    diagnostics.length = 0; document.getElementById('compat-diagnostics')?.remove();
    initialScripts = scripts; reconciledScriptTrees = undefined;
    prepareReadingBookmark(bookmark);
    applySnapshot(next);
    await loadGallery(next.character.id);
    releaseSessionData();
    await refreshScripts();
    await initializeAuthorVariables();
    if (token !== bindingToken) return;
    switchingSession = false; initialized = true; renderMessages();
    outer.postMessage({ kind: 'compat:ready', token }, '*');
    publishExtensionMenu();
    startupEventsTask = emit(events.CHAT_CHANGED, snapshot.session).catch(error => diagnostic('会话切换事件', error));
    await startupEventsTask;
    await finishStartupForSync(bindingToken);
}
const hostBodyContainers = new Set<Element>([root, extensionMenu, extensionMenuButton, extensionTopBar, composerMount, extensionSettingsMount]);
let nativePopupVisible = false;
let extensionOverlayVisible = false;
let lastPublishedOverlay = false;
function publishOverlayVisibility() {
    document.documentElement.toggleAttribute('data-compat-popup', nativePopupVisible);
    const visible = nativePopupVisible || extensionOverlayVisible;
    if (!snapshot?.session) return;
    if (visible === lastPublishedOverlay) return;
    lastPublishedOverlay = visible;
    outer.postMessage({ kind: 'compat:popup', session: snapshot.session, visible }, '*');
}
function checkExtensionOverlay() {
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    extensionOverlayVisible = [...document.body.children].some(el => {
        if (hostBodyContainers.has(el) || !(el instanceof HTMLElement)) return false;
        const style = window.getComputedStyle(el);
        if (el.checkVisibility && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
        return isBlockingExtensionOverlay(
            { tagName: el.tagName, hidden: el.hidden, role: el.getAttribute('role'), ariaModal: el.getAttribute('aria-modal') },
            {
                position: style.position,
                display: style.display,
                visibility: style.visibility,
                opacity: style.opacity,
                pointerEvents: style.pointerEvents,
                zIndex: style.zIndex,
                backgroundColor: style.backgroundColor,
                backgroundImage: style.backgroundImage,
                backdropFilter: style.backdropFilter,
            },
            el.getBoundingClientRect(),
            viewport,
        );
    });
    publishOverlayVisibility();
}
const observedOverlays = new WeakSet<Element>();
const overlayAttrObserver = new MutationObserver(checkExtensionOverlay);
const observeExtensionChildren = () => {
    for (const el of document.body.children) {
        if (hostBodyContainers.has(el) || observedOverlays.has(el) || el.tagName === 'IFRAME' || el.tagName === 'DIALOG') continue;
        observedOverlays.add(el);
        overlayAttrObserver.observe(el, { attributes: true, attributeFilter: ['style', 'class', 'hidden'] });
    }
    checkExtensionOverlay();
};
new MutationObserver(observeExtensionChildren).observe(document.body, { childList: true });
window.addEventListener('resize', checkExtensionOverlay);
onPopupVisibility(visible => {
    nativePopupVisible = visible;
    publishOverlayVisibility();
});
window.addEventListener('message', event => {
    if (event.source !== outer || !event.data) return;
    const data = event.data;
    if (data.kind === 'compat:popup-focus' && data.session === snapshot?.session) { focusPopup(); return; }
    if (data.kind === 'compat:film-slots' && data.session === snapshot?.session && Array.isArray(data.slots)) {
        if (typeof data.filmToken === 'string') currentFilmToken = data.filmToken;
        films.sync(data.slots as CompatFilmSlot[], currentFilmToken);
        return;
    }
    if (data.kind === 'compat:film-media' && data.session === snapshot?.session && typeof data.mediaId === 'string') {
        const mime = typeof data.mime === 'string' && /^image\/(?:png|jpeg|webp)$/.test(data.mime) ? data.mime : '';
        const blob = data.bytes instanceof ArrayBuffer && mime
            ? new Blob([data.bytes], { type: mime })
            : data.blob instanceof Blob
                ? (/^image\/(?:png|jpeg|webp)$/.test(data.blob.type) || !mime ? data.blob : new Blob([data.blob], { type: mime }))
                : null;
        if (blob) films.receiveMedia(data.mediaId, blob, typeof data.name === 'string' ? data.name : undefined);
        return;
    }
    if (data.kind === 'compat:presentation' && data.session === snapshot?.session && 'stageTint' in data) { if (typeof data.stageTint === 'string' && /^#[0-9a-f]{6}$/i.test(data.stageTint)) document.documentElement.style.setProperty('--ti-stage-tint', data.stageTint); else document.documentElement.style.removeProperty('--ti-stage-tint'); return; }
    if (data.kind === 'compat:reading-target' && data.session === snapshot?.session) {
        readingReplyId = typeof data.replyId === 'string' ? data.replyId : undefined;
        lastReadingPosition = ''; scheduleReadingPosition(); return;
    }
    if (data.kind === 'compat:reading-jump' && data.session === snapshot?.session) {
        if (snapshot.generating) return;
        const behavior: ScrollBehavior = matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth';
        if (data.mode === 'latest-bottom') {
            stopRestoringBookmark();
            window.scrollTo({ top: document.documentElement.scrollHeight, behavior });
            scheduleReadingPosition();
            return;
        }
        const row = typeof data.replyId === 'string' ? rows.get(data.replyId) : undefined;
        if (row && !row.incomplete) {
            stopRestoringBookmark();
            window.scrollTo({ top: Math.max(0, window.scrollY + row.element.getBoundingClientRect().top - 14), behavior });
            scheduleReadingPosition();
        }
        return;
    }
    if (data.kind === 'compat:presentation' && data.presentation?.tokens && ['light', 'dark'].includes(data.presentation.colorScheme)) {
        readingPresentation = data.presentation;
        applyReadingPresentation(data.presentation);
        for (const row of rows.values()) streamViews.get(row.element)?.refreshSprite();
        for (const child of children) {
            // Only update our still-same-origin documents. Never reload authored content.
            try { if (child.contentDocument?.documentElement) applyReadingPresentation(data.presentation, child.contentDocument); } catch { /* An author may navigate its own frame. */ }
        }
        return;
    }
    if (data.kind === 'compat:composer' && data.token === token) {
        if (!composerPublishQueued) {
            composerReference = data.text;
            composerValue.set!.call(composerProxy, data.text);
        }
        return;
    }
    if (data.kind === 'compat:gallery' && data.token === token && data.storyId === snapshot?.character.id) {
        void loadGallery(data.storyId).catch(error => diagnostic('本地图库', error));
        return;
    }
    if (data.kind === 'compat:view') {
        const wasVisible = showMessages;
        showMessages = data.visible === true;
        if (!showMessages) { for (const row of rows.values()) disposeRow(row.element); rows.clear(); }
        else if (!wasVisible && initialized && !switchingSession && data.session === snapshot?.session) {
            prepareReadingBookmark(data.readingBookmark);
            renderMessages();
        }
        checkExtensionOverlay();
        return;
    }
    if (data.kind === 'compat:ping') { outer.postMessage({ kind: 'compat:hello', documentId }, '*'); return; }
    if (data.kind === 'compat:binding') {
        if (token !== data.token) transportedTemplateAssets = {};
        pendingComposerWrite = undefined;
        token = data.token;
        outer.postMessage({ kind: 'compat:bound', token }, '*');
        return;
    }
    if (data.kind === 'compat:init' && data.token === token) {
        Object.assign(retainedResources, data.resources);
        // postMessage already cloned changed catalogs. Unchanged catalogs stay
        // resident; switching chats must not copy every imported card again.
        const resources = retainedResources as SessionResources;
        data.snapshot = { ...data.snapshot, personas: resources.personas, extensions: resources.extensions,
            assetCatalog: { ...data.snapshot.assetCatalog, characters: resources.characters, presets: resources.presets } };
    }
    if (data.kind === 'compat:init' && data.token === token && snapshot && data.snapshot.session !== snapshot.session) {
        sessionSwitchTask = sessionSwitchTask.then(() => switchCompatibilitySession(data.snapshot, data.scripts, data.token, data.readingBookmark)).catch(error => {
            reportStartupFailure(data.token, error);
        });
        return;
    }
    if (data.kind === 'compat:init' && loading && data.token === token) {
        // A handshake retry must not restart scripts, but its snapshot is the new
        // delta baseline. Queue it during settlement just like an ordinary delta.
        const next = data.snapshot as CompatSnapshot;
        const delta: CompatSnapshotDelta = { ...next, order: next.messages.map(message => message.id) };
        if (transaction) deferredDeltas.push(delta); else applyDelta(delta);
        renderButtons(); publishExtensionMenu();
        if (initialized && !switchingSession) {
            outer.postMessage({ kind: 'compat:ready', token }, '*');
            publishExtensionMenu();
            const bindingToken = token;
            void startupEventsTask.then(() => finishStartupForSync(bindingToken)).catch(error => {
                reportStartupFailure(bindingToken, error);
            });
        }
        return;
    }
    if (data.kind === 'compat:init' && !loading) {
        loading = true; token = data.token;
        const startupToken = token;
        startupTask = (async () => {
            startupStage('读取角色状态');
            prepareReadingBookmark(data.readingBookmark);
            applySnapshot(data.snapshot); initialScripts = data.scripts;
            await loadGallery(data.snapshot.character.id);
            startupStage('加载扩展');
            await loadInstalledExtensions();
            await loadScripts((data.scripts as CardScript[]).filter(script => script.enabled), startupToken);
            if (startupToken !== token) return;
            startupStage('初始化 MVU 变量');
            await initializeAuthorVariables();
            if (startupToken !== token) return;
            startupStage('生成角色消息界面');
            renderMessages(); initialized = true; scheduleScriptRefresh();
            if (snapshot.mvuSettings.notifyLoading) notify('MVU 变量框架已就绪。', 'success');
            outer.postMessage({ kind: 'compat:ready', token }, '*');
        })();
        void startupTask.then(publishExtensionMenu, () => {});
        startupEventsTask = startupTask.then(async () => {
            if (startupToken !== token) return;
            try {
                for (const event of [events.SETTINGS_LOADED_BEFORE, events.SETTINGS_LOADED, events.SETTINGS_LOADED_AFTER, events.EXTENSION_SETTINGS_LOADED, events.EXTENSIONS_FIRST_LOAD, events.APP_READY]) {
                    startupStage(`准备故事事件：${event}`);
                    await emit(event);
                }
                startupStage(`准备故事事件：${events.CHAT_CHANGED}`);
                await emit(events.CHAT_CHANGED, snapshot.session);
            }
            catch (error) { diagnostic('会话启动事件', error); }
        });
        void startupEventsTask.then(() => finishStartupForSync(startupToken)).catch(error => {
            reportStartupFailure(startupToken, error);
        });
        return;
    }
    if (data.token !== token) return;
    if (data.kind === 'compat:native-progress') {
        // Token observers may start another generation. Never make settlement wait
        // on that observer, or its own settlement command could deadlock this queue.
        emitAndWait(events.STREAM_TOKEN_RECEIVED, data.text);
        return;
    }
    if (data.kind === 'compat:generation-progress') {
        const task = generationTasks.get(data.id);
        if (task && !task.stopped) {
            task.text += data.text; task.reasoning += data.reasoning;
            const text = task.text;
            const reasoning = task.reasoning;
            task.queue = task.queue.then(async () => {
                await emit(iframeEvents.STREAM_TOKEN_RECEIVED_FULLY, text, data.id);
                await emit(iframeEvents.STREAM_TOKEN_RECEIVED_INCREMENTALLY, data.text, data.id);
                await emit(iframeEvents.REASONING_TOKEN_RECEIVED_FULLY, reasoning, data.id);
                await emit(iframeEvents.REASONING_TOKEN_RECEIVED_INCREMENTALLY, data.reasoning, data.id);
            });
            void task.queue.catch(error => diagnostic('生成流事件', error));
        }
        return;
    }
    if (data.kind === 'compat:snapshot') { if (!transaction) applyDelta(data.delta); else deferredDeltas.push(data.delta); return; }
    if (data.kind === 'compat:reply') {
        const job = waiting.get(data.id); if (!job) return;
        waiting.delete(data.id); clearTimeout(job.timer);
        if (data.handoff) {
            const error = new Error('聊天已切换，旧任务已取消');
            for (const pending of waiting.values()) { clearTimeout(pending.timer); pending.reject(error); }
            waiting.clear();
            chat = [];
            metadata = { variables: {} };
            switchingSession = true;
            try { applyDelta(data.handoff); }
            finally { switchingSession = false; }
            openingSession = snapshot.session;
            openingCommitted = false;
            writeFailure = undefined;
            externalWorldInfo.clear();
            deferredDeltas.length = 0;
            prepareReadingBookmark(undefined);
            synchronizeTemplateScopes();
        }
        if (data.delta) { if (!transaction) applyDelta(data.delta); else deferredDeltas.push(data.delta); }
        if (data.error) job.reject(Object.assign(new Error(data.error), { name: data.errorName ?? 'Error' })); else job.resolve(data.result);
        return;
    }
    if (data.kind !== 'compat:command') return;
    const replyToken = data.token;
    if (data.command === 'saveBeforeRouteChange') {
        void Promise.resolve().then(async () => {
            if (transaction || switchingSession) throw new Error('剧情正在结算，请稍后再切换');
            await Promise.all([...legacyChatWrites]);
            await saveChatMetadata(undefined, true);
        }).then(() => outer.postMessage({ kind: 'compat:result', token: replyToken, id: data.id, result: {} }, '*'),
            error => outer.postMessage({ kind: 'compat:result', token: replyToken, id: data.id, error: error instanceof Error ? error.message : String(error) }, '*'));
        return;
    }
    if (data.command === 'extensionIllustration') {
        void Promise.resolve().then(async () => {
            const api = globals.STBaiBaiImage;
            if (typeof api?.generate !== 'function') throw new Error('柏宝绘尚未就绪');
            const result = await api.generate({ prompt: data.args[0], save: true });
            if (!result.path) throw new Error('已生成图片，但柏宝绘未能保存到图库');
            outer.postMessage({ kind: 'compat:result', token: replyToken, id: data.id, result: { illustrationPath: result.path } }, '*');
        }).catch(error => outer.postMessage({ kind: 'compat:result', token: replyToken, id: data.id, error: error instanceof Error ? error.message : String(error) }, '*'));
        return;
    }
    if (data.command === 'claimTemplateTask') {
        try { residentTemplates.claim(data.args[0]);
            outer.postMessage({ kind: 'compat:result', token, id: data.id, result: {} }, '*'); }
        catch (error) { outer.postMessage({ kind: 'compat:result', token, id: data.id, error: String(error) }, '*'); }
        return;
    }
    if (data.command === 'finishTemplateTask') {
        try { residentTemplates.finish(data.args[0], data.args[1] === true);
            if (!transaction) applyDelta(data.delta); else deferredDeltas.push(data.delta);
            outer.postMessage({ kind: 'compat:result', token, id: data.id, result: {} }, '*'); }
        catch (error) { outer.postMessage({ kind: 'compat:result', token, id: data.id, error: String(error) }, '*'); }
        return;
    }
    // Author event handlers can await generate(); its prompt Worker must not wait behind that same event.
    if (data.command === 'assemblePrompt') {
        void (async () => {
            if (!transaction) applyDelta(data.delta); else deferredDeltas.push(data.delta);
            // Preparation errors must reject the command, not escape the event
            // handler and leave the caller waiting until the timeout.
            if (data.templateAssets) Object.assign(transportedTemplateAssets, data.templateAssets);
            const input = (data.templateAssets ? { ...structuredClone(transportedTemplateAssets), ...data.args[0] } : data.args[0]) as AssemblePromptInput;
            if (switchingSession) await sessionDataReady;
            if (replyToken !== token) throw new Error('模板请求所属聊天已切换');
            return input.templatePreview ? assemblePrompt(input) : residentTemplates.run(input, input.nativePrompt?.afterScan
                ? (id, activations, count) => request('nativePlugins.afterScan', { id, activations, count }, 1800) : undefined);
        })().then(assembled => outer.postMessage({ kind: 'compat:result', token: replyToken, id: data.id, result: { assembled } }, '*'))
            .catch(error => outer.postMessage({ kind: 'compat:result', token: replyToken, id: data.id, error: String(error) }, '*'));
        return;
    }
    if (data.command === 'extensionMenu' || data.command === 'slash' || data.command === 'quickReply' || data.command === 'quickReplyContext' || data.command === 'scriptButton' || data.command === 'event' || data.command === 'settledMessageReceived') {
        // A /trigger may await generation events sent back to this document.
        // Do not hold the event queue while the command awaits those events.
        if (!transaction) applyDelta(data.delta); else deferredDeltas.push(data.delta);
        const run = data.command === 'extensionMenu' ? Promise.resolve().then(() => {
            const item = extensionActionTargets().find(node => extensionMenuIds.get(node) === data.args[0]);
            if (item instanceof HTMLElement) item.click();
        }) : data.command === 'settledMessageReceived' ? dispatchEvent(events.MESSAGE_RECEIVED, data.args, true)
            : data.command === 'event' ? emit(data.args[0], ...data.args.slice(1))
            : data.command === 'scriptButton' ? runScriptButton(data.args[0])
            : data.command === 'quickReply' ? quickReplies.api.executeQuickReply(data.args[0], data.args[1])
            : data.command === 'quickReplyContext' ? quickReplies.executeContext(data.args[0], data.args[1], data.args[2]) : runAuthorSlash(data.args[0]);
        void run.then(pipe => outer.postMessage({ kind: 'compat:result', token: replyToken, id: data.id, result: { pipe } }, '*'), error => {
            diagnostic(data.command, error);
            outer.postMessage({ kind: 'compat:result', token: replyToken, id: data.id, error: error instanceof Error ? error.message : String(error) }, '*');
        });
        return;
    }
    if (['prepareHelperGeneration', 'finishHelperGeneration', 'cancelHelperGeneration'].includes(data.command)) {
        if (!transaction) applyDelta(data.delta); else deferredDeltas.push(data.delta);
        const run = data.command === 'prepareHelperGeneration' ? prepareHelperGeneration(data.args[0], data.args[1])
            : data.command === 'finishHelperGeneration' ? finishHelperGeneration(data.args[0], data.args[1]).then(generationResult => ({ generationResult }))
            : cancelHelperGeneration(data.args[0]).then(() => ({}));
        void run.then(result => outer.postMessage({ kind: 'compat:result', token: replyToken, id: data.id, result }, '*'),
            error => outer.postMessage({ kind: 'compat:result', token: replyToken, id: data.id, error: String(error), errorName: error?.name }, '*'));
        return;
    }
    commandQueue = commandQueue.then(async () => {
        try {
            if (replyToken !== token) throw new Error('执行请求所属聊天已切换');
            applyDelta(data.delta);
            let result: any = {};
            if (data.command === 'assemblePrompt') result.assembled = await assemblePrompt(data.args[0]);
            else if (data.command === 'event') await emit(data.args[0], ...data.args.slice(1));
            else if (data.command === 'validateVariables') {
                const registered = variableSchemas.get(data.args[0]);
                result.variables = registered ? await registered.schema.parseAsync(data.args[1]) : data.args[1];
                if (!_.isPlainObject(result.variables)) throw new Error('变量管理器结构必须返回对象');
            }
            else if (data.command === 'validatePluginVariables') {
                const [session, epoch, head, swipe, scope, before, candidate, changesMvu] = data.args;
                if (snapshot.session !== session || (snapshot.branchEpoch ?? 0) !== epoch || chat.at(-1)?._id !== head || chat.at(-1)?.swipe_id !== swipe) {
                    throw new Error('校验时剧情路线已切换，请重新预演');
                }
                assertAuthorScriptsReady();
                let next = normalizeMvuVariables(candidate).variables;
                const registered = variableSchemas.get(scope)?.schema;
                if (registered && registered !== mvuVariableSchema) {
                    const parsed = await registered.parseAsync(next);
                    if (!_.isPlainObject(parsed)) throw new Error('变量管理器结构必须返回对象');
                    next = { ...next, ...parsed };
                }
                // Chat and message edits must both honor the same author MVU schema.
                if (schema && (changesMvu || !_.isEqual(next.stat_data, before.stat_data))) {
                    next = await parseMvuVariables(next, schema);
                    next.stat_data = mvuJsonValue(next.stat_data);
                    next.schema = '没有用别管这个';
                    delete next.display_data;
                    delete next.delta_data;
                }
                result.variables = next;
            }
            else if (data.command === 'beforeGeneration') {
                assertAuthorScriptsReady();
                await initializeNewMvuBindings();
                await saveChatMetadata(undefined, true);
                const type = data.args[0] ?? 'normal';
                if (snapshot.routeReplacing && baibaiRunning()) await emit(events.CHAT_CHANGED, snapshot.session);
                await emit(events.GENERATION_STARTED, type, {}, false);
                await emit(events.GENERATION_AFTER_COMMANDS, type, {}, false);
                await flush();
                const { aborted, history } = await interceptGenerationHistory(type);
                result.generationAborted = aborted;
                result.interceptedHistory = history;
                result.injections = aborted ? [] : await collectInjections(true);
                await flush();
            } else if (data.command === 'runSPresetFinalRequest') {
                const payload = (data.args[0] ?? {}) as { request?: Record<string, any>; activatedLorebookEntries?: Array<Record<string, any>> };
                const reqDraft = payload.request ?? {};
                if (Array.isArray(payload.activatedLorebookEntries) && payload.activatedLorebookEntries.length) {
                    await emit(events.WORLD_INFO_ACTIVATED, payload.activatedLorebookEntries);
                }
                await emit(events.CHAT_COMPLETION_SETTINGS_READY, reqDraft);
                const beforeMeta = structuredClone(metadata);
                const beforeExtras = chat.map(row => row?.extra ? structuredClone(row.extra) : undefined);
                const out = await runSPresetFinalRequestInRealm({ request: reqDraft, rawPreset: nativeOaiSettings });
                const extrasChanged = chat.some((row, index) => !_.isEqual(row?.extra, beforeExtras[index]));
                if (metadataSaveTimer !== undefined || !_.isEqual(metadata, beforeMeta) || extrasChanged) {
                    clearTimeout(metadataSaveTimer);
                    metadataSaveTimer = undefined;
                    await saveChatMetadata(undefined, chat.length === snapshot.messages.length);
                }
                result.spresetRequest = out.request;
                result.spresetOutputPreprocessing = out.outputPreprocessing;
                result.spresetApplied = out.applied;
                result.spresetDeletedReasoningEffort = out.deletedReasoningEffort;
            } else if (data.command === 'refreshRouteMemory') {
                if (baibaiRunning()) await emit(events.CHAT_CHANGED, snapshot.session);
            } else if (data.command === 'settle') result = await settle(data.args[0], data.args[1], true, false, undefined, data.args[2]?.strict === true, data.args[2]?.messageContent);
            else if (data.command === 'diagnostics') result.diagnostics = diagnostics;
            else throw new Error(`未实现的兼容运行命令：${data.command}`);
            outer.postMessage({ kind: 'compat:result', token: replyToken, id: data.id, result }, '*');
        } catch (error) {
            diagnostic(data.command, error);
            outer.postMessage({ kind: 'compat:result', token: replyToken, id: data.id, error: error instanceof Error ? error.message : String(error) }, '*');
        } finally {
            for (const delta of deferredDeltas.splice(0)) applyDelta(delta);
        }
    });
});
outer.postMessage({ kind: 'compat:hello', documentId }, '*');

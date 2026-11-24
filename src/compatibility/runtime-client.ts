import { showNotification } from '../store/notification-store';
import { compatibilityOrigin } from '../core/native-runtime';
import { compatibilityDiagnosticStates, diagnosticLabel, diagnosticOperation, recordDiagnostic } from '../core/diagnostics';
import { sessionResources, sessionSnapshot, type SessionResources } from './session-resources';
import type { CompatibilityHost, CompatibilityLoadReport, CompatibilityScriptButton, CompatSnapshot, CompatSnapshotDelta, RuntimeResult } from './contracts';
import { templateAssetFields, type TemplateAssets } from './template-transport';
import { compatibilityComposer } from './composer-bridge';
import { setStoryRuntimeLoading, noteSyncInteraction } from '../core/sync/activity';
import { mutatesStory, runBranchOperation } from '../store/branch-runtime';
import { isReadingBookmark, readReadingBookmark, writeReadingBookmark } from '../shell/reading-bookmark';
import { baibaiBundleIds } from './baibai-route';

let host: CompatibilityHost | undefined;
/** Expected cancellation when the UI replaces a chat's connection. */
export class CompatibilityConnectionChangedError extends Error {}
interface RuntimeEndpoint {
    session: string; window: Window; token: string; branchEpoch: number;
    startupComplete?: boolean;
    transport: Promise<void>; resolveTransport(): void; rejectTransport(error: Error): void;
    ready: Promise<void>; resolveReady?: () => void; rejectReady(error: Error): void;
    templateAssets?: Partial<TemplateAssets>;
    dispose?: () => void;
    removeListeners?: () => void;
    opening?: { id: string | null; bundles: string[]; committed?: boolean; committing?: boolean; write?: Promise<unknown>; timer: ReturnType<typeof setTimeout> };
    createdBundle?: { routeId: string; hash: string };
    switching?: boolean;
}
let endpoint: RuntimeEndpoint | undefined;
const emptyScriptButtons: CompatibilityScriptButton[] = [];
let scriptButtons = emptyScriptButtons;
const scriptButtonSubscribers = new Set<() => void>();
export const getCompatibilityScriptButtons = () => scriptButtons;
const extensionMenuSubscribers = new Set<() => void>();
let extensionMenuButtons = emptyScriptButtons;
let illustrationAvailable = false;
export const getCompatibilityExtensionMenu = () => extensionMenuButtons;
export const getCompatibilityIllustrationAvailable = () => illustrationAvailable;
export function subscribeCompatibilityExtensionMenu(subscriber: () => void) {
    extensionMenuSubscribers.add(subscriber);
    return () => { extensionMenuSubscribers.delete(subscriber); };
}
function publishExtensionMenu(buttons: CompatibilityScriptButton[], hasIllustration = false) {
    if (illustrationAvailable === hasIllustration && buttons.length === extensionMenuButtons.length && buttons.every((item, index) => item.id === extensionMenuButtons[index].id && item.name === extensionMenuButtons[index].name)) return;
    illustrationAvailable = hasIllustration;
    extensionMenuButtons = buttons;
    extensionMenuSubscribers.forEach(subscriber => subscriber());
}
export function subscribeCompatibilityScriptButtons(subscriber: () => void) {
    scriptButtonSubscribers.add(subscriber);
    return () => { scriptButtonSubscribers.delete(subscriber); };
}
function publishScriptButtons(buttons: CompatibilityScriptButton[]) {
    if (buttons.length === scriptButtons.length && buttons.every((button, index) => button.id === scriptButtons[index].id && button.name === scriptButtons[index].name)) return;
    scriptButtons = buttons;
    scriptButtonSubscribers.forEach(subscriber => subscriber());
}
export function compatibilityStoryReady(session: string): boolean { return endpoint?.session === session && endpoint.startupComplete === true && !endpoint.opening && !endpoint.switching; }
export function requireCompatibilityRouteReady() {
    if (endpoint && (!endpoint.startupComplete || endpoint.opening || endpoint.switching || endpoint.session !== host?.session() || endpoint.branchEpoch !== (host?.snapshot().branchEpoch ?? 0))) {
        throw new Error('剧情路线正在载入，请稍后再生成');
    }
}
const connections = new Set<{ session: string; resolve(value: RuntimeEndpoint): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
let sequence = 0;
const pending = new Map<number, { resolve(value: RuntimeResult): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
let lastSnapshot: CompatSnapshot | undefined;
const documentResources = new WeakMap<Window, { documentId: string; resources: SessionResources }>();
function deltaSnapshot(forceVariables = false): CompatSnapshotDelta {
    const next = host!.snapshot();
    const previous = lastSnapshot;
    lastSnapshot = next;
    const previousMessages = new Set(previous?.messages);
    return { session: next.session, revision: next.revision, character: next.character, userName: next.userName,
        generating: next.generating, branchEpoch: next.branchEpoch, routeId: next.routeId, routeReplacing: next.routeReplacing,
        ...(previous?.nativeMessageMenu === next.nativeMessageMenu ? {} : { nativeMessageMenu: next.nativeMessageMenu }),
        ...(previous?.chatMetadata === next.chatMetadata ? {} : { chatMetadata: next.chatMetadata ?? null }),
        modelSettings: next.modelSettings,
        mvuExtraAnalysisActive: next.mvuExtraAnalysisActive,
        helperRenderDepth: next.helperRenderDepth,
        mvuSettings: next.mvuSettings,
        ...(previous?.extensions === next.extensions ? {} : { extensions: next.extensions }),
        ...(previous?.assembledMessages === next.assembledMessages ? {} : { assembledMessages: next.assembledMessages }),
        order: next.messages.map(m => m.id), messages: next.messages.filter(message => forceVariables || !previousMessages.has(message)),
        scopes: Object.fromEntries(Object.entries(next.scopes).filter(([scope, value]) => forceVariables || previous?.scopes[scope as keyof CompatSnapshot['scopes']] !== value)),
        ...(forceVariables || previous?.scriptVariables !== next.scriptVariables ? { scriptVariables: next.scriptVariables } : {}),
        ...(forceVariables || previous?.extensionVariables !== next.extensionVariables ? { extensionVariables: next.extensionVariables } : {}),
        ...(previous?.worldbookBindings === next.worldbookBindings ? {} : { worldbookBindings: next.worldbookBindings }),
        ...(previous?.worldinfoSettings === next.worldinfoSettings ? {} : { worldinfoSettings: next.worldinfoSettings }),
        ...(previous?.regexCatalog === next.regexCatalog ? {} : { regexCatalog: next.regexCatalog }),
        ...(previous?.assetCatalog === next.assetCatalog ? {} : { assetCatalog: {
            ...(previous?.assetCatalog.characters === next.assetCatalog.characters ? {} : { characters: next.assetCatalog.characters }),
            ...(previous?.assetCatalog.presets === next.assetCatalog.presets ? {} : { presets: next.assetCatalog.presets }),
            ...(previous?.assetCatalog.inUsePreset === next.assetCatalog.inUsePreset ? {} : { inUsePreset: next.assetCatalog.inUsePreset }),
            loadedPresetName: next.assetCatalog.loadedPresetName,
        } }),
        ...(previous?.scriptTrees === next.scriptTrees ? {} : { scriptTrees: next.scriptTrees }),
        activePersonaId: next.activePersonaId,
        proxyPresets: next.proxyPresets,
        ...(previous?.personas === next.personas ? {} : { personas: next.personas }),
        ...(previous?.worldbooks === next.worldbooks ? {} : { worldbooks: next.worldbooks }) };
}

export function installCompatibilityHost(value: CompatibilityHost): void { host = value; }
export function compatibilitySnapshot(): CompatSnapshot | undefined { return host?.snapshot(); }
export function refreshCompatibilityGallery(storyId: string): void {
    if (endpoint) endpoint.window.postMessage({ kind: 'compat:gallery', token: endpoint.token, storyId }, compatibilityOrigin);
}
export function stopCompatibilityRuntime(): void {
    disconnect(new CompatibilityConnectionChangedError('正在清空测试内容'));
    window.dispatchEvent(new Event('tipsy-compatibility-stop'));
}
export function resetCompatibilityBranch(): void {
    disconnect(new CompatibilityConnectionChangedError('故事路线已切换，旧任务已结束'));
    window.dispatchEvent(new Event('tipsy-compatibility-reload'));
}
export function saveCompatibilityBeforeRouteChange(): Promise<RuntimeResult> | undefined {
    if (endpoint?.startupComplete && endpoint.session === host?.session() && !endpoint.opening) {
        return commandCompatibilityRuntime('saveBeforeRouteChange');
    }
}
export function connectCompatibilityFrame(win: Window, session: string): () => void {
    if (endpoint?.window === win && (endpoint.switching || endpoint.session === session)) return endpoint.dispose ?? (() => {});
    if (endpoint?.window === win && lastSnapshot?.extensions.extensions.some(extension => extension.enabled && extension.generateInterceptor === 'bbs_generateInterceptor')) {
        resetCompatibilityBranch();
        return () => {};
    }
    disconnect(new CompatibilityConnectionChangedError('兼容会话已切换'));
    setStoryRuntimeLoading(true);
    let resolveTransport!: () => void;
    let rejectTransport!: (error: Error) => void;
    const transport = new Promise<void>((resolve, reject) => { resolveTransport = resolve; rejectTransport = reject; });
    void transport.catch(() => {});
    let resolveReady!: () => void;
    let rejectReady!: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    void ready.catch(() => {});
    const binding: RuntimeEndpoint = { window: win, session, branchEpoch: host?.snapshot().branchEpoch ?? 0, token: crypto.randomUUID(), transport, resolveTransport, rejectTransport, ready, resolveReady, rejectReady };
    endpoint = binding;
    for (const connection of connections) {
        clearTimeout(connection.timer);
        if (connection.session === session) connection.resolve(binding);
        else connection.reject(new CompatibilityConnectionChangedError('等待兼容环境期间会话已切换'));
    }
    connections.clear();
    let initialized = false;
    let startupComplete = false;
    let templateStartup: Promise<unknown> = Promise.resolve();
    let startupStage = '等待兼容服务连接';
    let logStage = '等待兼容服务连接';
    const logStartup = diagnosticOperation('兼容', '初始化作者运行环境');
    const reportStartupTimeout = () => {
        if (startupComplete || endpoint !== binding) return;
        const message = `角色初始化未完成：${startupStage}`;
        const error = new Error(message);
        binding.rejectTransport(error); binding.rejectReady(error);
        if (endpoint === binding) {
            logStartup('失败', { stage: logStage, code: 'TIMEOUT' });
            host?.diagnostic({ name: '初始化', scriptId: '', level: 'error', message });
            disconnect(error);
            window.dispatchEvent(new CustomEvent('tipsy-compatibility-fault', { detail: { session, message } }));
        }
    };
    let timer = setTimeout(reportStartupTimeout, 30000);
    const handle = async (event: MessageEvent) => {
        if (event.source !== win || event.origin !== compatibilityOrigin || endpoint !== binding) return;
        const data = event.data;
        if (data?.kind === 'compat:hello') {
            if (!host || host.session() !== session || initialized) return;
            initialized = true;
            // StrictMode can reconnect the listener without reloading the child document.
            win.postMessage({ kind: 'compat:binding', token: endpoint.token }, compatibilityOrigin);
            lastSnapshot = host.snapshot();
            const resources = sessionResources(lastSnapshot);
            const cached = documentResources.get(win);
            const previous = cached && cached.documentId === data.documentId ? cached.resources : undefined;
            const changed = Object.fromEntries(Object.entries(resources).filter(([key, value]) => !previous || previous[key as keyof SessionResources] !== value));
            win.postMessage({ kind: 'compat:init', token: endpoint.token, snapshot: sessionSnapshot(lastSnapshot), resources: changed,
                scripts: host.scripts(), readingBookmark: readReadingBookmark(session) }, compatibilityOrigin);
            documentResources.set(win, { documentId: data.documentId, resources });
            return;
        }
        if (data?.token !== endpoint.token) return;
        if (data.kind === 'compat:reading-bookmark') {
            if (data.session === binding.session && host?.session() === binding.session && isReadingBookmark(data.bookmark)) writeReadingBookmark(binding.session, data.bookmark);
            return;
        }
        if (data.kind === 'compat:script-buttons') {
            if (data.session === binding.session && host?.session() === binding.session && Array.isArray(data.buttons)) {
                publishScriptButtons(data.buttons.filter(button => typeof button?.id === 'string' && typeof button?.name === 'string'));
            }
            return;
        }
        if (data.kind === 'compat:extension-menu') {
            if (data.session === binding.session && host?.session() === binding.session && Array.isArray(data.buttons)) {
                publishExtensionMenu(data.buttons.filter(button => typeof button?.id === 'string' && typeof button?.name === 'string'), data.illustrationAvailable === true);
            }
            return;
        }
        if (data.kind === 'compat:interaction') { noteSyncInteraction(); return; }
        if (data.kind === 'compat:startup-complete') {
            if (!startupComplete) logStartup('成功', { stage: '初始化完成' });
            startupComplete = true; binding.startupComplete = true; clearTimeout(timer);
            setStoryRuntimeLoading(false);
            window.dispatchEvent(new CustomEvent('tipsy-compatibility-ready', { detail: session }));
            return;
        }
        if (data.kind === 'compat:fault') {
            if (!startupComplete) logStartup('失败', { stage: logStage, code: 'INITIALIZATION_ERROR' });
            else recordDiagnostic('兼容', '作者运行环境', '失败', { stage: '运行中', code: 'RUNTIME_FAULT' });
            setStoryRuntimeLoading(false);
            const error = new Error(String(data.message ?? '作者运行环境已失效'));
            clearTimeout(timer); disconnect(error);
            window.dispatchEvent(new CustomEvent('tipsy-compatibility-fault', { detail: { session: binding.session, message: error.message } }));
            return;
        }
        if (data.kind === 'compat:bound') {
            logStage = '加载角色资源与脚本';
            startupStage = '读取角色状态'; binding.resolveTransport();
            win.postMessage({ kind: 'compat:composer', token: binding.token, text: compatibilityComposer() }, compatibilityOrigin);
            return;
        }
        if (data.kind === 'compat:stage') {
            if (startupComplete) return;
            startupStage = String(data.stage);
            if (['读取角色状态', '加载扩展', '作者脚本入口已完成', '初始化 MVU 变量', '生成角色消息界面', '确认故事状态已保存'].includes(startupStage)) logStage = startupStage;
            else if (startupStage.startsWith('加载作者脚本：')) logStage = '加载作者脚本';
            else if (startupStage.startsWith('等待角色页面载入：')) logStage = '等待作者互动界面';
            else if (startupStage.startsWith('准备故事事件：')) logStage = '触发故事启动事件';
            window.dispatchEvent(new CustomEvent('tipsy-compatibility-stage', { detail: { session, stage: startupStage } }));
            return;
        }
        if (data.kind === 'compat:progress') {
            // Script catalogs also refresh after startup. Their progress must
            // never re-arm the completed session's initialization deadline.
            if (startupComplete) return;
            clearTimeout(timer);
            timer = setTimeout(reportStartupTimeout, 30000);
            return;
        }
        if (data.kind === 'compat:ready') {
            binding.resolveTransport();
            const firstReady = binding.resolveReady; binding.resolveReady = undefined;
            firstReady?.();
            if (firstReady) {
                templateStartup = Promise.resolve(host?.request('runtime.ready', {}));
                void templateStartup.catch(() => {});
            }
            return;
        }
        if (data.kind === 'compat:notice') {
            const kind = ['success', 'warning', 'error'].includes(data.level) ? data.level as 'success' | 'warning' | 'error' : 'info';
            showNotification(String(data.message), { kind, id: `compat:${binding.session}:${String(data.message)}` }); return;
        }
        if (data.kind === 'compat:load-report') {
            const row = data.report as CompatibilityLoadReport | undefined;
            if (!row || (row.type !== 'extension' && row.type !== 'script') || typeof row.id !== 'string') return;
            const observed = compatibilityDiagnosticStates[row.type];
            if (row.state === 'removed') { observed.delete(row.id); return; }
            if (row.state !== 'ready' && row.state !== 'failed') return;
            observed.set(row.id, row.state);
            if (row.state === 'failed') recordDiagnostic('兼容', row.type === 'extension' ? '酒馆扩展' : '作者脚本', '失败', {
                stage: row.stage === 'runtime' ? '运行中' : '初始化',
                code: ['DEPENDENCY_MISSING', 'UNSUPPORTED_MODULE', 'CATALOG_ERROR', 'LOAD_ERROR', 'TIMEOUT', 'RUNTIME_ERROR'].includes(row.code ?? '') ? row.code : 'ERROR',
                component: diagnosticLabel(typeof row.name === 'string' && row.name ? row.name : row.id),
                componentVersion: typeof row.version === 'string' ? diagnosticLabel(row.version) : undefined,
            });
            return;
        }
        if (data.kind === 'compat:runtime-error') {
            recordDiagnostic('兼容', data.area === 'author' ? '作者互动界面' : '作者运行环境', '失败', { stage: '运行中', code: 'RUNTIME_ERROR' });
            return;
        }
        if (data.kind === 'compat:diagnostic') { host?.diagnostic(data.diagnostic); return; }
        if (data.kind === 'compat:result') {
            const job = pending.get(data.id);
            if (!job) return;
            clearTimeout(job.timer); pending.delete(data.id);
            if (data.error) job.reject(Object.assign(new Error(data.error), { name: data.errorName ?? 'Error' })); else job.resolve(data.result ?? {});
            return;
        }
        if (data.kind !== 'compat:request' || !host || host.session() !== binding.session || binding.switching) return;
        const target = endpoint;
        const requestSession = binding.session;
        const streaming = data.method === 'extension.completion.read' || data.method === 'extension.completion.cancel';
        try {
            if (!streaming && ((host.snapshot().branchEpoch ?? 0) !== binding.branchEpoch || data.branchEpoch !== binding.branchEpoch)) throw new CompatibilityConnectionChangedError('操作所属故事路线已切换');
            if (data.session !== requestSession) return;
            if (binding.opening && !['legacy.commitOpening', 'legacy.finishOpening', 'runtime.refresh', 'runtime.sync'].includes(data.method)) throw new Error('新会话的开场正在交接');
            if (data.method === 'legacy.newChat') {
                if (!binding.startupComplete || pending.size) throw new Error('请等待当前操作结束后再创建聊天');
                const source = host.snapshot();
                const bundles = baibaiBundleIds(source.chatMetadata);
                if (binding.createdBundle?.routeId === source.routeId) bundles.push(binding.createdBundle.hash);
                binding.switching = true;
                try { await runBranchOperation(() => host!.request(data.method, data.params ?? {})); }
                finally { binding.switching = false; }
                if (endpoint !== binding) return;
                const next = host.snapshot();
                const delta = deltaSnapshot();
                binding.session = next.session; binding.branchEpoch = next.branchEpoch ?? 0;
                binding.opening = { id: next.messages[0]?.id ?? null, bundles, timer: setTimeout(() => {
                    if (endpoint !== binding) return;
                    if (binding.opening?.committing) {
                        void binding.opening.write?.finally(() => { if (endpoint === binding) resetCompatibilityBranch(); }).catch(() => {});
                    } else resetCompatibilityBranch();
                }, 10000) };
                win.postMessage({ kind: 'compat:reply', token: binding.token, id: data.id, handoff: delta }, compatibilityOrigin);
                return;
            }
            const opening = data.method === 'legacy.commitOpening' ? binding.opening : undefined;
            if (data.method === 'legacy.commitOpening' && (!opening || opening.committed || opening.committing)) throw new Error('没有可替换的会话开场');
            if (data.method === 'legacy.finishOpening') {
                if (!binding.opening || binding.opening.committing) throw new Error('开场写入尚未完成');
                win.postMessage({ kind: 'compat:reply', token: binding.token, id: data.id }, compatibilityOrigin);
                setTimeout(() => { if (endpoint === binding) resetCompatibilityBranch(); }, 0);
                return;
            }
            if (data.method === 'runtime.startup') await templateStartup;
            const vectorRoute = data.method === 'extension.memoryVector' && data.params?.action === 'vec/bundle/create' ? host.snapshot().routeId : undefined;
            const call = () => host!.request(data.method === 'runtime.startup' ? 'runtime.ready' : data.method,
                opening ? { ...data.params, opening: opening.id, allowedBundles: opening.bundles } : data.params ?? {});
            if (opening) opening.committing = true;
            const write = Promise.resolve(mutatesStory(data.method) && data.method !== 'legacy.save' ? runBranchOperation(call) : call());
            if (opening) opening.write = write;
            const result = await write.finally(() => { if (opening) opening.committing = false; });
            if (opening) opening.committed = true;
            if (endpoint === target && binding.session === requestSession && !binding.switching) {
                const hash = (result as { body?: { data?: { hash?: unknown } } } | undefined)?.body?.data?.hash;
                if (vectorRoute && typeof hash === 'string') binding.createdBundle = { routeId: vectorRoute, hash };
                const changed = (host.snapshot().branchEpoch ?? 0) !== binding.branchEpoch;
                win.postMessage({ kind: 'compat:reply', token: target.token, id: data.id, result, ...(!streaming && !changed && { delta: deltaSnapshot(data.method === 'runtime.sync') }) }, compatibilityOrigin);
                if (changed) setTimeout(() => { if (endpoint === target) resetCompatibilityBranch(); }, 0);
            }
        } catch (error) {
            if (endpoint === target && binding.session === requestSession) win.postMessage({ kind: 'compat:reply', token: target.token, id: data.id, error: error instanceof Error ? error.message : String(error), errorName: error instanceof Error ? error.name : 'Error',
                ...((host.snapshot().branchEpoch ?? 0) === binding.branchEpoch && { delta: deltaSnapshot(true) }) }, compatibilityOrigin);
            if (data.method === 'legacy.commitOpening') setTimeout(() => { if (endpoint === binding) resetCompatibilityBranch(); }, 0);
        }
    };
    window.addEventListener('message', handle);
    const syncComposer = (event: Event) => {
        if (endpoint === binding) win.postMessage({ kind: 'compat:composer', token: binding.token,
            text: (event as CustomEvent<string>).detail }, compatibilityOrigin);
    };
    window.addEventListener('tipsy-composer-value', syncComposer);
    win.postMessage({ kind: 'compat:ping' }, compatibilityOrigin);
    binding.dispose = () => { if (endpoint === binding) disconnect(new CompatibilityConnectionChangedError('兼容界面已关闭')); };
    binding.removeListeners = () => { clearTimeout(timer); window.removeEventListener('message', handle); window.removeEventListener('tipsy-composer-value', syncComposer); };
    return binding.dispose;
}
function disconnect(error: Error) {
    if (endpoint?.opening) clearTimeout(endpoint.opening.timer);
    endpoint?.removeListeners?.();
    if (endpoint) void Promise.resolve(host?.request('runtime.disconnect', { session: endpoint.session })).catch(error => console.warn('兼容会话关闭失败', error));
    endpoint?.rejectTransport(error);
    endpoint?.rejectReady(error);
    endpoint = undefined; lastSnapshot = undefined;
    compatibilityDiagnosticStates.extension.clear(); compatibilityDiagnosticStates.script.clear();
    publishScriptButtons(emptyScriptButtons);
    publishExtensionMenu(emptyScriptButtons);
    for (const job of pending.values()) { clearTimeout(job.timer); job.reject(error); }
    pending.clear();
    setStoryRuntimeLoading(false);
}
function waitForConnection(session: string): Promise<RuntimeEndpoint> {
    if (endpoint?.session === session) return Promise.resolve(endpoint);
    return new Promise((resolve, reject) => {
        const connection = { session, resolve, reject, timer: setTimeout(() => {
            connections.delete(connection); reject(new Error('兼容通信通道未能建立，请重新载入角色运行环境'));
        }, 30000) };
        connections.add(connection);
    });
}
export function publishCompatibilityGenerationProgress(id: string, text: string, reasoning: string): void {
    if (endpoint) endpoint.window.postMessage({ kind: 'compat:generation-progress', token: endpoint.token, id, text, reasoning }, compatibilityOrigin);
}
export function publishNativeGenerationProgress(messageId: string, floor: number, text: string, reasoning: string, done = false): void {
    if (endpoint) endpoint.window.postMessage({ kind: 'compat:native-progress', token: endpoint.token, messageId, floor, text, reasoning, done }, compatibilityOrigin);
}
export function syncCompatibilityFrame(): void {
    if (endpoint && !endpoint.switching && !endpoint.opening && lastSnapshot && host?.session() === endpoint.session) {
        const snapshot = host.snapshot();
        if ((snapshot.branchEpoch ?? 0) === endpoint.branchEpoch && snapshot !== lastSnapshot) endpoint.window.postMessage({ kind: 'compat:snapshot', token: endpoint.token, delta: deltaSnapshot() }, compatibilityOrigin);
    }
}
export async function commandCompatibilityRuntime(command: string, args: unknown[] = [], required = false, reuseTemplateAssets = false): Promise<RuntimeResult> {
    const session = host?.session();
    if (!session || (!required && (!endpoint || endpoint.session !== session))) {
        if (required) throw new Error('角色兼容宿主尚未安装');
        return {};
    }
    const target = await waitForConnection(session);
    // Host pipeline tasks consume initialized scripts/MVU. Exported EJS APIs used
    // during startup run inside the author realm and do not pass through this gate.
    await target.transport;
    if (!['claimTemplateTask', 'finishTemplateTask'].includes(command)) await target.ready;
    if (endpoint !== target || host?.session() !== session) throw new CompatibilityConnectionChangedError('兼容会话在执行前已切换');
    const id = ++sequence;
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            pending.delete(id);
            const error = new Error(`兼容环境执行超时：${command}`);
            reject(error);
            const input = args[0] as { templatePreview?: boolean } | undefined;
            if (command === 'assemblePrompt' && !input?.templatePreview && endpoint === target) {
                // A resident async function cannot be safely raced and then reused:
                // it may resume later against another task's variables. Drop the
                // whole author document and require an explicit retry instead.
                disconnect(error);
                window.dispatchEvent(new CustomEvent('tipsy-compatibility-fault', { detail: { session, message: error.message } }));
            }
        }, command === 'saveBeforeRouteChange' ? 5000 : ['event', 'settledMessageReceived', 'beforeGeneration', 'extensionIllustration', 'slash', 'quickReply', 'quickReplyContext', 'scriptButton', 'prepareHelperGeneration', 'finishHelperGeneration'].includes(command) ? 600000 : 30000);
        pending.set(id, { resolve, reject, timer });
        try {
            let templateAssets: Partial<TemplateAssets> | undefined;
            let nextAssets: Partial<TemplateAssets> | undefined;
            if (command === 'assemblePrompt' && reuseTemplateAssets) {
                const input = { ...(args[0] as Record<string, unknown>) };
                templateAssets = {}; nextAssets = {};
                for (const field of templateAssetFields) {
                    (nextAssets as Record<string, unknown>)[field] = input[field];
                    if (!target.templateAssets || target.templateAssets[field] !== input[field]) (templateAssets as Record<string, unknown>)[field] = input[field];
                    delete input[field];
                }
                args = [input];
            }
            target.window.postMessage({ kind: 'compat:command', token: target.token, id, command, args, templateAssets, delta: deltaSnapshot() }, compatibilityOrigin);
            if (nextAssets) target.templateAssets = nextAssets;
        }
        catch (error) { clearTimeout(timer); pending.delete(id); reject(error instanceof Error ? error : new Error(String(error))); }
    });
}

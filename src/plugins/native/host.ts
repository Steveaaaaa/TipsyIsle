import { z } from 'zod';
import type { CommandDeclaration, CommandInput, GenerationInput, MessageRef, Panel, Permission, ReplySaved, RouteChanged, StorageScope, PromptStageInput, ServiceInput, ToolInput } from '../../../packages/plugin-sdk/index.js';
import { supportedHostApi } from '../../../packages/plugin-sdk/package-format.mjs';
import { platformStorage } from '../../core/platform-bridge';
import { contentHash } from '../../pipeline/content-hash';
import { enqueuePersistentOperation } from '../../store/persistence';
import { stageCompatibilityChoice } from '../../compatibility/composer-bridge';
import { activePlugins, assertPluginActive, bindPluginTask, canRun, currentPluginDevice, deviceKey, errorMessage, initializeNativePlugins, loadPluginDevice, loadPluginPackage, nativePluginStore, pluginById, readPluginBucket, rememberPluginDevice, reportPlugin, type InstalledPlugin } from './catalog';
import { applyPluginPatch, validateJson, type PluginBucket } from './storage';
import { assertCurrentStory, commitPluginStory, findStoryMessage, liveStory, messageRef, nativeStoryBusy, replyBuckets, sameMessageRef, settled, storyMessage, storyPage, watchStory, type StoryView } from './story-port';
import { callVm } from './vm-client';
import { isPromptMode, vmLimits, type VmMode } from './vm-protocol';
import { untilAbort } from './abortable';
import { PluginApiError } from './errors';
import { callPlatform } from './platform-api';
import { storyChangeCursor, watchStoryChanges } from './events';

const smallId = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
const text = (size: number) => z.string().max(size);
const label = text(100).min(1);
const refSchema = z.strictObject({ messageId: text(300), swipeId: text(300), revision: text(200) });
const panelSchema = z.strictObject({ title: label,
    blocks: z.array(z.discriminatedUnion('type', [z.strictObject({ type: z.literal('text'), text: text(4000) }), z.strictObject({ type: z.literal('list'), items: z.array(text(2000)).max(24) }),
        z.strictObject({ type: z.literal('table'), columns: z.array(label).min(1).max(12), rows: z.array(z.array(text(2000)).max(12)).max(100) }),
        z.strictObject({ type: z.literal('media'), id: z.string().max(480), label })])).max(16).optional(),
    fields: z.array(z.strictObject({ id: smallId, label, type: z.enum(['text', 'textarea', 'checkbox', 'select']), initial: z.union([text(4000), z.boolean()]).optional(),
        required: z.boolean().optional(), options: z.array(z.strictObject({ value: text(200), label })).min(1).max(24).optional() })).max(12).optional(),
    actions: z.array(z.strictObject({ id: smallId, label, kind: z.enum(['primary', 'secondary']).optional() })).max(12).optional(), state: z.unknown().optional(),
    layout: z.strictObject({ html: text(180_000), css: text(90_000).optional() }).optional(),
    task: z.strictObject({ id: text(480).min(1), onFinished: smallId.optional() }).optional(),
});
const scopeSchema = z.enum(['device', 'route', 'reply']);
type Invocation = { mode: Exclude<VmMode, 'verify' | 'migrate'>; input: CommandInput | GenerationInput | ReplySaved | RouteChanged | PromptStageInput | ServiceInput | ToolInput | { cursor: string }; view: StoryView; plugin: InstalledPlugin;
    target?: MessageRef; id: string; external?: AbortSignal };

function parsePanel(value: unknown): Panel | null {
    if (value === null) return null;
    const panel = panelSchema.parse(value);
    for (const items of [panel.fields ?? [], panel.actions ?? []]) if (new Set(items.map(item => item.id)).size !== items.length) throw new Error('插件面板的标识不能重复');
    for (const field of panel.fields ?? []) {
        if (field.type === 'select' && (!field.options?.length || field.initial !== undefined && !field.options.some(option => option.value === field.initial))) throw new Error('插件面板的列表选项无效');
        if (field.initial !== undefined && typeof field.initial !== (field.type === 'checkbox' ? 'boolean' : 'string')) throw new Error('插件面板字段的默认值类型不符');
    }
    return { ...panel, state: panel.state === undefined ? undefined : validateJson(panel.state) };
}

export async function invokeNativePlugin(call: Invocation): Promise<unknown> {
    const { plugin, mode, view, target, external } = call;
    const id = plugin.manifest.id;
    const phase = mode === 'command' ? `操作 · ${(call.input as CommandInput).id}` : ({ replySaved: '回复已保存', routeChanged: '路线已切换', contribute: '生成补充',
        beforeScan: '世界书扫描前', afterScan: '世界书扫描后', storyChanged: '存档已更新', tool: '模型工具', service: '插件服务' })[mode];
    const timeout = mode === 'command' ? vmLimits.commandWall : isPromptMode(mode) ? vmLimits.contributionWall : mode === 'tool' ? vmLimits.toolWall : mode === 'service' ? vmLimits.serviceWall : vmLimits.eventWall;
    const task = bindPluginTask(plugin, timeout, external);
    const start = performance.now();
    const check = () => { task.signal.throwIfAborted(); assertPluginActive(plugin); };
    const currentRoute = () => { check(); assertCurrentStory(view, liveStory()); };
    const checkTarget = () => {
        if (target && !findStoryMessage(liveStory(), target)) throw new PluginApiError('STALE_REPLY', '插件操作对应的回复已经改变');
    };
    const persistent = mode === 'command' || mode === 'replySaved' || mode === 'storyChanged' || mode === 'service';
    const legacy = supportedHostApi(plugin.manifest) === '1.0.0';
    try {
        const pkg = await untilAbort(loadPluginPackage(plugin), task.signal);
        check();
        const permitted = (p: Permission) => { if (!plugin.grants.includes(p)) throw new PluginApiError('PERMISSION_DENIED', `未授予权限：${p}`); };
        let devicePromise: ReturnType<typeof loadPluginDevice> | undefined;
        let draft: string | undefined;
        const maps = new Map<StorageScope, { before?: PluginBucket; current: PluginBucket; changed: boolean }>();
        let count = 0;
        let pending: Promise<unknown> = Promise.resolve();
        const bucket = async (scope: StorageScope) => {
            permitted(`storage.${scope}`);
            const cached = maps.get(scope); if (cached) return cached;
            if (scope !== 'device' && !view.ref) throw new PluginApiError('STALE_ROUTE', '请先打开一段剧情');
            if (scope === 'reply' && !target) throw new PluginApiError('STALE_REPLY', '没有指定回复');
            devicePromise ??= scope === 'device' ? loadPluginDevice(plugin) : undefined;
            const before = scope === 'device' ? (await untilAbort(devicePromise!, task.signal)).bucket : scope === 'route' ? view.storage?.[id] : replyBuckets(view, target)?.[id];
            const data = { before, current: await untilAbort(readPluginBucket(pkg, before, scope, task.signal), task.signal), changed: false };
            maps.set(scope, data); return data;
        };
        const rpc = (method: string, args: unknown) => {
            const work = pending.then(async () => {
                check();
                switch (method) {
                    case 'story.readMessages': {
                        permitted('story.read');
                        const { before, limit } = z.strictObject({ before: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(16).optional() }).parse(args);
                        return storyPage(view, before, limit);
                    }
                    case 'story.getMessage': permitted('story.read'); return storyMessage(view, refSchema.parse(args));
                    case 'storage.read': {
                        const data = await bucket(scopeSchema.parse(args));
                        return { values: data.current.values, version: data.current.version };
                    }
                    case 'storage.patch': {
                        if (!persistent) throw new PluginApiError('PERMISSION_DENIED', '当前阶段只能读取存储');
                        const { scope, patch } = z.strictObject({ scope: scopeSchema, patch: z.unknown() }).parse(args);
                        if (scope !== 'device') { currentRoute(); checkTarget(); }
                        const data = await bucket(scope);
                        const next = await applyPluginPatch(data.current, patch, `${call.id}:${++count}`);
                        data.changed ||= data.current !== next; data.current = next;
                        return null;
                    }
                    case 'ui.replaceDraft':
                        permitted('composer.draft');
                        if (mode !== 'command' || !view.ref) throw new PluginApiError('PERMISSION_DENIED', '只有用户发起的剧情操作可以替换输入框');
                        currentRoute(); checkTarget(); draft = text(12_000).parse(args); return null;
                    case 'resources.read': {
                        permitted('resources.read');
                        const path = text(180).parse(args);
                        if (!Object.hasOwn(pkg.texts, path)) throw new PluginApiError('INVALID_ARGUMENT', '资源不在此插件的清单中');
                        return pkg.texts[path];
                    }
                    case 'log': reportPlugin(id, phase, 'log', performance.now() - start, text(800).parse(args)); return null;
                    default: return callPlatform(method, args, { plugin, pkg, mode, signal: task.signal, permit: permitted, check,
                        callService: (provider, input) => invokeNativePlugin({ mode: 'service', id: crypto.randomUUID(), input, plugin: provider,
                            view, target, external: task.signal }) });
                }
            }).catch(error => {
                if (error instanceof z.ZodError) throw new PluginApiError('INVALID_ARGUMENT', error.issues[0]?.message ?? '插件参数无效');
                throw error;
            });
            pending = work.catch(() => {});
            return work;
        };
        const output = await callVm({ mode, code: pkg.code, input: call.input,
            api: { hostApi: supportedHostApi(plugin.manifest), context: { story: view.ref, target, route: view.route ?? null }, settings: plugin.settings } }, task.signal, rpc);
        check();
        let result: unknown;
        if (mode === 'command') {
            if (output !== null) permitted('ui.panel');
            const panel = parsePanel(output);
            if (panel?.layout) permitted('ui.surface');
            if (panel?.blocks?.some(block => block.type === 'media')) permitted('media.manage');
            result = panel;
            if (legacy) { currentRoute(); checkTarget(); }
        } else if (mode === 'contribute') result = output === null ? null : z.strictObject({ text: text(2600) }).parse(output).text.trim() || null;
        else if (mode === 'beforeScan' || mode === 'afterScan' || mode === 'tool' || mode === 'service') result = output;
        else {
            if (output !== null) throw new Error('剧情事件处理器不应返回界面');
            result = null;
        }
        if (persistent) {
            const mutation = (scope: StorageScope) => {
                const data = maps.get(scope);
                return data?.changed ? { before: data.before, after: data.current } : undefined;
            };
            const device = mutation('device'), route = mutation('route'), reply = mutation('reply');
            const local = device ? { ...await devicePromise!, bucket: device.after } : undefined;
            const ready = () => {
                check();
                if (device && currentPluginDevice(id) !== devicePromise) throw new PluginApiError('STORAGE_CONFLICT', '插件设置或设备数据已改变，请重试');
                if (route || reply || legacy) { currentRoute(); checkTarget(); }
            };
            if (route || reply) {
                await commitPluginStory({ view, target, pluginId: id, route, reply, check: ready,
                    extras: local ? { [deviceKey(id)]: local } : undefined,
                    committed: local ? () => rememberPluginDevice(id, local) : undefined });
            } else if (local) await enqueuePersistentOperation(async () => {
                ready(); await platformStorage.saveSnapshots({ [deviceKey(id)]: local }, false); rememberPluginDevice(id, local);
            });
            if (draft !== undefined) { currentRoute(); checkTarget(); stageCompatibilityChoice(draft); }
        }
        if (!isPromptMode(mode)) reportPlugin(id, phase, 'ok', performance.now() - start);
        return result;
    } catch (error) {
        reportPlugin(id, phase, task.signal.aborted ? 'skipped' : 'error', performance.now() - start, errorMessage(error));
        throw error;
    } finally { task.close(); }
}

export interface PluginCommand { key: string; plugin: InstalledPlugin; spec: CommandDeclaration }
export function listNativeCommands(location: CommandDeclaration['location'], view = liveStory(), target?: MessageRef): PluginCommand[] {
    const node = target ? findStoryMessage(view, target) : view.path.at(-1);
    if (location !== 'workspace' && (!view.ref || view.busy || target && (!node || !settled(node)))) return [];
    return activePlugins().flatMap(plugin => (plugin.manifest.commands ?? []).filter(spec => spec.location === location
        && (!spec.role || node?.role === spec.role) && (!spec.latestOnly || !!node && sameMessageRef(view.ref?.head, messageRef(node))))
        .map(spec => ({ key: `${plugin.manifest.id}:${spec.id}`, plugin, spec })));
}

export interface CommandSession { command: PluginCommand; view: StoryView; target?: MessageRef }
export function watchNativeCommand(session: CommandSession, invalidate: () => void): () => void {
    const check = () => {
        try { assertPluginActive(session.command.plugin); if (supportedHostApi(session.command.plugin.manifest) === '1.0.0') assertCurrentStory(session.view, liveStory()); }
        catch { invalidate(); }
    };
    const offStory = supportedHostApi(session.command.plugin.manifest) === '1.0.0' ? watchStory(check) : () => {};
    const offPlugin = nativePluginStore.subscribe(check);
    check();
    return () => { offStory(); offPlugin(); };
}
export async function runNativeCommand(session: CommandSession, signal: AbortSignal, action?: CommandInput['action']): Promise<Panel | null> {
    const current = liveStory(), legacy = supportedHostApi(session.command.plugin.manifest) === '1.0.0';
    if (legacy) assertCurrentStory(session.view, current);
    const view = session.view;
    const command = listNativeCommands(session.command.spec.location, view, session.target).find(item => item.key === session.command.key);
    if (!command || command.plugin.digest !== session.command.plugin.digest || !canRun(command.plugin)) throw new Error('这个插件操作已不可用');
    const target = session.target ?? view.ref?.head ?? undefined;
    return await invokeNativePlugin({ mode: 'command', id: crypto.randomUUID(), input: { id: command.spec.id, target, action },
        plugin: command.plugin, view, target, external: signal }) as Panel | null;
}

export function notifyNativeReplySaved(view: StoryView, reply: MessageRef, kind: ReplySaved['kind']) {
    // Snapshot and durable acknowledgement are supplied by the workspace. LAN
    // restoration never produces a new event, even if the plugin is installed.
    if (!view.ref || !findStoryMessage(view, reply)) return;
    const event: ReplySaved = { id: `reply:${contentHash(JSON.stringify([view.ref.chatId, reply])).toString(36)}`, reply, kind };
    void initializeNativePlugins().then(() => {
        for (const plugin of activePlugins()) if (plugin.manifest.events?.includes('story.replySaved')) {
            void invokeNativePlugin({ mode: 'replySaved', id: `${event.id}:${kind}`, input: event, plugin, view, target: reply }).catch(() => {});
        }
    }).catch(() => {});
}

export function observeNativeRoutes() {
    let previous = liveStory().ref;
    let queued = false;
    const onChange = () => {
        if (queued || nativeStoryBusy() || !activePlugins().some(plugin => plugin.manifest.events?.includes('story.routeChanged'))) return;
        queued = true;
        queueMicrotask(() => {
            queued = false;
            if (nativeStoryBusy()) return;
            const view = liveStory(), before = previous;
            previous = view.ref;
            if (!view.ref || before?.routeId === view.ref.routeId) return;
            const event: RouteChanged = { id: `route:${view.ref.routeId}`, previous: before, current: view.ref };
            for (const plugin of activePlugins()) {
                if (!plugin.manifest.events?.includes('story.routeChanged')) continue;
                void invokeNativePlugin({ mode: 'routeChanged', id: event.id, input: event, plugin, view, target: view.ref.head ?? undefined }).catch(() => {});
            }
        });
    };
    watchStory(onChange);
    window.addEventListener('tipsy-sync-runtime-ready', onChange);
    window.addEventListener('tipsy-branch-operations-idle', onChange);
    nativePluginStore.subscribe((state, before) => {
        if (state.catalog !== before.catalog && !before.catalog.plugins.some(plugin => plugin.enabled && plugin.manifest.events?.includes('story.routeChanged')))
            previous = liveStory().ref;
    });
    const delivered = new Map<string, string>(), running = new Set<string>();
    const deliver = () => {
        const cursor = storyChangeCursor();
        if (!cursor || nativeStoryBusy()) return;
        for (const plugin of activePlugins()) {
            const id = plugin.manifest.id, key = `${id}:${plugin.digest}`;
            if (!plugin.manifest.events?.includes('story.changed') || delivered.get(key) === cursor || running.has(id)) continue;
            delivered.set(key, cursor); running.add(id);
            void invokeNativePlugin({ mode: 'storyChanged', input: { cursor }, id: `change:${cursor}`, plugin, view: liveStory() })
                .catch(() => {}).finally(() => { running.delete(id); if (storyChangeCursor() !== cursor) deliver(); });
        }
    };
    watchStoryChanges(deliver);
    watchStory(() => { if (!nativeStoryBusy()) queueMicrotask(deliver); });
    window.addEventListener('tipsy-sync-runtime-ready', deliver);
    window.addEventListener('tipsy-branch-operations-idle', deliver);
    nativePluginStore.subscribe((state, old) => {
        if (state.catalog !== old.catalog || state.maintenance !== old.maintenance) {
            for (const item of old.catalog.plugins) if (!canRun(item) || !activePlugins().some(plugin => plugin.manifest.id === item.manifest.id && plugin.digest === item.digest)) delivered.delete(`${item.manifest.id}:${item.digest}`);
            queueMicrotask(deliver);
        }
    });
}

export interface NativeContribution { id: string; digest: string; name: string; text: string; elapsed: number }
export const pluginPromptLimit = 256;
export const combinedPluginPromptLimit = 640;
export async function nativeGenerationContributions(kind: GenerationInput['kind'], signal: AbortSignal): Promise<NativeContribution[]> {
    // Bootstrap is warmed by the workspace. A local storage fault cannot block sending.
    if (!nativePluginStore.getState().ready) return [];
    const view = liveStory();
    const plugins = activePlugins().filter(plugin => plugin.manifest.generation === true);
    if (!view.ref || !plugins.length) return [];
    const input: GenerationInput = { id: crypto.randomUUID(), kind, maxTokens: pluginPromptLimit };
    const results = await Promise.all(plugins.map(async (plugin): Promise<NativeContribution | undefined> => {
        const start = performance.now();
        try {
            const output = await invokeNativePlugin({ mode: 'contribute', id: input.id, input, plugin, view, target: view.ref?.head ?? undefined, external: signal });
            const elapsed = performance.now() - start;
            const current = pluginById(plugin.manifest.id);
            if (current?.digest !== plugin.digest || !canRun(current)) return;
            try { assertCurrentStory(view, liveStory(), false); }
            catch (error) { reportPlugin(plugin.manifest.id, '生成补充', 'skipped', elapsed, errorMessage(error)); return; }
            if (typeof output === 'string') return { id: plugin.manifest.id, digest: plugin.digest, name: plugin.manifest.name, text: output, elapsed };
            reportPlugin(plugin.manifest.id, '生成补充', 'ok', elapsed, '本轮没有补充内容');
        } catch { /* Invocation records the failure; the story request continues. */ }
    }));
    signal.throwIfAborted();
    return results.filter((item): item is NativeContribution => !!item);
}

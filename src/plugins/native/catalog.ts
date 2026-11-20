import { gt } from 'semver';
import { platformStorage } from '../../core/platform-bridge';
import { createReactiveStore } from '../../store/reactive-store';
import { enqueuePersistentOperation } from '../../store/persistence';
import { supportedHostApi, validSetting } from '../../../packages/plugin-sdk/package-format.mjs';
import type { MigrationInput, MigrationResult, Permission, PluginManifest, Settings } from '../../../packages/plugin-sdk/index.js';
import { type PluginPackage } from './package';
import { emptyPluginBucket, pluginValues, type PluginBucket } from './storage';
import { storyBucketsForPlugin } from './story-port';
import { callVm } from './vm-client';
import { vmLimits } from './vm-protocol';
import { PluginApiError } from './errors';

const catalogKey = 'native_plugins_v1';
const packageKey = (id: string) => `native_plugin_package:${id}`;
export const deviceKey = (id: string) => `native_plugin_device:${id}`;
export const pluginLimit = 24;
export interface InstalledPlugin {
    manifest: PluginManifest;
    fingerprint: string;
    digest: string;
    enabled: boolean;
    prepared?: boolean;
    grants: Permission[];
    access?: PluginAccess;
    settings: Settings;
}
export interface PluginAccess { connections: string[]; assets: string[]; origins: string[] }
export interface LocalPluginData { bucket: PluginBucket; settings: Settings }
interface Catalog { plugins: InstalledPlugin[]; publishers: Record<string, string> }
export interface PluginDiagnostic { at: number; task: string; elapsed: number; status: 'ok' | 'error' | 'skipped' | 'log'; detail?: string }
interface CatalogView { ready: boolean; error: string; catalog: Catalog; maintenance: string[]; diagnostics: Record<string, PluginDiagnostic[]> }
export const nativePluginStore = createReactiveStore<CatalogView>(() => ({ ready: false, error: '', catalog: { plugins: [], publishers: {} }, maintenance: [], diagnostics: {} }));
const pkgCache = new Map<string, Promise<PluginPackage>>();
const deviceCache = new Map<string, Promise<LocalPluginData>>();
const running = new Map<string, Set<AbortController>>();
let initialization: Promise<void> | undefined;

export const pluginById = (id: string) => nativePluginStore.getState().catalog.plugins.find(plugin => plugin.manifest.id === id);
export function canRun(plugin: InstalledPlugin) {
    return plugin.enabled && plugin.prepared !== false && !nativePluginStore.getState().maintenance.includes(plugin.manifest.id)
        && !!supportedHostApi(plugin.manifest) && plugin.manifest.permissions.every(p => plugin.grants.includes(p));
}
export const activePlugins = () => nativePluginStore.getState().catalog.plugins.filter(canRun);
export function initializeNativePlugins(): Promise<void> {
    return initialization ??= platformStorage.loadSnapshot<Catalog>(catalogKey, { plugins: [], publishers: {} })
        .then(catalog => { nativePluginStore.setState({ ready: true, error: '', catalog }); })
        .catch(error => { initialization = undefined; nativePluginStore.setState({ ready: false, error: errorMessage(error) }); throw error; });
}
export const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
export function reportPlugin(id: string, task: string, status: PluginDiagnostic['status'], elapsed = 0, detail?: string) {
    nativePluginStore.setState(draft => {
        const rows = draft.diagnostics[id] ??= [];
        rows.unshift({ at: Date.now(), task, status, elapsed: Math.round(elapsed), detail: detail?.slice(0, 800) });
        if (rows.length > 30) rows.length = 30;
    });
}
export function assertPluginActive(plugin: InstalledPlugin) {
    const current = pluginById(plugin.manifest.id);
    if (current?.digest !== plugin.digest || !canRun(current)) throw new PluginApiError('PLUGIN_INACTIVE', '插件已停用或更新，请重新打开操作');
}

export function bindPluginTask(plugin: InstalledPlugin, timeout: number, external?: AbortSignal) {
    const id = plugin.manifest.id;
    assertPluginActive(plugin);
    const controller = new AbortController();
    const tasks = running.get(id) ?? new Set(); running.set(id, tasks); tasks.add(controller);
    const abort = () => controller.abort(external?.reason);
    if (external?.aborted) abort(); else external?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error('插件操作超时，已跳过')), timeout);
    return { signal: controller.signal, close() {
        clearTimeout(timer); external?.removeEventListener('abort', abort); tasks.delete(controller);
        if (!tasks.size && running.get(id) === tasks) running.delete(id);
    } };
}
function stopTasks(id: string) {
    for (const task of running.get(id) ?? []) task.abort(new Error('插件已停用或正在更新'));
    running.delete(id);
}

export async function loadPluginPackage(plugin: InstalledPlugin): Promise<PluginPackage> {
    const id = plugin.manifest.id;
    if (!pkgCache.has(id)) pkgCache.set(id, platformStorage.loadSnapshot<PluginPackage | null>(packageKey(id), null).then(value => {
        if (!value) throw new Error('插件包文件缺失，请重新安装');
        return value;
    }).catch(error => { pkgCache.delete(id); throw error; }));
    const value = await pkgCache.get(id)!;
    if (value.digest !== plugin.digest || value.fingerprint !== plugin.fingerprint) throw new Error('插件包版本已改变，请重试');
    return value;
}
export function loadPluginDevice(plugin: InstalledPlugin): Promise<LocalPluginData> {
    const id = plugin.manifest.id;
    if (!deviceCache.has(id)) deviceCache.set(id, platformStorage.loadSnapshot<LocalPluginData>(deviceKey(id), {
        bucket: emptyPluginBucket(plugin.fingerprint, plugin.manifest.storageVersion), settings: plugin.settings,
    }).catch(error => { deviceCache.delete(id); throw error; }));
    return deviceCache.get(id)!;
}
export const currentPluginDevice = (id: string) => deviceCache.get(id);
export function rememberPluginDevice(id: string, value: LocalPluginData) { deviceCache.set(id, Promise.resolve(value)); }

export function normalizePluginSettings(manifest: PluginManifest, values: Settings, strict = false): Settings {
    return Object.fromEntries((manifest.settings ?? []).map(field => {
        const value = values[field.id];
        if (strict && value !== undefined && !validSetting(field, value)) throw new Error(`请检查「${field.label}」的值`);
        return [field.id, validSetting(field, value) ? value : field.default];
    }));
}

const migratedBuckets = new WeakMap<PluginBucket, Map<string, Promise<MigrationResult>>>();
async function migrateValues(pkg: PluginPackage, from: PluginBucket, scope: MigrationInput['scope'], signal: AbortSignal, settings?: Settings): Promise<MigrationResult> {
    signal.throwIfAborted();
    if (from.owner !== pkg.fingerprint) throw new Error('此数据属于不同签名的发布者');
    if (from.schemaVersion === pkg.manifest.storageVersion) return { values: from.values, settings };
    if (from.schemaVersion > pkg.manifest.storageVersion) throw new Error('此存档使用了较新的插件格式，请先更新插件');
    if (!pkg.migration) throw new Error(`插件缺少从存储格式 ${from.schemaVersion} 升级的迁移入口`);
    const key = `${pkg.digest}:${scope}`;
    let cache = migratedBuckets.get(from);
    if (!cache) migratedBuckets.set(from, cache = new Map());
    let migration = settings === undefined ? cache.get(key) : undefined;
    if (!migration) {
        migration = (async () => {
            const input: MigrationInput = { scope, fromVersion: from.schemaVersion, toVersion: pkg.manifest.storageVersion, values: from.values, settings };
            const output = await callVm({ mode: 'migrate', code: pkg.migration!, input }, signal) as MigrationResult | null;
            if (!output || typeof output !== 'object' || Array.isArray(output)) throw new Error('迁移必须返回 values 对象');
            if (output.settings !== undefined && (scope !== 'device' || !output.settings || typeof output.settings !== 'object' || Array.isArray(output.settings))) throw new Error('只有设备迁移可以返回插件设置');
            pluginValues(output.values);
            if (output.settings !== undefined) normalizePluginSettings(pkg.manifest, output.settings, true);
            return output;
        })();
        if (settings === undefined) {
            cache.set(key, migration);
            void migration.catch(() => { if (cache.get(key) === migration) cache.delete(key); });
        }
    }
    const result = await migration;
    signal.throwIfAborted();
    return result;
}
export async function readPluginBucket(pkg: PluginPackage, stored: PluginBucket | undefined, scope: MigrationInput['scope'], signal: AbortSignal): Promise<PluginBucket> {
    if (!stored) return emptyPluginBucket(pkg.fingerprint, pkg.manifest.storageVersion);
    const result = await migrateValues(pkg, stored, scope, signal);
    return stored.schemaVersion === pkg.manifest.storageVersion ? stored : { ...stored, schemaVersion: pkg.manifest.storageVersion, values: result.values };
}

export interface InstallReview { pkg: PluginPackage; current?: InstalledPlugin; added: Permission[] }
export function reviewPlugin(pkg: PluginPackage): InstallReview {
    const { id, version, storageVersion, permissions } = pkg.manifest;
    const catalog = nativePluginStore.getState().catalog;
    const current = pluginById(id);
    const registered = catalog.publishers[id];
    if (registered && registered !== pkg.fingerprint) throw new Error('签名与此插件首次安装时的发布者不一致，已拒绝替换');
    if (!current && catalog.plugins.length >= pluginLimit) throw new Error(`此设备最多安装 ${pluginLimit} 个原生插件`);
    if (current && !gt(version, current.manifest.version)) throw new Error(current.digest === pkg.digest ? '这个版本已安装' : '更新必须使用更高的插件版本');
    if (current && storageVersion < current.manifest.storageVersion) throw new Error('更新不能降低插件存储格式版本');
    if (current && storageVersion > current.manifest.storageVersion && !pkg.migration) throw new Error('改变存储格式需要提供迁移入口');
    return { pkg, current, added: permissions.filter(item => !current?.manifest.permissions.includes(item)) };
}
async function verifyPlugin(pkg: PluginPackage) {
    const { commands, events, generation, pipeline, tools, provides } = pkg.manifest;
    await callVm({ mode: 'verify', code: pkg.code, input: { commands: (commands ?? []).map(command => command.id), events: events ?? [], generation: generation === true,
        pipeline: pipeline ?? [], tools: (tools ?? []).map(tool => tool.id), services: provides ?? [] } },
        AbortSignal.timeout(vmLimits.commandWall));
    if (pkg.migration) await callVm({ mode: 'verify', code: pkg.migration, input: { migration: true } }, AbortSignal.timeout(vmLimits.commandWall));
}
async function preparePluginData(pkg: PluginPackage): Promise<LocalPluginData> {
    const { id, storageVersion } = pkg.manifest;
    await verifyPlugin(pkg);
    const local = await platformStorage.loadSnapshot<LocalPluginData>(deviceKey(id), {
        bucket: emptyPluginBucket(pkg.fingerprint, storageVersion), settings: {},
    });
    const migrated = await migrateValues(pkg, local.bucket, 'device', AbortSignal.timeout(vmLimits.migrationWall), local.settings);
    // Validate every older format we can currently open before activating the
    // package. Keep immutable history readable for peers on the previous version.
    if (storageVersion > 1) {
        const checked = new Set<string>();
        for await (const { scope, bucket } of storyBucketsForPlugin(id)) {
            if (bucket.owner !== pkg.fingerprint || bucket.schemaVersion >= storageVersion) continue;
            const key = `${scope}:${bucket.schemaVersion}:${JSON.stringify(bucket.values)}`;
            if (checked.has(key)) continue;
            await migrateValues(pkg, bucket, scope, AbortSignal.timeout(vmLimits.migrationWall));
            checked.add(key);
        }
    }
    return { bucket: { ...local.bucket, schemaVersion: storageVersion, values: migrated.values },
        settings: normalizePluginSettings(pkg.manifest, migrated.settings ?? local.settings) };
}
function updatedCatalog(plugin: InstalledPlugin): Catalog {
    const { catalog } = nativePluginStore.getState();
    const id = plugin.manifest.id;
    return { publishers: { ...catalog.publishers, [id]: plugin.fingerprint }, plugins: [...catalog.plugins.filter(item => item.manifest.id !== id), plugin]
        .sort((a, b) => a.manifest.id < b.manifest.id ? -1 : 1) };
}
function maintenance(id: string, on: boolean) {
    nativePluginStore.setState(draft => { draft.maintenance = on ? [...draft.maintenance, id] : draft.maintenance.filter(key => key !== id); });
    if (on) {
        stopTasks(id);
        const plugin = pluginById(id);
        if (plugin) void import('./tasks').then(tasks => tasks.cancelPluginTasks(`${id}:${plugin.fingerprint}`));
    }
}
let adminQueue: Promise<unknown> = Promise.resolve();
function administer<T>(fn: () => Promise<T>): Promise<T> {
    const operation = adminQueue.then(fn); adminQueue = operation.catch(() => {}); return operation;
}
export function installPlugin(approved: InstallReview, enable: boolean): Promise<void> {
    return administer(async () => {
        await initializeNativePlugins();
        const { pkg, current } = reviewPlugin(approved.pkg);
        if (current !== approved.current) throw new Error('插件状态已变化，请重新检查安装内容');
        if (current && !enable) throw new Error('更新需要确认授权，才会检查和迁移原有数据');
        const id = pkg.manifest.id, start = performance.now();
        maintenance(id, true);
        try {
            const data = enable ? await preparePluginData(pkg) : undefined;
            const next: InstalledPlugin = { manifest: pkg.manifest, fingerprint: pkg.fingerprint, digest: pkg.digest, enabled: enable,
                prepared: enable, grants: enable ? [...pkg.manifest.permissions] : [], settings: data?.settings ?? normalizePluginSettings(pkg.manifest, {}),
                access: current?.access && { ...current.access, origins: current.access.origins.filter(origin => pkg.manifest.origins?.includes(origin)) } };
            await enqueuePersistentOperation(async () => {
                const catalog = updatedCatalog(next);
                await platformStorage.saveSnapshots({ [catalogKey]: catalog, [packageKey(id)]: pkg, ...(data && { [deviceKey(id)]: data }) }, false);
                pkgCache.set(id, Promise.resolve(pkg));
                if (data) rememberPluginDevice(id, data);
                nativePluginStore.setState({ catalog });
            });
            reportPlugin(id, current ? '更新' : '安装', 'ok', performance.now() - start);
        } catch (error) {
            reportPlugin(id, current ? '更新' : '安装', 'error', performance.now() - start, errorMessage(error)); throw error;
        } finally { maintenance(id, false); }
    });
}
export function setNativePluginEnabled(id: string, enabled: boolean): Promise<void> {
    if (!enabled) maintenance(id, true);
    return administer(async () => {
        const current = pluginById(id), start = performance.now();
        try {
            if (!current || current.enabled === enabled) return;
            let data: LocalPluginData | undefined;
            if (enabled) {
                if (!supportedHostApi(current.manifest)) throw new Error('此插件版本不支持当前宿主');
                const pkg = await loadPluginPackage(current);
                if (current.prepared === false) data = await preparePluginData(pkg);
                else await verifyPlugin(pkg);
            }
            await enqueuePersistentOperation(async () => {
                const catalog = updatedCatalog({ ...current, enabled, prepared: enabled || current.prepared,
                    settings: data?.settings ?? current.settings, grants: enabled ? [...current.manifest.permissions] : [] });
                await platformStorage.saveSnapshots({ [catalogKey]: catalog, ...(data && { [deviceKey(id)]: data }) }, false);
                if (data) rememberPluginDevice(id, data);
                nativePluginStore.setState({ catalog });
            });
            reportPlugin(id, enabled ? '启用' : '停用', 'ok', performance.now() - start);
        } catch (error) { reportPlugin(id, enabled ? '启用' : '停用', 'error', performance.now() - start, errorMessage(error)); throw error; }
        finally { if (!enabled) maintenance(id, false); }
    });
}
export function uninstallNativePlugin(id: string): Promise<void> {
    maintenance(id, true);
    return administer(async () => {
        try {
            const { catalog } = nativePluginStore.getState();
            const next = { ...catalog, plugins: catalog.plugins.filter(plugin => plugin.manifest.id !== id) };
            await platformStorage.saveSnapshots({ [catalogKey]: next, [packageKey(id)]: null }, false);
            pkgCache.delete(id); deviceCache.delete(id);
            nativePluginStore.setState(draft => { draft.catalog = next; delete draft.diagnostics[id]; });
        } finally { maintenance(id, false); }
    });
}
export function changeNativePluginSettings(id: string, values: Settings) {
    return administer(() => enqueuePersistentOperation(async () => {
        const plugin = pluginById(id);
        if (!plugin || plugin.prepared === false) throw new Error('请先启用插件，再保存设置');
        const settings = normalizePluginSettings(plugin.manifest, values, true);
        const data = { ...await loadPluginDevice(plugin), settings };
        const catalog = updatedCatalog({ ...plugin, settings });
        await platformStorage.saveSnapshots({ [catalogKey]: catalog, [deviceKey(id)]: data }, false);
        rememberPluginDevice(id, data); nativePluginStore.setState({ catalog });
    }));
}

export function changeNativePluginAccess(id: string, access: PluginAccess) {
    return administer(async () => {
        const plugin = pluginById(id);
        if (!plugin) throw new Error('插件已卸载');
        maintenance(id, true);
        try {
            await enqueuePersistentOperation(async () => {
                const catalog = updatedCatalog({ ...plugin, access: { ...access, origins: access.origins.filter(origin => plugin.manifest.origins?.includes(origin)) } });
                await platformStorage.saveSnapshots({ [catalogKey]: catalog }, false);
                nativePluginStore.setState({ catalog });
            });
        } finally { maintenance(id, false); }
    });
}

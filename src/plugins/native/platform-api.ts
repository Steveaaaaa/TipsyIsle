import { z } from 'zod';
import type { AssetRef, HostCapabilities, Json, Permission, ServiceInfo, ServiceInput, ServiceOutput } from '../../../packages/plugin-sdk/index.js';
import { hostApi } from '../../../packages/plugin-sdk/package-format.mjs';
import { detectRuntimeFlavor } from '../../core/platform-bridge';
import { satisfies } from 'semver';
import { activePlugins, assertPluginActive, type InstalledPlugin } from './catalog';
import { assetGrant } from './asset-data';
import { idSchema, localId, missing, routeSchema } from './edits';
import { PluginApiError } from './errors';
import type { PluginPackage } from './package';
import { validateJson } from './storage';
import type { VmMode } from './vm-protocol';

interface CallAccess {
    plugin: InstalledPlugin; pkg: PluginPackage; mode: VmMode; signal: AbortSignal;
    permit(permission: Permission): void; check(): void;
    callService(provider: InstalledPlugin, input: ServiceInput): Promise<unknown>;
}
const capabilities = async (plugin: InstalledPlugin): Promise<HostCapabilities> => {
    const runtime = await detectRuntimeFlavor();
    const hasIndex = typeof Worker !== 'undefined' && typeof indexedDB !== 'undefined';
    return { api: hostApi, platform: runtime === 'tauri-native' ? /Android/i.test(navigator.userAgent) ? 'android' : 'desktop' : 'web',
        transport: runtime === 'local-gateway' ? 'gateway' : runtime === 'tauri-native' ? 'native' : 'browser', permissions: [...plugin.grants],
        features: ['story.routes', 'story.journal', 'story.transactions', 'assets.transactions', 'generation.stages', 'generation.tools.openai',
            'models.chat.openai', 'models.embedding.openai', 'services.v1', 'ui.isolatedLayout', ...(hasIndex ? ['index.text', 'index.vector', 'media.blobs', 'models.image.openai', 'models.speech.openai'] : []),
            ...(runtime === 'local-gateway' ? ['models.chat.providerAdapter'] : []), runtime === 'tauri-native' ? 'network.native' : 'network.cors'],
    };
};
const serviceResult = z.strictObject({ value: z.unknown().refine(value => value !== undefined), tasks: z.array(idSchema).max(12).optional(), media: z.array(idSchema).max(12).optional() });
const availableServices = () => activePlugins().flatMap(plugin => plugin.grants.includes('services.provide')
    ? (plugin.manifest.provides ?? []).map(info => ({ info: { ...info, plugin: plugin.manifest.id } satisfies ServiceInfo, plugin })) : []);
const ownerOf = (plugin: InstalledPlugin) => `${plugin.manifest.id}:${plugin.fingerprint}`;
const storyReads = new Set(['listChats', 'listRoutes', 'tree', 'version', 'readPage', 'readText', 'search', 'state']);
const editActions = new Set(['preview', 'commit', 'undo']);

export async function callPlatform(method: string, args: unknown, access: CallAccess): Promise<unknown> {
    const { plugin, pkg, mode, signal, permit, check } = access;
    const allowed = plugin.access ?? { assets: [], connections: [], origins: [] };
    const owner = ownerOf(plugin);
    const writes = mode === 'command' || mode === 'replySaved' || mode === 'storyChanged' || mode === 'service';
    const requireWrites = () => { if (!writes) throw new PluginApiError('PERMISSION_DENIED', '当前阶段只允许读取数据'); };
    if (method === 'host.capabilities') return capabilities(plugin);
    if (method === 'story.changes') {
        permit('story.events');
        const { readStoryChanges } = await import('./events');
        return readStoryChanges(args);
    }
    const [group, action] = method.split('.');
    if (group === 'story' && storyReads.has(action)) {
        permit('story.history');
        if (['readPage', 'readText', 'search'].includes(action)) permit('story.read');
        if (action === 'state') permit('story.variables');
        return (await import('./story-data')).storyRead(action, args);
    }
    if (method === 'story.open') {
        permit('story.navigate');
        if (mode !== 'command') throw new PluginApiError('PERMISSION_DENIED', '只有用户打开的插件面板可以切换当前剧情');
        return (await import('./story-data')).openPluginRoute(routeSchema.parse(args), check);
    }
    if (method === 'storage.readAt' || method === 'storage.patchAt') {
        if (method.endsWith('patchAt')) requireWrites();
        const { addressedStorage } = await import('./addressed-storage');
        return addressedStorage(pkg, method === 'storage.readAt' ? 'readAt' : 'patchAt', args, permit, check, signal);
    }
    if ((group === 'story' || group === 'assets') && editActions.has(action)) {
        requireWrites(); permit(group === 'story' ? 'story.edit' : 'assets.write');
        const permitAsset = (ref: AssetRef) => {
            if (!allowed.assets.includes(assetGrant(ref))) throw new PluginApiError('PERMISSION_DENIED', '请在插件权限中授权要修改的资源');
        };
        const editAccess = { owner, check, permit: permitAsset, allowVariables: () => permit('story.variables') };
        const { previewEdit, commitEdit, undoEdit } = await import('./transactions');
        if (action === 'preview') return previewEdit(group, args, editAccess);
        return (action === 'commit' ? commitEdit : undoEdit)(group, args, editAccess);
    }
    if (group === 'assets') {
        permit('assets.read');
        const { workspaceStore } = await import('../../store/workspace-store');
        const { assetRead } = await import('./asset-data');
        return assetRead(workspaceStore.getState(), action, args);
    }
    if (group === 'index') {
        permit('index.manage'); if (action !== 'search') requireWrites();
        const { indexRpc } = await import('./index-client');
        return indexRpc(owner, action, args, signal);
    }
    if (group === 'models') {
        requireWrites(); permit('models.use');
        if (action === 'connections') return (await (await import('./connections')).connectionChoices()).filter(item => allowed.connections.includes(item.id));
        if (action === 'start') return (await import('./tasks')).startModel(owner, args, allowed.connections, signal);
    }
    if (group === 'tasks') {
        requireWrites();
        if (!['models.use', 'network.request', 'services.call'].some(p => plugin.grants.includes(p as Permission))) permit('models.use');
        const { readTask, cancelTask, taskEmbeddings } = await import('./tasks');
        if (action === 'read') return readTask(owner, args, signal);
        if (action === 'embeddings') return taskEmbeddings(owner, args);
        if (action === 'cancel') return cancelTask(owner, idSchema.parse(args));
    }
    if (group === 'network') {
        requireWrites(); permit('network.request');
        const { pluginNetwork } = await import('./tasks');
        return pluginNetwork(owner, action, args, allowed.origins, signal);
    }
    if (group === 'media') {
        requireWrites(); permit('media.manage');
        return (await import('./media')).mediaRpc(owner, action, args, signal);
    }
    if (group === 'services') {
        requireWrites(); permit('services.call');
        if (mode === 'service') throw new PluginApiError('PERMISSION_DENIED', '服务处理器不嵌套调用其他服务');
        const services = availableServices(), requested = plugin.manifest.consumes ?? [];
        if (action === 'list') return services.filter(({ info }) => requested.some(req => req.id === info.id && satisfies(info.version, req.range))).map(({ info }) => info);
        const input = z.strictObject({ id: idSchema, method: localId, args: z.unknown() }).parse(args);
        const req = requested.find(item => item.id === input.id);
        if (!req) throw new PluginApiError('PERMISSION_DENIED', '请在清单里声明此服务依赖');
        const provider = services.find(item => item.info.id === req.id);
        if (!provider) throw missing('已启用的插件服务');
        if (!satisfies(provider.info.version, req.range)) throw new PluginApiError('SERVICE_VERSION', `服务版本为 ${provider.info.version}，需要 ${req.range}`);
        if (!provider.info.methods.includes(input.method)) throw missing('服务方法');
        check();
        const output = serviceResult.parse(await access.callService(provider.plugin, { id: req.id, method: input.method, args: validateJson(input.args as Json, 240_000), caller: plugin.manifest.id })) as ServiceOutput;
        const value = validateJson(output.value, 240_000);
        check(); assertPluginActive(provider.plugin);
        if (output.tasks?.length) (await import('./tasks')).shareTasks(ownerOf(provider.plugin), owner, output.tasks);
        if (output.media?.length) {
            const { shareMedia } = await import('./media');
            await shareMedia(ownerOf(provider.plugin), owner, output.media);
        }
        return value;
    }
    throw new PluginApiError('INVALID_ARGUMENT', '插件接口不存在');
}

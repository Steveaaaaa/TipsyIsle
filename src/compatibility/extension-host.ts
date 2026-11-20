import { detectRuntimeFlavor } from '../core/platform-bridge';
import { createReactiveStore } from '../store/reactive-store';
import { integratedExtensions, type ExtensionCatalog } from './extensions';
import { readExtensionVariables } from './extension-variables';
import { scopedVariableStore, replaceExtensionVariables } from '../store/scoped-variable-store';
import { persistWorkspaceNow } from '../store/workspace-store';

export const extensionCatalogStore = createReactiveStore<ExtensionCatalog>(() => ({ extensions: integratedExtensions, canManage: false }));
let refreshTask: Promise<void> | undefined;
export function refreshExtensionCatalog(): Promise<void> {
    return refreshTask ??= (async () => {
        try {
            const flavor = await detectRuntimeFlavor();
            if (flavor === 'tauri-native') {
                const { listNativeExtensions } = await import('./native-extension-files');
                const extensions = await listNativeExtensions();
                extensionCatalogStore.setState({ extensions: [...integratedExtensions, ...extensions.sort((a, b) => a.loadingOrder - b.loadingOrder || a.id.localeCompare(b.id))], canManage: true, error: undefined });
                return;
            }
            if (flavor !== 'local-gateway') {
                extensionCatalogStore.setState({ extensions: integratedExtensions, canManage: false, error: '请使用本地网页服务或安装版管理扩展。' }); return;
            }
            const response = await fetch('/api/tipsy-isle/extensions/list');
            if (!response.ok) throw new Error('读取扩展目录失败，请重启已更新的本地网关');
            const data = await response.json();
            extensionCatalogStore.setState({ extensions: [...integratedExtensions, ...data.extensions], canManage: data.canManage === true, error: undefined });
        } catch (error) { extensionCatalogStore.setState({ canManage: false, error: error instanceof Error ? error.message : String(error) }); }
    })().finally(() => { refreshTask = undefined; });
}
const emptySettings = {};
let catalogSources: unknown[] = [];
let cachedCatalog: ExtensionCatalog | undefined;
export function extensionCatalog(): ExtensionCatalog {
    const catalog = extensionCatalogStore.getState(), settings = (scopedVariableStore.getState().extension.tipsy_extensions ?? emptySettings) as Record<string, any>;
    if (!cachedCatalog || catalogSources[0] !== catalog || catalogSources[1] !== settings) {
        const disabled: string[] = Array.isArray(settings.disabled) ? settings.disabled : [];
        cachedCatalog = { ...catalog, extensions: catalog.extensions.map(entry => ({ ...entry, enabled: entry.integrated || !disabled.includes(entry.id) })) };
        catalogSources = [catalog, settings];
    }
    return cachedCatalog;
}
export async function setExtensionEnabled(id: string, enabled: boolean) {
    const settings = structuredClone(readExtensionVariables(scopedVariableStore.getState().extension, 'tipsy_extensions'));
    const disabled = new Set<string>(Array.isArray(settings.disabled) ? settings.disabled : []);
    if (enabled) disabled.delete(id); else disabled.add(id);
    replaceExtensionVariables('tipsy_extensions', { ...settings, disabled: [...disabled] });
    await persistWorkspaceNow();
}
export async function requestExtension(params: Record<string, any>): Promise<{ status: number; body: any }> {
    if (!['version', 'install', 'delete', 'update', 'reinstall'].includes(params.action)) throw new Error('未知扩展操作');
    const flavor = await detectRuntimeFlavor();
    if (flavor === 'tauri-native') {
        try {
            const { manageNativeExtension } = await import('./native-extension-files');
            const body = await manageNativeExtension(params);
            if (params.action !== 'version') await refreshExtensionCatalog();
            return { status: 200, body };
        } catch (error) { return { status: 400, body: { message: error instanceof Error ? error.message : String(error) } }; }
    }
    if (flavor !== 'local-gateway') return { status: 501, body: { message: '当前运行方式尚未接入 Git 扩展管理' } };
    const response = await fetch(`/api/tipsy-isle/extensions/${params.action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params) });
    const body = await response.json();
    if (params.action !== 'version') await refreshExtensionCatalog();
    return { status: response.status, body };
}

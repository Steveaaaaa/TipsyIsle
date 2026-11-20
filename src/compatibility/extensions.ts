import app from '../../package.json';

export interface CompatibilityExtension {
    id: string; name: string; type: 'local' | 'global' | 'system'; version: string; loadingOrder: number;
    js?: string; css?: string; requires?: string[]; dependencies?: string[]; error?: string;
    generateInterceptor?: string;
    integrated?: boolean; enabled?: boolean;
}
export interface ExtensionCatalog { extensions: CompatibilityExtension[]; canManage: boolean; error?: string }
export const helperCompatibilityVersion = '4.12.1-tipsy.1';
export const hostVersion = app.version;
/** Versions identify adapters; they do not claim an upstream checkout or complete equivalence. */
export const integratedExtensions: CompatibilityExtension[] = [
    { id: 'JS-Slash-Runner', name: '酒馆助手兼容模块', type: 'system', version: helperCompatibilityVersion, loadingOrder: 0, integrated: true },
    { id: 'ST-Prompt-Template', name: '提示词模板兼容模块', type: 'system', version: '1.17-tipsy.1', loadingOrder: 1, integrated: true },
    { id: 'regex', name: '正则', type: 'system', version: app.version, loadingOrder: 2, integrated: true },
    { id: 'quick-reply', name: '快捷回复', type: 'system', version: app.version, loadingOrder: 3, integrated: true },
];
export function findCompatibilityExtension(catalog: ExtensionCatalog, id: string) {
    const key = String(id).replace(/^third-party\//, '');
    return catalog.extensions.find(entry => entry.id === key);
}
export function createExtensionApi(read: () => ExtensionCatalog, request: (method: string, params?: Record<string, any>) => Promise<any>) {
    const mutation = async (action: string, params: Record<string, unknown>) => {
        const result = await request('extensions.manage', { action, ...params });
        return new Response(JSON.stringify(result.body), { status: result.status, headers: { 'Content-Type': 'application/json' } });
    };
    return {
        isAdmin: () => read().canManage,
        getTavernHelperExtensionId: () => 'JS-Slash-Runner',
        getTavernHelperVersion: () => helperCompatibilityVersion,
        getTavernVersion: () => hostVersion,
        getExtensionType: (id: string) => findCompatibilityExtension(read(), id)?.type ?? null,
        isInstalledExtension: (id: string) => !!findCompatibilityExtension(read(), id),
        getExtensionInstallationInfo: async (id: string) => {
            const extension = findCompatibilityExtension(read(), id);
            if (!extension || extension.integrated) return null;
            const result = await request('extensions.manage', { action: 'version', id });
            if (result.status >= 400) throw new Error(result.body?.message ?? '读取扩展版本失败');
            return result.body;
        },
        installExtension: (url: string, type: 'local' | 'global') => mutation('install', { url, type }),
        uninstallExtension: (id: string) => mutation('delete', { id }),
        reinstallExtension: (id: string) => mutation('reinstall', { id }),
        updateExtension: (id: string) => mutation('update', { id }),
        updateTavernHelper: async () => (await mutation('update', { id: 'JS-Slash-Runner' })).ok,
    };
}

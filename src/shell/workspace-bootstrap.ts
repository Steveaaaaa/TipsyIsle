import { initializeLanSync } from '../core/sync/engine';
import { hydrateStorySettings } from '../registry/schema-registry';
import { initializeNativeRuntime } from '../core/native-runtime';
import { refreshExtensionCatalog } from '../compatibility/extension-host';
import { hydrateWorkspaceFromPlatform, authorMessageRevision, setStatusBanner } from '../store/workspace-store';
import { hydrateVariablesFromPlatform } from '../store/scoped-variable-store';
import { hydrateThemeFromPlatform } from '../theme/theme-engine';
import { hydrateAppearance } from '../theme/appearance-store';
import { initializeNativePlugins } from '../plugins/native/catalog';
import { observeNativeRoutes } from '../plugins/native/host';
import { initializeStoryChanges } from '../plugins/native/events';
import { registeredSnapshots, suspendRegisteredPersistence } from '../store/persistence';
import { installWorkspaceCompatibility } from '../compatibility/workspace-host';
import { diagnosticErrorKind, diagnosticOperation } from '../core/diagnostics';

installWorkspaceCompatibility();
let bootstrap: Promise<void> | undefined;
export function initializeWorkspace(): Promise<void> {
    if (bootstrap) return bootstrap;
    const report = diagnosticOperation('启动', '载入应用');
    let stage = '连接原生运行环境';
    return bootstrap = (async () => {
        await initializeNativeRuntime();
        stage = '读取主题和设置';
        await hydrateThemeFromPlatform();
        await hydrateAppearance();
        await hydrateStorySettings();
        const finish = suspendRegisteredPersistence();
        try {
            stage = '恢复会话与变量';
            await hydrateVariablesFromPlatform();
            await hydrateWorkspaceFromPlatform(false);
            stage = '载入扩展目录';
            await refreshExtensionCatalog();
            await initializeStoryChanges(authorMessageRevision, registeredSnapshots()).catch(error => console.warn('无法载入插件存档日志', error));
            await finish(true);
            report('成功', { stage: '工作区就绪' });
            observeNativeRoutes();
            void initializeNativePlugins().catch(() => {});
            // Sync initialization itself waits for the author runtime and a quiet moment.
            setTimeout(() => {
                void initializeLanSync().catch(error => setStatusBanner(`互通初始化失败：${String(error)}`));
            }, 0);
        } catch (error) { await finish(false); throw error; }
    })().catch(error => { report('失败', { stage, code: diagnosticErrorKind(error) }); bootstrap = undefined; throw error; });
}

import app from '../../package.json';
import { extensionCatalog } from '../compatibility/extension-host';
import { scriptsFromTrees, type ScriptScope } from '../compatibility/script-trees';
import { canRun, nativePluginStore } from '../plugins/native/catalog';
import { getWorkspaceScriptTrees } from '../store/workspace/scripts';
import { compatibilityDiagnosticStates, diagnosticLabel, diagnosticsStore, formatDiagnostic } from './diagnostics';
import { detectRuntimeFlavor } from './platform-bridge';
import { saveExport } from './platform-files';

function environment(flavor: Awaited<ReturnType<typeof detectRuntimeFlavor>>) {
    const ua = navigator.userAgent;
    const android = /Android(?: ([\d.]+))?/i.exec(ua);
    const windows = /Windows NT ([\d.]+)/i.exec(ua);
    const system = android ? `Android ${android[1] ?? ''}`.trim() : windows ? `Windows NT ${windows[1]}` : navigator.platform || '未知';
    const engine = /(?:EdgA?|Firefox|Chrome|Version)\/[\d.]+/i.exec(ua)?.[0];
    const appPlatform = flavor !== 'tauri-native' ? '网页' : android ? 'Android' : 'Windows';
    const runtime = { 'tauri-native': '原生客户端', 'local-gateway': '本地网页网关', 'browser-offline': '纯浏览器' }[flavor];
    return [`TipsyIsle 版本：${app.version}`, `平台：${appPlatform}`, `运行方式：${runtime}`, `系统：${system}`,
        `${flavor === 'tauri-native' ? 'WebView' : '浏览器'}：${engine ?? '未知'}`];
}

function componentLine(name: string, version: string | undefined, enabled: boolean, state: string) {
    return `- ${diagnosticLabel(name || '未命名')}${version ? ` · v${diagnosticLabel(version)}` : ''} · ${enabled ? '已启用' : '已停用'}${enabled ? ` · ${state}` : ''}`;
}

function inventory() {
    const { catalog, diagnostics, ready } = nativePluginStore.getState();
    const native = catalog.plugins.map(plugin => {
        const { id, name, version } = plugin.manifest;
        const last = diagnostics[id]?.find(row => ['ok', 'error'].includes(row.status) && !['安装', '更新', '启用', '停用'].includes(row.task));
        return componentLine(name || id, version, plugin.enabled, !canRun(plugin) ? '当前不可运行' : !last ? '运行状态未知' : last.status === 'error' ? '最近一次操作失败' : '最近一次操作成功');
    });
    const extensions = extensionCatalog();
    const compat = extensions.extensions.map(entry => componentLine(entry.name || entry.id, entry.version, entry.enabled === true,
        entry.integrated ? '内置兼容模块' : observedLabel(compatibilityDiagnosticStates.extension.get(entry.id))));
    if (extensions.error && extensions.canManage === false) compat.push('- 外部扩展目录当前不可用');
    const trees = getWorkspaceScriptTrees();
    const scopes: Array<[ScriptScope, string]> = [['global', '全局脚本'], ['preset', '当前预设脚本'], ['character', '当前角色卡脚本']];
    const scripts = scopes.flatMap(([scope, title]) => group(title, scriptsFromTrees(trees[scope]).map(script => componentLine(script.name || script.id,
        script.version, script.enabled, observedLabel(compatibilityDiagnosticStates.script.get(script.id))))));
    return [...group('原生插件', native, ready ? '无' : '目录尚未载入'), ...group('酒馆扩展', compat), ...scripts];
}

function group(title: string, lines: string[], empty = '无') {
    return ['', title, ...(lines.length ? lines : [`- ${empty}`])];
}
function observedLabel(state: 'ready' | 'failed' | undefined) {
    return state === 'ready' ? '已加载' : state === 'failed' ? '加载或运行失败' : '运行状态未知';
}

export async function exportDiagnosticReport(): Promise<boolean> {
    const now = new Date();
    const flavor = await detectRuntimeFlavor();
    const { entries, storageFailed } = diagnosticsStore.getState();
    const lines = ['TipsyIsle 诊断日志', `导出时间：${now.toISOString()}`, '', '== 运行环境 ==', ...environment(flavor),
        '', '== 当前插件和脚本 ==', ...inventory(), '', `== 最近记录（${entries.length} 条，由早到晚） ==`,
        ...(storageFailed ? ['本机日志存储不可用，报告包含当前仍可读取的记录。'] : []),
        ...(entries.length ? entries.map(formatDiagnostic) : ['暂无记录'])];
    const date = now.toISOString().slice(0, 19).replace(/:/g, '-');
    return saveExport(new Blob(['\uFEFF', lines.join('\r\n'), '\r\n'], { type: 'text/plain;charset=utf-8' }), `TipsyIsle-diagnostics-${date}.txt`);
}

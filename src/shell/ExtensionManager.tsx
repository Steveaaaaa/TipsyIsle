import { useState } from 'react';
import { extensionCatalogStore, refreshExtensionCatalog, requestExtension, setExtensionEnabled } from '../compatibility/extension-host';
import { scopedVariableStore } from '../store/scoped-variable-store';
import { workspaceStore } from '../store/workspace-store';
import { settingsDraftStore, useSettingsEditor } from '../registry/settings-draft';

export function ExtensionManager() {
    const { editing } = useSettingsEditor();
    const draft = settingsDraftStore.useStore();
    const catalog = extensionCatalogStore.useStore();
    const generating = workspaceStore.useStore(state => state.isGenerating || state.helperGenerationCount > 0);
    const settings = scopedVariableStore.useStore(state => state.extension.tipsy_extensions);
    const disabled = (settings as { disabled?: string[] } | undefined)?.disabled ?? [];
    const [url, setUrl] = useState('');
    const [type, setType] = useState<'local' | 'global'>('local');
    const [busy, setBusy] = useState(false);
    const [feedback, setFeedback] = useState('');
    const run = async (action: string, id?: string) => {
        setBusy(true); setFeedback('');
        try {
            const result = await requestExtension({ action, id, url, type });
            if (result.status >= 400) throw new Error(result.body?.message ?? '扩展操作失败');
            setFeedback(action === 'version' ? `${result.body.current_branch_name} · ${result.body.current_commit_hash} · ${result.body.is_up_to_date ? '已是最新' : '可更新'}` : result.body.message);
            if (action === 'install') setUrl('');
        } catch (error) { setFeedback(error instanceof Error ? error.message : String(error)); }
        finally { setBusy(false); }
    };
    return <section className="ttm-panel-block">
        <h2 className="ttm-section-heading">扩展管理</h2>
        <p className="ttm-asset-help">第三方扩展在独立兼容来源运行。安装、更新、移除或启停后，重新载入运行环境生效；依赖未接入宿主接口的扩展会报告具体错误。</p>
        {catalog.error && <p role="alert">{catalog.error}</p>}
        <input className="ttm-select-input" aria-label="扩展 Git 仓库地址" placeholder="HTTPS Git 仓库地址" value={url} onChange={event => setUrl(event.target.value)} disabled={busy || !catalog.canManage} />
        <select className="ttm-select-input" aria-label="扩展安装范围" value={type} onChange={event => setType(event.target.value as 'local' | 'global')} disabled={busy}>
            <option value="local">本地扩展</option><option value="global">全局扩展</option>
        </select>
        <button className="ttm-mini-btn" type="button" disabled={busy || !catalog.canManage || !url.trim()} onClick={() => void run('install')}>安装扩展</button>
        <button className="ttm-mini-btn" type="button" disabled={busy} onClick={() => void refreshExtensionCatalog()}>刷新目录</button>
        <button className="ttm-mini-btn" type="button" disabled={busy || generating} onClick={() => window.dispatchEvent(new Event('tipsy-compatibility-reload'))}>重新载入运行环境</button>
        {feedback && <p role="status">{feedback}</p>}
        {catalog.extensions.map(extension => <details className="ttm-asset-text-section" key={extension.id}>
            <summary>{extension.name} · {extension.version || '未标版本'} · {extension.integrated ? '内置兼容模块' : extension.type}</summary>
            {extension.integrated ? <p className="ttm-asset-help">随 TipsyIsle 更新；兼容版本号不代表上游插件全部行为已实现。</p> : <>
                <label><input type="checkbox" checked={(editing ? draft.extensions[extension.id] : undefined) ?? !disabled.includes(extension.id)} disabled={busy} onChange={async event => {
                    if (editing) {
                        const enabled = event.target.checked;
                        settingsDraftStore.setState(next => { if (enabled === !disabled.includes(extension.id)) delete next.extensions[extension.id]; else next.extensions[extension.id] = enabled; });
                        setFeedback('启停设置已加入草稿，保存后重新载入运行环境生效。'); return;
                    }
                    setBusy(true);
                    try { await setExtensionEnabled(extension.id, event.target.checked); setFeedback('已保存启停设置，重新载入运行环境后生效。'); }
                    catch (error) { setFeedback(error instanceof Error ? error.message : String(error)); }
                    finally { setBusy(false); }
                }} />启用</label>
                {extension.error && <p role="alert">{extension.error}</p>}
                {([['version', '检查版本'], ['update', '更新'], ['reinstall', '重新安装'], ['delete', '卸载']] as const).map(([action, label]) =>
                    <button type="button" className="ttm-mini-btn" key={action} disabled={busy || !catalog.canManage} onClick={() => void run(action, extension.id)}>{label}</button>)}
            </>}
        </details>)}
    </section>;
}

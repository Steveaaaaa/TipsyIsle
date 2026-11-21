import { getAvailableWorldbooks, selectPreset, setGlobalWorldbookEnabled, setStatusBanner, updateLorebookEntry, updatePresetPrompt, type WorkspaceState } from '../store/workspace-store';
import type { NormalizedLorebook, NormalizedPreset } from '../types';
import { AssetMoreButton } from './AssetActionMenu';
import { PresetEntriesPanel } from './AssetInspectorPanel';
import type { DeleteAssetTarget } from './DeleteAssetDialog';
import { WorldbookEntriesPanel, worldbookPositions } from './WorldbookEntriesPanel';
import { runStoreAction } from './workspace-ui-actions';

interface AssetPanelProps {
    state: WorkspaceState;
    assetMenu: DeleteAssetTarget | null;
    openAssetMenu: (target: DeleteAssetTarget) => void;
}

export function WorkspacePresetPanel({ state, assetMenu, openAssetMenu, activePreset, importing, onImport }: AssetPanelProps & {
    activePreset: NormalizedPreset;
    importing: boolean;
    onImport: () => Promise<void>;
}) {
    return (
        <section className="ttm-asset-workspace">
            <div className="ttm-asset-workspace-header">
            <label className="ttm-section-heading" htmlFor="narrative-preset-select">叙事预设</label>
            <select
                id="narrative-preset-select"
                className="ttm-select-input"
                aria-label="当前叙事预设"
                value={activePreset.id}
                onChange={(event) => runStoreAction('切换预设', () => selectPreset(event.target.value))}
            >
                <option value="">不使用预设</option>
                {state.presets.map((p) => (
                    <option key={p.id} value={p.id}>
                        {p.name}
                    </option>
                ))}
            </select>
            {activePreset.id && <AssetMoreButton label="预设更多操作" expanded={assetMenu?.kind === 'preset'} onOpen={anchor => openAssetMenu({ kind: 'preset', id: activePreset.id, name: activePreset.name, anchor })} />}
            </div>
            {!activePreset.id && <div className="ttm-empty-search"><p>当前未使用预设。角色卡、世界书与聊天历史仍会正常组装，不额外添加平台叙事指令。可导入作者推荐的预设，再在上方选用。</p><button type="button" className="ttm-btn-secondary" disabled={importing} onClick={() => void onImport()}>导入预设 JSON</button></div>}
            {activePreset.id && <PresetEntriesPanel
                key={activePreset.id}
                preset={activePreset}
                disabled={state.isGenerating || state.helperGenerationCount > 0}
                onUpdatePrompt={(identifier, patch) => {
                    const updated = runStoreAction('更新预设词条', () => updatePresetPrompt(activePreset.id, identifier, patch));
                    if (updated && patch.content !== undefined) setStatusBanner('预设词条内容已保存。');
                    return updated;
                }}
            />}
        </section>
    );
}

export function WorkspaceWorldbookPanel({ state, assetMenu, openAssetMenu, activeLorebooks, lorebookHitsOpen, setLorebookHitsOpen }: AssetPanelProps & {
    activeLorebooks: NormalizedLorebook[];
    lorebookHitsOpen: boolean;
    setLorebookHitsOpen: (open: boolean) => void;
}) {
    const promptInfo = state.lastAssembledPrompt;
    return <section className="ttm-asset-workspace">
        <WorldbookEntriesPanel books={getAvailableWorldbooks(state)}
            menuBookId={assetMenu?.kind === 'worldbook' ? assetMenu.id : undefined}
            onMoreBook={(book, anchor) => openAssetMenu({ kind: 'worldbook', id: book.id, name: book.name, anchor })}
            activeBookIds={activeLorebooks.map(book => book.id)} globalBookIds={state.activeLorebookIds}
            disabled={state.isGenerating || state.helperGenerationCount > 0}
            onToggleBook={(bookId, enabled) => { runStoreAction('更新世界书', () => setGlobalWorldbookEnabled(bookId, enabled)); }}
            onToggle={(bookId, uid, enabled) => { runStoreAction('更新世界书', () => updateLorebookEntry(bookId, uid, { disabled: !enabled })); }} />
        <details className="ttm-worldbook-activation" onToggle={event => setLorebookHitsOpen(event.currentTarget.open)}><summary>本轮激活情况</summary>
            {lorebookHitsOpen && <div className="ttm-worldbook-activation-content">{promptInfo ? <>
                <h3 className="ttm-sub-heading">本轮激活词条（{promptInfo.activatedLorebookEntries.length}）</h3>
                {promptInfo.activatedLorebookEntries.map(hit => <div key={JSON.stringify([hit.world, (hit.entry || hit).uid])} className="ttm-hit-card">
                    <strong>{(hit.entry || hit).comment}</strong>
                    <p className="ttm-asset-help">插入位置：{worldbookPositions[(hit.entry || hit).position] ?? '其他位置'} · 匹配词：{(hit.matchedKeys || []).join('、') || '常驻或状态延续'}</p>
                    <pre className="ttm-entry-body">{(hit.entry || hit).content}</pre>
                </div>)}
            </> : <p role="status">正在计算激活情况…</p>}</div>}
        </details>
    </section>;
}

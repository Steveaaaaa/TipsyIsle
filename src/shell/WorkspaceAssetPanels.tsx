import {
    getActiveCharacter,
    getAvailableWorldbooks,
    getCharacterWorldbooks,
    selectPreset,
    setCharacterWorldbookBinding,
    setGlobalWorldbookEnabled,
    setStatusBanner,
    updateLorebookEntry,
    updatePresetPrompt,
    type WorkspaceState,
} from '../store/workspace-store';
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
    const activeCharacter = getActiveCharacter(state);
    const remembersCharacter = state.sessionKind === 'character' && Boolean(activeCharacter.id);
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
            {remembersCharacter && (
                <p className="ttm-asset-memory-note">
                    已按角色「{activeCharacter.name}」记住当前预设，切换角色后自动恢复。
                </p>
            )}
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
    const books = getAvailableWorldbooks(state);
    const disabled = state.isGenerating || state.helperGenerationCount > 0;
    const activeCharacter = getActiveCharacter(state);
    const hasCharacter = state.sessionKind === 'character' && Boolean(activeCharacter.id);
    const charBinding = hasCharacter ? getCharacterWorldbooks(activeCharacter, state) : null;
    const embeddedBookName = (activeCharacter.characterBook ?? activeCharacter.embeddedLorebook)?.name;
    const globalBookNames = new Set(books.filter(book => state.activeLorebookIds.includes(book.id)).map(book => book.name));
    const uniqueBookNames = [...new Set([
        ...books.map(book => book.name),
        ...(charBinding?.primary ? [charBinding.primary] : []),
        ...(charBinding?.additional ?? []),
    ])];
    const charBoundCount = charBinding ? (charBinding.primary ? 1 : 0) + charBinding.additional.length : 0;

    const toggleCharacterAdditional = (bookName: string, checked: boolean) => {
        if (!hasCharacter || !charBinding) return;
        const nextAdditional = checked
            ? [...charBinding.additional, bookName]
            : charBinding.additional.filter(name => name !== bookName);
        runStoreAction('更新角色世界书绑定', () => setCharacterWorldbookBinding(activeCharacter.id, charBinding.primary, nextAdditional));
    };

    return <section className="ttm-asset-workspace">
        <details className="ttm-worldbook-bindings" open>
            <summary>
                <span>世界书绑定管理</span>
                <small>
                    通用 {state.activeLorebookIds.length} 本{hasCharacter ? ` · 当前角色 ${charBoundCount} 本` : ''}
                </small>
            </summary>
            <div className="ttm-worldbook-bindings-body">
                <div className="ttm-binding-section">
                    <div className="ttm-binding-section-head">
                        <h4>通用世界书（全局生效 · 可多选）</h4>
                        <span className="ttm-binding-hint">对所有角色卡持续生效，可同时开启多本。</span>
                    </div>
                    {books.length ? (
                        <div className="ttm-binding-chips" role="group" aria-label="通用世界书多选">
                            {books.map(book => {
                                const checked = state.activeLorebookIds.includes(book.id);
                                return (
                                    <label key={book.id} className={`ttm-binding-chip${checked ? ' is-active' : ''}`}>
                                        <input
                                            type="checkbox"
                                            checked={checked}
                                            disabled={disabled}
                                            onChange={event => runStoreAction('更新通用世界书', () => setGlobalWorldbookEnabled(book.id, event.target.checked))}
                                        />
                                        <span>{book.name}</span>
                                        <small>{book.entries.length}</small>
                                    </label>
                                );
                            })}
                        </div>
                    ) : <p className="ttm-binding-empty">尚未导入任何世界书。</p>}
                </div>

                {hasCharacter && charBinding && (
                    <div className="ttm-binding-section">
                        <div className="ttm-binding-section-head">
                            <h4>角色「{activeCharacter.name}」专属世界书（一对多 · 自动记住）</h4>
                            <span className="ttm-binding-hint">支持 1 本主世界书 + 任意多本附加世界书，切换角色后自动恢复。</span>
                        </div>
                        <div className="ttm-binding-primary-row">
                            <label htmlFor="character-primary-worldbook">主世界书</label>
                            <select
                                id="character-primary-worldbook"
                                className="ttm-select-input"
                                value={charBinding.primary ?? ''}
                                disabled={disabled}
                                onChange={event => {
                                    const nextPrimary = event.target.value || null;
                                    runStoreAction('更新角色主世界书', () => setCharacterWorldbookBinding(activeCharacter.id, nextPrimary, charBinding.additional));
                                }}
                            >
                                <option value="">不设主世界书</option>
                                {uniqueBookNames.map(name => (
                                    <option key={name} value={name}>
                                        {name}{name === embeddedBookName ? '（角色内嵌）' : ''}
                                    </option>
                                ))}
                            </select>
                        </div>
                        <div className="ttm-binding-subhead">附加世界书（可多选）</div>
                        {uniqueBookNames.length ? (
                            <div className="ttm-binding-chips" role="group" aria-label="角色附加世界书多选">
                                {uniqueBookNames.map(name => {
                                    const isPrimary = charBinding.primary === name;
                                    const checked = charBinding.additional.includes(name);
                                    const isGlobal = globalBookNames.has(name);
                                    return (
                                        <label key={name} className={`ttm-binding-chip${checked || isPrimary ? ' is-active' : ''}${isPrimary ? ' is-primary' : ''}`}>
                                            <input
                                                type="checkbox"
                                                checked={isPrimary || checked}
                                                disabled={disabled || isPrimary}
                                                onChange={event => toggleCharacterAdditional(name, event.target.checked)}
                                            />
                                            <span>{name}</span>
                                            {isPrimary && <small>主书</small>}
                                            {!isPrimary && isGlobal && <small>通用</small>}
                                        </label>
                                    );
                                })}
                            </div>
                        ) : <p className="ttm-binding-empty">暂无可绑定的世界书。</p>}
                    </div>
                )}
            </div>
        </details>
        <WorldbookEntriesPanel books={books}
            menuBookId={assetMenu?.kind === 'worldbook' ? assetMenu.id : undefined}
            onMoreBook={(book, anchor) => openAssetMenu({ kind: 'worldbook', id: book.id, name: book.name, anchor })}
            activeBookIds={activeLorebooks.map(book => book.id)} globalBookIds={state.activeLorebookIds}
            disabled={disabled}
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

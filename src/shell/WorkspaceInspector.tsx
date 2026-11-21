import { useMemo, useState, type ReactNode } from 'react';
import { commandCompatibilityRuntime } from '../compatibility/runtime-client';
import { DEFAULT_CONTEXT_TOKENS } from '../core/generation-defaults';
import { getScopedVariables, replaceScopedVariables, resolveMergedVariables, scopedVariableStore } from '../store/scoped-variable-store';
import { refreshPromptInspectorPreview, workspaceStore, type WorkspaceState } from '../store/workspace-store';
import type { ChatMessageNode, NormalizedCharacterCard, NormalizedPreset, VariableScopeLevel } from '../types';
import { Icon } from './Icon';
import { SettingsPanel } from './SettingsPanel';
import type { SettingsCategory } from './settings-presentation';
import { runUiAction } from './workspace-ui-actions';

export type InspectorTab = 'prompt-tree' | 'variables' | 'schema-settings';

interface WorkspaceInspectorProps {
    tab: InspectorTab;
    onTabChange: (tab: InspectorTab) => void;
    mobileActive: boolean;
    visible: boolean;
    state: WorkspaceState;
    activeMessages: ChatMessageNode[];
    activeCharacter: NormalizedCharacterCard;
    activePreset: NormalizedPreset;
    hasStory: boolean;
    generating: boolean;
    settingsDestination: { category: SettingsCategory; revision: number };
    advancedTools: ReactNode;
    dataTools: ReactNode;
    onOpenPersona: (anchor: HTMLElement) => void;
    onReplayGuide: () => void;
    onClose: () => void;
    onOpenAppearance: () => void;
    onOpenAppearancePackages: () => void;
    onOpenAsset: (kind: 'presets' | 'lorebook', anchor: HTMLElement) => void;
    onShowCharacters: () => void;
}

export function WorkspaceInspector({
    tab, onTabChange, mobileActive, visible, state, activeMessages, activeCharacter, activePreset, hasStory, generating,
    settingsDestination, advancedTools, dataTools, onOpenPersona, onReplayGuide, onClose, onOpenAppearance,
    onOpenAppearancePackages, onOpenAsset, onShowCharacters,
}: WorkspaceInspectorProps) {
    const variableState = scopedVariableStore.useStore();
    const [selectedVarScope, setSelectedVarScope] = useState<VariableScopeLevel>('chat');
    const [newVarKey, setNewVarKey] = useState('');
    const [newVarVal, setNewVarVal] = useState('');
    const [variableValueMode, setVariableValueMode] = useState<'text' | 'json'>('text');
    const scopeContext = {
        presetId: activePreset.id,
        characterId: activeCharacter.id,
        chatId: state.activeChatId,
        messageId: activeMessages.at(-1)?.id,
        floor: activeMessages.at(-1)?.floor,
    };

    const refreshPreview = () => {
        void runUiAction('更新提示词预览', refreshPromptInspectorPreview, undefined);
    };

    const variablesVisible = tab === 'variables' && visible;
    const currentScopeVariables = useMemo(() => variablesVisible ? getScopedVariables(selectedVarScope, scopeContext) : {},
        [variablesVisible, selectedVarScope, variableState, activeCharacter, activePreset, state.activeChatId, state.activeLeafId]);
    const mergedVariables = useMemo(() => variablesVisible ? resolveMergedVariables(scopeContext) : {},
        [variablesVisible, variableState, activeCharacter, activePreset, state.activeChatId, state.activeLeafId]);
    const promptInfo = state.lastAssembledPrompt;
    const writeInspectorVariables = async (next: Record<string, unknown>) => {
        if (!hasStory) { replaceScopedVariables(next, selectedVarScope, scopeContext); return; }
        const previous = getScopedVariables(selectedVarScope, scopeContext);
        const session = state.activeChatId;
        const result = await commandCompatibilityRuntime('validateVariables', [selectedVarScope, next]);
        if (workspaceStore.getState().activeChatId !== session || JSON.stringify(getScopedVariables(selectedVarScope, scopeContext)) !== JSON.stringify(previous)) throw new Error('校验期间变量或会话已变化，请重新操作');
        replaceScopedVariables(result.variables ?? next, selectedVarScope, scopeContext);
    };

    return (
        <aside
            id="ttm-inspector"
            data-ti-shell="settings"
            aria-label="外观与设置"
            className={`ttm-inspector ${
                mobileActive ? 'is-mobile-active' : ''
            }`}
        >
            <div className="ttm-inspector-heading"><h2 data-ti-type="heading">设置与工具</h2><div className="ttm-inspector-heading-actions">
                {tab === 'schema-settings' && <button type="button" className="ttm-btn-ghost ttm-inspector-guide" title="重新开始使用引导" disabled={generating} onClick={onReplayGuide}><Icon name="book" width={17} height={17} />使用引导</button>}
                <button type="button" className="ttm-icon-btn" aria-label="关闭侧面板" onClick={onClose}><Icon name="close" /></button>
            </div></div>
            {(tab === 'prompt-tree' || tab === 'variables') && <button type="button" className="ttm-btn-ghost" onClick={() => onTabChange('schema-settings')}><Icon name="chevron" width={14} height={14} style={{ transform: 'rotate(180deg)' }} />返回设置</button>}
            <nav className="ttm-inspector-tabs" aria-label="工具分类">
                <button
                    type="button"
                    onClick={onOpenAppearance}
                >
                    外观
                </button>
                <button
                    type="button"
                    aria-haspopup="dialog"
                    onClick={event => onOpenAsset('presets', event.currentTarget)}
                >
                    预设
                </button>
                <button
                    type="button"
                    aria-haspopup="dialog"
                    onClick={event => onOpenAsset('lorebook', event.currentTarget)}
                >
                    世界书
                </button>
                <button
                    type="button"
                    className={tab === 'schema-settings' ? 'is-active' : ''}
                    aria-current={tab === 'schema-settings' ? 'page' : undefined}
                    onClick={() => onTabChange('schema-settings')}
                >
                    设置
                </button>
            </nav>

            <div className="ttm-inspector-content" key={tab}>{visible && <>
                {tab === 'prompt-tree' && !promptInfo && (
                    <p role="status">提示词预览按需计算。<button type="button" className="ttm-mini-btn" onClick={refreshPreview}>刷新预览</button></p>
                )}
                {tab === 'prompt-tree' && promptInfo && (
                    <div className="ttm-prompt-inspector">
                        <div className="ttm-token-meter">
                            <div className="ttm-token-summary">
                                <span>总上下文消耗</span>
                                <strong>
                                    {promptInfo.tokenUsage.total} / {(promptInfo.tokenUsage.budget ?? DEFAULT_CONTEXT_TOKENS)} Tokens
                                </strong>
                            </div>
                            <div className="ttm-token-breakdown">
                                <span>预设与角色: {promptInfo.tokenUsage.system + (promptInfo.tokenUsage.character ?? 0)}</span>
                                <span>世界书: {promptInfo.tokenUsage.lorebook}</span>
                                <span>历史记录: {promptInfo.tokenUsage.history}</span>
                            </div>
                        </div>

                        <div className="ttm-assembled-list">
                            {promptInfo.messages.map((msg, idx) => (
                                <div key={idx} className="ttm-assembled-item">
                                    <header>
                                        <span className={`ttm-role-tag is-${msg.role}`}>[{msg.role}]</span>
                                        <strong>{msg.sourceLabel}</strong>
                                        <small>{msg.estimatedTokens} tok</small>
                                    </header>
                                    <pre>{msg.content}</pre>
                                </div>
                            ))}
                        </div>
                    </div>
                )}

                {variablesVisible && (
                    <div className="ttm-vars-inspector">
                        <div className="ttm-scope-selector">
                            {(['global', 'preset', 'character', 'chat', 'message'] as VariableScopeLevel[]).map(
                                (lv) => (
                                    <button
                                        key={lv}
                                        type="button"
                                        className={`ttm-chip-btn ${selectedVarScope === lv ? 'is-active' : ''}`}
                                        onClick={() => setSelectedVarScope(lv)}
                                    >
                                        {lv}
                                    </button>
                                ),
                            )}
                        </div>

                        <label className="ttm-var-value-mode">
                            值格式
                            <select
                                className="ttm-select-input"
                                value={variableValueMode}
                                onChange={(event) => setVariableValueMode(event.target.value as 'text' | 'json')}
                            >
                                <option value="text">文本 / 数字</option>
                                <option value="json">JSON（对象、数组等）</option>
                            </select>
                        </label>
                        <div className="ttm-var-add-row">
                            <input
                                type="text"
                                className="ttm-text-input"
                                placeholder="变量名 (如 affection)"
                                value={newVarKey}
                                onChange={(e) => setNewVarKey(e.target.value)}
                            />
                            <textarea
                                className="ttm-text-input"
                                aria-label="变量值"
                                rows={variableValueMode === 'json' ? 4 : 1}
                                placeholder={variableValueMode === 'json' ? '{"value": 1}' : '值'}
                                value={newVarVal}
                                onChange={(e) => setNewVarVal(e.target.value)}
                            />
                            <button
                                type="button"
                                className="ttm-btn-primary"
                                onClick={() => {
                                    if (!newVarKey.trim()) return;
                                    void runUiAction('写入变量', async () => {
                                        const num = Number(newVarVal);
                                        const value: unknown = variableValueMode === 'json'
                                            ? JSON.parse(newVarVal)
                                            : !Number.isNaN(num) && newVarVal.trim() !== '' ? num : newVarVal;
                                        await writeInspectorVariables({ ...currentScopeVariables, [newVarKey.trim()]: value });
                                        setNewVarKey('');
                                        setNewVarVal('');
                                    }, undefined);
                                }}
                            >
                                写入
                            </button>
                        </div>

                        <h3 className="ttm-sub-heading">当前层级 ({selectedVarScope}) 变量</h3>
                        <div className="ttm-var-table">
                            {Object.entries(currentScopeVariables).map(([k, v]) => (
                                <div key={k} className="ttm-var-row">
                                    <code>{k}</code>
                                    <span>{JSON.stringify(v)}</span>
                                    <button
                                        type="button"
                                        className="ttm-mini-btn"
                                        onClick={() => {
                                            setNewVarKey(k);
                                            setVariableValueMode('json');
                                            setNewVarVal(JSON.stringify(v, null, 2) ?? 'null');
                                        }}
                                    >编辑</button>
                                    <button
                                        type="button"
                                        className="ttm-msg-action-btn is-danger"
                                        aria-label={`删除变量 ${k}`}
                                        onClick={() => { const next = { ...currentScopeVariables }; delete next[k]; void runUiAction('删除变量', () => writeInspectorVariables(next), undefined); }}
                                    >
                                        ×
                                    </button>
                                </div>
                            ))}
                        </div>

                        <h3 className="ttm-sub-heading">五级合并生效视图 (Merged Snapshot)</h3>
                        <pre className="ttm-json-preview">{JSON.stringify(mergedVariables, null, 2)}</pre>
                    </div>
                )}

                {tab === 'schema-settings' && <SettingsPanel key={settingsDestination.revision} initialCategory={settingsDestination.category} advancedTools={advancedTools} dataTools={dataTools} onOpenPersona={onOpenPersona}
                    onOpenAppearance={onOpenAppearancePackages}
                    onOpenAssets={(kind, anchor) => {
                        if (kind === 'characters') onShowCharacters();
                        else onOpenAsset(kind, anchor);
                    }} />}
            </>}</div>
        </aside>
    );
}

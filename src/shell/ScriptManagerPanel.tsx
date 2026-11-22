import { useRef, useState } from 'react';
import {
    getActiveCharacter, getActivePreset, getWorkspaceScriptTrees, persistWorkspaceNow,
    replaceWorkspaceScriptTrees, setStatusBanner, workspaceStore,
} from '../store/workspace-store';
import { scopedVariableStore } from '../store/scoped-variable-store';
import { normalizeScriptTrees, type ScriptScope } from '../compatibility/script-trees';
import { resetCompatibilityBranch } from '../compatibility/runtime-client';
import { saveExport } from '../core/platform-files';

const SCOPE_LABELS: Record<ScriptScope, string> = {
    global: '全局脚本',
    preset: '当前预设',
    character: '当前故事',
};

interface ScriptNode {
    type: 'script' | 'folder';
    id: string;
    name: string;
    enabled: boolean;
    content?: string;
    info?: string;
    data?: Record<string, unknown>;
    button?: { enabled: boolean; buttons: Array<{ name: string; visible: boolean }> };
    scripts?: ScriptNode[];
    icon?: string;
    color?: string;
}

function emptyScript(index: number): ScriptNode {
    return {
        type: 'script',
        id: crypto.randomUUID(),
        name: `新建脚本 #${index + 1}`,
        enabled: true,
        info: '',
        content: '// 在此编写酒馆助手 (TavernHelper) 脚本\n',
        data: {},
        button: { enabled: true, buttons: [] },
    };
}

function countScripts(items: ScriptNode[]): number {
    let total = 0;
    for (const item of items) {
        if (item.type === 'folder' && Array.isArray(item.scripts)) total += countScripts(item.scripts);
        else total += 1;
    }
    return total;
}

function updateNodeInTree(items: ScriptNode[], id: string, updater: (node: ScriptNode) => ScriptNode): ScriptNode[] {
    return items.map(item => {
        if (item.id === id) return updater(item);
        if (item.type === 'folder' && Array.isArray(item.scripts)) {
            return { ...item, scripts: updateNodeInTree(item.scripts, id, updater) };
        }
        return item;
    });
}

function removeNodeInTree(items: ScriptNode[], id: string): ScriptNode[] {
    return items
        .filter(item => item.id !== id)
        .map(item => item.type === 'folder' && Array.isArray(item.scripts)
            ? { ...item, scripts: removeNodeInTree(item.scripts, id) }
            : item);
}

function moveNodeInTree(items: ScriptNode[], id: string, delta: -1 | 1): ScriptNode[] {
    const idx = items.findIndex(item => item.id === id);
    if (idx >= 0) {
        const target = idx + delta;
        if (target < 0 || target >= items.length) return items;
        const next = [...items];
        [next[idx], next[target]] = [next[target], next[idx]];
        return next;
    }
    return items.map(item => item.type === 'folder' && Array.isArray(item.scripts)
        ? { ...item, scripts: moveNodeInTree(item.scripts, id, delta) }
        : item);
}

export function ScriptManagerPanel({ defaultScope = 'character' }: { defaultScope?: ScriptScope }) {
    const state = workspaceStore.useStore();
    scopedVariableStore.useStore(s => s.extension.tavern_helper);
    const activeCharacter = getActiveCharacter(state);
    const activePreset = getActivePreset(state);
    const hasCharacter = !!activeCharacter.id;
    const hasPreset = !!activePreset.id;
    const [scope, setScope] = useState<ScriptScope>(
        defaultScope === 'character' && !hasCharacter ? 'global' : defaultScope === 'preset' && !hasPreset ? 'global' : defaultScope,
    );
    const [editingId, setEditingId] = useState<string | null>(null);
    const [draft, setDraft] = useState<ScriptNode | null>(null);
    const [busy, setBusy] = useState(false);
    const [feedback, setFeedback] = useState('');
    const fileRef = useRef<HTMLInputElement>(null);

    const disabled = state.isGenerating || state.helperGenerationCount > 0 || busy;
    const trees = getWorkspaceScriptTrees(state);
    const currentTree: ScriptNode[] = trees[scope] ?? [];
    const scopeUnavailable = scope === 'character' && !hasCharacter || scope === 'preset' && !hasPreset;

    const commitTree = async (next: ScriptNode[], message?: string) => {
        setBusy(true);
        setFeedback('');
        try {
            replaceWorkspaceScriptTrees(next, scope, true);
            await persistWorkspaceNow();
            if (message) setFeedback(message);
        } catch (error) {
            setFeedback(error instanceof Error ? error.message : String(error));
        } finally {
            setBusy(false);
        }
    };

    const startNew = () => {
        const created = emptyScript(countScripts(currentTree));
        setEditingId(created.id);
        setDraft(created);
        setFeedback('');
    };

    const startEdit = (node: ScriptNode) => {
        if (editingId === node.id) {
            setEditingId(null);
            setDraft(null);
            return;
        }
        setEditingId(node.id);
        setDraft(structuredClone(node));
        setFeedback('');
    };

    const saveDraft = async () => {
        if (!draft) return;
        if (!draft.name.trim()) { setFeedback('请填写脚本名称。'); return; }
        const exists = (items: ScriptNode[]): boolean => items.some(item => item.id === draft.id || (item.type === 'folder' && Array.isArray(item.scripts) && exists(item.scripts)));
        const next = exists(currentTree)
            ? updateNodeInTree(currentTree, draft.id, () => draft)
            : [...currentTree, draft];
        await commitTree(next, `已保存脚本「${draft.name}」。`);
        setEditingId(null);
        setDraft(null);
    };

    const handleImport = async (file: File) => {
        setBusy(true);
        setFeedback('');
        try {
            const parsed = JSON.parse(await file.text());
            const items = Array.isArray(parsed) ? parsed : [parsed];
            const imported = normalizeScriptTrees(items.map((item: any) => ({ ...item, id: crypto.randomUUID() }))) as ScriptNode[];
            replaceWorkspaceScriptTrees([...currentTree, ...imported], scope, false);
            await persistWorkspaceNow();
            setFeedback(`已导入 ${imported.length} 项脚本到「${SCOPE_LABELS[scope]}」。`);
            setStatusBanner(`已导入 ${imported.length} 项酒馆助手脚本。`);
        } catch (error) {
            setFeedback(error instanceof Error ? error.message : String(error));
        } finally {
            setBusy(false);
        }
    };

    const handleExport = async () => {
        const blob = new Blob([JSON.stringify(currentTree, null, 2)], { type: 'application/json' });
        const ok = await saveExport(blob, `tavern-scripts-${scope}.json`);
        if (ok) setFeedback(`已导出「${SCOPE_LABELS[scope]}」中的脚本。`);
    };

    const renderNodes = (nodes: ScriptNode[], depth = 0) => nodes.map((node, index) => (
        <div
            key={node.id}
            className="ttm-asset-text-section"
            style={{
                padding: '0.6rem',
                borderRadius: '0.5rem',
                border: '1px solid var(--border-subtle, rgba(128,128,128,0.22))',
                marginBottom: '0.5rem',
                marginLeft: depth ? `${depth * 0.75}rem` : undefined,
            }}
        >
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem', cursor: 'pointer', flex: 1, minWidth: '10rem' }}>
                    <input
                        type="checkbox"
                        role="switch"
                        checked={node.enabled !== false}
                        disabled={disabled}
                        aria-label={`启用${node.type === 'folder' ? '文件夹' : '脚本'} ${node.name}`}
                        onChange={event => {
                            const next = updateNodeInTree(currentTree, node.id, item => ({ ...item, enabled: event.target.checked }));
                            void commitTree(next);
                        }}
                    />
                    <strong>{node.type === 'folder' ? `📁 ${node.name || '未命名文件夹'}` : (node.name || '未命名脚本')}</strong>
                </label>
                <button type="button" className="ttm-mini-btn" disabled={disabled || index === 0} onClick={() => void commitTree(moveNodeInTree(currentTree, node.id, -1))} title="上移">↑</button>
                <button type="button" className="ttm-mini-btn" disabled={disabled || index === nodes.length - 1} onClick={() => void commitTree(moveNodeInTree(currentTree, node.id, 1))} title="下移">↓</button>
                {node.type === 'script' && (
                    <button type="button" className="ttm-mini-btn" disabled={disabled} onClick={() => startEdit(node)}>{editingId === node.id ? '收起' : '编辑'}</button>
                )}
                <button
                    type="button"
                    className="ttm-msg-action-btn is-danger"
                    disabled={disabled}
                    aria-label={`删除 ${node.name}`}
                    onClick={() => {
                        if (editingId === node.id) { setEditingId(null); setDraft(null); }
                        void commitTree(removeNodeInTree(currentTree, node.id), `已删除「${node.name}」。`);
                    }}
                >×</button>
            </div>
            {node.info && <p className="ttm-asset-help" style={{ marginTop: '0.25rem' }}>{node.info.slice(0, 140)}{node.info.length > 140 ? '…' : ''}</p>}
            {editingId === node.id && draft && (
                <ScriptNodeEditor
                    node={draft}
                    disabled={disabled}
                    onChange={setDraft}
                    onSave={() => void saveDraft()}
                    onCancel={() => { setEditingId(null); setDraft(null); }}
                />
            )}
            {node.type === 'folder' && Array.isArray(node.scripts) && node.scripts.length > 0 && (
                <div style={{ marginTop: '0.5rem' }}>{renderNodes(node.scripts, depth + 1)}</div>
            )}
        </div>
    ));

    return (
        <section className="ttm-panel-block" aria-label="酒馆助手脚本管理">
            <h2 className="ttm-section-heading">酒馆助手脚本管理</h2>
            <p className="ttm-asset-help">
                管理内置酒馆助手（TavernHelper）脚本的开关、代码与排序。启停或修改脚本后，点击「重新载入运行环境」可立即重建脚本沙箱。
            </p>
            <div className="ttm-scope-selector" role="tablist" aria-label="脚本作用域">
                {(['global', 'preset', 'character'] as ScriptScope[]).map(item => (
                    <button
                        key={item}
                        type="button"
                        role="tab"
                        aria-selected={scope === item}
                        className={`ttm-chip-btn ${scope === item ? 'is-active' : ''}`}
                        onClick={() => { setScope(item); setEditingId(null); setDraft(null); setFeedback(''); }}
                    >
                        {SCOPE_LABELS[item]}（{countScripts(trees[item] ?? [])}）
                    </button>
                ))}
            </div>

            {scopeUnavailable ? (
                <p className="ttm-asset-help">
                    {scope === 'character' ? '当前尚未选择故事角色卡。' : '当前未选用叙事预设。'}请切换到「全局脚本」或先选择对应资源。
                </p>
            ) : (
                <>
                    <div className="ttm-editor-actions">
                        <button type="button" className="ttm-btn-primary" disabled={disabled} onClick={startNew}>新建脚本</button>
                        <button type="button" className="ttm-mini-btn" disabled={disabled} onClick={() => fileRef.current?.click()}>导入 JSON</button>
                        <button type="button" className="ttm-mini-btn" disabled={disabled || !currentTree.length} onClick={() => void handleExport()}>导出 JSON</button>
                        <button
                            type="button"
                            className="ttm-mini-btn"
                            disabled={disabled}
                            onClick={() => {
                                resetCompatibilityBranch();
                                setFeedback('已触发脚本运行环境重新载入。');
                            }}
                        >重新载入运行环境</button>
                        <input
                            ref={fileRef}
                            type="file"
                            accept=".json"
                            hidden
                            onChange={event => {
                                const file = event.target.files?.[0];
                                event.target.value = '';
                                if (file) void handleImport(file);
                            }}
                        />
                    </div>
                    {feedback && <p role="status">{feedback}</p>}

                    {draft && !currentTree.some(item => item.id === draft.id) && (
                        <ScriptNodeEditor
                            node={draft}
                            disabled={disabled}
                            onChange={setDraft}
                            onSave={() => void saveDraft()}
                            onCancel={() => { setEditingId(null); setDraft(null); }}
                        />
                    )}

                    {!currentTree.length && !draft && <p className="ttm-asset-help">当前作用域暂无酒馆助手脚本。</p>}
                    <div className="ttm-var-table">{renderNodes(currentTree)}</div>
                </>
            )}
        </section>
    );
}

function ScriptNodeEditor({
    node, disabled, onChange, onSave, onCancel,
}: {
    node: ScriptNode;
    disabled: boolean;
    onChange: (next: ScriptNode) => void;
    onSave: () => void;
    onCancel: () => void;
}) {
    const buttons = node.button?.buttons ?? [];
    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginTop: '0.6rem', paddingTop: '0.6rem', borderTop: '1px dashed var(--border-subtle, rgba(128,128,128,0.22))' }}>
            <label className="ttm-asset-field-label">
                脚本名称
                <input className="ttm-text-input" value={node.name} disabled={disabled} onChange={e => onChange({ ...node, name: e.target.value })} />
            </label>
            <label className="ttm-asset-field-label">
                作者说明 / 备注
                <textarea className="ttm-textarea" rows={2} value={node.info ?? ''} disabled={disabled} onChange={e => onChange({ ...node, info: e.target.value })} />
            </label>
            <label className="ttm-asset-field-label">
                脚本代码 (JavaScript)
                <textarea className="ttm-textarea" rows={10} style={{ fontFamily: 'monospace' }} value={node.content ?? ''} disabled={disabled} onChange={e => onChange({ ...node, content: e.target.value })} />
            </label>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem' }}>
                <input
                    type="checkbox"
                    checked={node.button?.enabled !== false}
                    disabled={disabled}
                    onChange={e => onChange({ ...node, button: { enabled: e.target.checked, buttons } })}
                />
                启用脚本快捷按钮
            </label>
            {buttons.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
                    {buttons.map((btn, idx) => (
                        <label key={`${btn.name}-${idx}`} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>
                            <input
                                type="checkbox"
                                checked={btn.visible !== false}
                                disabled={disabled}
                                onChange={e => {
                                    const nextButtons = buttons.map((item, i) => i === idx ? { ...item, visible: e.target.checked } : item);
                                    onChange({ ...node, button: { enabled: node.button?.enabled !== false, buttons: nextButtons } });
                                }}
                            />
                            {btn.name}
                        </label>
                    ))}
                </div>
            )}
            <div className="ttm-editor-actions">
                <button type="button" className="ttm-btn-primary" disabled={disabled} onClick={onSave}>保存脚本</button>
                <button type="button" className="ttm-btn-secondary" disabled={disabled} onClick={onCancel}>取消</button>
            </div>
        </div>
    );
}

import { useRef, useState } from 'react';
import {
    getActiveCharacter, getActivePreset, persistWorkspaceNow, saveWorkspaceRegexRules,
    setStatusBanner, workspaceStore,
} from '../store/workspace-store';
import { workspaceGlobalRegexes } from '../store/global-regex-store';
import { scopedVariableStore } from '../store/scoped-variable-store';
import { normalizeRegexScripts } from '../pipeline/normalizer';
import { serializeRegexRule } from '../pipeline/asset-serializer';
import { fromTavernRegexes } from '../compatibility/regex-codec';
import { saveExport } from '../core/platform-files';
import type { RegexPlacementStage, RegexScriptRule } from '../types';

type RegexScope = 'global' | 'preset' | 'character';

const PLACEMENTS: Array<{ id: RegexPlacementStage; label: string }> = [
    { id: 'user_input', label: '用户输入' },
    { id: 'ai_output', label: 'AI 输出' },
    { id: 'slash_command', label: '斜杠命令' },
    { id: 'world_info', label: '世界书' },
    { id: 'reasoning', label: '思考过程' },
];

const SCOPE_LABELS: Record<RegexScope, string> = {
    global: '全局正则',
    preset: '当前预设',
    character: '当前故事',
};

function emptyRegexRule(index: number): RegexScriptRule {
    return {
        id: crypto.randomUUID(),
        scriptName: `新建正则 #${index + 1}`,
        findRegex: '',
        replaceString: '',
        trimStrings: [],
        placement: ['ai_output'],
        disabled: false,
        markdownOnly: true,
        promptOnly: false,
        runOnEdit: true,
        substituteRegex: 0,
        minDepth: null,
        maxDepth: null,
    };
}

export function RegexManagerPanel({ defaultScope = 'character' }: { defaultScope?: RegexScope }) {
    const state = workspaceStore.useStore();
    const extState = scopedVariableStore.useStore();
    const activeCharacter = getActiveCharacter(state);
    const activePreset = getActivePreset(state);
    const hasCharacter = !!activeCharacter.id;
    const hasPreset = !!activePreset.id;
    const [scope, setScope] = useState<RegexScope>(
        defaultScope === 'character' && !hasCharacter ? 'global' : defaultScope === 'preset' && !hasPreset ? 'global' : defaultScope,
    );
    const [editingId, setEditingId] = useState<string | null>(null);
    const [draft, setDraft] = useState<RegexScriptRule | null>(null);
    const [busy, setBusy] = useState(false);
    const [feedback, setFeedback] = useState('');
    const fileRef = useRef<HTMLInputElement>(null);

    const disabled = state.isGenerating || state.helperGenerationCount > 0 || busy;
    const globalRules = (extState.extension.tipsy_regex?.rules as RegexScriptRule[] | undefined) ?? workspaceGlobalRegexes();
    const rules: RegexScriptRule[] = scope === 'global'
        ? globalRules
        : scope === 'preset'
            ? (activePreset.regexScripts ?? [])
            : (activeCharacter.regexScripts ?? []);

    const scopeUnavailable = scope === 'character' && !hasCharacter || scope === 'preset' && !hasPreset;

    const commitRules = async (next: RegexScriptRule[], message?: string) => {
        setBusy(true);
        setFeedback('');
        try {
            await saveWorkspaceRegexRules(scope, next);
            if (message) setFeedback(message);
        } catch (error) {
            setFeedback(error instanceof Error ? error.message : String(error));
        } finally {
            setBusy(false);
        }
    };

    const startNew = () => {
        const created = emptyRegexRule(rules.length);
        setEditingId(created.id);
        setDraft(created);
        setFeedback('');
    };

    const startEdit = (rule: RegexScriptRule) => {
        if (editingId === rule.id) {
            setEditingId(null);
            setDraft(null);
            return;
        }
        setEditingId(rule.id);
        setDraft(structuredClone(rule));
        setFeedback('');
    };

    const saveDraft = async () => {
        if (!draft) return;
        if (!draft.scriptName.trim()) { setFeedback('请填写正则名称。'); return; }
        const exists = rules.some(rule => rule.id === draft.id);
        const next = exists ? rules.map(rule => rule.id === draft.id ? draft : rule) : [...rules, draft];
        await commitRules(next, `已保存正则「${draft.scriptName}」。`);
        setEditingId(null);
        setDraft(null);
    };

    const moveRule = async (index: number, delta: -1 | 1) => {
        const target = index + delta;
        if (target < 0 || target >= rules.length) return;
        const next = [...rules];
        [next[index], next[target]] = [next[target], next[index]];
        await commitRules(next);
    };

    const deleteRule = async (rule: RegexScriptRule) => {
        const next = rules.filter(item => item.id !== rule.id);
        if (editingId === rule.id) { setEditingId(null); setDraft(null); }
        await commitRules(next, `已删除正则「${rule.scriptName}」。`);
    };

    const handleImport = async (file: File) => {
        setBusy(true);
        setFeedback('');
        try {
            const parsed = JSON.parse(await file.text());
            const items = Array.isArray(parsed) ? parsed : [parsed];
            const imported = items.map((item: any) => {
                if (typeof item?.find_regex === 'string' && typeof item?.findRegex !== 'string') {
                    return fromTavernRegexes([item])[0];
                }
                if (typeof item?.findRegex !== 'string') throw new Error('无效的 SillyTavern 正则 JSON');
                return normalizeRegexScripts([{ ...item, id: crypto.randomUUID() }])[0];
            });
            await saveWorkspaceRegexRules(scope, [...rules, ...imported]);
            await persistWorkspaceNow();
            setFeedback(`已导入 ${imported.length} 条正则到「${SCOPE_LABELS[scope]}」。`);
            setStatusBanner(`已导入 ${imported.length} 条正则规则。`);
        } catch (error) {
            setFeedback(error instanceof Error ? error.message : String(error));
        } finally {
            setBusy(false);
        }
    };

    const handleExport = async () => {
        const payload = rules.map(serializeRegexRule);
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
        const ok = await saveExport(blob, `regex-${scope}.json`);
        if (ok) setFeedback(`已导出 ${rules.length} 条正则规则。`);
    };

    return (
        <section className="ttm-panel-block" aria-label="正则管理">
            <h2 className="ttm-section-heading">正则管理</h2>
            <p className="ttm-asset-help">
                支持查看、开关、添加、编辑、排序与删除正则规则。作用域按「全局 → 预设 → 故事」依次叠加生效；前端美化状态栏通常挂载在「AI 输出 + 仅作用于显示渲染」。
            </p>
            <div className="ttm-scope-selector" role="tablist" aria-label="正则作用域">
                {(['global', 'preset', 'character'] as RegexScope[]).map(item => (
                    <button
                        key={item}
                        type="button"
                        role="tab"
                        aria-selected={scope === item}
                        className={`ttm-chip-btn ${scope === item ? 'is-active' : ''}`}
                        onClick={() => { setScope(item); setEditingId(null); setDraft(null); setFeedback(''); }}
                    >
                        {SCOPE_LABELS[item]}（{item === 'global' ? globalRules.length : item === 'preset' ? (activePreset.regexScripts?.length ?? 0) : (activeCharacter.regexScripts?.length ?? 0)}）
                    </button>
                ))}
            </div>

            {scopeUnavailable ? (
                <p className="ttm-asset-help">
                    {scope === 'character' ? '当前尚未选择故事角色卡。' : '当前未选用叙事预设。'}请切换到「全局正则」或先选择对应资源。
                </p>
            ) : (
                <>
                    <div className="ttm-editor-actions">
                        <button type="button" className="ttm-btn-primary" disabled={disabled} onClick={startNew}>新建正则</button>
                        <button type="button" className="ttm-mini-btn" disabled={disabled} onClick={() => fileRef.current?.click()}>导入 JSON</button>
                        <button type="button" className="ttm-mini-btn" disabled={disabled || !rules.length} onClick={() => void handleExport()}>导出 JSON</button>
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

                    {draft && !rules.some(rule => rule.id === draft.id) && (
                        <RegexRuleEditor
                            rule={draft}
                            disabled={disabled}
                            onChange={setDraft}
                            onSave={() => void saveDraft()}
                            onCancel={() => { setEditingId(null); setDraft(null); }}
                        />
                    )}

                    {!rules.length && !draft && <p className="ttm-asset-help">当前作用域暂无正则规则。</p>}

                    <div className="ttm-var-table">
                        {rules.map((rule, index) => (
                            <div key={rule.id} className="ttm-asset-text-section" style={{ padding: '0.6rem', borderRadius: '0.5rem', border: '1px solid var(--border-subtle, rgba(128,128,128,0.22))', marginBottom: '0.5rem' }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                                    <label style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem', cursor: 'pointer', flex: 1, minWidth: '10rem' }}>
                                        <input
                                            type="checkbox"
                                            role="switch"
                                            checked={!rule.disabled}
                                            disabled={disabled}
                                            aria-label={`启用正则 ${rule.scriptName}`}
                                            onChange={event => {
                                                const next = rules.map(item => item.id === rule.id ? { ...item, disabled: !event.target.checked } : item);
                                                void commitRules(next);
                                            }}
                                        />
                                        <strong>{rule.scriptName || '未命名正则'}</strong>
                                    </label>
                                    <button type="button" className="ttm-mini-btn" disabled={disabled || index === 0} onClick={() => void moveRule(index, -1)} title="上移">↑</button>
                                    <button type="button" className="ttm-mini-btn" disabled={disabled || index === rules.length - 1} onClick={() => void moveRule(index, 1)} title="下移">↓</button>
                                    <button type="button" className="ttm-mini-btn" disabled={disabled} onClick={() => startEdit(rule)}>{editingId === rule.id ? '收起' : '编辑'}</button>
                                    <button type="button" className="ttm-msg-action-btn is-danger" disabled={disabled} aria-label={`删除正则 ${rule.scriptName}`} onClick={() => void deleteRule(rule)}>×</button>
                                </div>
                                <div className="ttm-asset-help" style={{ marginTop: '0.25rem' }}>
                                    <span>阶段：{rule.placement.map(p => PLACEMENTS.find(x => x.id === p)?.label ?? p).join('、') || '无'}</span>
                                    {rule.markdownOnly && <span> · 仅显示渲染</span>}
                                    {rule.promptOnly && <span> · 仅提示词</span>}
                                    {(rule.minDepth != null || rule.maxDepth != null) && <span> · 深度 {rule.minDepth ?? 0}~{rule.maxDepth ?? '∞'}</span>}
                                </div>
                                {editingId === rule.id && draft && (
                                    <RegexRuleEditor
                                        rule={draft}
                                        disabled={disabled}
                                        onChange={setDraft}
                                        onSave={() => void saveDraft()}
                                        onCancel={() => { setEditingId(null); setDraft(null); }}
                                    />
                                )}
                            </div>
                        ))}
                    </div>
                </>
            )}
        </section>
    );
}

function RegexRuleEditor({
    rule, disabled, onChange, onSave, onCancel,
}: {
    rule: RegexScriptRule;
    disabled: boolean;
    onChange: (next: RegexScriptRule) => void;
    onSave: () => void;
    onCancel: () => void;
}) {
    const togglePlacement = (stage: RegexPlacementStage, checked: boolean) => {
        const placement = checked
            ? [...new Set([...rule.placement, stage])]
            : rule.placement.filter(item => item !== stage);
        onChange({ ...rule, placement });
    };

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginTop: '0.6rem', paddingTop: '0.6rem', borderTop: '1px dashed var(--border-subtle, rgba(128,128,128,0.22))' }}>
            <label className="ttm-asset-field-label">
                规则名称
                <input className="ttm-text-input" value={rule.scriptName} disabled={disabled} onChange={e => onChange({ ...rule, scriptName: e.target.value })} />
            </label>
            <label className="ttm-asset-field-label">
                查找正则 (Find Regex)
                <input className="ttm-text-input" placeholder="如 /<UpdateVariable>[\\s\\S]*?<\\/UpdateVariable>/gi" value={rule.findRegex} disabled={disabled} onChange={e => onChange({ ...rule, findRegex: e.target.value })} />
            </label>
            <label className="ttm-asset-field-label">
                替换为 (Replace With)
                <textarea className="ttm-textarea" rows={5} value={rule.replaceString} disabled={disabled} onChange={e => onChange({ ...rule, replaceString: e.target.value })} />
            </label>
            <label className="ttm-asset-field-label">
                修剪字符串 (Trim Out，每行一个)
                <textarea
                    className="ttm-textarea"
                    rows={2}
                    value={(rule.trimStrings ?? []).join('\n')}
                    disabled={disabled}
                    onChange={e => onChange({ ...rule, trimStrings: e.target.value ? e.target.value.split(/\r?\n/) : [] })}
                />
            </label>
            <div>
                <div className="ttm-asset-field-label">作用位置</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.6rem' }}>
                    {PLACEMENTS.map(stage => (
                        <label key={stage.id} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>
                            <input
                                type="checkbox"
                                checked={rule.placement.includes(stage.id)}
                                disabled={disabled}
                                onChange={e => togglePlacement(stage.id, e.target.checked)}
                            />
                            {stage.label}
                        </label>
                    ))}
                </div>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem' }}>
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>
                    <input type="checkbox" checked={!!rule.markdownOnly} disabled={disabled} onChange={e => onChange({ ...rule, markdownOnly: e.target.checked })} />
                    仅作用于显示渲染
                </label>
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>
                    <input type="checkbox" checked={!!rule.promptOnly} disabled={disabled} onChange={e => onChange({ ...rule, promptOnly: e.target.checked })} />
                    仅作用于提示词
                </label>
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>
                    <input type="checkbox" checked={!!rule.runOnEdit} disabled={disabled} onChange={e => onChange({ ...rule, runOnEdit: e.target.checked })} />
                    编辑时运行
                </label>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '0.5rem' }}>
                <label className="ttm-asset-field-label">
                    宏替换模式
                    <select className="ttm-select-input" value={Number(rule.substituteRegex ?? 0)} disabled={disabled} onChange={e => onChange({ ...rule, substituteRegex: Number(e.target.value) as 0 | 1 | 2 })}>
                        <option value={0}>不替换</option>
                        <option value={1}>原样替换</option>
                        <option value={2}>正则转义替换</option>
                    </select>
                </label>
                <label className="ttm-asset-field-label">
                    最小深度
                    <input type="number" className="ttm-text-input" placeholder="留空不限" value={rule.minDepth ?? ''} disabled={disabled} onChange={e => onChange({ ...rule, minDepth: e.target.value === '' ? null : Number(e.target.value) })} />
                </label>
                <label className="ttm-asset-field-label">
                    最大深度
                    <input type="number" className="ttm-text-input" placeholder="留空不限" value={rule.maxDepth ?? ''} disabled={disabled} onChange={e => onChange({ ...rule, maxDepth: e.target.value === '' ? null : Number(e.target.value) })} />
                </label>
            </div>
            <div className="ttm-editor-actions">
                <button type="button" className="ttm-btn-primary" disabled={disabled} onClick={onSave}>保存规则</button>
                <button type="button" className="ttm-btn-secondary" disabled={disabled} onClick={onCancel}>取消</button>
            </div>
        </div>
    );
}

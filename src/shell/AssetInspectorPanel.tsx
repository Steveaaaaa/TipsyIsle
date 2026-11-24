import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { beginSyncAssetEdit } from '../core/sync/activity';
import type { NormalizedCharacterCard, NormalizedLorebook, NormalizedPreset, PresetPromptSlot } from '../types';
import { clearMvuCharacterOverrides, mvuCharacterConfigEntries, readMvuCharacterSettings } from '../pipeline/mvu-settings';
import { requestWorldbook } from '../compatibility/worldbook-host';
import { serializeCharacterCard } from '../pipeline/asset-serializer';
import { inspectCardCompatibility } from '../pipeline/card-compatibility';
import { CharacterAvatar } from './CharacterAvatar';
import { storyIdentity } from '../core/story-identity';
import { EntryBrowser } from './EntryBrowser';
import { EntryStatus } from './EntryStatus';
import { ExplainedValue, messageRoles, depthDescription, depthExplanation } from './EntryExplanations';

interface CharacterDetailsPanelProps {
    actions?: ReactNode;
    mode?: 'player' | 'advanced';
    character: NormalizedCharacterCard;
    disabled: boolean;
    onSaveDocument: (document: Record<string, unknown>) => boolean;
}

export function MvuCharacterSettingsEditor({ book, disabled }: { book: NormalizedLorebook; disabled: boolean }) {
    const [draft, setDraft] = useState<string | null>(null);
    useEffect(() => draft !== null ? beginSyncAssetEdit() : undefined, [draft !== null]);
    const [saving, setSaving] = useState(false);
    const [feedback, setFeedback] = useState('');
    const [open, setOpen] = useState(false);
    const source = useMemo(() => open ? mvuCharacterConfigEntries(book)[0]?.content ?? '{}' : '{}', [book, open]);
    const warnings = useMemo(() => open ? readMvuCharacterSettings(book).warnings : [], [book, open]);
    return <details className="ttm-panel-block ttm-asset-text-section" onToggle={event => setOpen(event.currentTarget.open)}>
        <summary>MVU 角色配置</summary>
        {open && <>
        <p className="ttm-asset-help">保存到「{book.name}」的停用条目 [config_override]，缺省字段继承全局设置。可设置“更新方式”、“额外模型解析配置”和“兼容性”。</p>
        <textarea className="ttm-textarea" rows={10} aria-label="MVU 角色配置 JSON" disabled={disabled || saving}
            value={draft ?? source} onChange={event => { setDraft(event.target.value); setFeedback(''); }} />
        {warnings.map(warning => <p role="alert" key={warning}>{warning}</p>)}
        {feedback && <p role="status">{feedback}</p>}
        <button type="button" className="ttm-mini-btn" disabled={disabled || saving || draft === null} onClick={async () => {
            setSaving(true);
            try { await requestWorldbook('worldbook.mvu.config', { name: book.name, content: draft ?? source }); setDraft(null); setFeedback('角色配置已保存。'); }
            catch (error) { setFeedback(error instanceof Error ? error.message : String(error)); }
            finally { setSaving(false); }
        }}>保存角色配置</button>
        <button type="button" className="ttm-mini-btn" disabled={disabled || saving} onClick={() => {
            try { setDraft(clearMvuCharacterOverrides(draft ?? source)); setFeedback('保存后恢复继承全局设置，未知扩展字段继续保留。'); }
            catch (error) { setFeedback(error instanceof Error ? error.message : String(error)); }
        }}>继承全局设置</button>
        <button type="button" className="ttm-mini-btn" disabled={saving || draft === null} onClick={() => { setDraft(null); setFeedback(''); }}>撤销编辑</button>
        </>}
    </details>;
}

export function CharacterDetailsPanel({ character, disabled, onSaveDocument, mode = 'player', actions }: CharacterDetailsPanelProps) {
    const identity = storyIdentity(character);
    const embeddedBook = character.characterBook ?? character.embeddedLorebook;
    const [reportOpen, setReportOpen] = useState(false);
    const report = reportOpen ? inspectCardCompatibility(character) : null;
    const [documentOpen, setDocumentOpen] = useState(false);
    const [documentDraft, setDocumentDraft] = useState<string | null>(null);
    useEffect(() => documentDraft !== null ? beginSyncAssetEdit() : undefined, [documentDraft !== null]);
    const [documentError, setDocumentError] = useState('');
    const documentText = useMemo(() => documentOpen ? JSON.stringify(serializeCharacterCard(character), null, 2) : '', [character, documentOpen]);

    return (
        <section className="ttm-panel-block ttm-character-details" aria-label="故事详情">
            <div className="ttm-character-detail-title"><h2 className="ttm-section-heading">故事详情</h2>{actions}</div>
            <div className="ttm-character-detail-header">
                <CharacterAvatar name={identity.name} avatar={character.avatar} className="ttm-character-detail-avatar" />
                <div className="ttm-char-meta">
                    <strong>{identity.name}</strong>
                    <p>{character.creator || '未注明作者'}</p>
                    {identity.version && <p>{identity.metadataVersion ? '名称标注版本' : '版本'} {identity.version}</p>}
                    {identity.metadataVersion && <p>卡片元数据版本 {identity.metadataVersion}</p>}
                </div>
            </div>
            <div className="ttm-asset-counts">
                <span>内嵌世界书：{embeddedBook?.entries.length ?? 0} 条</span>
                <span>正则：{character.regexScripts?.length ?? 0} 条</span>
                {report && <span>启用脚本：{report.enabledScripts} 个</span>}
            </div>
            {mode === 'advanced' && <><details className="ttm-asset-text-section" onToggle={event => setReportOpen(event.currentTarget.open)}>
                <summary>兼容检查{report ? ` · ${report.findings.length} 项需注意` : ' · 展开查看'}</summary>
                {report && <>
                <p className="ttm-asset-help">世界书启用 {report.enabledEntries}/{report.entries}，正则 {report.regexRules} 条。原始扩展数据随角色卡保留。</p>
                <p className="ttm-asset-help">EJS 生成模板与作者脚本运行环境已接入开发版；完整插件兼容尚未完成。脚本启动失败时会在状态栏显示原因。</p>
                {report.findings.map((finding, index) => <p key={index} className="ttm-asset-help">{finding.path}：{finding.message}</p>)}
                </>}
            </details>
            <details className="ttm-asset-text-section" onToggle={event => setDocumentOpen(event.currentTarget.open)}>
                <summary>角色卡完整数据编辑</summary>
                {documentOpen && <>
                <p className="ttm-asset-help">编辑角色字段、内嵌世界书、正则与扩展参数。保存后影响后续生成；已有聊天消息保持原文。</p>
                <textarea className="ttm-textarea" rows={16} aria-label="角色卡完整 JSON" disabled={disabled}
                    value={documentDraft ?? documentText} onChange={event => { setDocumentDraft(event.target.value); setDocumentError(''); }} />
                {documentError && <p role="alert">{documentError}</p>}
                <button type="button" className="ttm-mini-btn" disabled={disabled || documentDraft === null}
                    onClick={() => {
                        try {
                            const parsed = JSON.parse(documentDraft ?? documentText);
                            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('角色卡必须是 JSON 对象');
                            const data = parsed.data ?? parsed;
                            if (typeof data.name !== 'string' || !data.name.trim()) throw new Error('角色名称不能为空');
                            if (onSaveDocument(parsed)) { setDocumentDraft(null); setDocumentError(''); }
                        } catch (error) { setDocumentError(error instanceof Error ? error.message : String(error)); }
                    }}>保存完整数据</button>
                <button type="button" className="ttm-mini-btn" disabled={documentDraft === null}
                    onClick={() => { setDocumentDraft(null); setDocumentError(''); }}>撤销编辑</button>
                </>}
            </details>
            </>}
            {mode === 'player' && <><details className="ttm-asset-text-section" open>
                <summary>作者说明</summary>
                <p className="ttm-asset-plain-text">{character.creatorNotes || '暂无作者说明。'}</p>
            </details>
            <details className="ttm-asset-text-section">
                <summary>角色描述</summary>
                <p className="ttm-asset-plain-text">{character.description || '暂无角色描述。'}</p>
            </details>
            </>}
        </section>
    );
}

interface PresetEntriesPanelProps {
    preset: NormalizedPreset;
    disabled?: boolean;
    onUpdatePrompt: (identifier: string, patch: Partial<PresetPromptSlot>) => boolean;
}

export function PresetEntriesPanel({ preset, disabled, onUpdatePrompt }: PresetEntriesPanelProps) {
    const [drafts, setDrafts] = useState<Map<string, string>>(() => new Map());
    const [editing, setEditing] = useState<Set<string>>(() => new Set());
    useEffect(() => editing.size ? beginSyncAssetEdit() : undefined, [editing.size > 0]);
    const [feedback, setFeedback] = useState('');
    const prompts = useMemo(() => [...(preset.promptSlots ?? preset.prompts ?? [])].sort((a, b) => (a.injectionOrder ?? 0) - (b.injectionOrder ?? 0)), [preset]);
    const discardDraft = (id: string) => {
        setDrafts(previous => { const next = new Map(previous); next.delete(id); return next; });
        setEditing(previous => { const next = new Set(previous); next.delete(id); return next; });
    };
    return <EntryBrowser label="预设词条" storageKey={`tipsy-entry-favorites:preset:${preset.id}`}
        entries={prompts.map(prompt => ({ id: prompt.identifier, name: prompt.name || prompt.identifier, content: prompt.content, enabled: prompt.enabled !== false, dirty: drafts.has(prompt.identifier) && drafts.get(prompt.identifier) !== prompt.content }))}
        toggleDisabled={disabled}
        onToggleEnabled={(entry, enabled) => { onUpdatePrompt(entry.id, { enabled }); setFeedback(''); }}
        renderDetail={entry => {
            const prompt = prompts.find(item => item.identifier === entry.id)!;
            const content = drafts.get(entry.id) ?? prompt.content;
            const dirty = content !== prompt.content;
            const inChat = prompt.injectionPosition === 'in_chat' || prompt.injectionPosition === 1;
            const role = messageRoles[prompt.role] ?? messageRoles.system;
            return <div className="ttm-selected-entry" key={entry.id}>
                <label className="ttm-detail-enabled"><input type="checkbox" role="switch" checked={entry.enabled} disabled={disabled} aria-label={`启用 ${entry.name}`} onChange={event => { onUpdatePrompt(entry.id, { enabled: event.target.checked }); setFeedback(''); }} /><EntryStatus enabled={entry.enabled} /></label>
                {prompt.marker && <p className="ttm-entry-notice">这是动态内容占位项，生成时可能由角色资料、聊天记录等内容填充，最终发送内容不一定与这里相同。</p>}
                {editing.has(entry.id) ? <textarea className="ttm-textarea ttm-entry-editor" aria-label={`${entry.name} 内容`} rows={12} disabled={disabled} value={content} onChange={event => { setDrafts(previous => new Map(previous).set(entry.id, event.target.value)); setFeedback(''); }} />
                    : <pre className="ttm-entry-body" aria-label="选项正文">{prompt.content || '（此选项暂无固定正文）'}</pre>}
                <div className="ttm-entry-edit-actions">
                    {editing.has(entry.id) ? <><button type="button" className="ttm-btn-primary" disabled={disabled || !dirty} onClick={() => { if (onUpdatePrompt(entry.id, { content })) { discardDraft(entry.id); setFeedback('内容已保存。'); } else setFeedback('保存失败，请关闭浮窗查看页面提示；编辑内容仍保留。'); }}>保存内容</button><button type="button" className="ttm-btn-secondary" onClick={() => { discardDraft(entry.id); setFeedback(''); }}>取消编辑</button><small>{dirty ? '未保存 · 翻页和切换选项会保留草稿' : '内容未修改'}</small></>
                        : <button type="button" className="ttm-btn-secondary" disabled={disabled} onClick={() => { setEditing(previous => new Set(previous).add(entry.id)); setFeedback(''); }}>编辑内容</button>}
                    {feedback && <span role="status">{feedback}</span>}
                </div>
                <section className="ttm-entry-explanations" aria-label="作用方式"><h4>作用方式</h4>
                    <ExplainedValue label="消息类型" value={role.name} explanation={role.help} />
                    <ExplainedValue label="插入方式" value={inChat ? '插入聊天记录' : '按预设顺序'} explanation={inChat ? '将内容插入本次发送的聊天记录中，具体位置由下方的消息深度决定。' : '按作者设置的预设顺序加入提示词；此方式不使用聊天深度，目录翻页与搜索不会改变执行顺序。'} />
                    {inChat && <ExplainedValue label="插入位置" value={depthDescription(Math.max(0, prompt.injectionDepth ?? 4))} explanation={depthExplanation} />}
                </section>
                <details className="ttm-entry-advanced"><summary>高级信息</summary><dl><dt>原始标识</dt><dd>{prompt.identifier}</dd><dt>消息类型代码</dt><dd>{prompt.role}</dd><dt>插入方式代码</dt><dd>{String(prompt.injectionPosition ?? 'relative')}</dd><dt>预设顺序值</dt><dd>{prompt.injectionOrder ?? 0}</dd></dl></details>
            </div>;
        }} />;
}

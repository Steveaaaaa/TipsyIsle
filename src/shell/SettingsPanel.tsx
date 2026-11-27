import { useRef, useState } from 'react';
import { SchemaFormRenderer } from '../registry/SchemaFormRenderer';
import { countPendingSettingsChanges, settingsDraftStore, discardSettingsDraft, SettingsDraftProvider, useSettingsEditor } from '../registry/settings-draft';
import { commitSettingsDraft } from './settings-draft-actions';
import { ExtensionManager } from './ExtensionManager';
import { LanSyncPanel } from './LanSyncPanel';
import type { ReactNode } from 'react';
import { workspaceStore, setStatusBanner } from '../store/workspace-store';
import { MvuSettingsPanel } from './MvuSettingsPanel';
import { RegexManagerPanel } from './RegexManagerPanel';
import { ScriptManagerPanel } from './ScriptManagerPanel';
import { Icon } from './Icon';
import { SettingsDisclosure, SettingsSection } from './SettingsPrimitives';
import { pluginSettingsDestinations, settingsCategories, settingsCategoryForField, settingsFieldLabels, storyToolDestinations, type PluginSettingsDestination, type SettingsCategory } from './settings-presentation';
import type { StreamDisplayMode } from '../pipeline/streaming-message';
import { NativePluginManager } from '../plugins/native/PluginManager';
import { PersonaSettings } from './PersonaSettings';
import { nativeAppUpdates } from '../core/native-runtime';
import { checkAppUpdate, showCurrentReleaseNotes } from '../core/app-update';
import { DiagnosticLogPanel } from './DiagnosticLogPanel';
import { StoryModelProfilesBar } from './StoryModelProfilesBar';
import app from '../../package.json';

const INLINE_HELP_FIELDS = new Set(['api.chat_completion_source', 'api.custom_url', 'mvu.mode']);

type SettingsPanelProps = {
    advancedTools?: ReactNode; dataTools?: ReactNode; onOpenPersona?: (anchor: HTMLElement) => void;
    onOpenAppearance?: () => void; onOpenAssets?: (kind: 'characters' | 'lorebook' | 'presets', anchor: HTMLElement) => void;
    initialCategory?: SettingsCategory;
};
export function SettingsPanel(props: SettingsPanelProps) {
    return <SettingsDraftProvider><SettingsPanelContent {...props} /></SettingsDraftProvider>;
}
function SettingsPanelContent({ advancedTools, dataTools, onOpenAppearance, onOpenAssets, initialCategory = 'connection' }: SettingsPanelProps) {
    const workspace = workspaceStore.useStore();
    const { fields, setValues: setSchemaValues } = useSettingsEditor();
    const draft = settingsDraftStore.useStore();
    const changed = countPendingSettingsChanges(draft);
    const saving = draft.saving;
    const saveError = draft.saveError;
    const saveBlocked = workspace.isGenerating || workspace.helperGenerationCount > 0;
    const [category, setCategory] = useState<SettingsCategory>(initialCategory);
    const [pluginDestination, setPluginDestination] = useState<PluginSettingsDestination>('overview');
    const [direction, setDirection] = useState<'forward' | 'backward'>('forward');
    const [query, setQuery] = useState('');
    const searchInput = useRef<HTMLInputElement>(null);
    const categoryLabel = settingsCategories.find(item => item.id === category)!;
    const ids = Object.keys(fields);
    const renderFields = (fieldIds: string[], inlineIds = INLINE_HELP_FIELDS) => (
        <SchemaFormRenderer fieldIds={fieldIds} fieldOverrides={settingsFieldLabels} ungrouped inlineHelpIds={inlineIds} />
    );
    // Dedicated editors now own identity, theme and saved connection profiles; hide their raw keys.
    const searchable = Object.values(fields).filter(field => !field.id.startsWith('ui.') && !['mvu.profile', 'api.connection_profiles', 'api.active_profile'].includes(field.id));
    const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    const results = words.length ? searchable.filter(field => {
        const shown = { ...field, ...settingsFieldLabels[field.id] };
        const text = `${shown.title} ${shown.description ?? ''} ${field.id} ${shown.options?.map(option => option.label).join(' ') ?? ''}`.toLocaleLowerCase();
        return words.every(word => text.includes(word));
    }) : [];
    const pluginResults = words.length ? pluginSettingsDestinations.filter(item => {
        const text = `${item.title} ${item.description} ${item.keywords}`.toLocaleLowerCase();
        return words.every(word => text.includes(word));
    }) : [];
    const storyToolResults = words.length ? storyToolDestinations.filter(item => {
        const text = `${item.title} ${item.description} ${item.keywords}`.toLocaleLowerCase();
        return words.every(word => text.includes(word));
    }) : [];
    const resultCount = results.length + pluginResults.length + storyToolResults.length;
    const navigate = (next: SettingsCategory, pluginView: PluginSettingsDestination = 'overview') => {
        setDirection(settingsCategories.findIndex(item => item.id === next) < settingsCategories.findIndex(item => item.id === category) ? 'backward' : 'forward');
        setCategory(next); setPluginDestination(pluginView); setQuery('');
    };

    return <div className="ttm-settings-panel" data-category={category}>
        <fieldset className="ttm-settings-editor" disabled={saving}>
        <div className="ttm-settings-search"><Icon name="search" width={17} height={17} /><input ref={searchInput} type="search" aria-label="搜索设置" placeholder="搜索设置，如插件、模型连接" value={query} onChange={event => setQuery(event.target.value)} />
            {query && <button type="button" className="ttm-icon-btn" aria-label="清空搜索" onClick={() => { setQuery(''); searchInput.current?.focus(); }}><Icon name="close" width={16} height={16} /></button>}</div>
        <nav className="ttm-settings-categories" aria-label="设置分类">{settingsCategories.map(item => <button key={item.id} type="button" data-guide={item.id === 'plugins' ? 'plugins' : undefined} aria-current={!words.length && category === item.id ? 'page' : undefined} onClick={() => navigate(item.id)}><Icon name={item.icon} width={17} height={17} /><span>{item.label}</span></button>)}</nav>
        {words.length ? <div className="ttm-settings-results" aria-live="polite"><h3>找到 {resultCount} 项设置</h3>
            {storyToolResults.map(item => <button type="button" className="ttm-settings-result" key={item.id} onClick={() => navigate(item.category)}>
                <span><strong>{item.title}</strong><small>{item.description}</small></span>
                <span>故事运行<Icon name="chevron" width={15} height={15} /></span>
            </button>)}
            {pluginResults.map(item => <button type="button" className="ttm-settings-result" key={item.id} onClick={() => navigate('plugins', item.id)}>
                <span><strong>{item.title}</strong><small>{item.description}</small></span>
                <span>插件<Icon name="chevron" width={15} height={15} /></span>
            </button>)}
            {results.map(field => <button type="button" className="ttm-settings-result" key={field.id} onClick={() => navigate(settingsCategoryForField(field.id))}>
                <span><strong>{settingsFieldLabels[field.id]?.title ?? field.title}</strong><small>{settingsFieldLabels[field.id]?.description ?? field.description}</small></span>
                <span>{settingsCategories.find(item => item.id === settingsCategoryForField(field.id))?.label}<Icon name="chevron" width={15} height={15} /></span>
            </button>)}
            {!resultCount && <p className="ttm-settings-note">试试“密钥”“插件权限”“应答格式”或“预加载”。</p>}
        </div> : <div className="ttm-settings-category" key={category} data-guide={category === 'plugins' ? undefined : category} data-direction={direction}>
            <header className="ttm-settings-category-heading"><h3>{categoryLabel.label}</h3><p>{categoryLabel.description}</p></header>
            {category === 'connection' && <>
                <SettingsSection title="剧情模型">
                    <StoryModelProfilesBar />
                    {renderFields(['api.chat_completion_source', 'api.custom_url', 'api.key', 'api.model'])}
                </SettingsSection>
                <SettingsSection title="生成参数与上下文">
                    {renderFields(['sampler.temperature', 'sampler.max_tokens', 'sampler.context_max_tokens'])}
                    <div className="ttm-settings-inline-bar">
                        <span>推荐：上下文 262K · 回复上限 16K · 世界书 50%</span>
                        <button type="button" className="ttm-mini-btn" onClick={() => {
                            setSchemaValues(Object.fromEntries(['sampler.context_max_tokens', 'sampler.max_tokens', 'lorebook.budget_percent', 'mvu.max_tokens']
                                .map(id => [id, fields[id].defaultValue])));
                            setStatusBanner('推荐容量已填入草稿，点击底部保存后生效。');
                        }}>填入推荐容量</button>
                    </div>
                    <SettingsDisclosure title="采样与推理高级参数">{renderFields(ids.filter(id => id.startsWith('sampler.') && !['sampler.temperature', 'sampler.max_tokens', 'sampler.context_max_tokens'].includes(id)))}</SettingsDisclosure>
                </SettingsSection>
                <button type="button" className="ttm-settings-link" onClick={() => navigate('story')}>前往「故事运行」配置额外变量解析<Icon name="arrow" width={17} height={17} /></button>
            </>}
            {category === 'story' && <>
                <MvuSettingsPanel />
                <SettingsSection title="互动页面、脚本与正则">
                    {renderFields(['sandbox.enable_html_frames', 'helper.render_depth'])}
                    <SettingsDisclosure title="酒馆助手脚本管理（全局 / 预设 / 故事）"><ScriptManagerPanel /></SettingsDisclosure>
                    <SettingsDisclosure title="正则管理（全局 / 预设 / 故事）"><RegexManagerPanel /></SettingsDisclosure>
                </SettingsSection>
                <SettingsDisclosure title="世界书触发与语义检索">
                    {renderFields(ids.filter(id => id.startsWith('lorebook.')))}
                    {renderFields(['vectors.enabled'])}<VectorConnectionFields />
                </SettingsDisclosure>
            </>}
            {category === 'reading' && <>
                <SettingsSection title="回复呈现与外观">
                    {renderFields(['api.stream'])}
                    <div className="ttm-field-card">
                        <div className="ttm-field-top"><label className="ttm-field-title" htmlFor="settings-stream-mode">流式显示方式</label></div>
                        <p className="ttm-field-desc">按当前故事保存，推荐「自动识别」；页面渲染异常时可切换为等待整段作者页面。</p>
                        <select id="settings-stream-mode" className="ttm-select-input" value={draft.streamModes[workspace.activeCharacterId] ?? workspace.streamDisplayModes[workspace.activeCharacterId] ?? 'auto'} onChange={event => {
                            const mode = event.target.value as StreamDisplayMode;
                            settingsDraftStore.setState(next => { if (mode === (workspace.streamDisplayModes[workspace.activeCharacterId] ?? 'auto')) delete next.streamModes[workspace.activeCharacterId]; else next.streamModes[workspace.activeCharacterId] = mode; });
                        }}>
                            <option value="auto">自动识别正文与作者页面</option><option value="segmented">分段显示正文与组件</option><option value="document">等待整段作者页面</option>
                        </select>
                    </div>
                    {onOpenAppearance && <button type="button" className="ttm-settings-link" onClick={onOpenAppearance}>前往外观工作台与外观包<Icon name="chevron" width={16} height={16} /></button>}
                </SettingsSection>
            </>}
            {category === 'profile' && <SettingsSection title="头像、称呼与个人特征">
                <PersonaSettings key={workspace.activeCharacterId} onSaved={() => setStatusBanner('个人资料已保存。')} />
            </SettingsSection>}
            {category === 'data' && <>
                <SettingsSection title="导入内容" description="在对应列表的更多菜单中查看详情或删除；删除故事时可选择是否一并删除附带世界书。">
                    {onOpenAssets && <div className="ttm-settings-resource-links">{([{ id: 'characters', label: '故事' }, { id: 'lorebook', label: '世界书' }, { id: 'presets', label: '预设' }] as const).map(item => <button type="button" className="ttm-settings-link" key={item.id} onClick={event => onOpenAssets(item.id, event.currentTarget)}>{item.label}<Icon name="chevron" width={16} height={16} /></button>)}</div>}
                </SettingsSection>{dataTools}
            </>}
            {category === 'sync' && <LanSyncPanel />}
            {category === 'plugins' && <>
                <NativePluginManager initialSection={pluginDestination} />
                <SettingsDisclosure title="酒馆兼容扩展"><ExtensionManager /></SettingsDisclosure>
            </>}
            {category === 'advanced' && <>
                <SettingsSection title="应用更新" description={`当前版本：TipsyIsle ${app.version}`}>
                    <div className="ttm-app-update-buttons">
                        <button type="button" className="ttm-btn-secondary" onClick={event => showCurrentReleaseNotes(event.currentTarget)}><Icon name="book" width={16} height={16} />查看当前版本日志</button>
                        {nativeAppUpdates && <button type="button" className="ttm-btn-secondary" onClick={() => void checkAppUpdate(true)}><Icon name="refresh" width={16} height={16} />检查更新</button>}
                    </div>
                </SettingsSection>
                <SettingsDisclosure title="错误日志"><DiagnosticLogPanel /></SettingsDisclosure>
                <SettingsSection title="运行诊断与作者配置" description="普通阅读通常无需打开。遇到脚本或变量问题时，可查看诊断或按作者说明调整。">{advancedTools}</SettingsSection>
                {ids.some(id => settingsCategoryForField(id) === 'advanced') && <SettingsDisclosure title="其他扩展参数">{renderFields(ids.filter(id => settingsCategoryForField(id) === 'advanced'))}</SettingsDisclosure>}
            </>}
        </div>}
        </fieldset>
        {!!changed && <div className="ttm-settings-savebar" role="region" aria-label="保存设置">
            <div className="ttm-settings-savebar-row">
                <div className="ttm-settings-savebar-status">
                    <span className="ttm-settings-dirty-dot" aria-hidden="true" />
                    <strong>{changed} 项修改待保存</strong>
                </div>
                <div className="ttm-settings-savebar-actions">
                    <button type="button" className="ttm-btn-ghost" disabled={saving} onClick={() => discardSettingsDraft()}>撤销</button>
                    <button type="button" className="ttm-btn-primary" disabled={saving || saveBlocked} onClick={() => void commitSettingsDraft()}>
                        {saving ? '保存中…' : saveBlocked ? '等待生成' : '保存'}
                    </button>
                </div>
            </div>
            {saveError && <p className="ttm-settings-savebar-error" role="alert">{saveError}</p>}
        </div>}
    </div>;
}

function VectorConnectionFields() {
    const { values, fields } = useSettingsEditor();
    return values['vectors.enabled'] ? <SchemaFormRenderer fieldIds={Object.keys(fields).filter(id => id.startsWith('vectors.') && id !== 'vectors.enabled')} fieldOverrides={settingsFieldLabels} ungrouped inlineHelpIds={new Set<string>()} /> : null;
}

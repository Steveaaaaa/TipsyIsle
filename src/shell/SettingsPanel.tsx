import { useRef, useState } from 'react';
import { SchemaFormRenderer } from '../registry/SchemaFormRenderer';
import { settingsDraftStore, discardSettingsDraft, SettingsDraftProvider, useSettingsEditor } from '../registry/settings-draft';
import { ExtensionManager } from './ExtensionManager';
import { LanSyncPanel } from './LanSyncPanel';
import type { ReactNode } from 'react';
import { workspaceStore, saveSettingsEdits, setStatusBanner } from '../store/workspace-store';
import { updateSyncOptions } from '../core/sync/engine';
import { MvuSettingsPanel } from './MvuSettingsPanel';
import { Icon } from './Icon';
import { SettingsDisclosure, SettingsSection } from './SettingsPrimitives';
import { pluginSettingsDestinations, settingsCategories, settingsCategoryForField, settingsFieldLabels, type PluginSettingsDestination, type SettingsCategory } from './settings-presentation';
import type { StreamDisplayMode } from '../pipeline/streaming-message';
import { NativePluginManager } from '../plugins/native/PluginManager';

type SettingsPanelProps = {
    advancedTools?: ReactNode; dataTools?: ReactNode; onOpenPersona?: (anchor: HTMLElement) => void;
    onOpenAppearance?: () => void; onOpenAssets?: (kind: 'characters' | 'lorebook' | 'presets', anchor: HTMLElement) => void;
    initialCategory?: SettingsCategory;
};
export function SettingsPanel(props: SettingsPanelProps) {
    return <SettingsDraftProvider><SettingsPanelContent {...props} /></SettingsDraftProvider>;
}
function SettingsPanelContent({ advancedTools, dataTools, onOpenPersona, onOpenAppearance, onOpenAssets, initialCategory = 'connection' }: SettingsPanelProps) {
    const workspace = workspaceStore.useStore();
    const { fields, setValues: setSchemaValues } = useSettingsEditor();
    const draft = settingsDraftStore.useStore();
    const [saving, setSaving] = useState(false), [saveError, setSaveError] = useState('');
    const changed = Object.keys(draft.values).length + Object.keys(draft.streamModes).length + Object.keys(draft.syncOptions).length
        + Object.keys(draft.extensions).length + Number(draft.deviceName !== undefined);
    const save = async () => {
        setSaving(true); setSaveError('');
        try {
            for (const [id, value] of Object.entries(draft.values)) if (fields[id]?.type === 'number' && (value === '' || !Number.isFinite(Number(value)))) {
                throw new Error(`请填写「${fields[id].title}」的数值。`);
            }
            if (draft.deviceName !== undefined && !draft.deviceName.trim()) throw new Error('请填写设备名称。');
            await saveSettingsEdits(draft.values, draft.streamModes, draft.extensions);
            settingsDraftStore.setState({ values: {}, streamModes: {}, extensions: {} });
            if (Object.keys(draft.syncOptions).length || draft.deviceName !== undefined) await updateSyncOptions(draft.syncOptions, draft.deviceName);
            discardSettingsDraft(); setStatusBanner('设置已保存。');
        } catch (error) { setSaveError(error instanceof Error ? error.message : String(error)); }
        finally { setSaving(false); }
    };
    const [category, setCategory] = useState<SettingsCategory>(initialCategory);
    const [pluginDestination, setPluginDestination] = useState<PluginSettingsDestination>('overview');
    const [direction, setDirection] = useState<'forward' | 'backward'>('forward');
    const [query, setQuery] = useState('');
    const searchInput = useRef<HTMLInputElement>(null);
    const categoryLabel = settingsCategories.find(item => item.id === category)!;
    const ids = Object.keys(fields);
    const renderFields = (fieldIds: string[]) => <SchemaFormRenderer fieldIds={fieldIds} fieldOverrides={settingsFieldLabels} ungrouped showDescriptions />;
    // Dedicated editors now own identity and theme; hide their legacy raw keys.
    const searchable = Object.values(fields).filter(field => !field.id.startsWith('ui.') && field.id !== 'mvu.profile');
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
    const resultCount = results.length + pluginResults.length;
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
            {pluginResults.map(item => <button type="button" className="ttm-settings-result" key={item.id} onClick={() => navigate('plugins', item.id)}>
                <span><strong>{item.title}</strong><small>{item.description}</small></span>
                <span>插件<Icon name="chevron" width={15} height={15} /></span>
            </button>)}
            {results.map(field => <button type="button" className="ttm-settings-result" key={field.id} onClick={() => navigate(settingsCategoryForField(field.id))}>
                <span><strong>{settingsFieldLabels[field.id]?.title ?? field.title}</strong><small>{settingsFieldLabels[field.id]?.description ?? field.description}</small></span>
                <span>{settingsCategories.find(item => item.id === settingsCategoryForField(field.id))?.label}<Icon name="chevron" width={15} height={15} /></span>
            </button>)}
            {!resultCount && <p className="ttm-settings-note">试试“密钥”“插件权限”“应答格式”或“渲染范围”。</p>}
        </div> : <div className="ttm-settings-category" key={category} data-guide={category === 'plugins' ? undefined : category} data-direction={direction}>
            <header className="ttm-settings-category-heading"><h3>{categoryLabel.label}</h3><p>{categoryLabel.description}</p>{category !== 'plugins' && <small>修改后点击底部保存。关闭面板会保留本次草稿；刷新页面前请先保存。</small>}</header>
            {category === 'connection' && <>
                <SettingsSection title="剧情模型" description="先填写接口、地址、密钥和模型名称。使用第三方中转时，按服务商提供的信息填写。">
                    {renderFields(['api.chat_completion_source', 'api.custom_url', 'api.key', 'api.model'])}
                </SettingsSection>
                <SettingsSection title="回复与上下文" description="按模型能力设置生成参数；选用导入的预设时，可能带入该预设的参数。">
                    {renderFields(['sampler.temperature', 'sampler.max_tokens', 'sampler.context_max_tokens'])}
                    <p className="ttm-settings-note">推荐容量：上下文 262,144、回复上限 16,384、世界书占比 50%、额外变量解析回复上限 8,192 Token。</p>
                    <button type="button" className="ttm-btn-secondary" onClick={() => {
                        setSchemaValues(Object.fromEntries(['sampler.context_max_tokens', 'sampler.max_tokens', 'lorebook.budget_percent', 'mvu.max_tokens']
                            .map(id => [id, fields[id].defaultValue])));
                        setStatusBanner('推荐容量已填入草稿，点击底部保存后生效。');
                    }}>使用推荐容量</button>
                </SettingsSection>
                <button type="button" className="ttm-settings-link" onClick={() => navigate('story')}>配置额外模型解析<Icon name="arrow" width={17} height={17} /></button>
                <SettingsDisclosure title="采样与推理的高级参数">{renderFields(ids.filter(id => id.startsWith('sampler.') && !['sampler.temperature', 'sampler.max_tokens', 'sampler.context_max_tokens'].includes(id)))}</SettingsDisclosure>
            </>}
            {category === 'story' && <>
                <MvuSettingsPanel />
                <SettingsSection title="作者互动页面" description="封面、状态栏和交互按钮依赖这些能力。优先遵循故事作者的说明。">{renderFields(['helper.render_depth', 'sandbox.enable_html_frames'])}</SettingsSection>
                <SettingsDisclosure title="世界书触发与语义检索">
                    {renderFields(ids.filter(id => id.startsWith('lorebook.')))}
                    {renderFields(['vectors.enabled'])}<VectorConnectionFields />
                </SettingsDisclosure>
            </>}
            {category === 'reading' && <SettingsSection title="回复生成时的呈现方式" description="流式输出开关用于模型请求；显示方式按当前故事保存，不改变作者正则、脚本或原始回复。">
                {renderFields(['api.stream'])}
                <label className="ttm-asset-field-label" htmlFor="settings-stream-mode">流式显示方式</label><select id="settings-stream-mode" className="ttm-select-input" value={draft.streamModes[workspace.activeCharacterId] ?? workspace.streamDisplayModes[workspace.activeCharacterId] ?? 'auto'} onChange={event => {
                    const mode = event.target.value as StreamDisplayMode;
                    settingsDraftStore.setState(next => { if (mode === (workspace.streamDisplayModes[workspace.activeCharacterId] ?? 'auto')) delete next.streamModes[workspace.activeCharacterId]; else next.streamModes[workspace.activeCharacterId] = mode; });
                }}>
                    <option value="auto">自动识别正文与作者页面</option><option value="segmented">分段显示正文与组件</option><option value="document">等待整段作者页面</option>
                </select>
                <p className="ttm-settings-note">推荐自动识别。普通正文逐步显示；需要完整内容的作者页面等待生成完成后呈现。若某个故事显示异常，可手动选择等待整段作者页面。</p>
                {onOpenAppearance && <button type="button" className="ttm-settings-link" onClick={onOpenAppearance}>打开外观工作台<Icon name="arrow" width={17} height={17} /></button>}
            </SettingsSection>}
            {category === 'profile' && <SettingsSection title="头像、称呼与个人特征" description="称呼对应故事中的 {{user}}，外貌、性格等用于补充故事中的自己。故事专属资料优先，未设置时使用全局默认，两份不会叠加。">
                {onOpenPersona && <button type="button" className="ttm-btn-secondary" onClick={event => onOpenPersona(event.currentTarget)}>编辑个人资料</button>}
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
                <SettingsSection title="运行诊断与作者配置" description="普通阅读通常无需打开。遇到脚本或变量问题时，可查看诊断或按作者说明调整。">{advancedTools}</SettingsSection>
                {ids.some(id => settingsCategoryForField(id) === 'advanced') && <SettingsDisclosure title="其他扩展参数">{renderFields(ids.filter(id => settingsCategoryForField(id) === 'advanced'))}</SettingsDisclosure>}
            </>}
        </div>}
        </fieldset>
        {!!changed && <div className="ttm-settings-savebar" role="region" aria-label="保存设置">
            <div><strong>{changed} 项修改待保存</strong><small>保存后用于后续运行</small>{saveError && <p role="alert">{saveError}</p>}</div>
            <button type="button" className="ttm-btn-secondary" disabled={saving} onClick={() => { discardSettingsDraft(); setSaveError(''); }}>放弃修改</button>
            <button type="button" className="ttm-btn-primary" disabled={saving || workspace.isGenerating || workspace.helperGenerationCount > 0} onClick={() => void save()}>{saving ? '正在保存…' : workspace.isGenerating || workspace.helperGenerationCount > 0 ? '生成结束后保存' : '保存设置'}</button>
        </div>}
    </div>;
}

function VectorConnectionFields() {
    const { values, fields } = useSettingsEditor();
    return values['vectors.enabled'] ? <SchemaFormRenderer fieldIds={Object.keys(fields).filter(id => id.startsWith('vectors.') && id !== 'vectors.enabled')} fieldOverrides={settingsFieldLabels} ungrouped showDescriptions /> : null;
}

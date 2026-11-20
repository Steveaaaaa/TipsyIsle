import { SchemaFormRenderer } from '../registry/SchemaFormRenderer';
import { useSettingsEditor } from '../registry/settings-draft';
import { workspaceStore, getActiveCharacter, getAvailableWorldbooks, getCharacterWorldbooks } from '../store/workspace-store';
import { resolveMvuSettings, readMvuCharacterSettings } from '../pipeline/mvu-settings';
import { isNativeRuntime } from '../core/native-runtime';
import { resolveMvuConnection } from '../compatibility/mvu-connection';
import { ModelConnectionManager } from './ModelConnectionManager';
import { SettingsDisclosure, SettingsSection } from './SettingsPrimitives';
import { settingsFieldLabels } from './settings-presentation';

export function MvuSettingsPanel() {
    const { values, setValue: setSchemaValue, setValues: setSchemaValues } = useSettingsEditor();
    const workspace = workspaceStore.useStore();
    const bookName = getCharacterWorldbooks(getActiveCharacter(workspace), workspace).primary;
    const book = getAvailableWorldbooks(workspace).find(item => item.name === bookName);
    const { override } = readMvuCharacterSettings(book);
    const effective = resolveMvuSettings(values, book);
    const extra = effective.settings['mvu.mode'] === '额外模型解析';
    const selected = String(values['mvu.profile'] ?? '');
    const native = isNativeRuntime();
    let profiles: Array<{ 名称: string }> = [], profileError = '';
    try { const parsed = JSON.parse(String(values['mvu.profiles'] || '[]')); if (Array.isArray(parsed)) profiles = parsed; else profileError = '连接方案需要是 JSON 数组。'; }
    catch { profileError = '连接方案数据无法读取，可在下方高级选项中修正。'; }
    let summary = '', connectionError = '', connectionSettings = values;
    try {
        const connection = resolveMvuConnection(effective.settings);
        connectionSettings = connection.settings;
        const inherited = connection.settings['mvu.source'] === '与插头相同';
        summary = `${inherited ? '沿用剧情连接' : selected ? `方案「${selected}」` : '独立连接'} · ${connection.api.model || '尚未填写模型名称'}`;
    } catch (error) { connectionError = error instanceof Error ? error.message : String(error); }
    const source = String(connectionSettings['mvu.source'] ?? '与插头相同');
    const fields = (fieldIds: string[], disabled = false) => <SchemaFormRenderer fieldIds={fieldIds} fieldOverrides={settingsFieldLabels} ungrouped showDescriptions disabled={disabled} displayValues={disabled ? connectionSettings : undefined} />;
    const profileFields = ['source', 'protocol', 'url', 'key', 'model', 'provider', 'auth_type', 'provider_api', 'thinking', 'context_window', 'temperature', 'frequency_penalty', 'presence_penalty', 'top_p', 'top_k', 'max_tokens', 'headers', 'include_body', 'exclude_body', 'prompt_strategy', 'preset', 'random_header', 'format', 'disable_thinking', 'pseudo_stream'];
    const editProfile = () => setSchemaValues({ ...Object.fromEntries(profileFields.map(id => [`mvu.${id}`, connectionSettings[`mvu.${id}`]])), 'mvu.profile': '' });
    const profileCovered = new Set(profileFields.map(id => `mvu.${id}`));
    const taskFields = ['mvu.prompt_strategy', ...(connectionSettings['mvu.prompt_strategy'] === '使用其他预设' ? ['mvu.preset'] : []), 'mvu.history', 'mvu.max_tokens', 'mvu.request_mode', 'mvu.attempts', 'mvu.min_chars', 'mvu.trigger', 'mvu.whitelist', 'mvu.blacklist', 'mvu.task'];

    return <SettingsSection title="变量更新 · MVU" description="用于更新人物状态、物品、数值和关系。这里修改全局默认；故事自带的作者配置有优先权。">
        {fields(['mvu.mode'])}
        <div className="ttm-settings-effective"><strong>保存后的运行方式</strong><span>{extra ? '使用额外模型解析' : '随剧情回复更新'}</span>
            {override.更新方式 !== undefined && <small>更新方式由当前故事的作者配置指定；上方全局默认仍会保存，供未覆盖此项的故事使用。</small>}
            {override.额外模型解析配置?.启用自动请求 !== undefined && <small>自动请求由当前故事指定为{effective.settings['mvu.automatic'] ? '开启' : '关闭'}。</small>}
        </div>
        {effective.warnings.map(warning => <p className="ttm-settings-error" role="status" key={warning}>{warning}</p>)}
        {extra && <>
            {fields(['mvu.automatic'])}
            {(profiles.length > 0 || selected) && <div className="ttm-field-card"><label className="ttm-field-title" htmlFor="settings-mvu-profile">已保存的解析连接</label>
                <select id="settings-mvu-profile" className="ttm-select-input" value={selected} onChange={event => setSchemaValue('mvu.profile', event.target.value)}>
                    <option value="">手动配置 / 沿用剧情连接</option>{profiles.map(profile => <option key={profile.名称} value={profile.名称}>{profile.名称}</option>)}
                    {selected && !profiles.some(profile => profile.名称 === selected) && <option value={selected}>{selected}（未找到方案）</option>}
                </select></div>}
            {(profileError || connectionError) && <p className="ttm-settings-error" role="alert">{profileError || connectionError}</p>}
            {selected && <p className="ttm-settings-note">当前显示方案实际使用的连接和参数。<button type="button" className="ttm-settings-inline-link" onClick={editProfile}>编辑这份方案</button></p>}
            {fields(['mvu.source'], !!selected)}
            {source === '与插头相同' && !selected && <p className="ttm-settings-note">直接使用「模型连接」中的 API 地址、密钥和模型，无需再填一遍。</p>}
            {source === '自定义' && <div className="ttm-settings-connection-fields">{fields(['mvu.protocol', 'mvu.url', 'mvu.key', 'mvu.model'], !!selected)}</div>}
            {source === '更多' && <div className="ttm-settings-connection-fields">
                <p className="ttm-settings-note">通过多服务商接入库连接模型；无需了解其内部名称。账号授权和模型目录需要本机网页网关支持。</p>
                {native ? <p className="ttm-settings-note">当前安装版不提供本机网关的账号授权入口。使用第三方 API 时，可选择“单独配置 API”填写地址与密钥。</p> : !selected && <ModelConnectionManager section="provider" />}
                {fields([...(native || selected ? ['mvu.provider'] : []), 'mvu.auth_type', 'mvu.model', 'mvu.url', ...(connectionSettings['mvu.auth_type'] === 'oauth' ? [] : ['mvu.key'])], !!selected)}
                <SettingsDisclosure title="服务商协议与推理设置">{fields(['mvu.provider_api', 'mvu.thinking', 'mvu.context_window'], !!selected)}</SettingsDisclosure>
            </div>}
            {summary && <p className="ttm-settings-connection-summary"><strong>解析连接</strong><span>{summary}</span></p>}
            {fields(['mvu.format', 'mvu.random_header'], !!selected)}
            <SettingsDisclosure title="保存与管理解析连接方案"><ModelConnectionManager section="profiles" /></SettingsDisclosure>
            <SettingsDisclosure title="解析任务、长度与重试">
                {taskFields.map(id => <SchemaFormRenderer key={id} fieldIds={[id]} fieldOverrides={settingsFieldLabels} ungrouped showDescriptions
                    disabled={!!selected && profileCovered.has(id)} displayValues={selected ? connectionSettings : undefined} />)}
                <p className="ttm-settings-note">方案可覆盖提示词来源等参数。若要更改方案参数，先选择“编辑这份方案”，修改后以同名保存。</p>
            </SettingsDisclosure>
            <SettingsDisclosure title="解析请求的高级参数">
                {fields(['mvu.disable_thinking', 'mvu.pseudo_stream'], !!selected)}
                {source !== '与插头相同' && fields(['mvu.temperature', 'mvu.top_p', 'mvu.top_k', 'mvu.frequency_penalty', 'mvu.presence_penalty', 'mvu.headers', 'mvu.include_body', 'mvu.exclude_body'], !!selected)}
                {fields(['mvu.profiles'])}
            </SettingsDisclosure>
        </>}
        {!extra && <p className="ttm-settings-note">变量更新内容随剧情回复返回，不会单独发起额外解析请求。将更新方式改为“使用额外模型解析”后，可在这里设置独立 API 地址和密钥。</p>}
        <SettingsDisclosure title="通知与作者兼容选项">{fields(['mvu.notify_loading', 'mvu.notify_initialized', 'mvu.notify_error', 'mvu.notify_analysis', 'mvu.update_chat', 'mvu.sendas_assistant'])}</SettingsDisclosure>
    </SettingsSection>;
}

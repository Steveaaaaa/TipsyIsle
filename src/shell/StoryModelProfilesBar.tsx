import { useEffect, useMemo, useState } from 'react';
import {
    defaultParametersForSource,
    parseConnectionProfiles,
    profileFromSettings,
    removeConnectionProfile,
    serializeConnectionProfiles,
    settingsPatchFromProfile,
    suggestConnectionProfileName,
    upsertConnectionProfile,
} from '../core/model-profiles';
import { useSettingsEditor } from '../registry/settings-draft';

const REASONING_LABELS: Record<string, string> = {
    auto: '自动', low: '轻量', medium: '均衡', high: '深度', max: '极限',
};
const POST_PROCESS_LABELS: Record<string, string> = {
    auto: '跟随预设', none: '无', merge: '合并同角色', merge_tools: '合并同角色(工具)',
    semi: 'Semi-strict', semi_tools: 'Semi-strict(工具)', strict: 'Strict', strict_tools: 'Strict(工具)', single: '单条用户消息',
};
const SYSPROMPT_LABELS: Record<string, string> = {
    auto: '跟随预设(默认开)', on: '开启', off: '关闭(全转User)',
};

export function StoryModelProfilesBar() {
    const { values, editing, setValues } = useSettingsEditor();
    const profiles = useMemo(() => parseConnectionProfiles(values['api.connection_profiles']), [values]);
    const activeId = String(values['api.active_profile'] ?? '');
    const activeProfile = useMemo(() => profiles.find(item => item.id === activeId), [profiles, activeId]);
    const [nameInput, setNameInput] = useState(activeProfile?.name ?? '');
    const [feedback, setFeedback] = useState('');

    useEffect(() => {
        setNameInput(activeProfile?.name ?? '');
    }, [activeProfile?.id, activeProfile?.name]);

    const selectProfile = (id: string) => {
        setFeedback('');
        if (!id) {
            setValues({ 'api.active_profile': '' });
            setNameInput('');
            return;
        }
        const target = profiles.find(item => item.id === id);
        if (!target) return;
        setValues(settingsPatchFromProfile(target));
        setNameInput(target.name);
        setFeedback(editing ? `已载入渠道「${target.name}」到草稿，点击底部保存后生效。` : `已切换到渠道「${target.name}」。`);
    };

    const saveProfile = (asNew: boolean) => {
        const label = nameInput.trim() || suggestConnectionProfileName(values);
        const targetId = asNew ? undefined : activeProfile?.id;
        const created = profileFromSettings(label, values, targetId);
        const nextProfiles = upsertConnectionProfile(profiles, created);
        const stored = nextProfiles.find(item => item.name === created.name) ?? created;
        setValues({
            ...settingsPatchFromProfile(stored),
            'api.connection_profiles': serializeConnectionProfiles(nextProfiles),
        });
        setNameInput(stored.name);
        setFeedback(editing
            ? `已将渠道「${stored.name}」写入草稿（含推理强度、后处理与原厂 System 通道），点击底部保存生效。`
            : `已保存渠道「${stored.name}」。`);
    };

    const startFreshChannel = () => {
        const defaults = defaultParametersForSource(String(values['api.chat_completion_source'] ?? 'openai'));
        setValues({
            'api.active_profile': '',
            'api.chat_completion_source': defaults.source,
            'api.custom_url': defaults.baseUrl,
            'api.key': '',
            'api.model': defaults.model,
            'sampler.reasoning_effort': defaults.reasoningEffort,
            'sampler.prompt_post_processing': defaults.promptPostProcessing,
            'sampler.use_sysprompt': defaults.useSystemPrompt,
        });
        setNameInput('');
        setFeedback('已填入当前协议的默认合理参数，填写地址与密钥后即可存为新渠道。');
    };

    const deleteCurrent = () => {
        if (!activeProfile) return;
        const nextProfiles = removeConnectionProfile(profiles, activeProfile.id);
        setValues({
            'api.connection_profiles': serializeConnectionProfiles(nextProfiles),
            'api.active_profile': '',
        });
        setNameInput('');
        setFeedback(editing ? `已将渠道「${activeProfile.name}」从草稿移除，点击底部保存生效。` : `已删除渠道「${activeProfile.name}」。`);
    };

    const reasoning = String(values['sampler.reasoning_effort'] ?? 'auto');
    const postProcess = String(values['sampler.prompt_post_processing'] ?? 'auto');
    const useSysPrompt = String(values['sampler.use_sysprompt'] ?? 'auto');

    return (
        <div className="ttm-profile-bar" aria-label="模型渠道管理">
            <div className="ttm-profile-bar-row">
                <label className="ttm-profile-bar-field" htmlFor="story-model-profile-select">
                    <span>已保存渠道</span>
                    <select
                        id="story-model-profile-select"
                        className="ttm-select-input"
                        value={activeProfile?.id ?? ''}
                        onChange={event => selectProfile(event.target.value)}
                    >
                        <option value="">手动配置（未关联渠道）</option>
                        {profiles.map(profile => (
                            <option key={profile.id} value={profile.id}>
                                {profile.name}（{profile.model || profile.source}）
                            </option>
                        ))}
                    </select>
                </label>
                <label className="ttm-profile-bar-field" htmlFor="story-model-profile-name">
                    <span>渠道名称</span>
                    <input
                        id="story-model-profile-name"
                        className="ttm-text-input"
                        type="text"
                        placeholder="留空则按模型名自动命名"
                        value={nameInput}
                        onChange={event => setNameInput(event.target.value)}
                    />
                </label>
            </div>
            <div className="ttm-profile-bar-actions">
                {activeProfile && (
                    <button type="button" className="ttm-mini-btn" onClick={() => saveProfile(false)}>
                        更新当前渠道
                    </button>
                )}
                <button type="button" className="ttm-mini-btn" onClick={() => saveProfile(true)}>
                    存为新渠道
                </button>
                <button type="button" className="ttm-mini-btn" onClick={startFreshChannel}>
                    新建默认渠道
                </button>
                {activeProfile && (
                    <button type="button" className="ttm-mini-btn" onClick={deleteCurrent}>
                        删除渠道
                    </button>
                )}
            </div>
            <p className="ttm-settings-note">
                渠道一并保存：推理强度（{REASONING_LABELS[reasoning] ?? reasoning}）· 后处理（{POST_PROCESS_LABELS[postProcess] ?? postProcess}）· 原厂 System 通道（{SYSPROMPT_LABELS[useSysPrompt] ?? useSysPrompt}），可在下方「采样与推理的高级参数」调整后更新。
            </p>
            {feedback && <p className="ttm-profile-bar-feedback" role="status">{feedback}</p>}
        </div>
    );
}

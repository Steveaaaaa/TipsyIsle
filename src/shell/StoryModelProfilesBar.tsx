import { useEffect, useMemo, useState } from 'react';
import {
    PROFILE_OWNED_SETTING_KEYS,
    defaultParametersForSource,
    findMatchingConnectionProfile,
    parseConnectionProfiles,
    profileFromSettings,
    removeConnectionProfile,
    serializeConnectionProfiles,
    settingsPatchFromProfile,
    suggestConnectionProfileName,
    upsertConnectionProfile,
} from '../core/model-profiles';
import { settingsDraftStore, useSettingsEditor } from '../registry/settings-draft';
import { saveSettingsEdits, setStatusBanner, workspaceStore } from '../store/workspace-store';

export function StoryModelProfilesBar() {
    const workspace = workspaceStore.useStore();
    const draft = settingsDraftStore.useStore();
    const { values, editing, setValues } = useSettingsEditor();
    const profiles = useMemo(() => parseConnectionProfiles(values['api.connection_profiles']), [values]);
    const activeId = String(values['api.active_profile'] ?? '');
    const activeProfile = useMemo(() => profiles.find(item => item.id === activeId), [profiles, activeId]);
    const matchedProfile = useMemo(
        () => activeProfile ? undefined : findMatchingConnectionProfile(profiles, values),
        [activeProfile, profiles, values],
    );
    const effectiveProfile = activeProfile ?? matchedProfile;
    const selectedProfileId = effectiveProfile?.id ?? '';

    const [namingMode, setNamingMode] = useState<'closed' | 'create' | 'rename'>('closed');
    const [nameInput, setNameInput] = useState('');
    const [busy, setBusy] = useState(false);
    const [feedback, setFeedback] = useState('');

    useEffect(() => {
        if (namingMode === 'rename') setNameInput(effectiveProfile?.name ?? '');
    }, [namingMode, effectiveProfile?.name]);

    const commitImmediate = async (patch: Record<string, unknown>, message: string) => {
        setFeedback('');
        if (!editing) {
            setValues(patch);
            setFeedback(message);
            return;
        }
        if (workspace.isGenerating || workspace.helperGenerationCount > 0) {
            setValues(patch);
            setFeedback('当前正在生成回复，已写入草稿；生成结束后点底部保存生效。');
            return;
        }
        setBusy(true);
        try {
            await saveSettingsEdits(patch, {}, {});
            settingsDraftStore.setState(state => {
                for (const key of Object.keys(patch)) delete state.values[key];
            });
            setFeedback(message);
            setStatusBanner(message);
        } catch (error) {
            setFeedback(error instanceof Error ? error.message : String(error));
        } finally {
            setBusy(false);
        }
    };

    const selectProfile = (id: string) => {
        setNamingMode('closed');
        if (!id) {
            void commitImmediate({ 'api.active_profile': '' }, '已切换为手动直连，保留当前填写的地址与模型。');
            return;
        }
        const target = profiles.find(item => item.id === id);
        if (!target) return;
        void commitImmediate(settingsPatchFromProfile(target), `已切换到渠道「${target.name}」，连接参数已立即生效。`);
    };

    const saveProfile = (asNew: boolean, customLabel?: string) => {
        const label = (customLabel ?? nameInput).trim() || suggestConnectionProfileName(values);
        const targetId = asNew ? undefined : effectiveProfile?.id;
        const created = profileFromSettings(label, values, targetId);
        const nextProfiles = upsertConnectionProfile(profiles, created);
        const stored = nextProfiles.find(item => item.id === created.id || item.name === created.name) ?? created;
        setNamingMode('closed');
        void commitImmediate(
            {
                ...settingsPatchFromProfile(stored),
                'api.connection_profiles': serializeConnectionProfiles(nextProfiles),
            },
            asNew ? `已保存新渠道「${stored.name}」并立即接管当前连接。` : `已更新渠道「${stored.name}」。`,
        );
    };

    const startFreshChannel = () => {
        setNamingMode('closed');
        const defaults = defaultParametersForSource(String(values['api.chat_completion_source'] ?? 'openai'));
        void commitImmediate(
            {
                'api.active_profile': '',
                'api.chat_completion_source': defaults.source,
                'api.custom_url': defaults.baseUrl,
                'api.key': '',
                'api.model': defaults.model,
                'sampler.reasoning_effort': defaults.reasoningEffort,
                'sampler.prompt_post_processing': defaults.promptPostProcessing,
                'sampler.use_sysprompt': defaults.useSystemPrompt,
            },
            '已切回空白直连，填写地址与密钥后可存为新渠道。',
        );
    };

    const deleteCurrent = () => {
        if (!effectiveProfile) return;
        const nextProfiles = removeConnectionProfile(profiles, effectiveProfile.id);
        setNamingMode('closed');
        void commitImmediate(
            {
                'api.connection_profiles': serializeConnectionProfiles(nextProfiles),
                'api.active_profile': '',
            },
            `已删除渠道「${effectiveProfile.name}」，保留当前连接参数。`,
        );
    };

    const openNaming = (mode: 'create' | 'rename') => {
        setFeedback('');
        setNameInput(mode === 'rename' ? (effectiveProfile?.name ?? '') : suggestConnectionProfileName(values));
        setNamingMode(mode);
    };

    const hasDraftChannelEdits = Boolean(
        effectiveProfile && PROFILE_OWNED_SETTING_KEYS.some(key => key in draft.values),
    );

    return (
        <div className="ttm-profile-bar" aria-label="模型渠道管理" aria-busy={busy}>
            <div className="ttm-profile-bar-header">
                <label className="ttm-field-title" htmlFor="story-model-profile-select">当前连接渠道</label>
                <span className={`ttm-profile-status${effectiveProfile ? ' is-active' : ''}`}>
                    {effectiveProfile ? `已接管 · ${effectiveProfile.name}` : profiles.length ? '未绑定渠道' : '尚未保存渠道'}
                </span>
            </div>
            <div className="ttm-profile-bar-main">
                <select
                    id="story-model-profile-select"
                    className="ttm-select-input"
                    disabled={busy}
                    value={selectedProfileId}
                    onChange={event => selectProfile(event.target.value)}
                >
                    <option value="">手动直连（不关联已保存渠道）</option>
                    {profiles.map(profile => {
                        const name = profile.name.trim();
                        const detail = (profile.model || profile.source || '').trim();
                        const display = detail && detail.toLocaleLowerCase() !== name.toLocaleLowerCase()
                            ? `${name} · ${detail}`
                            : name;
                        return <option key={profile.id} value={profile.id}>{display}</option>;
                    })}
                </select>
            </div>
            <div className="ttm-profile-bar-actions">
                {effectiveProfile ? (
                    <>
                        {hasDraftChannelEdits && (
                            <button type="button" className="ttm-mini-btn is-accent" disabled={busy} onClick={() => saveProfile(false, effectiveProfile.name)}>
                                更新到「{effectiveProfile.name}」
                            </button>
                        )}
                        <button type="button" className="ttm-mini-btn" disabled={busy} onClick={() => openNaming('rename')}>
                            重命名
                        </button>
                        <button type="button" className="ttm-mini-btn" disabled={busy} onClick={() => openNaming('create')}>
                            另存新渠道
                        </button>
                        <button type="button" className="ttm-mini-btn" disabled={busy} onClick={startFreshChannel}>
                            新建空白连接
                        </button>
                        <button type="button" className="ttm-mini-btn" disabled={busy} onClick={deleteCurrent}>
                            删除渠道
                        </button>
                    </>
                ) : (
                    <>
                        <button type="button" className="ttm-mini-btn" disabled={busy} onClick={() => openNaming('create')}>
                            保存当前连接为渠道
                        </button>
                        {profiles.length > 0 && (
                            <button type="button" className="ttm-mini-btn is-accent" disabled={busy} onClick={() => selectProfile(profiles[0].id)}>
                                启用「{profiles[0].name}」
                            </button>
                        )}
                    </>
                )}
            </div>
            {namingMode !== 'closed' && (
                <div className="ttm-profile-name-row">
                    <input
                        id="story-model-profile-name"
                        className="ttm-text-input"
                        type="text"
                        placeholder="输入渠道名称（留空则按模型名命名）"
                        value={nameInput}
                        disabled={busy}
                        onChange={event => setNameInput(event.target.value)}
                    />
                    <button
                        type="button"
                        className="ttm-mini-btn is-accent"
                        disabled={busy}
                        onClick={() => saveProfile(namingMode === 'create')}
                    >
                        {namingMode === 'rename' ? '确认改名' : '保存并接管'}
                    </button>
                    <button type="button" className="ttm-mini-btn" disabled={busy} onClick={() => setNamingMode('closed')}>
                        取消
                    </button>
                </div>
            )}
            {feedback && <p className="ttm-profile-bar-feedback" role="status">{feedback}</p>}
        </div>
    );
}

import { useEffect, useState } from 'react';
import { useSettingsEditor } from '../registry/settings-draft';

interface Provider { id: string; name: string; oauth: boolean }
interface Login {
    id: string; provider: string; status: string; error?: string;
    events: Array<{ type: string; message?: string; url?: string; instructions?: string; verificationUri?: string; userCode?: string }>;
    prompt?: { id: string; type: string; message: string; placeholder?: string; options?: Array<{ id: string; label: string }> };
}
async function auth(action: string, body: object = {}) {
    const response = await fetch(`/api/tipsy-isle/llm/auth/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const result = await response.json(); if (!response.ok) throw new Error(result.error ?? '模型授权操作失败'); return result;
}
const safeLink = (url?: string) => url && /^https?:\/\//i.test(url) ? url : undefined;

export function ModelConnectionManager({ section = 'all', disabled = false }: { section?: 'all' | 'provider' | 'profiles'; disabled?: boolean }) {
    const { values, editing, setValue: setSchemaValue, setValues: setSchemaValues } = useSettingsEditor();
    const [providers, setProviders] = useState<Provider[]>([]);
    const [credentials, setCredentials] = useState<string[]>([]), [login, setLogin] = useState<Login>();
    const [answer, setAnswer] = useState(''), [name, setName] = useState(''), [feedback, setFeedback] = useState(''), [busy, setBusy] = useState(false);
    const provider = String(values['mvu.provider'] ?? 'openai');
    const refresh = async () => {
        const result = await auth('status'); setProviders(result.providers);
        setCredentials(result.credentials.filter((item: { type: string }) => item.type === 'oauth').map((item: { providerId: string }) => item.providerId));
    };
    const run = async (operation: () => Promise<void>) => {
        setBusy(true); setFeedback('');
        try { await operation(); } catch (error) { setFeedback(error instanceof Error ? error.message : String(error)); }
        finally { setBusy(false); }
    };
    useEffect(() => {
        if (login?.status !== 'pending') return;
        let disposed = false;
        const timer = setTimeout(() => { void auth('poll', { id: login.id }).then(next => {
            if (disposed) return;
            setLogin(next);
            if (next.status === 'complete') { setFeedback('授权已保存。认证方式选择“已授权账号”后即可使用。'); void refresh().catch(error => setFeedback(String(error))); }
        }).catch(error => { if (!disposed) { setFeedback(String(error)); setLogin(previous => previous ? { ...previous, status: 'failed' } : undefined); } }); }, 1500);
        return () => { disposed = true; clearTimeout(timer); };
    }, [login]);
    useEffect(() => { setAnswer(''); }, [login?.prompt?.id]);
    const profiles = (() => { try { const data = JSON.parse(String(values['mvu.profiles'] || '[]')); return Array.isArray(data) ? data : []; } catch { return []; } })();
    const saveProfile = async () => {
        const label = name.trim(); if (!label) throw new Error('请填写方案名称');
        const parsed = JSON.parse(String(values['mvu.profiles'] || '[]')); if (!Array.isArray(parsed)) throw new Error('请先修正连接方案 JSON');
        const pi = values['mvu.source'] === '更多';
        if (!pi && values['mvu.source'] !== '自定义') throw new Error('请先选择“单独配置 API”或“其他服务商与账号授权”，填写连接信息');
        const profile = { 名称: label, backend: pi ? 'pi' : 'custom', api地址: values['mvu.url'], 密钥: pi && values['mvu.auth_type'] === 'oauth' ? '' : values['mvu.key'], 模型名称: values['mvu.model'],
            request: Object.fromEntries(['protocol', 'temperature', 'frequency_penalty', 'presence_penalty', 'top_p', 'top_k', 'max_tokens', 'headers', 'include_body', 'exclude_body'].map(key => [key, values[`mvu.${key}`]])),
            破限方案: values['mvu.prompt_strategy'], 其他预设名称: values['mvu.preset'], 随机头部: values['mvu.random_header'], 应答格式: values['mvu.format'], 关闭thinking: values['mvu.disable_thinking'], 兼容假流式: values['mvu.pseudo_stream'],
            ...(pi ? { pi: { provider, api: values['mvu.provider_api'], authType: values['mvu.auth_type'], endpoint: values['mvu.url'], model: values['mvu.model'],
                contextWindow: values['mvu.context_window'], thinkingLevel: values['mvu.thinking'], customHeaders: values['mvu.headers'], customIncludeBody: values['mvu.include_body'], customExcludeBody: values['mvu.exclude_body'] } } : {}) };
        setSchemaValues({ 'mvu.profiles': JSON.stringify([...parsed.filter(item => item.名称 !== label), profile], null, 2), 'mvu.profile': label });
        setFeedback(editing ? `已将方案「${label}」加入草稿，请点击底部保存。` : `已保存并选用方案「${label}」。`);
    };
    return <fieldset className="ttm-panel-block ttm-settings-fields" disabled={disabled}>
        {section !== 'profiles' && <>
        <p className="ttm-asset-help">选择服务商，或按服务商提供的步骤登录账号；模型列表在下方模型名称旁获取。授权保存在本机网页网关。</p>
        <button className="ttm-mini-btn" disabled={busy} onClick={() => void run(refresh)}>读取服务商和授权状态</button>
        <label htmlFor="mvu-provider-select">服务商</label>
        <select id="mvu-provider-select" className="ttm-select-input" value={provider} disabled={busy || login?.status === 'pending'} onChange={event => {
            setSchemaValues({ 'mvu.provider': event.target.value, 'mvu.provider_api': '', 'mvu.url': '' });
        }}>
            {!providers.length && <option value={provider}>{provider}</option>}
            {providers.map(item => <option value={item.id} key={item.id}>{item.name}{credentials.includes(item.id) ? '（已授权）' : ''}</option>)}
        </select>
        <button className="ttm-mini-btn" disabled={busy || login?.status === 'pending' || !providers.find(item => item.id === provider)?.oauth} onClick={() => void run(async () => { setLogin(await auth('start', { provider })); })}>授权账号</button>
        <button className="ttm-mini-btn" disabled={busy || login?.status === 'pending' || !credentials.includes(provider)} onClick={() => void run(async () => { await auth('logout', { provider }); await refresh(); setFeedback('已移除本机授权。'); })}>移除授权</button>
        {login && <div aria-live="polite">
            {login.events.slice(-4).map((event, index) => <p key={index}>{event.message || event.instructions}
                {safeLink(event.url ?? event.verificationUri) && <a href={safeLink(event.url ?? event.verificationUri)} target="_blank" rel="noreferrer">打开服务商授权页面</a>}
                {event.userCode && <>授权码：<strong>{event.userCode}</strong></>}
            </p>)}
            {login.prompt && <form onSubmit={event => { event.preventDefault(); void run(async () => { setLogin(await auth('answer', { id: login.id, promptId: login.prompt!.id, value: answer })); }); }}>
                <label htmlFor="mvu-auth-answer">{login.prompt.message}</label>
                {login.prompt.type === 'select' ? <select id="mvu-auth-answer" className="ttm-select-input" required value={answer} onChange={event => setAnswer(event.target.value)}><option value="">请选择</option>{login.prompt.options?.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select>
                    : <input id="mvu-auth-answer" className="ttm-text-input" required type={login.prompt.type === 'secret' ? 'password' : 'text'} value={answer} placeholder={login.prompt.placeholder} onChange={event => setAnswer(event.target.value)} />}
                <button className="ttm-mini-btn" disabled={busy || !answer.trim()} type="submit">提交授权信息</button>
            </form>}
            {login.status === 'pending' && <button className="ttm-mini-btn" disabled={busy} onClick={() => void run(async () => { setLogin(await auth('cancel', { id: login.id })); })}>取消授权</button>}
            {login.error && <p role="alert">{login.error}</p>}
        </div>}
        </>}
        {section !== 'provider' && <>
        <p className="ttm-asset-help">给已填写的独立解析连接取一个名字，下次可以直接选择；同名保存会更新方案。</p>
        <label htmlFor="mvu-profile-select">当前方案</label>
        <select id="mvu-profile-select" className="ttm-select-input" value={String(values['mvu.profile'] ?? '')} onChange={event => setSchemaValue('mvu.profile', event.target.value)}>
            <option value="">使用手动配置</option>{profiles.map(profile => <option key={profile.名称} value={profile.名称}>{profile.名称}</option>)}
        </select>
        <label htmlFor="mvu-profile-name">保存方案名称</label>
        <input id="mvu-profile-name" className="ttm-text-input" value={name} onChange={event => setName(event.target.value)} placeholder="同名方案会被更新" />
        <button className="ttm-mini-btn" disabled={busy || !name.trim() || !!values['mvu.profile']} onClick={() => void run(saveProfile)}>保存当前手动配置</button>
        {!!values['mvu.profile'] && <p className="ttm-asset-help">若要修改已选方案，先点击上方“编辑这份方案”，修改后以同名保存。</p>}
        <button className="ttm-mini-btn" disabled={busy || !values['mvu.profile']} onClick={() => void run(async () => {
            setSchemaValues({ 'mvu.profiles': JSON.stringify(profiles.filter(profile => profile.名称 !== values['mvu.profile']), null, 2), 'mvu.profile': '' }); setFeedback(editing ? '方案已从草稿移除，请点击底部保存。' : '已删除方案。');
        })}>删除当前方案</button>
        </>}
        {feedback && <p role="status">{feedback}</p>}
    </fieldset>;
}

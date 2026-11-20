import { useState } from 'react';
import { lanSyncStore, startHosting, stopHosting, pairDevice, forgetPeer, syncNow, refreshDevices, updateSyncOptions, dismissConflict, useConflict } from '../core/sync/engine';
import { SettingsSection, SettingsDisclosure } from './SettingsPrimitives';
import { restoreArchivedChat } from '../store/workspace-store';
import type { NearbyDevice } from '../core/sync/protocol';
import './lan-sync.css';
import { settingsDraftStore, useSettingsEditor } from '../registry/settings-draft';

export function LanSyncPanel() {
    const { editing } = useSettingsEditor();
    const draft = settingsDraftStore.useStore();
    const view = lanSyncStore.useStore();
    const [selected, setSelected] = useState<NearbyDevice>();
    const [address, setAddress] = useState('');
    const [code, setCode] = useState('');
    const [working, setWorking] = useState(false);
    const [error, setError] = useState('');
    const run = async (action: () => Promise<unknown>) => {
        setWorking(true); setError('');
        try { await action(); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
        finally { setWorking(false); }
    };
    const disabled = working || view.busy || !view.ready;
    const state = view.state, peer = state?.peer;
    const reviews = Object.keys(state?.worldbookReviews ?? {}).length;
    const status = error || view.error ? '同步失败' : reviews ? `${reviews} 项世界书差异待确认` : view.waiting ? '等待应用更新' : view.busy ? '正在同步'
        : !state?.enabled ? '互通已暂停' : !peer ? '等待配对' : !view.online ? '等待设备上线'
        : view.localChangesPending ? '本机已保存，待同步' : view.pending ? `${view.pending} 项待上传` : state?.lastSync ? '已同步' : '正在确认进度';
    const pair = async (destination: string, id?: string) => { await pairDevice(destination, code, id); setSelected(undefined); setCode(''); };
    return <div className="ttm-lan-sync">
        <SettingsSection title="局域网互通" description="两端开启后会自动发现对方。首次配对输入一次配对码，以后回到同一局域网会自动重连。">
            <label className="ttm-asset-field-label" htmlFor="lan-device-name">这台设备的名称</label>
            <input id="lan-device-name" className="ttm-text-input" value={draft.deviceName ?? state?.deviceName ?? ''} maxLength={60} disabled={disabled}
                onChange={event => { const name = event.target.value; settingsDraftStore.setState({ deviceName: name === state?.deviceName ? undefined : name }); }}
                onBlur={event => { if (!editing && state && event.target.value.trim() !== state.deviceName) void run(() => updateSyncOptions({}, event.target.value)); }} />
            <div className="ttm-lan-status" role="status" aria-live="polite"><strong>{status}</strong><span>{view.message}</span>
                {state?.lastSync && <small>最近完成同步：{new Date(state.lastSync).toLocaleString()}</small>}</div>
            {(error || view.error) && <p className="ttm-lan-error" role="alert">{error || view.error}</p>}
            <div className="ttm-lan-actions">
                {!!reviews && <button type="button" className="ttm-btn-secondary" onClick={() => lanSyncStore.setState({ reviewPrompt: true })}>查看世界书差异</button>}
                <button type="button" className="ttm-btn-primary" disabled={disabled} onClick={() => void run(state?.enabled ? stopHosting : startHosting)}>{state?.enabled ? '暂停互通' : '开启互通并发现设备'}</button>
                {peer && <button type="button" className="ttm-btn-secondary" disabled={disabled || !state?.enabled} onClick={() => void run(syncNow)}>立即同步</button>}
            </div>
        </SettingsSection>
        {peer ? <SettingsSection title="已配对设备" description="配对关系保存在两端。重新打开应用或网络地址改变后，发现同一设备即可自动连接。">
            <div className="ttm-lan-peer"><strong>{peer.name}</strong><span>{view.online ? '已连接' : '等待上线 · 无需重新配对'}</span>
                <button type="button" className="ttm-btn-secondary" disabled={disabled} onClick={() => void run(forgetPeer)}>忘记此设备</button></div>
            <p className="ttm-settings-note">“暂停互通”保留配对；“忘记此设备”撤销配对，下次需要重新确认。已有故事和存档都会保留。</p>
        </SettingsSection> : state?.enabled && <>
            <SettingsSection title="附近的设备" description="在另一台设备也开启局域网互通，然后选择它的名称。">
                <button type="button" className="ttm-btn-secondary" disabled={disabled} onClick={() => void run(refreshDevices)}>刷新设备</button>
                {!view.host?.nearby?.length && <p className="ttm-settings-note">正在寻找设备… 请保持两端应用打开，并连接同一 Wi-Fi。Windows 出现防火墙提示时允许专用网络。</p>}
                {view.host?.nearby?.map(device => <div className="ttm-lan-peer ttm-lan-nearby" key={device.deviceId}>
                    <strong>{device.name}</strong><button type="button" className="ttm-btn-secondary" disabled={disabled} onClick={() => { setSelected(device); setCode(''); }}>选择设备</button>
                </div>)}
                {selected && <form className="ttm-lan-pair" onSubmit={event => { event.preventDefault(); void run(() => pair(selected.address, selected.deviceId)); }}>
                    <label className="ttm-asset-field-label" htmlFor="lan-nearby-code">输入「{selected.name}」显示的配对码</label>
                    <input autoFocus id="lan-nearby-code" className="ttm-text-input" value={code} onChange={event => setCode(event.target.value)} autoCapitalize="none" autoCorrect="off" spellCheck={false} required />
                    <div className="ttm-lan-actions"><button type="submit" className="ttm-btn-primary" disabled={disabled || !code.trim()}>配对并记住设备</button>
                        <button type="button" className="ttm-btn-secondary" onClick={() => setSelected(undefined)}>取消</button></div>
                </form>}
            </SettingsSection>
            <SettingsSection title="本机配对码" description="如果从另一台设备发起配对，在那里输入这个配对码。只需任意一端发起一次。">
                <input aria-label="本机配对码" className="ttm-text-input ttm-lan-code" value={view.host?.secret ?? ''} readOnly onFocus={event => event.target.select()} />
                <button type="button" className="ttm-btn-secondary" onClick={() => void run(() => navigator.clipboard.writeText(view.host?.secret ?? ''))}>复制配对码</button>
            </SettingsSection>
        </>}
        {state?.enabled && !peer && <SettingsDisclosure title="没有发现设备？手动连接">
            <p className="ttm-settings-note">自动发现受网络限制时，可填写对方地址。手动配对后同样会记住设备。</p>
            {view.host?.addresses.map(value => <p className="ttm-settings-note" key={value}>本机地址：{value}</p>)}
            <form onSubmit={event => { event.preventDefault(); void run(() => pair(address)); }}>
                <label className="ttm-asset-field-label" htmlFor="lan-address">另一台设备的地址</label>
                <input id="lan-address" className="ttm-text-input" placeholder="例如 http://192.168.1.8:5192" value={address} onChange={event => setAddress(event.target.value)} autoCapitalize="none" autoCorrect="off" spellCheck={false} required />
                <label className="ttm-asset-field-label" htmlFor="lan-code">配对码</label>
                <input id="lan-code" className="ttm-text-input" value={code} onChange={event => setCode(event.target.value)} autoCapitalize="none" autoCorrect="off" spellCheck={false} required />
                <button type="submit" className="ttm-btn-secondary" disabled={disabled || !address.trim() || !code.trim()}>配对并记住设备</button>
            </form>
        </SettingsDisclosure>}
        <SettingsSection title="同步范围" description="同步故事、世界书、预设、个人资料（昵称、头像、人设及默认资料）、聊天分支与剧情变量。API 密钥、连接配置和本机路径留在当前设备。">
            {([{ key: 'automatic', label: '自动同步', note: '角色加载完成后，在操作间隙同步。已开始游玩时暂存远端进度，切回应用或点击“立即同步”后接续。' },
                { key: 'appearance', label: '同步软件外观', note: '双方开启后同步已保存的外观包和素材，本机摆放设置不受影响。' },
                { key: 'galleries', label: '同步本地图库', note: '双方开启后传输图片，相同内容不重复上传。' }] as const).map(option => <label className="ttm-lan-option" key={option.key}>
                    <input type="checkbox" checked={(editing ? draft.syncOptions[option.key] : undefined) ?? state?.options[option.key] ?? false} disabled={disabled} onChange={event => {
                        const enabled = event.target.checked;
                        if (!editing) { void run(() => updateSyncOptions({ [option.key]: enabled })); return; }
                        settingsDraftStore.setState(next => { if (enabled === state?.options[option.key]) delete next.syncOptions[option.key]; else next.syncOptions[option.key] = enabled; });
                    }} />
                    <span><strong>{option.label}</strong><small>{option.note}</small></span>
                </label>)}
        </SettingsSection>
        {!!state?.conflicts.length && <SettingsSection title="保留下来的副本" description="两端分别修改过同一内容，两个版本都已保留。剧情副本也可从历史会话打开。">
            {state.conflicts.map(conflict => <div className="ttm-lan-conflict" key={conflict.id}>
                <strong>{conflict.label}</strong><small>来自 {conflict.device} · {new Date(conflict.modified).toLocaleString()}</small>
                <div className="ttm-lan-actions">{conflict.id.startsWith('chat:') ? <button type="button" className="ttm-btn-secondary" disabled={disabled} onClick={() => void run(() => restoreArchivedChat(conflict.id.slice(5)))}>打开剧情副本</button>
                    : <button type="button" className="ttm-btn-secondary" disabled={disabled} onClick={() => void run(() => useConflict(conflict.id))}>采用这份内容</button>}
                    <button type="button" className="ttm-btn-secondary" disabled={disabled} onClick={() => void run(() => dismissConflict(conflict.id))}>保留两份，关闭提示</button></div>
            </div>)}
        </SettingsSection>}
    </div>;
}

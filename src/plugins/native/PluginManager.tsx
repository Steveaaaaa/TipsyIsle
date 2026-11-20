import { useEffect, useRef, useState, type RefObject } from 'react';
import { pickNativePlugin } from '../../core/platform-files';
import { isNativeRuntime } from '../../core/native-runtime';
import { Icon } from '../../shell/Icon';
import { SettingsDisclosure } from '../../shell/SettingsPrimitives';
import type { PluginSettingsDestination } from '../../shell/settings-presentation';
import { hostApi } from '../../../packages/plugin-sdk/package-format.mjs';
import type { Permission, SettingField, SettingValue, Settings } from '../../../packages/plugin-sdk/index.js';
import { canRun, changeNativePluginAccess, changeNativePluginSettings, errorMessage, initializeNativePlugins, installPlugin, nativePluginStore, reviewPlugin, setNativePluginEnabled, uninstallNativePlugin, type InstalledPlugin, type InstallReview, type PluginDiagnostic } from './catalog';
import { PluginConnections, PluginResourceAccess } from './PluginAccess';
import './native-plugins.css';

const permissionLabels: Record<Permission, string> = {
    'story.read': '读取剧情的消息正文和摘要',
    'story.events': '订阅回复、路线和存档更新',
    'storage.device': '读写插件自己的本机数据',
    'storage.route': '读写跟随当前剧情路线的插件数据',
    'storage.reply': '读写跟随单条候选回复的插件数据',
    'ui.panel': '在应用内打开面板',
    'composer.draft': '替换输入框草稿（不会发送）',
    'generation.contribute': '给本次模型请求补充少量提示词',
    'resources.read': '读取插件包附带的资源',
    'story.history': '查看已保存的会话、路线和历史',
    'story.variables': '读取剧情变量和运行状态',
    'story.edit': '修改剧情、追加楼层或创建分支',
    'story.navigate': '打开已保存的剧情路线',
    'assets.read': '读取角色卡、世界书和预设',
    'assets.write': '修改单独授权的资源',
    'generation.pipeline': '在生成时注入文字、提供宏或整理模型看到的历史',
    'generation.tools': '让模型调用插件提供的只读工具',
    'models.use': '通过授权的连接发起独立模型任务',
    'network.request': '访问单独授权的网址',
    'media.manage': '读写插件的媒体文件',
    'index.manage': '读写插件自己的文本和向量索引',
    'services.provide': '向其他插件提供服务',
    'services.call': '调用清单声明的插件服务',
    'ui.surface': '使用定制界面、侧栏或全屏面板',
};

function Permissions({ permissions, added, grants }: { permissions: Permission[]; added?: Permission[]; grants?: Permission[] }) {
    return permissions.length ? <ul className="ttm-native-permissions">{permissions.map(permission => <li key={permission}>
        <span>{permissionLabels[permission]}</span>{added?.includes(permission) && <strong>新增</strong>}
        {grants && <small className={grants.includes(permission) ? 'is-granted' : ''}>{grants.includes(permission) ? '已授权' : '未授权'}</small>}
    </li>)}</ul> : <p className="ttm-settings-note">没有申请权限。</p>;
}

function PluginSetting({ field, value, onChange }: { field: SettingField; value: SettingValue; onChange(value: SettingValue): void }) {
    return <label className={`ttm-native-field${field.type === 'boolean' ? ' is-check' : ''}`}>
        <span>{field.label}{field.description && <small>{field.description}</small>}</span>
        {field.type === 'boolean' ? <input type="checkbox" checked={value === true} onChange={event => onChange(event.currentTarget.checked)} />
            : field.type === 'select' ? <select className="ttm-select-input" value={String(value)} onChange={event => onChange(event.currentTarget.value)}>{field.options?.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
            : <input className="ttm-native-input" type={field.type} min={field.min} max={field.max} step={field.type === 'number' ? 'any' : undefined} maxLength={2000} value={String(value)}
                onChange={event => onChange(field.type === 'number' && event.currentTarget.value !== '' ? event.currentTarget.valueAsNumber : event.currentTarget.value)} />}
    </label>;
}

function PluginSettings({ plugin, disabled, onSave }: { plugin: InstalledPlugin; disabled: boolean; onSave(values: Settings): void }) {
    const [values, setValues] = useState<Settings>(plugin.settings);
    const edited = Object.keys(values).some(id => values[id] !== plugin.settings[id]);
    return <div className="ttm-native-plugin-settings">
        {plugin.manifest.settings?.map(field => <PluginSetting key={field.id} field={field} value={values[field.id]} onChange={value => setValues(current => ({ ...current, [field.id]: value }))} />)}
        {edited && <div className="ttm-native-actions"><button type="button" className="ttm-btn-secondary" disabled={disabled} onClick={() => setValues(plugin.settings)}>放弃修改</button>
            <button type="button" className="ttm-btn-primary" disabled={disabled} onClick={() => onSave(values)}>保存插件设置</button></div>}
    </div>;
}

const sectionLabels: Record<PluginSettingsDestination, string> = { overview: '概览', permissions: '权限', logs: '运行日志' };
const diagnosticLabels: Record<PluginDiagnostic['status'], string> = { ok: '完成', log: '记录', skipped: '已跳过', error: '失败' };
const scopedPermissions: Permission[] = ['models.use', 'assets.write', 'network.request'];
const emptyDiagnostics: PluginDiagnostic[] = [];
const logTime = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
type Run = (action: () => Promise<void>) => void;

function PluginState({ plugin, busy }: { plugin: InstalledPlugin; busy: boolean }) {
    const running = canRun(plugin);
    const label = busy ? '处理中' : running ? '已启用' : plugin.enabled ? '不可运行' : '未启用';
    return <span className="ttm-native-state" data-state={busy ? 'busy' : running ? 'on' : plugin.enabled ? 'unavailable' : 'off'}>{label}</span>;
}

function PluginLogs({ id }: { id: string }) {
    const entries = nativePluginStore.useStore(state => state.diagnostics[id] ?? emptyDiagnostics);
    const [failuresOnly, setFailuresOnly] = useState(false);
    const [feedback, setFeedback] = useState('');
    const shown = failuresOnly ? entries.filter(entry => entry.status === 'error') : entries;
    const copy = async () => {
        try {
            await navigator.clipboard.writeText(shown.map(entry =>
                `${logTime.format(entry.at)}  ${diagnosticLabels[entry.status]}  ${entry.task}${entry.status !== 'log' ? ` · ${entry.elapsed} ms` : ''}${entry.detail ? `\n${entry.detail}` : ''}`).join('\n'));
            setFeedback('已复制当前日志。');
        } catch { setFeedback('复制失败，可以选中日志文字手动复制。'); }
    };
    return <>
        <p className="ttm-settings-note">仅显示本次打开应用后的最近 30 条记录。</p>
        <div className="ttm-native-log-tools">
            <div className="ttm-native-log-filter" role="group" aria-label="筛选日志">
                <button type="button" aria-pressed={!failuresOnly} onClick={() => { setFailuresOnly(false); setFeedback(''); }}>全部</button>
                <button type="button" aria-pressed={failuresOnly} onClick={() => { setFailuresOnly(true); setFeedback(''); }}>仅失败</button>
            </div>
            <button type="button" className="ttm-icon-btn" aria-label="复制当前日志" title="复制当前日志" disabled={!shown.length} onClick={() => void copy()}><Icon name="copy" width={17} height={17} /></button>
        </div>
        {feedback && <p className="ttm-settings-note" role="status">{feedback}</p>}
        {shown.length ? <ol className="ttm-native-diagnostics" aria-label="运行记录，最新在前">{shown.map((entry, index) => <li key={`${entry.at}:${shown.length - index}`}>
            <div><strong>{entry.task}</strong><span data-result={entry.status}>{diagnosticLabels[entry.status]}</span></div>
            <small><time dateTime={new Date(entry.at).toISOString()}>{logTime.format(entry.at)}</time>{entry.status !== 'log' && ` · ${entry.elapsed} ms`}</small>
            {entry.detail && <p>{entry.detail}</p>}
        </li>)}</ol> : <p className="ttm-native-no-results">{failuresOnly ? '没有失败记录。' : '暂无运行记录。'}</p>}
    </>;
}

function PluginDetail({ plugin, working, busy, section, onSection, onEnable, onBack, onStatus, run, headingRef }: {
    plugin: InstalledPlugin; working: boolean; busy: boolean; section: PluginSettingsDestination;
    onSection(section: PluginSettingsDestination): void; onEnable(): void; onBack(): void; onStatus(message: string): void;
    run: Run; headingRef: RefObject<HTMLHeadingElement>;
}) {
    const { id, name, publisher, version, description, permissions, settings } = plugin.manifest;
    const [accessOpened, setAccessOpened] = useState(section === 'permissions');
    const disabled = working || busy;
    return <section className="ttm-native-detail" aria-label={`${name} · 插件详情`}>
        <button type="button" className="ttm-btn-ghost ttm-native-back ttm-native-back-to-list" onClick={onBack}><Icon name="chevron" width={15} height={15} />返回插件列表</button>
        <header className="ttm-native-detail-heading">
            <h4 ref={headingRef} tabIndex={-1}>{name}</h4>
            <p>{publisher} · v{version}</p><PluginState plugin={plugin} busy={busy} />
        </header>
        <nav className="ttm-native-detail-tabs" aria-label="插件详情">{(Object.keys(sectionLabels) as PluginSettingsDestination[]).map(item =>
            <button key={item} type="button" aria-current={section === item ? 'page' : undefined} onClick={() => {
                if (item === 'permissions') setAccessOpened(true);
                onSection(item);
            }}>{sectionLabels[item]}</button>)}</nav>
        <div className="ttm-native-detail-content" hidden={section !== 'overview'} aria-label="概览">
            {description && <p className="ttm-native-description">{description}</p>}
            <div className="ttm-native-actions">
                <button type="button" disabled={disabled} className="ttm-btn-secondary" onClick={onEnable}>{plugin.enabled ? '停用插件' : '启用插件'}</button>
                <button type="button" disabled={disabled} className="ttm-btn-ghost ttm-native-uninstall" title="卸载后保留已有数据" onClick={() => run(async () => {
                    await uninstallNativePlugin(id); onBack(); onStatus(`已卸载「${name}」，保留已有数据。`);
                })}><Icon name="trash" width={15} height={15} />卸载</button>
            </div>
            {plugin.prepared !== false && !!settings?.length && <SettingsDisclosure title="插件设置"><PluginSettings key={`${plugin.digest}:${JSON.stringify(plugin.settings)}`} plugin={plugin} disabled={disabled} onSave={values => run(async () => {
                await changeNativePluginSettings(id, values); onStatus(`「${name}」的设置已保存。`);
            })} /></SettingsDisclosure>}
            <details className="ttm-native-id"><summary>插件标识与发布者指纹</summary><code>{id}<br />{plugin.fingerprint}</code></details>
        </div>
        <div className="ttm-native-detail-content" hidden={section !== 'permissions'} aria-label="权限">
            <h5>插件申请的权限</h5><Permissions permissions={permissions} grants={plugin.grants} />
            {(accessOpened || section === 'permissions') && scopedPermissions.some(permission => permissions.includes(permission)) && <>
                <h5>单独授权的资源</h5>
                <PluginResourceAccess key={`${plugin.digest}:${JSON.stringify(plugin.access)}`} plugin={plugin} disabled={disabled} onSave={value => run(async () => {
                    await changeNativePluginAccess(id, value); onStatus(`「${name}」的授权已保存。`);
                })} />
            </>}
        </div>
        {section === 'logs' && <div className="ttm-native-detail-content" aria-label="运行日志"><PluginLogs id={id} /></div>}
    </section>;
}

export function NativePluginManager({ initialSection = 'overview' }: { initialSection?: PluginSettingsDestination }) {
    const plugins = nativePluginStore.useStore(state => state.catalog.plugins);
    const maintenance = nativePluginStore.useStore(state => state.maintenance);
    const ready = nativePluginStore.useStore(state => state.ready);
    const loadError = nativePluginStore.useStore(state => state.error);
    const fileInput = useRef<HTMLInputElement>(null);
    const heading = useRef<HTMLHeadingElement>(null), listHeading = useRef<HTMLHeadingElement>(null), reviewHeading = useRef<HTMLHeadingElement>(null);
    const [section, setSection] = useState(initialSection);
    const [selectedId, setSelectedId] = useState<string>();
    const [query, setQuery] = useState('');
    const [filter, setFilter] = useState('all');
    const [connectionsOpen, setConnectionsOpen] = useState(false);
    const [review, setReview] = useState<InstallReview | null>(null);
    const [grant, setGrant] = useState<InstalledPlugin | null>(null);
    const [working, setWorking] = useState(false);
    const [status, setStatus] = useState('');
    const [error, setError] = useState('');
    useEffect(() => { void initializeNativePlugins().catch(() => {}); }, []);
    useEffect(() => { if (review || grant || connectionsOpen) reviewHeading.current?.focus(); }, [review, grant, connectionsOpen]);
    const act = (run: () => Promise<void>) => {
        setWorking(true); setError(''); setStatus('');
        void run().catch(error => setError(errorMessage(error))).finally(() => setWorking(false));
    };
    const inspect = async (file: File) => {
        setGrant(null); setReview(null); setConnectionsOpen(false);
        const { inspectPluginPackage } = await import('./package');
        setReview(reviewPlugin(await inspectPluginPackage(file)));
    };
    const focus = (ref: RefObject<HTMLElement>) => requestAnimationFrame(() => ref.current?.focus());
    const choose = (id: string) => { setSelectedId(id); focus(heading); };
    const backToList = () => { setSelectedId(undefined); focus(listHeading); };
    const accept = (enable: boolean) => review && act(async () => {
        await installPlugin(review, enable);
        setQuery(''); setFilter('all'); setSection('overview'); choose(review.pkg.manifest.id);
        setReview(null); setStatus(`已${review.current ? '更新' : '安装'}「${review.pkg.manifest.name}」${enable ? '，插件已启用' : '，尚未启用'}。`);
    });
    const needle = query.trim().toLocaleLowerCase();
    const filtered = plugins.filter(({ manifest, enabled }) => (filter === 'all' || enabled === (filter === 'enabled')) &&
        (!needle || `${manifest.name} ${manifest.publisher} ${manifest.id}`.toLocaleLowerCase().includes(needle)));
    const selected = plugins.find(plugin => plugin.manifest.id === selectedId);
    const installedHeading = <div className="ttm-native-list-heading"><h4 tabIndex={-1} ref={listHeading}>已安装 <span>{plugins.length}</span></h4><small>插件 API {hostApi}</small></div>;
    return <section className="ttm-native-manager" aria-label="微醺屿插件管理">
        <div className="ttm-native-toolbar">
            <button type="button" className="ttm-btn-primary" data-guide-action="plugins" disabled={working || !ready} onClick={() => {
                if (isNativeRuntime()) act(async () => { const file = await pickNativePlugin(); if (file) await inspect(file); });
                else fileInput.current?.click();
            }}><Icon name="upload" width={16} height={16} />导入插件</button>
            <button type="button" className="ttm-btn-secondary" aria-expanded={connectionsOpen} disabled={working || !ready || !!review || !!grant} onClick={() => setConnectionsOpen(open => !open)}><Icon name="cpu" width={16} height={16} />专用模型连接</button>
            <input ref={fileInput} type="file" hidden accept=".tipsy-plugin" onChange={event => {
                const file = event.currentTarget.files?.[0]; event.currentTarget.value = '';
                if (file) act(() => inspect(file));
            }} />
        </div>
        {(error || loadError) && <p role="alert" className="ttm-native-error">{error || loadError}</p>}
        {status && <p role="status" className="ttm-settings-note">{status}</p>}
        {working && <p role="status" className="ttm-settings-note">正在处理插件，请稍候…</p>}
        {!ready && !loadError && <p role="status" className="ttm-settings-note">正在读取已安装插件…</p>}
        {!ready && loadError && <button type="button" className="ttm-btn-secondary" disabled={working} onClick={() => act(initializeNativePlugins)}>重试读取</button>}
        {connectionsOpen && <div className="ttm-native-review"><h4 tabIndex={-1} ref={reviewHeading}>插件专用模型连接</h4><p className="ttm-settings-note">添加后，可以在每个插件的「权限」里单独授权。</p><PluginConnections run={act} working={working} /></div>}
        {review && <div className="ttm-native-review">
            <div><h4 tabIndex={-1} ref={reviewHeading}>{review.current ? '检查插件更新' : '检查新插件'} · {review.pkg.manifest.name}</h4>
                <p className="ttm-settings-note">{review.pkg.manifest.publisher} · {review.current ? `${review.current.manifest.version} → ` : ''}{review.pkg.manifest.version}</p></div>
            {review.pkg.manifest.description && <p>{review.pkg.manifest.description}</p>}
            <details><summary>{review.current ? '签名与已安装版本一致' : '发布者签名指纹'}</summary><code>{review.pkg.fingerprint}</code></details>
            <Permissions permissions={review.pkg.manifest.permissions} added={review.current ? review.added : undefined} />
            <div className="ttm-native-actions"><button type="button" className="ttm-btn-secondary" disabled={working} onClick={() => { setReview(null); setError(''); }}>取消</button>
                {!review.current && <button type="button" className="ttm-btn-secondary" disabled={working} onClick={() => accept(false)}>仅安装</button>}
                <button type="button" className="ttm-btn-primary" disabled={working} onClick={() => accept(true)}>{review.current ? '确认更新并启用' : '授权并启用'}</button></div>
        </div>}
        {grant && <div className="ttm-native-review">
            <h4 tabIndex={-1} ref={reviewHeading}>启用「{grant.manifest.name}」</h4>
            <Permissions permissions={grant.manifest.permissions} />
            <div className="ttm-native-actions"><button type="button" className="ttm-btn-secondary" disabled={working} onClick={() => { setGrant(null); setError(''); focus(heading); }}>取消</button>
                <button type="button" className="ttm-btn-primary" disabled={working} onClick={() => act(async () => {
                    await setNativePluginEnabled(grant.manifest.id, true); setGrant(null); setStatus(`已启用「${grant.manifest.name}」。`); focus(heading);
                })}>授权并启用</button></div>
        </div>}
        {ready && !review && !grant && !connectionsOpen && (!plugins.length ? <>
            {installedHeading}<div className="ttm-native-empty"><Icon name="plugin" width={26} height={26} /><div><strong>还没有安装插件</strong><p>拿到社区作者提供的 .tipsy-plugin 文件后，从这里导入。</p></div></div>
        </> : <div className="ttm-native-workspace" data-detail-open={!!selected}>
            <div className="ttm-native-library">
                {installedHeading}
                <div className="ttm-native-list-controls">
                    <label className="ttm-native-search"><Icon name="search" width={15} height={15} /><input type="search" aria-label="按插件名称、作者或标识查找" placeholder="搜索插件" value={query} onChange={event => setQuery(event.target.value)} /></label>
                    <select aria-label="按启用状态筛选插件" className="ttm-select-input" value={filter} onChange={event => setFilter(event.target.value)}><option value="all">全部状态</option><option value="enabled">已启用</option><option value="disabled">未启用</option></select>
                </div>
                {section !== 'overview' && !selected && <p className="ttm-settings-note">选择插件，查看{sectionLabels[section]}。</p>}
                {filtered.length ? <ul className="ttm-native-plugin-list">{filtered.map(plugin => {
                    const { id, name, publisher } = plugin.manifest;
                    return <li key={id}><button type="button" className="ttm-native-plugin-entry" aria-current={selected?.manifest.id === id ? 'true' : undefined} onClick={() => choose(id)}>
                        <span className="ttm-native-entry-copy"><strong>{name}</strong><small>{publisher}</small></span>
                        <PluginState plugin={plugin} busy={maintenance.includes(id)} /><Icon name="chevron" width={14} height={14} />
                    </button></li>;
                })}</ul> : <p className="ttm-native-no-results">没有符合条件的插件。</p>}
            </div>
            {selected ? <PluginDetail key={selected.manifest.id} plugin={selected} working={working} busy={maintenance.includes(selected.manifest.id)} section={section}
                onSection={setSection} onBack={backToList} onStatus={setStatus} run={act} headingRef={heading} onEnable={() => {
                    if (!selected.enabled) { setError(''); setStatus(''); setGrant(selected); return; }
                    act(async () => { await setNativePluginEnabled(selected.manifest.id, false); setStatus(`已停用「${selected.manifest.name}」。`); });
                }} /> : <div className="ttm-native-detail-hint"><Icon name="plugin" width={24} height={24} /><span>选择一个插件，查看详情。</span></div>}
        </div>)}
    </section>;
}

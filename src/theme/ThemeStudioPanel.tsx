import { useDeferredValue, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Immer } from 'immer';
import _ from 'lodash';
import { AnchoredDialog } from '../shell/AnchoredDialog';
import { Icon } from '../shell/Icon';
import { saveExport } from '../core/platform-files';
import { isNativeRuntime } from '../core/native-runtime';
import { AppearancePreview, type PreviewPage } from './AppearancePreview';
import { appearanceAsset, appearanceDevice, appearanceLibrary, appearanceStore, decodeAppearance, deleteAppearancePack, importAppearancePacks,
    loadAppearancePack, pauseAppearance, saveAppearance, saveDeviceLayouts, useAppearancePack, type AppearancePackEntry } from './appearance-store';
import { allowedAreas, areas, artLabels, assetUrl, blankAppearance, defaultText, fontLabels, parts, placements, shellSurfaces, textLabels, widgetValues,
    type Appearance, type Area, type Device, type FontRole, type Layout, type Part, type Widget } from './appearance-model';
import { compileAppearance } from './appearance-style';
import './appearance-workbench.css';

const tabs = { basic: '基础', layout: '布局与部件', css: '高级 CSS', packages: '外观包' } as const;
const pages: Record<PreviewPage, string> = { chat: '会话', library: '馆藏', settings: '设置', empty: '空白页', startup: '启动画面' };
const mediaExtensions = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif', 'svg'];
const fontExtensions = ['woff2', 'woff', 'ttf', 'otf'];
type DeviceLayouts = Partial<Record<Device, Layout>>;
type Draft = { skin: Appearance; layouts: DeviceLayouts; reset: boolean; packId: string | null };
const currentDraft = (): Draft => {
    const { saved, activePackId } = appearanceStore.getState();
    return { skin: saved ?? defaultPreview, layouts: appearanceDevice.getState().layouts, reset: false, packId: activePackId };
};
const immutableDraft = new Immer({ autoFreeze: false });
type History = { past: Draft[]; present: Draft; future: Draft[] };
const newHistory = (present: Draft): History => ({ past: [], present, future: [] });

function Group({ title, children, selected = false }: { title: string; children: ReactNode; selected?: boolean }) {
    return <section className="ttm-skin-group" data-ti-skin-selection={selected || undefined}><h3>{title}</h3>{children}</section>;
}

function FilePick({ title, extensions, pick, pickMany, onError, disabled }: { title: string; extensions: string[]; onError: (error: string) => void; disabled?: boolean } & (
    { pick: (file: File) => void; pickMany?: never } | { pick?: never; pickMany: (files: File[], errors: string[]) => void }
)) {
    const input = useRef<HTMLInputElement>(null);
    const multiple = !!pickMany;
    const accept = (files: File[], errors: string[] = []) => {
        if (pickMany) { pickMany(files, errors); return; }
        if (files[0]) pick?.(files[0]); else if (errors[0]) onError(errors[0]);
    };
    const onPick = async () => {
        if (!isNativeRuntime()) { input.current?.click(); return; }
        try {
            const { open } = await import('@tauri-apps/plugin-dialog');
            const selected = await open({ multiple, directory: false, pickerMode: 'document', filters: [{ name: title, extensions }] });
            if (!selected) return;
            const paths = Array.isArray(selected) ? selected : [selected];
            const [{ readFile }, { basename }] = await Promise.all([import('@tauri-apps/plugin-fs'), import('@tauri-apps/api/path')]);
            const files: File[] = [], errors: string[] = [];
            for (const path of paths) {
                let name = '';
                try { name = await basename(path); files.push(new File([new Uint8Array(await readFile(path)).buffer], name)); }
                catch (error) { errors.push(pickMany ? `无法读取${name ? `「${name}」` : '所选文件'}` : String(error)); }
            }
            accept(files, errors);
        } catch (error) { onError(String(error)); }
    };
    return <><button type="button" className="ttm-btn-secondary" disabled={disabled} onClick={() => void onPick()}><Icon name="upload" width={16} height={16} />{title}</button>
        <input ref={input} type="file" hidden disabled={disabled} multiple={multiple} accept={extensions.map(ext => `.${ext}`).join(',')} onChange={event => {
            const files = Array.from(event.target.files ?? []); event.target.value = ''; if (files.length) accept(files);
        }} /></>;
}

export function ThemeStudioPanel({ open, showPackages, device, onClose }: { open: boolean; showPackages: boolean; device: Device; onClose: () => void }) {
    const saved = appearanceStore.useStore();
    const savedDevice = appearanceDevice.useStore();
    const { packs } = appearanceLibrary.useStore();
    const [history, setHistory] = useState(() => newHistory(currentDraft()));
    const [tab, setTab] = useState<keyof typeof tabs>('basic');
    const [previewDevice, setPreviewDevice] = useState<Device>(device);
    const [page, setPage] = useState<PreviewPage>('chat');
    const [pane, setPane] = useState<'edit' | 'preview'>('edit');
    const [compare, setCompare] = useState(false);
    const [localMode, setLocalMode] = useState(false);
    const [selected, setSelected] = useState('routes');
    const [dragged, setDragged] = useState<string>();
    const [saving, setSaving] = useState(false);
    const [packBusy, setPackBusy] = useState(false);
    const [pendingDelete, setPendingDelete] = useState<{ entry: AppearancePackEntry; anchor: HTMLButtonElement }>();
    const [deleteError, setDeleteError] = useState('');
    const [status, setStatus] = useState('');
    const [error, setError] = useState('');
    const { skin, layouts, reset: queuedReset, packId } = history.present;
    const busy = saving || packBusy;
    const editableLayout = localMode ? layouts[previewDevice] : undefined;
    const items = placements(skin, previewDevice, editableLayout);
    const narrowAreas: Area[] = ['top', 'sidebar', 'conversation', 'toolbar', 'more', 'input-before', 'input-after', ...(previewDevice === 'mobile' ? ['mobile' as const] : [])];
    const displaySkin = useDeferredValue(compare ? saved.saved ?? defaultPreview : skin);
    const previewCss = useMemo(() => open ? compileAppearance(displaySkin) : '', [open, displaySkin]);
    const changedSkin = queuedReset ? !!saved.saved : packId !== saved.activePackId || !_.isEqual(skin, saved.saved ?? defaultPreview);
    const changedDevice = !_.isEqual(layouts, savedDevice.layouts);
    const dirty = changedSkin || changedDevice;
    const selectedPart = Object.hasOwn(parts, selected) ? selected as Part : undefined;
    const selectedWidget = skin.widgets.find(item => item.id === selected);
    const selectedRegion = (Object.keys(areas) as Area[]).find(area => items[area].includes(selected));
    const assetKeys = Object.keys(skin.assets);
    const retainedDraft = useRef(false);
    useEffect(() => {
        if (!open) return;
        if (showPackages) { setTab('packages'); setPane('edit'); }
        if (!retainedDraft.current) {
            setHistory(newHistory(currentDraft())); setPreviewDevice(device); setCompare(false); setError(''); setStatus('');
        }
    }, [open, showPackages]);

    const update = (change: (draft: Draft) => void, reset = false) => {
        if (saving) return;
        setCompare(false); setStatus(''); setError('');
        setHistory(state => {
            const next = immutableDraft.produce(state.present, draft => { change(draft); draft.reset = reset; });
            if (next === state.present) return state;
            return { past: [...state.past.slice(-39), state.present], present: next, future: [] };
        });
    };
    const edit = (change: (draft: Appearance) => void) => update(draft => change(draft.skin));
    const changeHistory = (direction: -1 | 1) => {
        setCompare(false); setStatus(''); setError('');
        setHistory(state => {
            if (direction === -1) { const next = state.past.at(-1); return next ? { past: state.past.slice(0, -1), present: next, future: [state.present, ...state.future] } : state; }
            const next = state.future[0]; return next ? { past: [...state.past, state.present], present: next, future: state.future.slice(1) } : state;
        });
    };
    const perform = async (task: () => Promise<void>) => {
        setError(''); setStatus('');
        try { await task(); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    };
    const save = () => void perform(async () => {
        setSaving(true);
        try {
            if (changedSkin || changedDevice && !saved.saved && !queuedReset) await saveAppearance(queuedReset ? null : skin, packId);
            if (changedDevice) saveDeviceLayouts(layouts);
            if (savedDevice.paused && !queuedReset) pauseAppearance(false);
            setHistory(newHistory(currentDraft())); setCompare(false); setStatus('外观已保存。');
        } finally { setSaving(false); }
    });
    const runPackAction = (task: () => Promise<void>) => void perform(async () => {
        setPackBusy(true);
        try { await task(); } finally { setPackBusy(false); }
    });
    const importPackages = (files: File[], errors: string[]) => runPackAction(async () => {
        const imported: Appearance[] = [];
        for (const file of files) {
            try { imported.push(decodeAppearance(JSON.parse(await file.text()))); }
            catch { errors.push(`「${file.name}」不是有效的外观包`); }
        }
        if (imported.length) await importAppearancePacks(imported);
        const result = imported.length ? `已导入 ${imported.length} 个外观包。` : '';
        if (errors.length) setError(`${result}${errors[0]}${errors.length > 1 ? `，另有 ${errors.length - 1} 个文件未导入` : ''}。`);
        else setStatus(result);
    });
    const previewPack = (entry: AppearancePackEntry) => runPackAction(async () => {
        const pack = await loadAppearancePack(entry.id);
        update(draft => { draft.skin = pack; draft.packId = entry.id; });
        setLocalMode(false); setPane('preview');
    });
    const applyPack = (entry: AppearancePackEntry) => runPackAction(async () => {
        await useAppearancePack(entry.id);
        if (appearanceDevice.getState().paused) pauseAppearance(false);
        setHistory(state => ({ past: dirty ? [...state.past.slice(-39), state.present] : [], present: { ...currentDraft(), layouts: state.present.layouts }, future: [] }));
        setCompare(false); setLocalMode(false); setStatus(`正在使用「${entry.name}」。`);
    });
    const removePack = (entry: AppearancePackEntry) => void (async () => {
        setPackBusy(true); setDeleteError('');
        try {
            await deleteAppearancePack(entry.id);
            setHistory(state => ({ past: state.past.filter(draft => draft.packId !== entry.id),
                present: state.present.packId === entry.id ? { ...currentDraft(), layouts: state.present.layouts } : state.present,
                future: state.future.filter(draft => draft.packId !== entry.id) }));
            setPendingDelete(undefined); setError(''); setStatus(`已删除「${entry.name}」。`);
        } catch (reason) { setDeleteError(reason instanceof Error ? reason.message : String(reason)); }
        finally { setPackBusy(false); }
    })();
    const exportPackage = () => void perform(async () => {
        const name = skin.name.trim() || '微醺屿外观';
        if (await saveExport(new Blob([JSON.stringify(skin, null, 2)], { type: 'application/json' }), `${name.replace(/[\\/:*?"<>|]/g, '-')}.tipsy-appearance.json`)) setStatus('已导出当前草稿。');
    });
    const putAsset = (file: File, category: 'image' | 'font', use?: (change: Appearance, id: string) => void) => void perform(async () => {
        const asset = await appearanceAsset(file, category);
        const id = `asset-${crypto.randomUUID().slice(0, 8)}`;
        edit(draft => { draft.assets[id] = asset; use?.(draft, id); });
    });
    const imageSelect = (label: string, value: string, change: (draft: Appearance, source: string) => void) => <div className="ttm-skin-asset-field">
        <label>{label}<select value={value} onChange={event => edit(draft => change(draft, event.target.value))}><option value="">使用默认</option>
            {assetKeys.filter(id => skin.assets[id].mime.startsWith('image/')).map(id => <option key={id} value={id}>{skin.assets[id].name}</option>)}</select></label>
        <FilePick title="选图" extensions={mediaExtensions} pick={file => putAsset(file, 'image', change)} onError={setError} />
    </div>;
    const textField = (id: keyof typeof defaultText | Part, label: string, placeholder: string) => <label key={id}>{label}<input type="text" placeholder={placeholder} value={skin.text[id] ?? ''} onChange={event => edit(draft => {
        if (event.target.value || id === 'subtitle' || id === 'hint' || id === 'startup-title' || id === 'input') draft.text[id] = event.target.value; else delete draft.text[id];
    })} /></label>;

    const relocate = (id: string, to: Area, before?: string) => {
        if (id === before || !narrowAreas.includes(to) || (Object.hasOwn(parts, id) && !allowedAreas(id as Part, previewDevice).includes(to))) return;
        update(draft => {
            const current = placements(draft.skin, previewDevice, localMode ? draft.layouts[previewDevice] : undefined);
            for (const area of Object.keys(areas) as Area[]) current[area] = current[area].filter(item => item !== id);
            const index = before === undefined ? current[to].length : current[to].indexOf(before);
            current[to].splice(index < 0 ? current[to].length : index, 0, id);
            if (localMode) draft.layouts[previewDevice] = current; else draft.skin.layout[previewDevice] = current;
        });
    };
    const moveWithin = (id: string, step: -1 | 1) => {
        if (!selectedRegion) return;
        const group = items[selectedRegion], index = group.indexOf(id);
        if (index + step < 0 || index + step >= group.length) return;
        relocate(id, selectedRegion, group[index + (step === -1 ? -1 : 2)]);
    };
    const onSelect = (id: string) => {
        setSelected(id); setTab(id === 'brand' || id === 'input' ? 'basic' : 'layout'); setPane('edit');
        requestAnimationFrame(() => document.querySelector<HTMLElement>(id === 'input' || id === 'brand' || Object.hasOwn(parts, id) || id.startsWith('widget-') ? '[data-ti-skin-selection]' : '.is-selected-art')?.scrollIntoView({ block: 'nearest' }));
    };
    const editWidget = (change: (widget: Widget) => void) => edit(draft => { const widget = draft.widgets.find(item => item.id === selected); if (widget) change(widget); });

    if (!open) return null;
    return <><AnchoredDialog title="外观工作台" anchor={document.body} centered className="ttm-appearance-dialog" closeDisabled={busy} onClose={() => { retainedDraft.current = dirty; onClose(); }}>
        <div className="ttm-skin-workbench" data-pane={pane} aria-busy={busy}>
            <div className="ttm-skin-editor">
                <nav className="ttm-skin-tabs" aria-label="外观工作台功能">{(Object.keys(tabs) as (keyof typeof tabs)[]).map(key => <button type="button" key={key} aria-current={tab === key ? 'page' : undefined} onClick={() => { setTab(key); setPane('edit'); }}>{tabs[key]}</button>)}</nav>
                <div className="ttm-skin-editor-scroll" key={tab}>
                    {tab === 'basic' && <>
                        <Group title="应用名称" selected={selected === 'brand'}>{textField('name', textLabels.name, defaultText.name)}{textField('subtitle', textLabels.subtitle, defaultText.subtitle)}{textField('window', textLabels.window, '跟随软件名称')}</Group>
                        <Group title="字体与字号">{(Object.keys(fontLabels) as FontRole[]).map(role => {
                            const font = skin.fonts[role] ?? { family: '', size: 0, asset: '' };
                            const change = (draft: Appearance, patch: Partial<typeof font>) => { draft.fonts[role] = { ...(draft.fonts[role] ?? font), ...patch }; };
                            return <div className="ttm-skin-font" key={role}><strong>{fontLabels[role]}</strong><div className="ttm-skin-field-pair">
                                <label>字体名称<input type="text" placeholder="默认字体" value={font.family} onChange={e => edit(draft => change(draft, { family: e.target.value }))} /></label>
                                <label>字号（px）<input type="number" min="0" max="64" placeholder="默认" value={font.size || ''} onChange={e => edit(draft => change(draft, { size: Math.max(0, Math.min(64, Number(e.target.value))) }))} /></label></div>
                                <div className="ttm-skin-asset-field"><label>本地字体<select value={font.asset} onChange={e => edit(draft => change(draft, { asset: e.target.value }))}><option value="">不使用文件</option>{assetKeys.filter(id => skin.assets[id].mime.startsWith('font/')).map(id => <option value={id} key={id}>{skin.assets[id].name}</option>)}</select></label>
                                <FilePick title="选字体" extensions={fontExtensions} pick={file => putAsset(file, 'font', (draft, asset) => change(draft, { asset }))} onError={setError} /></div>
                            </div>;
                        })}</Group>
                        <Group title="壁纸">{imageSelect('壁纸素材', Object.hasOwn(skin.assets, skin.wallpaper.source) ? skin.wallpaper.source : '', (draft, source) => { draft.wallpaper.source = source; })}
                            <label>图片地址<input type="url" placeholder="https://" value={Object.hasOwn(skin.assets, skin.wallpaper.source) ? '' : skin.wallpaper.source} onChange={e => edit(draft => { draft.wallpaper.source = e.target.value; })} /></label>
                            <div className="ttm-skin-field-pair"><label>填充<select value={skin.wallpaper.fit} onChange={e => edit(draft => { draft.wallpaper.fit = e.target.value as Appearance['wallpaper']['fit']; })}><option value="cover">铺满</option><option value="contain">完整显示</option><option value="tile">平铺</option></select></label>
                            <label>对齐<select value={skin.wallpaper.position} onChange={e => edit(draft => { draft.wallpaper.position = e.target.value; })}><option value="center">居中</option><option value="center top">顶部</option><option value="center bottom">底部</option><option value="left center">左侧</option><option value="right center">右侧</option></select></label></div>
                            <label>遮罩 · {Math.round(skin.wallpaper.shade * 100)}%<input type="range" min="0" max="0.9" step="0.01" value={skin.wallpaper.shade} onChange={e => edit(draft => { draft.wallpaper.shade = Number(e.target.value); })} /></label>
                            {skin.wallpaper.source && <button type="button" className="ttm-btn-secondary" onClick={() => edit(draft => { draft.wallpaper.source = ''; })}>移除壁纸</button>}</Group>
                        <Group title="界面文案" selected={selected === 'input'}>{(Object.keys(textLabels) as (keyof typeof defaultText)[]).filter(id => !['name', 'subtitle', 'window'].includes(id)).map(id => textField(id, textLabels[id], defaultText[id]))}</Group>
                    </>}
                    {tab === 'layout' && <>
                        <Group title="部件摆放"><div className="ttm-skin-segments" aria-label="布局保存范围"><button type="button" aria-pressed={!localMode} onClick={() => setLocalMode(false)}>外观包布局</button><button type="button" aria-pressed={localMode} onClick={() => setLocalMode(true)}>本机摆放</button></div>
                            <div className="ttm-skin-zone-list">{(narrowAreas as Area[]).map(area => <div key={area} className="ttm-skin-zone" onDragOver={event => { if (dragged) event.preventDefault(); }} onDrop={event => { event.preventDefault(); if (dragged) relocate(dragged, area); setDragged(undefined); }}>
                                <strong>{areas[area]}</strong><div>{items[area].length ? items[area].map(id => <button key={id} type="button" draggable={device === 'desktop'} aria-pressed={selected === id} onClick={() => setSelected(id)}
                                    onDragStart={event => { event.dataTransfer.setData('text/plain', id); event.dataTransfer.effectAllowed = 'move'; setDragged(id); }} onDragEnd={() => setDragged(undefined)}
                                    onDrop={event => { event.preventDefault(); event.stopPropagation(); if (dragged) relocate(dragged, area, id); setDragged(undefined); }}>
                                    {Object.hasOwn(parts, id) ? parts[id as Part][0] : skin.widgets.find(w => w.id === id)?.label || '小组件'}</button>) : <small>空</small>}</div>
                            </div>)}</div>
                            {localMode && layouts[previewDevice] && <button type="button" className="ttm-btn-secondary" onClick={() => update(draft => { delete draft.layouts[previewDevice]; })}>清除本机摆放</button>}
                        </Group>
                        {(selectedPart || selectedWidget) && <Group title={selectedPart ? parts[selectedPart][0] : '编辑小组件'} selected>
                            {selectedRegion && <div className="ttm-skin-asset-field"><label>移到<select value={selectedRegion} onChange={e => relocate(selected, e.target.value as Area)}>{(selectedPart ? allowedAreas(selectedPart, previewDevice) : narrowAreas as Area[]).filter(area => narrowAreas.includes(area)).map(area => <option value={area} key={area}>{areas[area]}</option>)}</select></label>
                                <button type="button" className="ttm-icon-btn" aria-label="前移" title="前移" disabled={items[selectedRegion][0] === selected} onClick={() => moveWithin(selected, -1)}><Icon name="chevron" style={{ transform: 'rotate(-90deg)' }} /></button><button type="button" className="ttm-icon-btn" aria-label="后移" title="后移" disabled={items[selectedRegion].at(-1) === selected} onClick={() => moveWithin(selected, 1)}><Icon name="chevron" style={{ transform: 'rotate(90deg)' }} /></button></div>}
                            {selectedPart && <>{textField(selectedPart, '显示文字', parts[selectedPart][0])}{imageSelect('部件图标', skin.art[selectedPart] ?? '', (draft, id) => { draft.art[selectedPart] = id; })}</>}
                            {selectedWidget && <><label>名称<input value={selectedWidget.label} onChange={event => editWidget(widget => { widget.label = event.target.value; })} /></label>
                                <label>显示数据<select value={selectedWidget.value} onChange={event => editWidget(widget => { widget.value = event.target.value as Widget['value']; })}>{(Object.keys(widgetValues) as Widget['value'][]).map(id => <option key={id} value={id}>{widgetValues[id]}</option>)}</select></label>
                                <label>点击动作<select value={selectedWidget.action} onChange={event => editWidget(widget => { widget.action = event.target.value as Widget['action']; })}><option value="">无</option><option value="routes">打开故事路线</option><option value="settings">打开设置</option><option value="appearance">打开外观工作台</option></select></label>
                                {imageSelect('插图', selectedWidget.image, (draft, id) => { const widget = draft.widgets.find(item => item.id === selected); if (widget) widget.image = id; })}
                                <button type="button" className="ttm-btn-secondary" onClick={() => edit(draft => { draft.widgets = draft.widgets.filter(item => item.id !== selected); })}><Icon name="trash" width={16} height={16} />移除小组件</button></>}
                        </Group>}
                        <Group title="界面美术">{Object.entries({ ...artLabels, import: '导入图标' }).map(([id, label]) => <div key={id} className={selected === id ? 'is-selected-art' : ''}>
                            {imageSelect(label, skin.art[id] ?? '', (draft, source) => { draft.art[id] = source; })}
                        </div>)}<button type="button" className="ttm-btn-secondary" onClick={() => { const id = `widget-${crypto.randomUUID().slice(0, 8)}`; edit(draft => { draft.widgets.push({ id, label: '小组件', image: '', value: '', action: '' }); }); setSelected(id); }}><Icon name="plus" width={16} height={16} />添加小组件</button></Group>
                    </>}
                    {tab === 'css' && <>
                        <Group title="样式表"><label>软件界面 CSS<textarea className="ttm-skin-code" rows={15} spellCheck={false} value={skin.css} placeholder={'[data-ti-part="send"] {\n  border-radius: 6px;\n}'} onChange={event => edit(draft => { draft.css = event.target.value; })} /></label></Group>
                        <Group title="选择器"><label>界面区域<select defaultValue="" onChange={event => { if (!event.target.value) return; const value = event.target.value; edit(draft => { draft.css += `\n:scope[data-ti-shell="${value}"] {\n  \n}\n`; }); event.target.value = ''; }}><option value="">插入区域样式</option>{shellSurfaces.map(id => <option key={id}>{id}</option>)}</select></label>
                            <label>部件<select defaultValue="" onChange={event => { if (!event.target.value) return; const value = event.target.value; edit(draft => { draft.css += `\n[data-ti-part="${value}"] {\n  \n}\n`; }); event.target.value = ''; }}><option value="">插入部件样式</option>{[...Object.keys(parts), 'brand', 'logo', 'location', 'conversation-title', 'import', 'input', 'send', 'stop', 'more', 'more-panel', 'widget'].map(id => <option key={id}>{id}</option>)}</select></label></Group>
                        {saved.legacyCss && <Group title="旧版阅读 CSS"><label>保留的旧设置<textarea className="ttm-skin-code" readOnly rows={5} value={saved.legacyCss} /></label></Group>}
                    </>}
                    {tab === 'packages' && <>
                        <Group title="我的外观包">
                            <div className="ttm-skin-button-row"><FilePick title="导入外观包" extensions={['json']} pickMany={importPackages} onError={setError} disabled={busy} /></div>
                            {!packs.length ? <p className="ttm-skin-pack-empty">还没有保存的外观包。</p> : <ul className="ttm-skin-pack-list">
                                {packs.map(entry => {
                                    const active = saved.activePackId === entry.id;
                                    return <li className="ttm-skin-pack-row" key={entry.id}>
                                        <div className="ttm-skin-pack-name"><strong>{entry.name}</strong>
                                            {active && <span><Icon name="check" width={13} height={13} />{savedDevice.paused ? '已暂停' : '使用中'}</span>}
                                        </div>
                                        <div className="ttm-skin-pack-actions">
                                            <button type="button" className="ttm-btn-secondary" disabled={busy} onClick={() => previewPack(entry)}>预览</button>
                                            {(!active || savedDevice.paused) && <button type="button" className="ttm-btn-secondary" disabled={busy} onClick={() => applyPack(entry)}>使用</button>}
                                            <button type="button" className="ttm-icon-btn ttm-skin-pack-delete" disabled={busy} title="删除外观包" aria-label={`删除 ${entry.name}`} onClick={event => { setDeleteError(''); setPendingDelete({ entry, anchor: event.currentTarget }); }}><Icon name="trash" width={17} height={17} /></button>
                                        </div>
                                    </li>;
                                })}
                            </ul>}
                        </Group>
                        <Group title="当前草稿"><label>外观包名称<input value={skin.name} onChange={event => edit(draft => { draft.name = event.target.value; })} /></label><div className="ttm-skin-button-row">
                            <button type="button" className="ttm-btn-secondary" onClick={exportPackage}><Icon name="download" width={16} height={16} />导出外观包</button>
                            </div></Group>
                        <Group title="素材库"><div className="ttm-skin-button-row"><FilePick title="添加图片" extensions={mediaExtensions} pick={file => putAsset(file, 'image')} onError={setError} /><FilePick title="添加字体" extensions={fontExtensions} pick={file => putAsset(file, 'font')} onError={setError} /></div>
                            {assetKeys.map(id => <div key={id} className="ttm-skin-asset-line">{skin.assets[id].mime.startsWith('image/') && <img src={assetUrl(skin, id)} alt="" />}<span><strong>{skin.assets[id].name}</strong><code>asset:{id}</code></span><button type="button" className="ttm-icon-btn" title="移除素材" aria-label={`移除 ${skin.assets[id].name}`} onClick={() => edit(draft => {
                                delete draft.assets[id]; if (draft.wallpaper.source === id) draft.wallpaper.source = '';
                                for (const key of Object.keys(draft.art)) if (draft.art[key] === id) delete draft.art[key];
                                for (const font of Object.values(draft.fonts)) if (font.asset === id) font.asset = '';
                                for (const widget of draft.widgets) if (widget.image === id) widget.image = '';
                            })}><Icon name="trash" width={16} height={16} /></button></div>)}</Group>
                        <Group title="恢复外观"><button type="button" className="ttm-btn-secondary" disabled={!saved.previous || busy} onClick={() => update(draft => { draft.skin = saved.previous ?? blankAppearance(); draft.packId = saved.previousPackId; })}>载入上个保存版本</button>
                            <button type="button" className="ttm-btn-secondary" disabled={busy} onClick={() => update(draft => { draft.skin = blankAppearance(); draft.layouts = {}; draft.packId = null; }, true)}>恢复默认外观</button>
                        </Group>
                    </>}
                </div>
            </div>
            <div className="ttm-skin-preview">
                <div className="ttm-skin-preview-controls"><div className="ttm-skin-segments" aria-label="预览设备"><button type="button" aria-pressed={previewDevice === 'desktop'} onClick={() => setPreviewDevice('desktop')}>桌面</button><button type="button" aria-pressed={previewDevice === 'mobile'} onClick={() => setPreviewDevice('mobile')}>手机</button></div>
                    <label><span className="ttm-skin-visually-hidden">预览页面</span><select value={page} onChange={event => setPage(event.target.value as PreviewPage)}>{(Object.keys(pages) as PreviewPage[]).map(id => <option key={id} value={id}>{pages[id]}</option>)}</select></label>
                    <button type="button" className="ttm-btn-secondary" aria-pressed={compare} onClick={() => setCompare(!compare)}>{compare ? '查看草稿' : '对照已保存'}</button>
                </div>
                <AppearancePreview skin={displaySkin} css={previewCss} device={previewDevice} page={page} layout={compare ? savedDevice.layouts[previewDevice] : editableLayout} onSelect={onSelect} />
            </div>
            <footer className="ttm-skin-footer">
                <div className="ttm-skin-mobile-switch"><button type="button" className="ttm-btn-secondary" onClick={() => setPane(pane === 'edit' ? 'preview' : 'edit')}>{pane === 'edit' ? '查看预览' : '返回编辑'}</button></div>
                <button type="button" className="ttm-icon-btn" title="撤销" aria-label="撤销" disabled={!history.past.length || busy} onClick={() => changeHistory(-1)}><Icon name="history" width={17} height={17} /></button>
                <button type="button" className="ttm-icon-btn" title="重做" aria-label="重做" disabled={!history.future.length || busy} onClick={() => changeHistory(1)}><Icon name="history" width={17} height={17} style={{ transform: 'scaleX(-1)' }} /></button>
                <span className="ttm-skin-status" role={error ? 'alert' : 'status'}>{error || status || (savedDevice.paused ? '自定义外观已暂停' : dirty ? '有未保存的修改' : '')}</span>
                {savedDevice.paused && (saved.saved || Object.keys(savedDevice.layouts).length > 0) && !dirty && <button type="button" className="ttm-btn-secondary" onClick={() => pauseAppearance(false)}>重新启用</button>}
                <button type="button" className="ttm-btn-secondary" disabled={!dirty || busy} onClick={() => { setHistory(newHistory(currentDraft())); setCompare(false); setStatus(''); setError(''); }}>放弃修改</button>
                <button type="button" className="ttm-btn-primary" disabled={!dirty || busy} onClick={save}>{saving ? '正在保存' : '保存外观'}</button>
            </footer>
        </div>
    </AnchoredDialog>
    {pendingDelete && <AnchoredDialog title="删除外观包" anchor={pendingDelete.anchor} compact centered fitContent closeDisabled={packBusy} onClose={() => setPendingDelete(undefined)}>
        <div className="ttm-skin-delete-confirm">
            <p>确定从本机移除「{pendingDelete.entry.name}」？{saved.activePackId === pendingDelete.entry.id && '它正在使用，删除后会恢复默认外观。'}</p>
            {deleteError && <p className="ttm-skin-status" role="alert">{deleteError}</p>}
            <div className="ttm-editor-actions"><button type="button" className="ttm-btn-secondary" disabled={packBusy} onClick={() => setPendingDelete(undefined)}>取消</button>
                <button type="button" className="ttm-btn-danger" disabled={packBusy} onClick={() => removePack(pendingDelete.entry)}>{packBusy ? '正在删除…' : '确认删除'}</button></div>
        </div>
    </AnchoredDialog>}
    </>;
}

const defaultPreview = blankAppearance();

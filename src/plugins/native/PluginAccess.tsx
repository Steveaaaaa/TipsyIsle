import { useEffect, useState, type FormEvent } from 'react';
import type { ModelConnection, ModelKind } from '../../../packages/plugin-sdk/index.js';
import { workspaceStore } from '../../store/workspace-store';
import { resourceChoices } from './asset-data';
import { workflow } from './image-protocol';
import type { InstalledPlugin, PluginAccess } from './catalog';
import { connectionChoices, connectionStore, loadConnections, removeConnection, saveConnection, type ConnectionInput } from './connections';

export const kindLabels: Record<ModelKind, string> = { chat: '对话', image: '图片', speech: '语音', embedding: '文本嵌入' };
type Run = (run: () => Promise<void>) => void;
const blank: ConnectionInput = { label: '', model: '', baseUrl: '', apiKey: '', kind: 'chat' };

export function PluginConnections({ working, run }: { working: boolean; run: Run }) {
    const items = connectionStore.useStore(state => state.items);
    const [form, setForm] = useState<(ConnectionInput & { id?: string })>();
    useEffect(() => { void loadConnections().catch(() => {}); }, []);
    const change = (key: keyof ConnectionInput, value: string) => setForm(current => current && { ...current, [key]: value });
    const submit = (event: FormEvent) => {
        event.preventDefault();
        if (!form || working) return;
        const { id, ...input } = form;
        run(async () => { await saveConnection({ ...input, baseUrl: input.baseUrl.trim(), apiKey: input.apiKey.trim() }, id); setForm(undefined); });
    };
    let parsed:ReturnType<typeof workflow>|undefined; try{if(form?.workflowText)parsed=workflow(form.workflowText);}catch{ /* The JSON may still be in progress. */ }
    return <div className="ttm-native-access">
        {items.map(item => <div className="ttm-native-connection" key={item.id}>
            <div><strong>{item.label}</strong><small>{item.kinds.map(kind => kindLabels[kind]).join('、')} · {item.model}</small></div>
            <div className="ttm-native-actions"><button type="button" className="ttm-btn-secondary" disabled={working}
                onClick={() => setForm({ id: item.id, label: item.label, model: item.model, kind: item.kinds[0], baseUrl: item.baseUrl, apiKey: item.apiKey,providerKind:item.providerKind as ConnectionInput['providerKind'],workflowText:item.workflowText,preservePng:item.preservePng,slotOverrides:item.slotOverrides })}>编辑</button>
                <button type="button" className="ttm-btn-ghost" disabled={working} onClick={() => run(async () => {
                    await removeConnection(item.id); if (form?.id === item.id) setForm(undefined);
                })}>删除</button></div>
        </div>)}
        {!form ? <button type="button" className="ttm-btn-secondary" disabled={working} onClick={() => setForm(blank)}>添加模型连接</button>
            : <form onSubmit={submit} className="ttm-native-connection-form" autoComplete="off">
                <label className="ttm-native-field"><span>连接名称</span><input className="ttm-native-input" maxLength={80} required value={form.label} onChange={e => change('label', e.currentTarget.value)} /></label>
                <label className="ttm-native-field"><span>任务类型</span><select className="ttm-select-input" value={form.kind} onChange={e => change('kind', e.currentTarget.value)}>
                    {Object.entries(kindLabels).map(([id, label]) => <option value={id} key={id}>{label}</option>)}</select></label>
                <label className="ttm-native-field"><span>模型</span><input className="ttm-native-input" maxLength={300} required value={form.model} onChange={e => change('model', e.currentTarget.value)} /></label>
                {form.kind==='image' && <><label className="ttm-native-field">生图协议<select className="ttm-select-input" value={form.providerKind??'openai'} onChange={event=>change('providerKind',event.target.value)}>{Object.entries({openai:'OpenAI 兼容',moss:'MOSS-Image（OpenMOSS / 硅基流动等）',gemini:'Google Gemini',novelai:'NovelAI Diffusion',comfyui:'ComfyUI 工作流',webui:'SD WebUI / Forge'}).map(([key,title])=><option key={key} value={key}>{title}</option>)}</select></label>
                    {form.providerKind==='comfyui' && <><label>导入 API 工作流<input type="file" accept="application/json,.json" onChange={event=>{const file=event.target.files?.[0];if(file)run(async()=>{if(file.size>512000)throw new Error('工作流过大');change('workflowText',await file.text());});}} /></label><label>工作流 JSON<textarea value={form.workflowText??''} required maxLength={512000} onChange={event=>change('workflowText',event.target.value)}/></label>{parsed && <details><summary>检查和调整槽位</summary>{['prompt','negativePrompt','width','height','seed','charRef','styleRef'].map(slot=><label key={slot}>{slot}<select value={JSON.stringify(form.slotOverrides?.[slot]??parsed!.slots[slot]??null)} onChange={event=>{const overrides={...form.slotOverrides};if(event.target.value==='null')delete overrides[slot];else overrides[slot]=JSON.parse(event.target.value);setForm({...form,slotOverrides:overrides});}}><option value="null">自动识别</option>{Object.entries(parsed!.graph).flatMap(([key,node])=>Object.keys(node.inputs).filter(input=>!Array.isArray(node.inputs[input])).map(input=><option key={`${key}:${input}`} value={JSON.stringify([key,input])}>{key} · {node.class_type} · {input}</option>))}</select></label>)}</details>}</>}
                    <label><input type="checkbox" checked={!!form.preservePng} onChange={event=>setForm({...form,preservePng:event.target.checked})}/>保留原始图片，不转换为 WebP</label></>}
                <label className="ttm-native-field"><span>API 地址</span><input className="ttm-native-input" type="url" required placeholder="https://…/v1" value={form.baseUrl} onChange={e => change('baseUrl', e.currentTarget.value)} /></label>
                <label className="ttm-native-field"><span>API 密钥</span><input className="ttm-native-input" type="password" autoComplete="new-password" maxLength={4000} value={form.apiKey} onChange={e => change('apiKey', e.currentTarget.value)} /></label>
                <div className="ttm-native-actions"><button type="button" className="ttm-btn-secondary" disabled={working} onClick={() => setForm(undefined)}>取消</button>
                    <button type="submit" className="ttm-btn-primary" disabled={working}>保存连接</button></div>
            </form>}
    </div>;
}

const empty: PluginAccess = { assets: [], connections: [], origins: [] };
type Options = { id: string; label: string; detail?: string }[];
const assetLabel = { character: '角色卡', worldbook: '世界书', preset: '预设' } as const;
export function PluginResourceAccess({ plugin, disabled, onSave }: { plugin: InstalledPlugin; disabled: boolean; onSave(value: PluginAccess): void }) {
    const baseline = plugin.access ?? empty;
    const [grant, setGrant] = useState(baseline);
    const [models, setModels] = useState<ModelConnection[]>([]);
    const [error, setError] = useState('');
    const connections = connectionStore.useStore(state => state.items);
    const characters = workspaceStore.useStore(state => state.characters);
    const books = workspaceStore.useStore(state => state.lorebooks);
    const presets = workspaceStore.useStore(state => state.presets);
    const { permissions, origins } = plugin.manifest;
    useEffect(() => {
        if (!permissions.includes('models.use')) return;
        let alive = true;
        void connectionChoices().then(items => { if (alive) { setModels(items); setError(''); } }, () => { if (alive) setError('读取模型连接失败'); });
        return () => { alive = false; };
    }, [connections, permissions]);
    const choices = (key: keyof PluginAccess, label: string, options: Options, emptyText: string) => <fieldset className="ttm-native-grants">
        <legend>{label}</legend>
        {options.length ? options.map(option => <label className="ttm-native-grant" key={option.id}>
            <input type="checkbox" disabled={disabled} checked={grant[key].includes(option.id)} onChange={event => {
                const checked = event.currentTarget.checked;
                setGrant(state => ({ ...state, [key]: checked ? [...state[key], option.id] : state[key].filter(id => id !== option.id) }));
            }} /><span>{option.label}{option.detail && <small>{option.detail}</small>}</span>
        </label>) : <p className="ttm-settings-note">{emptyText}</p>}
    </fieldset>;
    const assets = permissions.includes('assets.write') ? resourceChoices({ characters, lorebooks: books, presets }) : [];
    const edited = (Object.keys(grant) as (keyof PluginAccess)[]).some(key => grant[key].length !== baseline[key].length || grant[key].some(id => !baseline[key].includes(id)));
    return <div className="ttm-native-access">
        {permissions.includes('models.use') && choices('connections', '模型连接', models.map(model => ({ id: model.id, label: model.label,
            detail: `${model.kinds.map(kind => kindLabels[kind]).join('、')} · ${model.model}` })), error || '没有可授权的连接')}
        {permissions.includes('assets.write') && choices('assets', '允许修改的资源', assets.map(asset => ({ ...asset, detail: assetLabel[asset.kind] })), '没有可授权的资源')}
        {permissions.includes('network.request') && choices('origins', '允许访问的网址', (origins ?? []).map(origin => ({ id: origin, label: origin })), '清单未声明网址')}
        {edited && <div className="ttm-native-actions"><button type="button" className="ttm-btn-secondary" disabled={disabled} onClick={() => setGrant(baseline)}>放弃修改</button>
            <button type="button" className="ttm-btn-primary" disabled={disabled} onClick={() => onSave(grant)}>保存授权</button></div>}
    </div>;
}

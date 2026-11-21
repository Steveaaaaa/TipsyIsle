import { useEffect, useRef, useState } from 'react';
import { fetchModelCatalog, modelListConnection, modelCatalogIdentity, readModelCatalogCache, saveModelCatalogCache, type CatalogModel } from '../core/model-catalog';
import { useSettingsEditor } from './settings-draft';

export function ModelNameInput({ fieldId, inputId, value, settings, describedBy, placeholder, disabled, onChange }: {
    fieldId: string; value: string; settings: Record<string, unknown>; describedBy?: string; placeholder?: string; disabled?: boolean;
    inputId?: string;
    onChange?: (value: string) => void;
}) {
    const { setValue: setSchemaValue, setValues: setSchemaValues } = useSettingsEditor();
    const [models, setModels] = useState<CatalogModel[]>([]);
    const [query, setQuery] = useState('');
    const [busy, setBusy] = useState(false);
    const [feedback, setFeedback] = useState('');
    const [failed, setFailed] = useState(false);
    const controller = useRef<AbortController>();
    const requestVersion = useRef(0);
    const [cached, setCached] = useState(false);
    const prefix = fieldId.split('.')[0];
    let connectionKey = '';
    try { connectionKey = modelCatalogIdentity(modelListConnection(fieldId, settings)); } catch { /* A header draft may not yet be valid JSON. */ }
    useEffect(() => {
        const version = ++requestVersion.current;
        setModels([]); setQuery(''); setFeedback(''); setBusy(false); setFailed(false); setCached(false);
        if (connectionKey) void readModelCatalogCache(modelListConnection(fieldId, settings)).then(result => {
            if (version !== requestVersion.current || result === null) return;
            setModels(result); setCached(true); setFeedback(`已载入保存的 ${result.length} 个模型，可直接更换；需要最新列表时点击刷新。`);
        }).catch(() => {});
        return () => { ++requestVersion.current; controller.current?.abort(); };
    }, [connectionKey]);
    const load = async () => {
        const request = new AbortController(); controller.current = request;
        ++requestVersion.current;
        setBusy(true); setFeedback(''); setFailed(false); setQuery('');
        try {
            const connection = modelListConnection(fieldId, settings);
            const result = await fetchModelCatalog(connection, request.signal);
            if (request.signal.aborted) return;
            setModels(result); setCached(true);
            await saveModelCatalogCache(connection, result);
            if (request.signal.aborted) return;
            setFeedback(result.length ? `已获取 ${result.length} 个模型，请选择；也可以直接填写模型名称。${prefix === 'vectors' ? '请选用嵌入模型，列表也可能包含对话模型。' : ''}`
                : '接口返回的模型列表为空，仍可手动填写模型名称。');
        } catch (error) {
            if (request.signal.aborted) return;
            setFailed(true);
            setFeedback(error instanceof Error && error.name === 'TimeoutError' ? '获取模型列表超时，可以重试或手动填写。'
                : error instanceof Error ? error.message : '无法获取模型列表，请检查地址和密钥。');
        } finally { if (!request.signal.aborted) setBusy(false); }
    };
    const filtered = models.filter(model => model.id.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
    const id = inputId ?? `ttm-field-${fieldId}`;
    const feedbackId = `${id}-catalog-status`;
    const descriptionIds = [describedBy, feedback ? feedbackId : undefined].filter(Boolean).join(' ') || undefined;
    return <div className="ttm-model-picker" aria-busy={busy}>
        <div className="ttm-model-input-row">
            <input id={id} type="text" className="ttm-text-input" value={value} placeholder={placeholder || '选择或填写模型名称'} disabled={disabled}
                autoCapitalize="none" spellCheck={false} aria-describedby={descriptionIds} onChange={event => onChange ? onChange(event.target.value) : setSchemaValue(fieldId, event.target.value)} />
            <button type="button" className="ttm-btn-secondary" disabled={disabled || busy} onClick={() => void load()}>{busy ? '正在获取…' : cached ? '刷新模型列表' : '获取模型列表'}</button>
        </div>
        {!!models.length && <div className="ttm-model-catalog">
            {models.length > 12 && <input type="search" className="ttm-text-input" aria-label="筛选模型列表" placeholder="输入关键词筛选模型" value={query} disabled={disabled} autoCapitalize="none" spellCheck={false} onChange={event => setQuery(event.target.value)} />}
            <select className="ttm-select-input" aria-label="选择已获取的模型" disabled={disabled} value={filtered.some(model => model.id === value) ? value : ''} onChange={event => {
                const model = models.find(item => item.id === event.target.value); if (!model) return;
                if (onChange) { onChange(model.id); return; }
                setSchemaValues({ [fieldId]: model.id, ...(fieldId === 'mvu.model' && settings['mvu.source'] === '更多' ? {
                    ...(model.api ? { 'mvu.provider_api': model.api } : {}), ...(model.contextWindow ? { 'mvu.context_window': model.contextWindow } : {}),
                } : {}) });
            }}>
                <option value="">{filtered.length ? `选择模型（${filtered.length} 个）` : '没有匹配的模型，请更换关键词'}</option>
                {filtered.map(model => <option key={model.id} value={model.id}>{model.id}</option>)}
            </select>
        </div>}
        {feedback && <p id={feedbackId} className={failed ? 'ttm-settings-error' : 'ttm-settings-note'} role={failed ? 'alert' : 'status'}>{feedback}</p>}
    </div>;
}

import { useEffect, useRef, useState } from 'react';
import { fetchModelCatalog, modelListConnection, modelCatalogIdentity, readModelCatalogCache, saveModelCatalogCache, type CatalogModel, type ModelListConnection } from '../core/model-catalog';
import { useSettingsEditor } from './settings-draft';

export function ModelNameInput({ fieldId, inputId, value, settings, connection, describedBy, placeholder, disabled, required, onChange }: {
    fieldId?: string; value: string; settings?: Record<string, unknown>; connection?: ModelListConnection; describedBy?: string; placeholder?: string; disabled?: boolean;
    inputId?: string;
    required?: boolean;
    onChange?: (value: string) => void;
}) {
    const { setValue: setSchemaValue, setValues: setSchemaValues } = useSettingsEditor();
    const [models, setModels] = useState<CatalogModel[]>([]);
    const [query, setQuery] = useState('');
    const [manualMode, setManualMode] = useState(false);
    const [busy, setBusy] = useState(false);
    const [feedback, setFeedback] = useState('');
    const [failed, setFailed] = useState(false);
    const controller = useRef<AbortController>();
    const requestVersion = useRef(0);
    const [cached, setCached] = useState(false);
    const prefix = (fieldId ?? 'api.model').split('.')[0];
    const resolveConnection = (): ModelListConnection => connection ?? modelListConnection(fieldId ?? 'api.model', settings ?? {});
    let connectionKey = '';
    try { connectionKey = modelCatalogIdentity(resolveConnection()); } catch { /* A header draft may not yet be valid JSON. */ }
    useEffect(() => {
        const version = ++requestVersion.current;
        setModels([]); setQuery(''); setManualMode(false); setFeedback(''); setBusy(false); setFailed(false); setCached(false);
        if (connectionKey) void readModelCatalogCache(resolveConnection()).then(result => {
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
            const targetConnection = resolveConnection();
            const result = await fetchModelCatalog(targetConnection, request.signal);
            if (request.signal.aborted) return;
            setModels(result); setCached(true);
            if (result.length) setManualMode(false);
            await saveModelCatalogCache(targetConnection, result);
            if (request.signal.aborted) return;
            setFeedback(result.length ? `已获取 ${result.length} 个模型，请从列表中选择。${prefix === 'vectors' ? '请选用嵌入模型，列表也可能包含对话模型。' : ''}`
                : '接口返回的模型列表为空，请手动填写模型名称。');
        } catch (error) {
            if (request.signal.aborted) return;
            setFailed(true);
            setFeedback(error instanceof Error && error.name === 'TimeoutError' ? '获取模型列表超时，可以重试或手动填写。'
                : error instanceof Error ? error.message : '无法获取模型列表，请检查地址和密钥。');
        } finally { if (!request.signal.aborted) setBusy(false); }
    };
    const filtered = models.filter(model => model.id.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
    const useCatalogPicker = models.length > 0 && !manualMode;
    const id = inputId ?? `ttm-field-${fieldId}`;
    const feedbackId = `${id}-catalog-status`;
    const descriptionIds = [describedBy, feedback ? feedbackId : undefined].filter(Boolean).join(' ') || undefined;
    const valueInCatalog = models.some(model => model.id === value);
    const valueInFiltered = filtered.some(model => model.id === value);
    return <div className="ttm-model-picker" aria-busy={busy}>
        {useCatalogPicker ? (
            <div className="ttm-model-catalog">
                {models.length > 12 && <input type="search" className="ttm-text-input" aria-label="筛选模型列表" placeholder="输入关键词筛选模型" value={query} disabled={disabled} autoCapitalize="none" spellCheck={false} onChange={event => setQuery(event.target.value)} />}
                <div className="ttm-model-input-row">
                    <select id={id} className="ttm-select-input" aria-label="选择已获取的模型" aria-describedby={descriptionIds} disabled={disabled} required={required} value={value} onChange={event => {
                        const picked = event.target.value;
                        if (!picked) return;
                        const model = models.find(item => item.id === picked);
                        if (onChange) { onChange(picked); return; }
                        const targetField = fieldId ?? 'api.model';
                        const activeSettings = settings ?? {};
                        setSchemaValues({ [targetField]: picked, ...(model && targetField === 'mvu.model' && activeSettings['mvu.source'] === '更多' ? {
                            ...(model.api ? { 'mvu.provider_api': model.api } : {}), ...(model.contextWindow ? { 'mvu.context_window': model.contextWindow } : {}),
                        } : {}) });
                    }}>
                        {!value && <option value="">{filtered.length ? `选择模型（${filtered.length} 个）` : '没有匹配的模型，请更换关键词'}</option>}
                        {value && !valueInFiltered && <option value={value}>{valueInCatalog ? `${value}（当前已选）` : `${value}（自定义）`}</option>}
                        {filtered.map(model => <option key={model.id} value={model.id}>{model.id}</option>)}
                    </select>
                    <button type="button" className="ttm-btn-secondary" disabled={disabled || busy} onClick={() => void load()}>{busy ? '正在获取…' : '刷新模型列表'}</button>
                </div>
            </div>
        ) : (
            <div className="ttm-model-input-row">
                <input id={id} type="text" className="ttm-text-input" value={value} placeholder={placeholder || '选择或填写模型名称'} disabled={disabled} required={required}
                    autoCapitalize="none" spellCheck={false} aria-describedby={descriptionIds} onChange={event => onChange ? onChange(event.target.value) : setSchemaValue(fieldId ?? 'api.model', event.target.value)} />
                <button type="button" className="ttm-btn-secondary" disabled={disabled || busy} onClick={() => void load()}>{busy ? '正在获取…' : cached ? '刷新模型列表' : '获取模型列表'}</button>
            </div>
        )}
        {(feedback || models.length > 0) && <div className="ttm-model-picker-footer">
            {feedback && <p id={feedbackId} className={failed ? 'ttm-settings-error' : 'ttm-settings-note'} role={failed ? 'alert' : 'status'}>{feedback}</p>}
            {models.length > 0 && (
                <button type="button" className="ttm-model-mode-toggle" disabled={disabled} onClick={() => setManualMode(current => !current)}>
                    {manualMode ? '返回模型列表' : '手动输入模型名'}
                </button>
            )}
        </div>}
    </div>;
}

import { useState } from 'react';
import { useSettingsEditor } from './settings-draft';
import { isNativeRuntime } from '../core/native-runtime';
import type { SchemaFieldDescriptor } from '../types';
import { ModelNameInput } from './ModelNameInput';

export interface SchemaFormRendererProps {
    fieldIds?: string[];
    fieldOverrides?: Record<string, Partial<SchemaFieldDescriptor>>;
    ungrouped?: boolean;
    inlineHelpIds?: ReadonlySet<string>;
    disabled?: boolean;
    displayValues?: Record<string, unknown>;
}

export function SchemaFormRenderer({ fieldIds, fieldOverrides = {}, ungrouped = false, inlineHelpIds, disabled = false, displayValues }: SchemaFormRendererProps) {
    const { fields, values } = useSettingsEditor();
    const [activeHelpId, setActiveHelpId] = useState<string | null>(null);

    const selected = (fieldIds ? fieldIds.map(id => fields[id]).filter(Boolean) : Object.values(fields))
        .map(field => ({ ...field, ...fieldOverrides[field.id] }));
    const renderField = (field: SchemaFieldDescriptor) => {
        const inline = Boolean(inlineHelpIds?.has(field.id));
        return <SchemaFieldItem key={field.id} field={field} value={displayValues?.[field.id] ?? values[field.id]} disabled={disabled}
            settings={displayValues ?? values} ungrouped={ungrouped}
            helpExpanded={inline || activeHelpId === field.id} onToggleHelp={() => setActiveHelpId(activeHelpId === field.id ? null : field.id)} />;
    };

    return <fieldset className="ttm-settings-fields" disabled={disabled}>{selected.map(renderField)}</fieldset>;
}

interface SchemaFieldItemProps {
    field: SchemaFieldDescriptor;
    value: unknown;
    helpExpanded: boolean;
    onToggleHelp: () => void;
    disabled?: boolean;
    ungrouped?: boolean;
    settings: Record<string, unknown>;
}

function SchemaFieldItem({ field, value, helpExpanded, onToggleHelp, disabled, ungrouped = false, settings }: SchemaFieldItemProps) {
    const { setValue: setSchemaValue } = useSettingsEditor();
    const resolvedValue = value ?? field.defaultValue;
    const [secretVisible, setSecretVisible] = useState(false);
    const describedBy = field.description && (helpExpanded || (!ungrouped && field.mobileWeight === 'essential')) ? `ttm-help-${field.id}` : undefined;
    const native = isNativeRuntime();
    const visibleOptions = (field.options || []).filter(opt => {
        if (!native || String(resolvedValue ?? '') === String(opt.value)) return true;
        if (field.id === 'api.chat_completion_source' && opt.value === 'vertexai') return false;
        if (field.id === 'mvu.source' && opt.value === '更多') return false;
        return true;
    });

    return (
        <div className="ttm-field-card" data-setting-id={field.id}>
            <div className="ttm-field-top">
                <div className="ttm-field-label-wrap">
                    <label className="ttm-field-title" htmlFor={`ttm-field-${field.id}`}>
                        {field.title}
                    </label>
                    {field.description && !helpExpanded && <button
                        type="button"
                        className="ttm-field-help-btn"
                        title={field.description}
                        onClick={onToggleHelp}
                        aria-label={`查看${field.title}的说明`}
                        aria-expanded={helpExpanded}
                    >
                        ?
                    </button>}
                </div>

                {field.type === 'number' && (
                    <input
                        type="number"
                        className="ttm-number-badge-input"
                        aria-label={field.title}
                        id={field.validation?.min !== undefined && field.validation?.max !== undefined ? undefined : `ttm-field-${field.id}`}
                        aria-describedby={describedBy}
                        disabled={disabled}
                        value={resolvedValue === '' ? '' : Number(resolvedValue ?? 0)}
                        min={field.validation?.min}
                        max={field.validation?.max}
                        step={field.validation?.step ?? 0.01}
                        onChange={(e) => setSchemaValue(field.id, e.target.value === '' ? '' : Number(e.target.value))}
                    />
                )}

                {field.type === 'boolean' && (
                    <button
                        id={`ttm-field-${field.id}`}
                        type="button"
                        role="switch"
                        aria-label={field.title}
                        aria-checked={Boolean(resolvedValue)}
                        aria-describedby={describedBy}
                        disabled={disabled}
                        className={`ttm-switch ${resolvedValue ? 'is-on' : ''}`}
                        onClick={() => setSchemaValue(field.id, !resolvedValue)}
                    >
                        <span className="ttm-switch-thumb" />
                    </button>
                )}
            </div>

            {describedBy && (
                <p className="ttm-field-desc" id={describedBy}>{field.description}</p>
            )}

            {field.type === 'number' && field.validation?.min !== undefined && field.validation?.max !== undefined && (
                <div className="ttm-slider-row">
                    <input
                        id={`ttm-field-${field.id}`}
                        type="range"
                        className="ttm-range-slider"
                        aria-describedby={describedBy}
                        disabled={disabled}
                        min={field.validation.min}
                        max={field.validation.max}
                        step={field.validation.step ?? 0.01}
                        value={Number(resolvedValue ?? 0)}
                        onChange={(e) => setSchemaValue(field.id, Number(e.target.value))}
                    />
                </div>
            )}

            {['api.model', 'mvu.model', 'vectors.model'].includes(field.id) ? <ModelNameInput fieldId={field.id} value={String(resolvedValue ?? '')} settings={settings} disabled={disabled} describedBy={describedBy} placeholder={field.placeholder} /> : (field.type === 'string' || field.type === 'text') && (
                <input
                    id={`ttm-field-${field.id}`}
                    type="text"
                    className="ttm-text-input"
                    aria-describedby={describedBy}
                    disabled={disabled}
                    placeholder={field.placeholder || ''}
                    value={String(resolvedValue ?? '')}
                    onChange={(e) => setSchemaValue(field.id, e.target.value)}
                />
            )}

            {(field.type === 'secret' || field.type === 'password') && <div className="ttm-setting-secret">
                <input
                    id={`ttm-field-${field.id}`}
                    type={secretVisible ? 'text' : 'password'}
                    className="ttm-text-input"
                    autoComplete="off"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    aria-describedby={describedBy}
                    disabled={disabled}
                    placeholder={field.placeholder || '••••••••'}
                    value={String(resolvedValue ?? '')}
                    onChange={(e) => setSchemaValue(field.id, e.target.value)}
                /><button type="button" className="ttm-btn-ghost" disabled={disabled} aria-controls={`ttm-field-${field.id}`} aria-pressed={secretVisible} onClick={() => setSecretVisible(!secretVisible)}>{secretVisible ? '隐藏' : '显示'}</button>
            </div>}

            {field.type === 'textarea' && <textarea id={`ttm-field-${field.id}`} className="ttm-textarea" rows={5} disabled={disabled}
                aria-describedby={describedBy} value={String(resolvedValue ?? '')} placeholder={field.placeholder}
                onChange={event => setSchemaValue(field.id, event.target.value)} />}

            {field.type === 'select' && (
                <select
                    id={`ttm-field-${field.id}`}
                    className="ttm-select-input"
                    aria-describedby={describedBy}
                    disabled={disabled}
                    value={String(resolvedValue ?? '')}
                    onChange={(e) => setSchemaValue(field.id, e.target.value)}
                >
                    {visibleOptions.map((opt) => (
                        <option key={String(opt.value)} value={String(opt.value)}>
                            {opt.label}
                        </option>
                    ))}
                </select>
            )}
        </div>
    );
}

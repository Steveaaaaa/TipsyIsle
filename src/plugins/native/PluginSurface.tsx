import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import type { CommandInput, Panel, PanelActionIcon, SurfaceBlock, TaskView } from '../../../packages/plugin-sdk/index.js';
import { saveExport } from '../../core/platform-files';
import { Icon } from '../../shell/Icon';
import { errorMessage } from './catalog';

const IsolatedLayout = lazy(() => import('./IsolatedLayout'));
const imageTypes = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif']);
const audioTypes = new Set(['audio/mpeg', 'audio/wav', 'audio/x-wav', 'audio/ogg', 'audio/webm', 'audio/mp4', 'audio/aac', 'audio/flac']);

function PanelSvgIcon({ name, size = 15 }: { name: PanelActionIcon | 'aperture'; size?: number }) {
    const common = { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.75, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true as const };
    switch (name) {
        case 'aperture':
            return <svg {...common}><circle cx="12" cy="12" r="9" /><path d="m14.31 8 5.74 9.94M9.69 8h11.48M7.38 12l5.74-9.94M9.69 16 3.95 6.06M14.31 16H2.83m13.79-4-5.74 9.94" /></svg>;
        case 'sparkle':
            return <svg {...common}><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9Z" /><path d="M19 3v3m1.5-1.5h-3M5 17v3m1.5-1.5h-3" /></svg>;
        case 'film':
            return <svg {...common}><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M7 5v14M17 5v14M3 9.5h4M17 9.5h4M3 14.5h4M17 14.5h4" /></svg>;
        case 'stage':
            return <svg {...common}><rect x="3" y="4" width="18" height="14" rx="2" /><path d="M3 14l4.5-4.5 3.5 3.5 3-3 7 5M8 21h8" /></svg>;
        case 'trash':
            return <svg {...common}><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" /></svg>;
        case 'download':
            return <svg {...common}><path d="M12 4v11m0 0-4-4m4 4 4-4M4 19h16" /></svg>;
        case 'refresh':
            return <svg {...common}><path d="M20 11a8 8 0 0 0-14.3-4.6L4 8m0-4v4h4M4 13a8 8 0 0 0 14.3 4.6L20 16m0 4v-4h-4" /></svg>;
        case 'sliders':
            return <svg {...common}><path d="M4 7h10m4 0h2M4 12h4m4 0h8M4 17h12m4 0h0" /><circle cx="16" cy="7" r="2" /><circle cx="10" cy="12" r="2" /><circle cx="14" cy="17" r="2" /></svg>;
    }
}

function MediaBlock({ owner, block, darkroom }: { owner: string; block: Extract<SurfaceBlock, { type: 'media' }>; darkroom: boolean }) {
    const [media, setMedia] = useState<{ blob: Blob; url: string; name: string }>();
    const [error, setError] = useState('');
    useEffect(() => {
        let active = true, url: string | undefined;
        void import('./media').then(({ loadMedia }) => loadMedia(owner, block.id)).then(({ blob, handle }) => {
            if (!active) return;
            url = URL.createObjectURL(blob); setMedia({ blob, url, name: handle.name });
        }).catch(err => { if (active) setError(errorMessage(err)); });
        return () => { active = false; if (url) URL.revokeObjectURL(url); };
    }, [owner, block.id]);

    const featured = block.featured || darkroom;
    const isImage = !!media && imageTypes.has(media.blob.type);
    const save = () => {
        if (!media) return;
        const name = (media.name || block.label).replace(/[\\/:*?"<>|]/g, '-');
        const subtype = /^\w+\/([a-z0-9]+)$/i.exec(media.blob.type)?.[1];
        void saveExport(media.blob, /\.\w{1,6}$/.test(name) ? name : `${name}.${subtype === 'mpeg' ? 'mp3' : subtype ?? 'bin'}`).catch(err => setError(errorMessage(err)));
    };

    return <figure className={`ttm-native-media${featured ? ' is-featured' : ''}`}>
        {isImage && <div className="ttm-native-media-stage">
            {featured && <img className="ttm-native-media-backdrop" src={media.url} alt="" aria-hidden="true" />}
            <img className="ttm-native-media-img" src={media.url} alt={block.label} />
            {featured && <span className="ttm-vf-corners" aria-hidden="true" />}
            {block.meta && <span className="ttm-native-media-meta">{block.meta}</span>}
        </div>}
        {media && audioTypes.has(media.blob.type) && <audio src={media.url} controls preload="metadata" aria-label={block.label} />}
        <figcaption className="ttm-native-media-footer">
            <div className="ttm-native-media-copy">
                <strong>{block.label}</strong>
                {block.caption && <small>{block.caption}</small>}
            </div>
            {media && <button type="button" className="ttm-icon-btn ttm-native-media-save" aria-label={`保存${block.label}`} title={`保存${block.label}`} onClick={save}>
                <Icon name="download" width={17} height={17} />
            </button>}
        </figcaption>
        {error && <span role="alert" className="ttm-native-error">{error}</span>}
    </figure>;
}

function FilmstripFrame({ owner, item, index, disabled, onSelect }: {
    owner: string;
    item: Extract<SurfaceBlock, { type: 'filmstrip' }>['items'][number];
    index: number;
    disabled: boolean;
    onSelect: () => void;
}) {
    const [url, setUrl] = useState('');
    useEffect(() => {
        let active = true, objectUrl = '';
        void import('./media').then(({ loadMedia }) => loadMedia(owner, item.id)).then(({ blob }) => {
            if (!active || !imageTypes.has(blob.type)) return;
            objectUrl = URL.createObjectURL(blob);
            setUrl(objectUrl);
        }).catch(() => {});
        return () => { active = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
    }, [owner, item.id]);
    const indexTag = String(index + 1).padStart(2, '0');
    const content = <>
        <span className="ttm-filmstrip-thumb">
            {url ? <img src={url} alt={item.label} /> : <span className="ttm-filmstrip-empty" aria-hidden="true" />}
            <span className="ttm-filmstrip-idx">{indexTag}</span>
        </span>
        <span className="ttm-filmstrip-meta">
            <strong>{item.label}</strong>
            {item.caption && <small>{item.caption}</small>}
        </span>
    </>;
    if (item.actionId) {
        return <button type="button" className={`ttm-filmstrip-card${item.active ? ' is-active' : ''}`} disabled={disabled}
            aria-current={item.active ? 'true' : undefined} title={item.label} onClick={onSelect}>{content}</button>;
    }
    return <div className={`ttm-filmstrip-card${item.active ? ' is-active' : ''}`}>{content}</div>;
}

function FilmstripBlock({ owner, block, disabled, onSelect }: {
    owner: string;
    block: Extract<SurfaceBlock, { type: 'filmstrip' }>;
    disabled: boolean;
    onSelect: (actionId: string, item: Extract<SurfaceBlock, { type: 'filmstrip' }>['items'][number], index: number) => void;
}) {
    return <section className="ttm-native-filmstrip" aria-label={block.label || '胶片底片轨'}>
        {block.label && <header className="ttm-native-filmstrip-head"><PanelSvgIcon name="film" size={14} /><span>{block.label}</span></header>}
        <div className="ttm-native-filmstrip-rail">
            {block.items.map((item, idx) => <FilmstripFrame key={`${item.id}:${idx}`} owner={owner} item={item} index={idx} disabled={disabled}
                onSelect={() => { if (item.actionId) onSelect(item.actionId, item, idx); }} />)}
        </div>
    </section>;
}

function aspectPreviewStyle(ratioValue: string): { width: number; height: number } | null {
    const match = /^(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)$/.exec(ratioValue.trim());
    if (!match) return null;
    const w = Number(match[1]), h = Number(match[2]);
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
    const scale = Math.min(26 / w, 20 / h);
    return { width: Math.max(8, Math.round(w * scale)), height: Math.max(8, Math.round(h * scale)) };
}

function splitOptionLabel(raw: string): { primary: string; secondary?: string } {
    const parts = raw.split('·').map(p => p.trim()).filter(Boolean);
    if (parts.length >= 2) return { primary: parts[parts.length - 1], secondary: parts.slice(0, -1).join(' · ') };
    return { primary: raw };
}

const taskStates = { queued: '等待执行', running: '正在处理', done: '已完成', failed: '任务失败', cancelled: '已取消' } as const;
export function SurfaceTask({ owner, id, onFinished }: { owner: string; id: string; onFinished(state: TaskView['state']): void }) {
    const [view, setView] = useState<TaskView>();
    const [error, setError] = useState('');
    const [cancelling, setCancelling] = useState(false);
    const read = useRef<typeof import('./tasks')>();
    const finished = useRef(onFinished);
    finished.current = onFinished;
    useEffect(() => {
        let active = true, off: (() => void) | undefined;
        void import('./tasks').then(tasks => {
            if (!active) return;
            read.current = tasks;
            const update = () => { if (active) setView(tasks.taskView(owner, id)); };
            off = tasks.subscribeTask(owner, id, update); update();
        }).catch(err => { if (active) setError(errorMessage(err)); });
        return () => { active = false; off?.(); };
    }, [owner, id]);
    useEffect(() => {
        if (view && ['done', 'failed', 'cancelled'].includes(view.state)) finished.current(view.state);
    }, [view?.state]);
    const state = view?.state ?? 'queued', active = state === 'queued' || state === 'running';
    return <section className="ttm-native-task" aria-label="后台任务">
        <div><strong role="status">{error && !view ? '任务不可用' : taskStates[state]}</strong>{view && active && <button type="button" className="ttm-btn-ghost" disabled={cancelling} onClick={() => {
            try { read.current?.cancelTask(owner, id); setCancelling(true); } catch (err) { setError(errorMessage(err)); }
        }}>取消任务</button>}</div>
        {!error && active && <progress aria-label="任务进度" max={1} value={view?.progress} />}
        {(error || view?.error) && <span className="ttm-native-error" role="alert">{error || view?.error?.message}</span>}
        {view?.delta && <pre className="ttm-native-task-text">{view.delta.slice(-16_000)}</pre>}
    </section>;
}

export function PluginPanel({ owner, panel, disabled, onAction }: { owner: string; panel: Panel; disabled: boolean; onAction(action: NonNullable<CommandInput['action']>): void }) {
    const [values, setValues] = useState<Record<string, string | boolean>>(() => Object.fromEntries((panel.fields ?? []).map(field =>
        [field.id, field.initial ?? (field.type === 'checkbox' ? false : field.options?.[0]?.value ?? '')])));
    const update = (id: string, value: string | boolean) => setValues(current => ({ ...current, [id]: value }));
    const darkroom = panel.theme === 'darkroom';

    const blocks = panel.blocks?.map((block, index) => {
        if (block.type === 'text') return <p key={index} className="ttm-native-copy">{block.text}</p>;
        if (block.type === 'list') return <ul key={index}>{block.items.map((item, i) => <li key={i}>{item}</li>)}</ul>;
        if (block.type === 'notice') return <div key={index} className={`ttm-native-notice is-${block.tone ?? 'info'}`} role="status">{block.text}</div>;
        if (block.type === 'badges') {
            return <div key={index} className="ttm-native-badges">
                {block.items.map((badge, i) => <span key={i} className={`ttm-native-badge is-${badge.tone ?? 'default'}`}>
                    <span className="ttm-native-badge-label">{badge.label}</span>
                    {badge.value !== undefined && <strong className="ttm-native-badge-val">{badge.value}</strong>}
                </span>)}
            </div>;
        }
        if (block.type === 'filmstrip') {
            return <FilmstripBlock key={`filmstrip:${index}`} owner={owner} block={block} disabled={disabled}
                onSelect={(actionId, item, idx) => !disabled && onAction({ id: actionId, values: { ...values, value: item.value ?? String(idx), index: String(idx) }, state: panel.state })} />;
        }
        if (block.type === 'media') return <MediaBlock key={`${index}:${block.id}`} owner={owner} block={block} darkroom={darkroom} />;
        return <div className="ttm-native-table" key={index} tabIndex={0}>
            <table><thead><tr>{block.columns.map((label, i) => <th key={i} scope="col">{label}</th>)}</tr></thead>
                <tbody>{block.rows.map((row, i) => <tr key={i}>{block.columns.map((_, j) => <td key={j}>{row[j]}</td>)}</tr>)}</tbody></table>
        </div>;
    });

    return <div className={`ttm-native-panel-content${panel.theme ? ` is-theme-${panel.theme}` : ''}`}>
        {(panel.eyebrow || panel.subtitle) && <header className="ttm-native-panel-hero">
            <div className="ttm-native-panel-hero-top">
                {panel.eyebrow && <span className="ttm-native-panel-eyebrow">
                    {darkroom && <PanelSvgIcon name="aperture" size={14} />}
                    <span>{panel.eyebrow}</span>
                </span>}
                {darkroom && <span className="ttm-native-sprockets" aria-hidden="true" />}
            </div>
            {panel.subtitle && <p className="ttm-native-panel-subtitle">{panel.subtitle}</p>}
        </header>}
        {blocks}
        {panel.layout && <Suspense fallback={<p role="status" className="ttm-settings-note">正在打开界面…</p>}>
            <IsolatedLayout layout={panel.layout} title={panel.title} disabled={disabled} onAction={(id, actionValues) => onAction({ id, values: actionValues, state: panel.state })} />
        </Suspense>}
        <form onSubmit={event => {
            event.preventDefault();
            const action = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
            if (action && !disabled) onAction({ id: action.value, values, state: panel.state });
        }}>
            {panel.fields?.map(field => {
                if (field.type === 'select' && (field.variant === 'aspect' || field.variant === 'chips') && field.options?.length) {
                    const current = String(values[field.id] ?? '');
                    return <div className="ttm-native-field ttm-native-field-group" key={field.id} role="radiogroup" aria-label={field.label}>
                        <span className="ttm-native-field-label">{field.label}</span>
                        <div className={`ttm-native-choice-grid${field.variant === 'aspect' ? ' is-aspect' : ''}`}>
                            {field.options.map(option => {
                                const selected = option.value === current;
                                const frameBox = field.variant === 'aspect' ? aspectPreviewStyle(option.value) : null;
                                const { primary, secondary } = field.variant === 'aspect' ? splitOptionLabel(option.label) : { primary: option.label };
                                return <button type="button" role="radio" aria-checked={selected} key={option.value} disabled={disabled}
                                    className={`ttm-native-choice-card${selected ? ' is-selected' : ''}`}
                                    onClick={() => update(field.id, option.value)}>
                                    {frameBox && <span className="ttm-native-aspect-box" aria-hidden="true"><i style={{ width: frameBox.width, height: frameBox.height }} /></span>}
                                    <span className="ttm-native-choice-text">
                                        <strong>{primary}</strong>
                                        {secondary && <small>{secondary}</small>}
                                    </span>
                                </button>;
                            })}
                        </div>
                        {field.hint && <small className="ttm-native-field-hint">{field.hint}</small>}
                    </div>;
                }
                return <label className={`ttm-native-field${field.type === 'checkbox' ? ' is-check' : ''}`} key={field.id}>
                    <span className="ttm-native-field-label">{field.label}</span>
                    {field.type === 'checkbox' ? <input type="checkbox" required={field.required} checked={values[field.id] === true} disabled={disabled} onChange={event => update(field.id, event.currentTarget.checked)} />
                        : field.type === 'select' ? <select className="ttm-select-input" required={field.required} value={String(values[field.id])} disabled={disabled} onChange={event => update(field.id, event.currentTarget.value)}>{field.options?.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
                        : field.type === 'textarea' ? <textarea className="ttm-native-input" rows={4} maxLength={4000} required={field.required} placeholder={field.placeholder} value={String(values[field.id])} disabled={disabled} onChange={event => update(field.id, event.currentTarget.value)} />
                        : <input className="ttm-native-input" maxLength={4000} required={field.required} placeholder={field.placeholder} value={String(values[field.id])} disabled={disabled} onChange={event => update(field.id, event.currentTarget.value)} />}
                    {field.hint && <small className="ttm-native-field-hint">{field.hint}</small>}
                </label>;
            })}
            {!!panel.actions?.length && <div className="ttm-native-actions">{panel.actions.map(action => {
                const cls = action.kind === 'primary' ? 'ttm-btn-primary'
                    : action.kind === 'danger' ? 'ttm-btn-secondary ttm-native-btn-danger'
                    : action.kind === 'ghost' ? 'ttm-btn-ghost'
                    : 'ttm-btn-secondary';
                return <button type="submit" key={action.id} value={action.id} disabled={disabled} className={cls}>
                    {action.icon && <PanelSvgIcon name={action.icon} size={15} />}
                    <span>{action.label}</span>
                </button>;
            })}</div>}
        </form>
    </div>;
}

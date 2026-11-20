import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import type { CommandInput, Panel, TaskView } from '../../../packages/plugin-sdk/index.js';
import { saveExport } from '../../core/platform-files';
import { Icon } from '../../shell/Icon';
import { errorMessage } from './catalog';

const IsolatedLayout = lazy(() => import('./IsolatedLayout'));
const imageTypes = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif']);
const audioTypes = new Set(['audio/mpeg', 'audio/wav', 'audio/x-wav', 'audio/ogg', 'audio/webm', 'audio/mp4', 'audio/aac', 'audio/flac']);

function MediaBlock({ owner, id, label }: { owner: string; id: string; label: string }) {
    const [media, setMedia] = useState<{ blob: Blob; url: string; name: string }>();
    const [error, setError] = useState('');
    useEffect(() => {
        let active = true, url: string | undefined;
        void import('./media').then(({ loadMedia }) => loadMedia(owner, id)).then(({ blob, handle }) => {
            if (!active) return;
            url = URL.createObjectURL(blob); setMedia({ blob, url, name: handle.name });
        }).catch(error => { if (active) setError(errorMessage(error)); });
        return () => { active = false; if (url) URL.revokeObjectURL(url); };
    }, [owner, id]);
    return <figure className="ttm-native-media">
        {media && imageTypes.has(media.blob.type) && <img src={media.url} alt={label} />}
        {media && audioTypes.has(media.blob.type) && <audio src={media.url} controls preload="metadata" aria-label={label} />}
        <figcaption><span>{label}</span>{media && <button type="button" className="ttm-icon-btn" aria-label={`保存${label}`} title={`保存${label}`} onClick={() => {
            const name = (media.name || label).replace(/[\\/:*?"<>|]/g, '-');
            const subtype = /^\w+\/([a-z0-9]+)$/i.exec(media.blob.type)?.[1];
            void saveExport(media.blob, /\.\w{1,6}$/.test(name) ? name : `${name}.${subtype === 'mpeg' ? 'mp3' : subtype ?? 'bin'}`).catch(error => setError(errorMessage(error)));
        }}><Icon name="download" width={17} height={17} /></button>}</figcaption>
        {error && <span role="alert" className="ttm-native-error">{error}</span>}
    </figure>;
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
        }).catch(error => { if (active) setError(errorMessage(error)); });
        return () => { active = false; off?.(); };
    }, [owner, id]);
    useEffect(() => {
        if (view && ['done', 'failed', 'cancelled'].includes(view.state)) finished.current(view.state);
    }, [view?.state]);
    const state = view?.state ?? 'queued', active = state === 'queued' || state === 'running';
    return <section className="ttm-native-task" aria-label="后台任务">
        <div><strong role="status">{error && !view ? '任务不可用' : taskStates[state]}</strong>{view && active && <button type="button" className="ttm-btn-ghost" disabled={cancelling} onClick={() => {
            try { read.current?.cancelTask(owner, id); setCancelling(true); } catch (error) { setError(errorMessage(error)); }
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
    const blocks = panel.blocks?.map((block, index) => {
        if (block.type === 'text') return <p key={index}>{block.text}</p>;
        if (block.type === 'list') return <ul key={index}>{block.items.map((item, index) => <li key={index}>{item}</li>)}</ul>;
        if (block.type === 'media') return <MediaBlock key={`${index}:${block.id}`} owner={owner} id={block.id} label={block.label} />;
        return <div className="ttm-native-table" key={index} tabIndex={0}>
            <table><thead><tr>{block.columns.map((label, index) => <th key={index} scope="col">{label}</th>)}</tr></thead>
                <tbody>{block.rows.map((row, index) => <tr key={index}>{block.columns.map((_, j) => <td key={j}>{row[j]}</td>)}</tr>)}</tbody></table>
        </div>;
    });
    return <div className="ttm-native-panel-content">
        {blocks}
        {panel.layout && <Suspense fallback={<p role="status" className="ttm-settings-note">正在打开界面…</p>}>
            <IsolatedLayout layout={panel.layout} title={panel.title} disabled={disabled} onAction={(id, values) => onAction({ id, values, state: panel.state })} />
        </Suspense>}
        <form onSubmit={event => {
            event.preventDefault();
            const action = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
            if (action && !disabled) onAction({ id: action.value, values, state: panel.state });
        }}>
            {panel.fields?.map(field => <label className={`ttm-native-field${field.type === 'checkbox' ? ' is-check' : ''}`} key={field.id}>
                <span>{field.label}</span>
                {field.type === 'checkbox' ? <input type="checkbox" required={field.required} checked={values[field.id] === true} disabled={disabled} onChange={event => update(field.id, event.currentTarget.checked)} />
                    : field.type === 'select' ? <select className="ttm-select-input" required={field.required} value={String(values[field.id])} disabled={disabled} onChange={event => update(field.id, event.currentTarget.value)}>{field.options?.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
                    : field.type === 'textarea' ? <textarea className="ttm-native-input" rows={4} maxLength={4000} required={field.required} value={String(values[field.id])} disabled={disabled} onChange={event => update(field.id, event.currentTarget.value)} />
                    : <input className="ttm-native-input" maxLength={4000} required={field.required} value={String(values[field.id])} disabled={disabled} onChange={event => update(field.id, event.currentTarget.value)} />}
            </label>)}
            {!!panel.actions?.length && <div className="ttm-native-actions">{panel.actions.map(action => <button type="submit" key={action.id} value={action.id} disabled={disabled}
                className={action.kind === 'primary' ? 'ttm-btn-primary' : 'ttm-btn-secondary'}>{action.label}</button>)}</div>}
        </form>
    </div>;
}

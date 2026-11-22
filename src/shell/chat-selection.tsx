import { useState } from 'react';
import { AnchoredDialog } from './AnchoredDialog';
import { Icon } from './Icon';
import { reportActionError } from './workspace-ui-actions';
import './chat-selection.css';

export interface ChatListEntry { id: string; title: string; characterName?: string; preview?: string; messageCount?: number; lastActivity?: number }
export type RemoveChats = (ids: string[]) => Promise<void>;

export function useChatSelection(entries: ChatListEntry[]) {
    const [selection, setSelection] = useState<Set<string> | null>(null);
    const selected = selection ? entries.filter(entry => selection.has(entry.id)) : [];
    return { selection, selected, start: (id?: string) => setSelection(new Set(id ? [id] : [])), clear: () => setSelection(null),
        setVisible: (ids: string[], checked: boolean) => setSelection(current => {
            const next = new Set(current);
            for (const id of ids) { if (checked) next.add(id); else next.delete(id); }
            return next;
        }),
        toggle: (id: string) => setSelection(current => {
            const next = new Set(current);
            if (next.has(id)) next.delete(id); else next.add(id);
            return next;
        }) };
}

export function ChatSelectionBar({ count, busy, onCancel, onDelete }: { count: number; busy: boolean; onCancel: () => void; onDelete: (anchor: HTMLElement) => void }) {
    return <div className="ttm-chat-selection-bar">
        <span aria-live="polite">已选 {count} 项</span>
        <button type="button" className="ttm-btn-secondary" onClick={onCancel}>取消多选</button>
        <button type="button" className="ttm-btn-danger" disabled={!count || busy} onClick={event => onDelete(event.currentTarget)}><Icon name="trash" width={16} height={16} />删除</button>
    </div>;
}

export interface ChatDeleteTarget { anchor: HTMLElement; entries: ChatListEntry[] }

export function ChatDeleteDialog({ target, busy, story, onClose, onDelete }: {
    target: ChatDeleteTarget; busy: boolean; story?: boolean; onClose: () => void; onDelete: RemoveChats;
}) {
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState('');
    const description = (entry: ChatListEntry) => [entry.characterName !== entry.title && entry.characterName, entry.preview].filter(Boolean).join(' · ');
    return <AnchoredDialog title={`删除 ${target.entries.length} 段会话？`} anchor={target.anchor} compact centered fitContent closeDisabled={saving} onClose={onClose}>
        <div className="ttm-chat-confirm">
            <p>这些会话及其所有分支都会被删除，无法撤销。{story && '角色卡会保留。'}</p>
            <ul>{target.entries.map(entry => <li key={entry.id}><strong>{entry.title}</strong>{description(entry) && <small>{description(entry)}</small>}</li>)}</ul>
            {error && <p role="alert" className="ttm-chat-dialog-error">{error}</p>}
            <div className="ttm-editor-actions">
                <button type="button" className="ttm-btn-secondary" disabled={saving} onClick={onClose}>取消</button>
                <button type="button" className="ttm-btn-danger" disabled={saving || busy} onClick={async () => {
                    setSaving(true); setError('');
                    try { await onDelete(target.entries.map(entry => entry.id)); }
                    catch (error) { reportActionError('删除会话', error); setError(error instanceof Error ? error.message : String(error)); }
                    finally { setSaving(false); }
                }}>{saving ? '正在删除…' : '确认删除'}</button>
            </div>
        </div>
    </AnchoredDialog>;
}

import { useMemo, useState } from 'react';
import { AnchoredDialog } from './AnchoredDialog';
import { deleteWorkspaceCharacters, deleteWorkspaceWorldbook, deleteWorkspacePreset, getCharacterDeletionBooks } from '../store/workspace-store';
import { showNotification } from '../store/notification-store';
import './asset-actions.css';

export interface DeleteAssetTarget { kind: 'character' | 'worldbook' | 'preset'; id: string; name: string; anchor: HTMLElement; }
export type DeleteAssetConfirmation = (DeleteAssetTarget & { kind: 'worldbook' | 'preset' })
    | { kind: 'characters'; cards: { id: string; name: string }[]; anchor: HTMLElement };
export function DeleteAssetDialog({ target, onClose, onDeleted }: { target: DeleteAssetConfirmation; onClose: () => void; onDeleted: () => void }) {
    const books = useMemo(() => target.kind === 'characters' ? getCharacterDeletionBooks(target.cards.map(card => card.id)) : [], [target]);
    const [selected, setSelected] = useState(new Set<string>());
    const [deleteChats, setDeleteChats] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const label = target.kind === 'characters' ? '角色卡' : target.kind === 'worldbook' ? '世界书' : '预设';
    const remove = async () => {
        setBusy(true); setError('');
        try {
            if (target.kind === 'characters') {
                const count = await deleteWorkspaceCharacters(target.cards.map(card => card.id), deleteChats, [...selected]);
                showNotification(count ? `已删除 ${count} 张角色卡` : '所选角色卡已不在馆藏中。', { kind: count ? 'success' : 'info' });
            } else {
                if (target.kind === 'worldbook') await deleteWorkspaceWorldbook(target.id);
                else await deleteWorkspacePreset(target.id);
                showNotification(`已删除${label}「${target.name}」`, { kind: 'success' });
            }
            onDeleted();
        } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
        finally { setBusy(false); }
    };
    return <AnchoredDialog compact fitContent closeDisabled={busy} title={`删除${label}`} anchor={target.anchor} onClose={onClose}>
        <div className="ttm-delete-asset">
            {target.kind === 'characters' ? <>
                <p>确定删除以下 {target.cards.length} 张角色卡？此操作无法撤销。</p>
                <ul className="ttm-delete-card-list" aria-label="待删除角色卡">{target.cards.map(card => <li key={card.id}>{card.name}</li>)}</ul>
            </> : <p>删除「{target.name}」？此操作无法撤销。</p>}
            {target.kind === 'worldbook' && <p className="ttm-asset-help">将删除此书，并移除使用它的故事、个人设定与会话绑定。</p>}
            {target.kind === 'preset' && <p className="ttm-asset-help">如果正在使用此预设，将切换到馆藏中的其他预设；没有其他预设时恢复内置预设。</p>}
            {books.length > 0 && <fieldset><legend>是否同时删除对应世界书？</legend>{books.map(({ book, shared }) =>
                <label key={book.id}><input type="checkbox" checked={selected.has(book.id)} disabled={busy} onChange={event => setSelected(previous => { const next = new Set(previous); if (event.target.checked) next.add(book.id); else next.delete(book.id); return next; })} /><span>{book.name}{shared && <small>也被其他内容使用，默认保留</small>}</span></label>
            )}<small>未勾选的世界书会保留在资源列表中。</small></fieldset>}
            {target.kind === 'characters' && <label className="ttm-delete-history"><input type="checkbox" checked={deleteChats} disabled={busy} onChange={event => setDeleteChats(event.target.checked)} />同时删除这些角色卡的会话记录</label>}
            {error && <p role="alert">{error}</p>}
            <div className="ttm-editor-actions"><button type="button" className="ttm-btn-secondary" disabled={busy} onClick={onClose}>取消</button><button type="button" className="ttm-btn-primary ttm-delete-confirm" disabled={busy} onClick={() => void remove()}>{busy ? '正在删除…' : '确认删除'}</button></div>
        </div>
    </AnchoredDialog>;
}

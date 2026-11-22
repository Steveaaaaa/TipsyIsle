import { useEffect, useRef, useState } from 'react';
import { AnchoredDialog } from './AnchoredDialog';
import { AssetActionMenu, AssetMoreButton } from './AssetActionMenu';
import { ChatDeleteDialog, ChatSelectionBar, useChatSelection, type ChatDeleteTarget, type ChatListEntry, type RemoveChats } from './chat-selection';
import { Icon } from './Icon';
import { openStoryRoutes } from './StoryRoutes';
import { reportActionError } from './workspace-ui-actions';

export const storyConversationId = 'ttm-story-conversations';
const recentDate = new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
const olderDate = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'numeric', day: 'numeric' });

export function StoryConversationManager({ mobile, anchor, entries, activeId, loaded, busy, routes, onClose, onOpen, onNew, onRename, onDelete, onSave }: {
    mobile: boolean; anchor: HTMLElement; entries: ChatListEntry[]; activeId: string; loaded: boolean; busy: boolean; routes: number;
    onClose: () => void; onOpen: (id: string) => Promise<void>; onNew: () => Promise<void>;
    onRename: (id: string, title: string) => Promise<void>; onDelete: RemoveChats; onSave: (anchor: HTMLElement, mode: 'import' | 'export') => void;
}) {
    const [query, setQuery] = useState('');
    const [menu, setMenu] = useState<{ id: string; anchor: HTMLElement }>();
    const [saveMenu, setSaveMenu] = useState<HTMLElement>();
    const [rename, setRename] = useState<{ id: string; title: string; anchor: HTMLElement }>();
    const [target, setTarget] = useState<ChatDeleteTarget>();
    const [working, setWorking] = useState(false);
    const [error, setError] = useState('');
    const searchRef = useRef<HTMLInputElement>(null);
    const selection = useChatSelection(entries);
    const disabled = busy || working;
    const needle = query.trim().toLocaleLowerCase();
    const matches = needle ? entries.filter(entry => [entry.title, entry.characterName, entry.preview].some(text => text?.toLocaleLowerCase().includes(needle))) : entries;
    const picked = menu && entries.find(entry => entry.id === menu.id);
    const visibleIds = matches.map(entry => entry.id);
    const visibleSelected = visibleIds.filter(id => selection.selection?.has(id)).length;
    const allVisible = visibleIds.length > 0 && visibleSelected === visibleIds.length;
    const year = new Date().getFullYear();
    useEffect(() => { if (!mobile) searchRef.current?.focus({ preventScroll: true }); }, [mobile]);
    const perform = async (action: string, run: () => Promise<void>) => {
        setWorking(true); setError('');
        try { await run(); }
        catch (cause) { reportActionError(action, cause); setError(cause instanceof Error ? cause.message : String(cause)); }
        finally { setWorking(false); }
    };
    const content = <>
        <div className="ttm-story-chat-controls">
            <label className="ttm-story-chat-search"><Icon name="search" width={17} height={17} /><input ref={searchRef} type="search" className="ttm-text-input" aria-label="搜索故事会话" placeholder="搜索会话、角色或预览" value={query} onChange={event => setQuery(event.target.value)} /></label>
            <div className="ttm-story-chat-tools">
                {selection.selection ? <button type="button" className="ttm-btn-secondary" disabled={disabled || !visibleIds.length} onClick={() => selection.setVisible(visibleIds, !allVisible)}>
                    <Icon name="check" width={16} height={16} />{allVisible ? (needle ? '取消勾选结果' : '取消全选') : (needle ? '勾选全部结果' : '全选')}
                </button> : <>
                    <button type="button" className="ttm-btn-primary" disabled={disabled} onClick={() => void perform('新建故事会话', onNew)}><Icon name="plus" width={16} height={16} />新建</button>
                    <button type="button" className="ttm-btn-secondary" disabled={disabled || !entries.length} onClick={() => selection.start()}><Icon name="check" width={16} height={16} />多选</button>
                    {activeId && <button type="button" className="ttm-btn-ghost" disabled={disabled} onClick={event => openStoryRoutes(undefined, event.currentTarget)}><Icon name="branch" width={16} height={16} />故事路线{routes > 1 ? ` · ${routes}` : ''}</button>}
                    <button type="button" className="ttm-btn-ghost" aria-haspopup="menu" aria-expanded={!!saveMenu} disabled={disabled} onClick={event => setSaveMenu(saveMenu ? undefined : event.currentTarget)}><Icon name="archive" width={16} height={16} />故事存档</button>
                </>}
            </div>
            {error && !rename && <p role="alert" className="ttm-chat-dialog-error">{error}</p>}
        </div>
        <div className="ttm-story-chat-scroll">
            {!matches.length ? <p className="ttm-night-list-status" role="status">{!loaded ? '正在读取会话…' : needle ? '没有找到匹配的会话' : '还没有故事会话'}</p> :
                <ul className="ttm-story-chat-entries">{matches.map(entry => {
                    const current = entry.id === activeId;
                    const date = entry.lastActivity ? new Date(entry.lastActivity) : undefined;
                    const timestamp = date && Number.isFinite(date.getTime()) ? date : undefined;
                    const detail = <><span className="ttm-story-chat-text"><span className="ttm-story-chat-title"><strong title={entry.title}>{entry.title}</strong>{current && <span className="ttm-story-chat-current">当前</span>}</span>
                        <small className="ttm-story-chat-preview">{entry.preview || '暂无正文'}</small></span>
                        <span className="ttm-story-chat-meta">{entry.characterName !== entry.title && <small title={entry.characterName}>{entry.characterName}</small>}
                            <small>{entry.messageCount ?? 0} 条消息</small>{timestamp && <time dateTime={timestamp.toISOString()} title={timestamp.toLocaleString('zh-CN')}>{(timestamp.getFullYear() === year ? recentDate : olderDate).format(timestamp)}</time>}</span></>;
                    return <li key={entry.id} className={current ? 'is-current' : undefined}>
                        {selection.selection ? <label className="ttm-story-chat-row ttm-chat-check">
                            <input type="checkbox" aria-label={`选择 ${entry.title}`} checked={selection.selection.has(entry.id)} onChange={() => selection.toggle(entry.id)} />{detail}
                        </label> : <>
                            <button type="button" className="ttm-story-chat-row" aria-current={current ? 'true' : undefined} disabled={disabled} onClick={() => void perform('打开故事会话', () => onOpen(entry.id))}>
                                <Icon name="chat" width={18} height={18} />{detail}
                            </button>
                            <AssetMoreButton label={`${entry.title} · 更多操作`} expanded={menu?.id === entry.id} onOpen={anchor => setMenu(menu?.id === entry.id ? undefined : { id: entry.id, anchor })} />
                        </>}
                    </li>;
                })}</ul>}
        </div>
        {selection.selection && <ChatSelectionBar count={selection.selected.length} busy={disabled} onCancel={selection.clear} onDelete={anchor => setTarget({ anchor, entries: selection.selected })} />}
        {picked && menu && <AssetActionMenu anchor={menu.anchor} label={`${picked.title} · 更多操作`} onClose={() => setMenu(undefined)} actions={[
            { label: '重命名', icon: 'settings', disabled, run: () => { setError(''); setRename({ id: picked.id, title: picked.title, anchor: menu.anchor }); } },
            { label: '多选会话', icon: 'check', disabled, run: () => selection.start(picked.id) },
            { label: '删除会话', icon: 'trash', destructive: true, disabled, run: () => setTarget({ anchor: menu.anchor, entries: [picked] }) },
        ]} />}
        {saveMenu && <AssetActionMenu anchor={saveMenu} label="故事存档" onClose={() => setSaveMenu(undefined)} actions={[
            { label: '导入故事存档', icon: 'upload', disabled, run: () => onSave(saveMenu, 'import') },
            { label: '导出故事存档', icon: 'download', disabled: disabled || !entries.length, run: () => onSave(saveMenu, 'export') },
        ]} />}
        {rename && <AnchoredDialog title="重命名会话" anchor={rename.anchor} compact centered fitContent closeDisabled={working} onClose={() => { setError(''); setRename(undefined); }}>
            <form className="ttm-free-edit" onSubmit={event => {
                event.preventDefault();
                if (disabled || !rename.title.trim()) return;
                void perform('重命名故事会话', async () => { await onRename(rename.id, rename.title); setRename(undefined); });
            }}>
                <label>会话名称<input className="ttm-text-input" value={rename.title} maxLength={100} disabled={working} onChange={event => setRename({ ...rename, title: event.target.value })} /></label>
                {error && <p role="alert" className="ttm-chat-dialog-error">{error}</p>}
                <div className="ttm-editor-actions"><button type="button" className="ttm-btn-secondary" disabled={working} onClick={() => { setError(''); setRename(undefined); }}>取消</button><button type="submit" className="ttm-btn-primary" disabled={disabled || !rename.title.trim()}>保存</button></div>
            </form>
        </AnchoredDialog>}
        {target && <ChatDeleteDialog target={target} busy={disabled} story onClose={() => setTarget(undefined)} onDelete={async ids => {
            await onDelete(ids); setTarget(undefined); selection.clear();
        }} />}
    </>;
    return mobile ? <AnchoredDialog id={storyConversationId} title="故事会话" anchor={anchor} surface="sheet" className="ttm-story-chat-manager" closeDisabled={working} onClose={onClose}>{content}</AnchoredDialog> :
        <section id={storyConversationId} className="ttm-story-chat-manager ttm-story-chat-panel" data-ti-shell="history" aria-labelledby={`${storyConversationId}-title`}>
            <header className="ttm-story-chat-heading"><h3 id={`${storyConversationId}-title`}>故事会话</h3><button type="button" className="ttm-icon-btn" aria-label="关闭故事会话" title="关闭故事会话" disabled={working} onClick={onClose}><Icon name="close" /></button></header>
            {content}
        </section>;
}

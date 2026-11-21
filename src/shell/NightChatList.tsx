import { useState, type ReactNode } from 'react';
import { AssetActionMenu, AssetMoreButton } from './AssetActionMenu';
import { Icon } from './Icon';
import './night-chat-list.css';

export interface NightChatEntry {
    id: string;
    title: string;
    messageCount: number;
    lastActivity?: number;
}

export function ShelfNavigation({ night, libraryLabel, onLibrary, onNight }: {
    night: boolean; libraryLabel: string; onLibrary: () => void; onNight: () => void;
}) {
    return <nav className="ttm-shelf-tabs" aria-label="左侧导航">
        <button type="button" aria-current={night ? undefined : 'page'} onClick={onLibrary}>
            <Icon name="book" width={16} height={16} /><span>{libraryLabel}</span>
        </button>
        <button type="button" aria-current={night ? 'page' : undefined} onClick={onNight}>
            <Icon name="chat" width={16} height={16} /><span>夜灯畅谈</span>
        </button>
    </nav>;
}

export function NightChatList({ mobile, visible, navigation, entries, activeId, busy, loaded, onNew, onOpen, onEdit }: {
    mobile: boolean;
    visible: boolean;
    navigation?: ReactNode;
    entries: NightChatEntry[];
    activeId: string;
    busy: boolean;
    loaded: boolean;
    onNew: () => void;
    onOpen: (id: string) => void;
    onEdit: (kind: 'title' | 'delete', entry: NightChatEntry, anchor: HTMLElement) => void;
}) {
    const [menu, setMenu] = useState<{ id: string; anchor: HTMLElement }>();
    const picked = visible && menu ? entries.find(entry => entry.id === menu.id) : undefined;
    return <aside aria-label="夜灯会话" data-ti-shell="night-chats" hidden={!visible}
        className={`ttm-sidebar ttm-night-shelf${mobile ? ' is-mobile-active' : ''}`}>
        {navigation}
        <div className="ttm-night-shelf-heading">
            <h2 data-ti-type="heading">夜灯会话</h2>
            <button type="button" className={mobile ? 'ttm-btn-primary' : 'ttm-mini-btn'} disabled={busy} onClick={onNew}>
                <Icon name="plus" width={16} height={16} />新建对话
            </button>
        </div>
        <div className="ttm-night-scroll">
            {entries.length === 0 ? <p role="status" className="ttm-night-list-status">{loaded ? '还没有夜灯对话' : '正在读取会话…'}</p> :
                <ul className="ttm-night-entries">
                    {entries.map(entry => <li key={entry.id} className={entry.id === activeId ? 'is-current' : undefined}>
                        <button type="button" className="ttm-night-open" disabled={busy && entry.id !== activeId}
                            aria-current={entry.id === activeId ? 'true' : undefined} onClick={() => onOpen(entry.id)}>
                            <Icon name="chat" width={17} height={17} />
                            <span className="ttm-night-entry-text"><strong title={entry.title}>{entry.title}</strong>
                                <small>{entry.messageCount ? `${entry.messageCount} 条消息` : '暂无消息'}</small></span>
                        </button>
                        <AssetMoreButton label={`${entry.title} · 更多操作`} expanded={picked?.id === entry.id}
                            onOpen={anchor => setMenu(previous => previous?.id === entry.id ? undefined : { id: entry.id, anchor })} />
                    </li>)}
                </ul>}
        </div>
        {picked && menu && <AssetActionMenu anchor={menu.anchor} label={`${picked.title} · 更多操作`} onClose={() => setMenu(undefined)} actions={[
            { label: '重命名', icon: 'settings', disabled: busy, run: () => onEdit('title', picked, menu.anchor) },
            { label: '删除对话', icon: 'trash', destructive: true, disabled: busy, run: () => onEdit('delete', picked, menu.anchor) },
        ]} />}
    </aside>;
}

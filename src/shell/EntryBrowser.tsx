import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Icon } from './Icon';
import { EntryStatus } from './EntryStatus';

export interface BrowserEntry {
    id: string; name: string; content: string; enabled: boolean;
    group?: string; groupId?: string; keywords?: string; dirty?: boolean;
}

export function EntryBrowser({ entries, label, storageKey, scope = '', filters, renderDetail }: {
    entries: BrowserEntry[]; label: string; storageKey: string; scope?: string;
    filters?: ReactNode; renderDetail: (entry: BrowserEntry) => ReactNode;
}) {
    const [search, setSearch] = useState('');
    const [includeContent, setIncludeContent] = useState(false);
    const [filter, setFilter] = useState('all');
    const [page, setPage] = useState(0);
    const [selectedId, setSelectedId] = useState<string>();
    const [mobileDetail, setMobileDetail] = useState(false);
    const [mobile, setMobile] = useState(() => matchMedia('(max-width: 760px)').matches);
    const [listHeight, setListHeight] = useState(0);
    const [favorites, setFavorites] = useState<Set<string>>(() => {
        try { const saved = JSON.parse(localStorage.getItem(storageKey) ?? '[]'); return new Set(Array.isArray(saved) ? saved.filter(value => typeof value === 'string') : []); } catch { return new Set(); }
    });
    const [storageWarning, setStorageWarning] = useState('');
    const list = useRef<HTMLDivElement>(null);
    const detail = useRef<HTMLElement>(null);
    const detailTitle = useRef<HTMLHeadingElement>(null);
    const wantsFocus = useRef(false);
    const directoryScroll = useRef(0);
    const listId = useId();
    const headingId = useId();
    useEffect(() => {
        const media = matchMedia('(max-width: 760px)');
        const update = () => { setMobile(media.matches); setPage(0); };
        media.addEventListener('change', update);
        return () => media.removeEventListener('change', update);
    }, []);
    const query = search.trim().toLocaleLowerCase();
    const matches = useMemo(() => entries.filter(entry =>
        (!scope || entry.groupId === scope) &&
        (filter === 'all' || filter === 'enabled' && entry.enabled || filter === 'disabled' && !entry.enabled || filter === 'favorites' && favorites.has(entry.id)) &&
        (!query || `${entry.name} ${entry.keywords ?? ''}`.toLocaleLowerCase().includes(query) || includeContent && entry.content.toLocaleLowerCase().includes(query))),
    [entries, filter, favorites, query, includeContent, scope]);
    const rowHeight = 48 + (includeContent && query ? 20 : 0);
    const pageSize = listHeight > 0 ? Math.max(1, Math.floor((listHeight - (mobile ? 4 : 12)) / rowHeight)) : mobile ? 9 : 12;
    const pages = Math.max(1, Math.ceil(matches.length / pageSize));
    const currentPage = Math.min(page, pages - 1);
    const visible = matches.slice(currentPage * pageSize, (currentPage + 1) * pageSize);
    useLayoutEffect(() => {
        const element = list.current;
        if (!element) return;
        const measure = () => { if (element.clientHeight > 0) setListHeight(element.clientHeight); };
        measure();
        const observer = new ResizeObserver(measure); observer.observe(element);
        return () => observer.disconnect();
    }, [mobileDetail, mobile]);
    // Selection is independent of the directory page and filters.
    const selected = entries.find(entry => entry.id === selectedId) ?? (selectedId === undefined ? entries[0] : undefined);
    useEffect(() => { if (selectedId === undefined && entries[0]) setSelectedId(entries[0].id); }, [entries, selectedId]);
    useEffect(() => setPage(0), [search, includeContent, filter, scope]);
    useLayoutEffect(() => { if (list.current) list.current.scrollTop = 0; }, [currentPage, query, filter, scope]);
    useLayoutEffect(() => {
        if (detail.current) detail.current.scrollTop = 0;
        if (wantsFocus.current) { detailTitle.current?.focus({ preventScroll: true }); wantsFocus.current = false; }
    }, [selected?.id, mobileDetail]);
    const toggleFavorite = (entry: BrowserEntry) => {
        const next = new Set(favorites);
        if (next.has(entry.id)) next.delete(entry.id); else next.add(entry.id);
        setFavorites(next);
        try { localStorage.setItem(storageKey, JSON.stringify([...next])); setStorageWarning(''); }
        catch { setStorageWarning('收藏仅在本次打开期间保留：浏览器无法保存偏好。'); }
    };
    const back = () => {
        setMobileDetail(false);
        requestAnimationFrame(() => {
            if (list.current) list.current.scrollTop = directoryScroll.current;
            list.current?.querySelector<HTMLButtonElement>('[aria-current="true"]')?.focus({ preventScroll: true });
        });
    };
    return <div className={`ttm-entry-browser ${mobileDetail ? 'is-detail' : ''}`}>
        <div className="ttm-entry-browser-tools">
            {filters}
            <div className="ttm-entry-search-row"><input type="search" className="ttm-text-input" aria-label={`搜索${label}`} placeholder="搜索全部选项名称" value={search} onChange={event => setSearch(event.target.value)} />
                <label className="ttm-entry-search-content"><input type="checkbox" checked={includeContent} onChange={event => setIncludeContent(event.target.checked)} />同时搜索内容</label></div>
            <nav className="ttm-entry-filters" aria-label={`${label}筛选`}>{[['all', '全部'], ['enabled', '已启用'], ['disabled', '已关闭'], ['favorites', '收藏']].map(([value, name]) =>
                <button type="button" key={value} className="ttm-chip-btn" aria-pressed={filter === value} onClick={() => setFilter(value)}>{name}</button>
            )}<span role="status">{matches.length} 项{query ? '匹配' : ''}</span></nav>
            {storageWarning && <p className="ttm-asset-help" role="status">{storageWarning}</p>}
        </div>
        <div className="ttm-entry-columns">
            <section className="ttm-entry-directory" aria-label={`${label}目录`}>
                <div className="ttm-entry-directory-list" id={listId} ref={list}>
                    {visible.map(entry => {
                        const offset = includeContent && query ? entry.content.toLocaleLowerCase().indexOf(query) : -1;
                        return <div className={`ttm-entry-directory-row ${selected?.id === entry.id ? 'is-selected' : ''}`} key={entry.id} style={{ height: rowHeight }}>
                            <button type="button" className="ttm-entry-select" title={entry.name} aria-current={selected?.id === entry.id ? 'true' : undefined} onClick={() => { directoryScroll.current = list.current?.scrollTop ?? 0; wantsFocus.current = true; setSelectedId(entry.id); setMobileDetail(true); }}>
                                <span className="ttm-entry-name">{entry.name}</span>
                                <span className="ttm-entry-state"><EntryStatus enabled={entry.enabled} />{entry.dirty ? ' · 未保存' : ''}{entry.group ? ` · ${entry.group}` : ''}</span>
                                {offset >= 0 && <span className="ttm-entry-match">…{entry.content.slice(Math.max(0, offset - 12), offset + 42)}…</span>}
                            </button>
                            <button type="button" className="ttm-entry-favorite ttm-icon-btn" aria-label={`${favorites.has(entry.id) ? '取消收藏' : '收藏'} ${entry.name}`} aria-pressed={favorites.has(entry.id)} onClick={() => toggleFavorite(entry)}><Icon name="bookmark" width={16} height={16} fill={favorites.has(entry.id) ? 'currentColor' : 'none'} /></button>
                        </div>;
                    })}
                    {!matches.length && <div className="ttm-entry-empty"><p>{entries.length ? '没有符合条件的选项' : '暂无可查看的选项'}</p>{entries.length > 0 && <button type="button" className="ttm-mini-btn" onClick={() => { setSearch(''); setFilter('all'); }}>清除搜索与状态筛选</button>}</div>}
                </div>
                <nav className="ttm-entry-pagination" aria-label={`${label}分页`}>
                    <button type="button" className="ttm-icon-btn" aria-label="上一页选项" aria-controls={listId} disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}><Icon name="chevron" style={{ transform: 'rotate(180deg)' }} /></button>
                    <label><select aria-label="选项页码" className="ttm-select-input" value={currentPage} onChange={event => setPage(Number(event.target.value))}>{Array.from({ length: pages }, (_, index) => <option value={index} key={index}>第 {index + 1} / {pages} 页</option>)}</select></label>
                    <button type="button" className="ttm-icon-btn" aria-label="下一页选项" aria-controls={listId} disabled={currentPage === pages - 1} onClick={() => setPage(currentPage + 1)}><Icon name="chevron" /></button>
                    <small>共 {matches.length} 项 · 每页 {pageSize} 项</small>
                </nav>
            </section>
            <section className="ttm-entry-detail-pane" aria-labelledby={headingId} ref={detail}>
                <button type="button" className="ttm-btn-ghost ttm-entry-back" onClick={back}><Icon name="chevron" width={16} height={16} style={{ transform: 'rotate(180deg)' }} />返回目录</button>
                <h3 ref={detailTitle} tabIndex={-1} id={headingId}>{selected?.name ?? '选择一个选项'}</h3>
                {selected && !matches.some(entry => entry.id === selected.id) && <p className="ttm-asset-help">当前详情不在筛选结果中，仍为你保留。</p>}
                {selected ? renderDetail(selected) : <p className="ttm-asset-help">从目录中选择一个选项，查看完整内容。</p>}
            </section>
        </div>
    </div>;
}

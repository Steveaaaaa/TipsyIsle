import { useEffect, useMemo, useRef, useState } from 'react';
import { AnchoredDialog } from './AnchoredDialog';
import { Icon } from './Icon';
import { workspaceStore, selectChatBranch, retryStoryFrom, setStatusBanner, restoreArchivedChat } from '../store/workspace-store';
import { listChatArchives, loadChatArchive, type ChatArchiveSummary, type ArchivedChat } from '../store/chat-archives';
import { activePath, branchExcerpt, routesAt, storyRoutes, storyTree, routeKey, swipeId, type StoryRoute, type StoryTreeBranch } from '../store/chat-tree';
import type { ChatMessageNode } from '../types';
import { messageStorySummary } from '../pipeline/story-summary';
import './story-routes.css';

export function openStoryRoutes(messageId?: string, anchor?: HTMLElement) {
    window.dispatchEvent(new CustomEvent('tipsy-open-branches', { detail: { messageId, anchor } }));
}
const floors = (messages: ChatMessageNode[]) => messages.length === 1 ? `第 ${messages[0].floor} 楼` : `第 ${messages[0].floor}–${messages.at(-1)!.floor} 楼`;
const latestReply = (path: ChatMessageNode[]) => [...path].reverse().find(node => node.role === 'assistant');
const canReplay = (node: ChatMessageNode) => node.floor > 0 && !!node.branchBases?.[swipeId(node)]?.reply;
const branchSummary = (branch: StoryTreeBranch) => branch.messages.filter(node => node.role === 'assistant')
    .map(node => messageStorySummary(node)?.text).filter(Boolean).join('；');
type RouteOwner = { chatId: string; label: string; originalKey?: string };
const NODE_WIDTH = 236, NODE_HEIGHT = 154, COLUMN_GAP = 28, LEVEL_GAP = 68, MAP_PADDING = 28;
function layoutTree(tree: StoryTreeBranch[], collapsed: Set<string>) {
    type Positioned = { branch: StoryTreeBranch; x: number; y: number };
    const nodes: Positioned[] = [], links: Array<{ from: Positioned; to: Positioned }> = [];
    const widths = new Map<string, number>();
    const measure = (branch: StoryTreeBranch): number => {
        const children = collapsed.has(branch.key) ? [] : branch.children;
        const width = Math.max(NODE_WIDTH, children.reduce((sum, child) => sum + measure(child), 0) + Math.max(0, children.length - 1) * COLUMN_GAP);
        widths.set(branch.key, width); return width;
    };
    tree.forEach(measure);
    const place = (branch: StoryTreeBranch, left: number, depth: number, parent?: Positioned) => {
        const width = widths.get(branch.key)!;
        const point = { branch, x: left + (width - NODE_WIDTH) / 2, y: MAP_PADDING + depth * (NODE_HEIGHT + LEVEL_GAP) };
        nodes.push(point); if (parent) links.push({ from: parent, to: point });
        if (!collapsed.has(branch.key)) for (const child of branch.children) {
            place(child, left, depth + 1, point); left += widths.get(child.key)! + COLUMN_GAP;
        }
    };
    let left = MAP_PADDING;
    for (const branch of tree) { place(branch, left, 0); left += widths.get(branch.key)! + COLUMN_GAP; }
    return { nodes, links, width: Math.max(NODE_WIDTH + 2 * MAP_PADDING, left - COLUMN_GAP + MAP_PADDING),
        height: Math.max(...nodes.map(node => node.y + NODE_HEIGHT), NODE_HEIGHT) + MAP_PADDING };
}

export function StoryRoutes() {
    const state = workspaceStore.useStore();
    const [target, setTarget] = useState<{ messageId?: string; anchor: HTMLElement }>();
    const [selectedKey, setSelectedKey] = useState<string>();
    const [previewKey, setPreviewKey] = useState<string>();
    const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
    const [archives, setArchives] = useState<ChatArchiveSummary[]>([]);
    const [archive, setArchive] = useState<ArchivedChat>();
    const [overview, setOverview] = useState(false);
    const [overviewChats, setOverviewChats] = useState<ArchivedChat[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const [zoom, setZoom] = useState(1);
    const [mobileView, setMobileView] = useState<'map' | 'detail'>('map');
    const [locate, setLocate] = useState(0);
    const mapRef = useRef<HTMLDivElement>(null);
    const resetView = () => { setSelectedKey(undefined); setPreviewKey(undefined); setCollapsed(new Set()); setZoom(1); setError(''); setMobileView('map'); };
    useEffect(() => {
        const open = (event: Event) => {
            const detail = (event as CustomEvent).detail ?? {};
            setTarget({ ...detail, anchor: detail.anchor ?? document.body }); setArchive(undefined); setOverview(false); setOverviewChats([]); resetView();
        };
        window.addEventListener('tipsy-open-branches', open);
        return () => window.removeEventListener('tipsy-open-branches', open);
    }, []);
    useEffect(() => {
        if (!target) return;
        let live = true;
        void listChatArchives().then(items => { if (live) setArchives(items.filter(item => item.characterId === state.activeCharacterId && item.id !== state.activeChatId)); }).catch(error => { if (live) setStatusBanner(String(error)); });
        return () => { live = false; };
    }, [target, state.activeCharacterId, state.activeChatId]);
    const nodes = archive?.messages ?? state.messages;
    const reply = target?.messageId && !archive && !overview ? latestReply(activePath(nodes, target.messageId)) : undefined;
    const point = reply && reply.floor > 0 ? reply : undefined;
    const view = useMemo(() => {
        const owners = new Map<string, RouteOwner>();
        if (!target) return { routes: [] as StoryRoute[], tree: [] as StoryTreeBranch[], owners, sessionCount: 0 };
        const groups = overview ? [
            { id: state.activeChatId, label: '当前会话', messages: state.messages, activeLeafId: state.activeLeafId },
            ...overviewChats.map((chat, index) => ({ ...chat, label: chat.syncLabel || `已保存会话 ${index + 1}` })),
        ] : [{ id: archive?.id ?? state.activeChatId, label: archive?.syncLabel || (archive ? '已保存会话' : '当前会话'), messages: nodes, activeLeafId: archive?.activeLeafId ?? state.activeLeafId }];
        const routes: StoryRoute[] = [], tree: StoryTreeBranch[] = [];
        for (const group of groups) {
            let entries = point ? routesAt(group.messages, point.id) : storyRoutes(group.messages);
            // A conversation still at its opening is visible in the card overview, without enabling opening branches.
            if (overview && !entries.length && group.activeLeafId) {
                const path = activePath(group.messages, group.activeLeafId), leaf = path.at(-1);
                if (leaf) entries = [{ key: routeKey(leaf), nodeId: leaf.id, swipe: leaf.activeSwipeIndex, label: '尚未开始对话', depth: path.length, path }];
            }
            const prefix = overview ? `${group.id}::` : '';
            const mapped = entries.map(route => {
                const key = prefix + route.key;
                owners.set(key, { chatId: group.id, label: group.label, originalKey: route.depth > 1 ? route.key : undefined });
                return { ...route, key };
            });
            // Build each session independently: imported sessions may share message IDs.
            const remap = (branch: StoryTreeBranch): StoryTreeBranch => ({ ...branch, key: prefix + branch.key,
                routes: branch.routes.map(route => mapped.find(item => item.key === prefix + route.key)!),
                endpoint: branch.endpoint ? mapped.find(item => item.key === prefix + branch.endpoint!.key) : undefined,
                children: branch.children.map(remap) });
            tree.push(...storyTree(entries).map(remap)); routes.push(...mapped);
        }
        return { routes, tree, owners, sessionCount: groups.length };
    }, [target, overview, overviewChats, nodes, point?.id, archive, state.activeChatId, state.activeLeafId, state.messages]);
    const { routes, tree, owners } = view;
    const flat = useMemo(() => {
        const result: StoryTreeBranch[] = [];
        const visit = (branches: StoryTreeBranch[]) => { for (const branch of branches) { result.push(branch); visit(branch.children); } };
        visit(tree); return result;
    }, [tree]);
    const active = (overview ? state.messages : nodes).find(node => node.id === (archive?.activeLeafId ?? state.activeLeafId));
    const current = active ? (overview ? `${state.activeChatId}::` : '') + routeKey(active) : undefined;
    const branchTitle = (branch: StoryTreeBranch) => branch.routes.length > 1 ? '分叉前的共同剧情'
        : `路线 ${routes.findIndex(route => route.key === branch.routes[0]?.key) + 1} · ${floors(branch.messages)}`;
    const selected = flat.find(branch => branch.key === selectedKey)
        ?? flat.find(branch => point && branch.messages.some(node => node.id === point.id))
        ?? flat.find(branch => branch.endpoint?.key === current) ?? flat[0];
    const preview = selected?.messages.find(node => routeKey(node) === previewKey)
        ?? selected?.messages.find(node => node.id === point?.id)
        ?? (selected && (latestReply(selected.messages) ?? selected.messages.at(-1)));
    const selectedOwner = selected && owners.get(selected.routes[0]?.key);
    const selectedIsCurrentChat = selectedOwner?.chatId === state.activeChatId;
    const replaySource = preview && latestReply(selected?.routes[0]?.path.filter(node => node.floor <= preview.floor) ?? []);
    const replay = preview?.role === 'assistant' ? preview : replaySource;
    const layout = useMemo(() => layoutTree(tree, collapsed), [tree, collapsed]);
    useEffect(() => {
        const viewport = mapRef.current;
        const position = layout.nodes.find(item => item.branch.key === selected?.key);
        if (!viewport || !position) return;
        const offset = Math.max(0, (viewport.clientWidth - layout.width * zoom) / 2);
        viewport.scrollTo({ left: offset + (position.x + NODE_WIDTH / 2) * zoom - viewport.clientWidth / 2,
            top: (position.y + NODE_HEIGHT / 2) * zoom - viewport.clientHeight / 2,
            behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
    }, [selected?.key, layout, zoom, locate, mobileView, target]);
    const busy = loading || state.isGenerating || state.helperGenerationCount > 0 || state.mvuExtraAnalysisActive;
    const act = async (action: () => void | Promise<void>) => {
        setLoading(true); setError('');
        try { await action(); setTarget(undefined); }
        catch (error) { setError(error instanceof Error ? error.message : String(error)); }
        finally { setLoading(false); }
    };
    const continueRoute = (route: StoryRoute) => void act(async () => {
        const owner = owners.get(route.key)!;
        if (owner.chatId !== state.activeChatId) await restoreArchivedChat(owner.chatId, owner.originalKey);
        else if (owner.originalKey) await selectChatBranch(owner.originalKey);
    });
    const showOverview = async () => {
        setLoading(true); resetView();
        try {
            const index = await listChatArchives();
            const loaded = await Promise.all(index.filter(item => item.characterId === state.activeCharacterId && item.id !== state.activeChatId).map(item => loadChatArchive(item.id)));
            setOverviewChats(loaded.filter((chat): chat is ArchivedChat => !!chat)); setArchive(undefined); setOverview(true);
        } catch (error) { setError(String(error)); } finally { setLoading(false); }
    };
    const select = (key: string) => { setSelectedKey(key); setPreviewKey(undefined); setError(''); setMobileView('detail'); };
    const locateCurrent = () => {
        const branch = flat.find(item => item.endpoint?.key === current);
        if (branch) { setSelectedKey(branch.key); setPreviewKey(undefined); }
        setCollapsed(new Set()); setMobileView('map'); setLocate(value => value + 1);
    };
    const toggle = (key: string) => setCollapsed(previous => { const next = new Set(previous); if (next.has(key)) next.delete(key); else next.add(key); return next; });
    if (!target) return null;
    return <AnchoredDialog title="故事路线" anchor={target.anchor} centered className="ttm-story-dialog" closeDisabled={loading} onClose={() => setTarget(undefined)}>
        <div className={`ttm-story-routes is-mobile-${mobileView}`} aria-busy={loading}>
            <div className="ttm-route-topbar">
                <div className="ttm-route-context"><strong>{overview ? '角色卡全部会话与分支' : point ? `第 ${point.floor} 楼的分支` : '当前会话路线图'}</strong><span>{overview ? `${view.sessionCount} 个会话 · ` : ''}{routes.length} 条路线{point ? ' · 局部视图' : ' · 按剧情摘要浏览'}</span></div>
                <label className="ttm-route-archive"><Icon name="history" width={16} height={16} /><select aria-label="选择总览或会话" value={overview ? '*' : archive?.id ?? ''} disabled={loading} onChange={async event => {
                    const id = event.target.value;
                    if (id === '*') { void showOverview(); return; }
                    resetView(); setOverview(false);
                    if (!id) { setArchive(undefined); return; }
                    setLoading(true);
                    try { const chat = await loadChatArchive(id); if (chat) setArchive(chat); }
                    catch (error) { setError(String(error)); } finally { setLoading(false); }
                }}><option value="*">整张角色卡总览</option><option value="">当前会话</option>{archives.map(item => <option key={item.id} value={item.id}>{item.syncLabel || branchExcerpt(item.lastMessage, 24) || '已保存会话'} · {item.activeCount} 层</option>)}</select></label>
            </div>
            <div className="ttm-route-mobile-tabs" role="group" aria-label="路线视图"><button type="button" aria-pressed={mobileView === 'map'} onClick={() => setMobileView('map')}><Icon name="branch" width={16} height={16} />路线图</button><button type="button" aria-pressed={mobileView === 'detail'} disabled={!selected} onClick={() => setMobileView('detail')}><Icon name="book" width={16} height={16} />剧情预览</button></div>
            {error && <p className="ttm-route-error" role="alert">{error}</p>}
            {!routes.length ? <div className="ttm-route-empty"><Icon name="branch" width={36} height={36} /><h3>故事正要开始</h3><p>开场后的剧情会在这里连成路线。<br />想试试另一个选择时，就从那一段剧情重新出发。</p></div> : <div className="ttm-route-workspace">
                <section className="ttm-route-map-panel" aria-label="故事分支结构">
                    <div className="ttm-route-map-heading"><span className="ttm-route-legend"><i />{archive ? '保存时的路线' : '当前路线'}</span><div>{!overview && <button type="button" disabled={loading} onClick={() => void showOverview()}>角色卡总览</button>}{point && <button type="button" onClick={() => { setTarget({ anchor: target.anchor }); resetView(); }}>整个会话</button>}<button type="button" onClick={locateCurrent}><Icon name="focus" width={15} height={15} />定位当前</button></div></div>
                    <div className="ttm-route-canvas-scroll" ref={mapRef} tabIndex={0} aria-label="路线画布，可滚动浏览">
                        <div className="ttm-route-canvas-size" style={{ width: layout.width * zoom, height: layout.height * zoom }}>
                            <div className="ttm-route-canvas" style={{ width: layout.width, height: layout.height, transform: `scale(${zoom})` }}>
                                <svg className="ttm-route-connectors" width={layout.width} height={layout.height} aria-hidden="true">{layout.links.map(({ from, to }) => {
                                    const x1 = from.x + NODE_WIDTH / 2, y1 = from.y + NODE_HEIGHT, x2 = to.x + NODE_WIDTH / 2, y2 = to.y;
                                    return <path key={to.branch.key} className={to.branch.routes.some(route => route.key === current) ? 'is-current' : ''} d={`M${x1},${y1} C${x1},${y1 + LEVEL_GAP / 2} ${x2},${y2 - LEVEL_GAP / 2} ${x2},${y2}`} />;
                                })}</svg>
                                {layout.nodes.map(({ branch, x, y }) => {
                                    const onCurrent = branch.routes.some(route => route.key === current), atCurrent = branch.endpoint?.key === current;
                                    const summary = branchSummary(branch);
                                    const excerpt = summary || '暂无剧情摘要';
                                    const owner = owners.get(branch.routes[0]?.key);
                                    return <div className={`ttm-map-node ${onCurrent ? 'is-on-route' : ''} ${selected?.key === branch.key ? 'is-selected' : ''}`} key={branch.key} style={{ left: x, top: y, width: NODE_WIDTH, height: NODE_HEIGHT }}>
                                        <button type="button" className="ttm-map-node-main" aria-pressed={selected?.key === branch.key} aria-current={atCurrent ? 'step' : undefined} onClick={() => select(branch.key)}>
                                            <span className="ttm-map-node-meta"><span>{overview ? owner?.label : floors(branch.messages)}</span>{atCurrent && <span className="ttm-route-current"><i />当前进度</span>}</span>
                                            <strong>{branchTitle(branch)}</strong><span className="ttm-map-node-excerpt" title={excerpt}>{excerpt}</span>
                                            <span className="ttm-map-node-foot">{branch.children.length > 1 ? `${branch.routes.length} 条后续路线` : branch.endpoint ? '故事停在这里' : `${branch.messages.length} 层连续剧情`}<Icon name={branch.children.length > 1 ? 'branch' : 'arrow'} width={15} height={15} /></span>
                                        </button>
                                        {!!branch.children.length && <button type="button" className="ttm-map-fold" aria-label={`${collapsed.has(branch.key) ? '展开' : '收起'}${floors(branch.messages)}的后续`} aria-expanded={!collapsed.has(branch.key)} onClick={() => toggle(branch.key)}><Icon name="chevron" width={13} height={13} style={{ transform: collapsed.has(branch.key) ? 'none' : 'rotate(90deg)' }} /></button>}
                                    </div>;
                                })}
                            </div>
                        </div>
                    </div>
                    <div className="ttm-route-map-footer"><span>沿连线浏览 · 点击节点预览</span><div className="ttm-route-zoom" role="group" aria-label="画布缩放"><button type="button" aria-label="缩小路线图" disabled={zoom <= .6} onClick={() => setZoom(value => Math.max(.6, +(value - .1).toFixed(1)))}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M5 12h14" /></svg></button><button type="button" aria-label="重置缩放" onClick={() => setZoom(1)}>{Math.round(zoom * 100)}%</button><button type="button" aria-label="放大路线图" disabled={zoom >= 1.3} onClick={() => setZoom(value => Math.min(1.3, +(value + .1).toFixed(1)))}><Icon name="plus" width={16} height={16} /></button></div></div>
                </section>
                {selected && preview && <aside className="ttm-route-detail" aria-label="选中剧情预览">
                    <div className="ttm-route-detail-heading"><div><h3>{branchTitle(selected)}</h3><span>{overview ? `${selectedOwner?.label} · ` : ''}{floors(selected.messages)} · {selected.messages.length} 层剧情</span></div><Icon name="book" width={22} height={22} /></div>
                    <div className="ttm-route-detail-scroll" key={selected.key}>
                        <label className="ttm-route-floor-select">查看摘要<select value={routeKey(preview)} onChange={event => setPreviewKey(event.target.value)}>{selected.messages.map(node => <option key={routeKey(node)} value={routeKey(node)}>#{node.floor} · {node.role === 'user' ? '你的回复' : node.role === 'assistant' ? '模型剧情' : '记录'}</option>)}</select></label>
                        <div className="ttm-route-prose" key={routeKey(preview)}><span className="ttm-route-speaker">{preview.role === 'user' ? '玩家选择' : '剧情摘要'}</span><p>{preview.role === 'user' ? '这一楼是玩家输入，可展开原文查看具体选择。' : messageStorySummary(preview)?.text || '这条回复暂无可识别的剧情摘要。新回复会优先读取作者摘要，缺少时在同一次生成中补充。'}</p>{messageStorySummary(preview) && <small className="ttm-route-note">{messageStorySummary(preview)!.source === 'author' ? '取自回复中的原有摘要' : '随本次回复生成'}</small>}</div>
                        <details className="ttm-route-original" key={`original:${routeKey(preview)}`}><summary>查看这一楼的原文</summary><p>{branchExcerpt(preview.content, 12000) || '这一楼主要包含互动界面。'}</p></details>
                        {selectedIsCurrentChat && replay && replay.floor > 0 && <div className="ttm-route-replay"><button type="button" className="ttm-btn-secondary" disabled={busy || !canReplay(replay)} onClick={() => void act(() => retryStoryFrom(replay.id, replay.activeSwipeIndex))}><Icon name="branch" width={17} height={17} />从第 {replay.floor} 楼重新选择</button><p>{!canReplay(replay) ? '这一楼尚无完整的选择前状态。' : busy ? '回复与变量处理完成后即可重新选择。' : `保留到第 ${replay.floor} 楼，另开一条路线。原来的后续会完整保留。`}</p></div>}
                        {preview.floor === 0 && <p className="ttm-route-note">开场不参与分支。想换一个开局，可以新建会话。</p>}
                        <div className="ttm-route-destinations"><h4>{selected.routes.length > 1 ? '从这里，故事走向…' : '沿这条路线继续'}</h4>{selected.routes.map(route => {
                            const isCurrent = !archive && route.key === current, end = route.path.at(-1)!;
                            const at = route.path.findIndex(node => routeKey(node) === routeKey(selected.messages.at(-1)!));
                            const summaryNode = route.path.slice(at + 1).find(node => node.role === 'assistant' && messageStorySummary(node)) ?? end;
                            const title = messageStorySummary(summaryNode)?.text || '暂无剧情摘要';
                            return <div className="ttm-route-destination" key={route.key}><div><span>路线 {routes.findIndex(item => item.key === route.key) + 1}{isCurrent ? ' · 当前路线' : ''} · 已到第 {route.depth - 1} 楼</span><p>{title}</p></div><button type="button" className={isCurrent ? 'ttm-btn-secondary' : 'ttm-btn-primary'} disabled={busy || isCurrent} onClick={() => continueRoute(route)}>{isCurrent ? <><Icon name="check" width={16} height={16} />正在游玩</> : <>继续这条路线<Icon name="arrow" width={16} height={16} /></>}</button></div>;
                        })}</div>
                    </div>
                    <div className="ttm-route-preview-note">预览不会改变进度，继续或重新选择时才会切换。</div>
                </aside>}
            </div>}
        </div>
    </AnchoredDialog>;
}

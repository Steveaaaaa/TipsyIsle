import { freeChatName } from '../store/chat-archives';
import { routeKey } from '../store/chat-tree';
import { selectChatBranch, type getChatBranchOptions, type listArchivedChats } from '../store/workspace-store';
import type { ChatMessageNode } from '../types';
import { Icon } from './Icon';
import { openStoryRoutes } from './StoryRoutes';
import { runStoreAction } from './workspace-ui-actions';

interface ConversationHistoryProps {
    historyOpen: boolean;
    hasStory: boolean;
    showingHome: boolean;
    isFree: boolean;
    branchOptions: ReturnType<typeof getChatBranchOptions>;
    lastMessage?: ChatMessageNode;
    generating: boolean;
    activeChatId: string;
    freeTitle: string;
    archivedChats: Awaited<ReturnType<typeof listArchivedChats>>;
    selectedArchivedChatId: string;
    selectedFreeArchive?: { id: string; title: string };
    onSelectArchive: (id: string) => void;
    onRestore: (id: string) => void;
    onEditFree: (editor: { anchor: HTMLElement; kind: 'title' | 'delete'; id: string; value: string }) => void;
    storySaveMenu?: HTMLElement;
    onToggleStorySave: (anchor: HTMLElement) => void;
    workspaceReady: boolean;
    clearing: boolean;
}

export function ConversationHistory({
    historyOpen, hasStory, showingHome, isFree, branchOptions, lastMessage, generating,
    activeChatId, freeTitle, archivedChats, selectedArchivedChatId, selectedFreeArchive, onSelectArchive, onRestore,
    onEditFree, storySaveMenu, onToggleStorySave, workspaceReady, clearing,
}: ConversationHistoryProps) {
    return (
        <div id="ttm-conversation-history" className="ttm-history-panel" data-ti-shell="history" hidden={!historyOpen}>
        {hasStory && !showingHome && <div className="ttm-chat-branch-bar"><button type="button" className="ttm-btn-secondary" onClick={event => openStoryRoutes(undefined, event.currentTarget)}><Icon name="branch" width={18} height={18} />故事路线 · {branchOptions.length}</button><small>查看不同回复与后续选择</small></div>}
        {isFree && !showingHome && <div className="ttm-chat-branch-bar">
            <label htmlFor="ttm-free-branch-select">当前分支</label>
            <select id="ttm-free-branch-select" className="ttm-select-input" value={lastMessage ? routeKey(lastMessage) : ''} disabled={generating || !branchOptions.length} onChange={event => runStoreAction('切换分支', () => selectChatBranch(event.target.value))}>
                {(!lastMessage || !branchOptions.some(branch => branch.id === routeKey(lastMessage))) && <option value={lastMessage ? routeKey(lastMessage) : ''}>{lastMessage ? '当前进度' : '暂无分支'}</option>}
                {branchOptions.map((branch, index) => <option key={branch.id} value={branch.id}>{branch.label.replace(/^路线 \d+ · /, `分支 ${index + 1} · `)}</option>)}
            </select>
            <button type="button" className="ttm-mini-btn" disabled={generating} onClick={event => onEditFree({ kind: 'title', anchor: event.currentTarget, id: activeChatId, value: freeTitle })}>重命名</button>
            <button type="button" className="ttm-mini-btn" disabled={generating} onClick={event => onEditFree({ kind: 'delete', anchor: event.currentTarget, id: activeChatId, value: freeTitle })}>删除本对话</button>
        </div>}
        <div className="ttm-chat-branch-bar ttm-chat-history-bar">
            <label htmlFor="ttm-chat-history-select">已保存会话</label>
            <select
                id="ttm-chat-history-select"
                className="ttm-select-input"
                value={selectedArchivedChatId}
                disabled={generating || archivedChats.length === 0}
                onChange={(event) => onSelectArchive(event.target.value)}
            >
                <option value="">恢复已保存会话</option>
                {(['character', 'free'] as const).map(kind => {
                    const chats = archivedChats.filter(chat => (chat.kind ?? 'character') === kind);
                    return chats.length > 0 && <optgroup key={kind} label={kind === 'free' ? freeChatName : '角色聊天'}>{chats.map(chat => <option key={chat.id} value={chat.id}>{chat.label}</option>)}</optgroup>;
                })}
            </select>
            <button
                type="button"
                className="ttm-mini-btn"
                disabled={generating || !selectedArchivedChatId}
                onClick={() => onRestore(selectedArchivedChatId)}
            >恢复</button>
            {selectedFreeArchive && <>
                <button type="button" className="ttm-mini-btn" disabled={generating} onClick={event => onEditFree({ kind: 'title', anchor: event.currentTarget, id: selectedFreeArchive.id, value: selectedFreeArchive.title })}>重命名</button>
                <button type="button" className="ttm-mini-btn" disabled={generating} onClick={event => onEditFree({ kind: 'delete', anchor: event.currentTarget, id: selectedFreeArchive.id, value: selectedFreeArchive.title })}>删除</button>
            </>}
            {!isFree && <button type="button" className="ttm-mini-btn" aria-haspopup="menu" aria-expanded={!!storySaveMenu} disabled={!workspaceReady || clearing}
                onClick={event => onToggleStorySave(event.currentTarget)}><Icon name="archive" width={16} height={16} />故事存档</button>}
            <small>新对话保留旧历史</small>
        </div>
        </div>
    );
}

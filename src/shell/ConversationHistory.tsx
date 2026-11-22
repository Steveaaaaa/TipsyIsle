import { routeKey } from '../store/chat-tree';
import { selectChatBranch, type getChatBranchOptions } from '../store/workspace-store';
import type { ChatMessageNode } from '../types';
import { runUiAction } from './workspace-ui-actions';

interface ConversationHistoryProps {
    historyOpen: boolean;
    branchOptions: ReturnType<typeof getChatBranchOptions>;
    lastMessage?: ChatMessageNode;
    generating: boolean;
}

export function ConversationHistory({ historyOpen, branchOptions, lastMessage, generating }: ConversationHistoryProps) {
    return (
        <div id="ttm-conversation-history" className="ttm-history-panel" data-ti-shell="history" hidden={!historyOpen}>
        <div className="ttm-chat-branch-bar">
            <label htmlFor="ttm-free-branch-select">当前分支</label>
            <select id="ttm-free-branch-select" className="ttm-select-input" value={lastMessage ? routeKey(lastMessage) : ''} disabled={generating || !branchOptions.length} onChange={event => { const id = event.target.value; void runUiAction('切换分支', () => selectChatBranch(id), undefined); }}>
                {(!lastMessage || !branchOptions.some(branch => branch.id === routeKey(lastMessage))) && <option value={lastMessage ? routeKey(lastMessage) : ''}>{lastMessage ? '当前进度' : '暂无分支'}</option>}
                {branchOptions.map((branch, index) => <option key={branch.id} value={branch.id}>{branch.label.replace(/^路线 \d+ · /, `分支 ${index + 1} · `)}</option>)}
            </select>
        </div>
        </div>
    );
}

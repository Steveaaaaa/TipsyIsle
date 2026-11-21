const pageKey = 'tipsy:workspace-page';

export type WorkspaceTab = 'characters' | 'chat' | 'inspector' | 'free';
export type AppearancePage = 'editor' | 'packages' | false;

interface WorkspacePage {
    tab: WorkspaceTab;
    chatId: string | null;
    appearance: AppearancePage;
    nightShelf: boolean;
}

export function readWorkspacePage(activeChatId: string | null): WorkspacePage {
    try {
        const saved = JSON.parse(localStorage.getItem(pageKey) ?? 'null');
        if (saved?.tab === 'characters' || saved?.tab === 'chat' || saved?.tab === 'inspector' || saved?.tab === 'free') {
            const chatId = activeChatId && saved.chatId === activeChatId ? activeChatId : null;
            return {
                tab: saved.tab,
                chatId,
                appearance: saved.appearance === 'editor' || saved.appearance === 'packages' ? saved.appearance : false,
                nightShelf: saved.tab === 'free' || (saved.nightShelf ?? chatId?.startsWith('free_')) === true,
            };
        }
    } catch { /* An unavailable preference should not block startup. */ }
    return { tab: 'chat', chatId: null, appearance: false, nightShelf: false };
}

export function rememberWorkspacePage(page: WorkspacePage): void {
    try { localStorage.setItem(pageKey, JSON.stringify(page)); }
    catch { /* Navigation still works without local storage. */ }
}

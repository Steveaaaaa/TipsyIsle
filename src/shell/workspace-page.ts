const pageKey = 'tipsy:workspace-page';

export type WorkspaceTab = 'characters' | 'chat' | 'inspector';
export type AppearancePage = 'editor' | 'packages' | false;

interface WorkspacePage {
    tab: WorkspaceTab;
    chatId: string | null;
    appearance: AppearancePage;
}

export function readWorkspacePage(activeChatId: string | null): WorkspacePage {
    try {
        const saved = JSON.parse(localStorage.getItem(pageKey) ?? 'null');
        if (saved?.tab === 'characters' || saved?.tab === 'chat' || saved?.tab === 'inspector') {
            return {
                tab: saved.tab,
                chatId: activeChatId && saved.chatId === activeChatId ? activeChatId : null,
                appearance: saved.appearance === 'editor' || saved.appearance === 'packages' ? saved.appearance : false,
            };
        }
    } catch { /* An unavailable preference should not block startup. */ }
    return { tab: 'chat', chatId: null, appearance: false };
}

export function rememberWorkspacePage(page: WorkspacePage): void {
    try { localStorage.setItem(pageKey, JSON.stringify(page)); }
    catch { /* Navigation still works without local storage. */ }
}

import { createReactiveStore } from './reactive-store';

export type NotificationKind = 'info' | 'success' | 'warning' | 'error' | 'progress';
export interface AppNotification { id: string; message: string; kind: NotificationKind; }
export interface NotificationOptions { id?: string; kind?: NotificationKind; duration?: number; }
export const notificationStore = createReactiveStore<{ items: AppNotification[] }>(() => ({ items: [] }));
const timers = new Map<string, ReturnType<typeof setTimeout>>();

export function dismissNotification(id: string): void {
    clearTimeout(timers.get(id)); timers.delete(id);
    notificationStore.setState(draft => { draft.items = draft.items.filter(item => item.id !== id); });
}
export function showNotification(message: string, options: NotificationOptions = {}): string {
    const id = options.id ?? crypto.randomUUID();
    const kind = options.kind ?? 'info';
    const duration = options.duration ?? (kind === 'progress' ? 0 : kind === 'success' ? 3000 : kind === 'error' ? 10000 : 5000);
    clearTimeout(timers.get(id)); timers.delete(id);
    notificationStore.setState(draft => {
        const existing = draft.items.find(item => item.id === id);
        if (existing) Object.assign(existing, { message, kind });
        else draft.items.push({ id, message, kind });
    });
    if (duration > 0) timers.set(id, setTimeout(() => dismissNotification(id), duration));
    return id;
}

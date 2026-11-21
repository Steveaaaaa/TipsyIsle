import { showNotification, dismissNotification, type NotificationOptions } from '../notification-store';

export function setStatusBanner(text: string | null, options: NotificationOptions = {}): void {
    if (text === null) dismissNotification('workspace');
    else showNotification(text, { id: 'workspace', kind: /失败|错误|异常/.test(text) ? 'error' : 'info', ...options });
}

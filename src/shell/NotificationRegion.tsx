import { createPortal } from 'react-dom';
import { useLayoutEffect, useState } from 'react';
import { dismissNotification, notificationStore } from '../store/notification-store';
import { Icon } from './Icon';
import { topAppDialog } from './AnchoredDialog';
import './notifications.css';

export function NotificationRegion() {
    const items = notificationStore.useStore(state => state.items);
    const [target, setTarget] = useState<Element>(document.body);
    useLayoutEffect(() => {
        const update = () => setTarget(topAppDialog() ?? document.body);
        update(); window.addEventListener('tipsy-dialog-change', update);
        return () => window.removeEventListener('tipsy-dialog-change', update);
    }, []);
    return createPortal(<aside className="ttm-notifications" data-ti-shell="notifications" aria-label="通知">{items.map(item =>
        <div key={item.id} className={`ttm-notification is-${item.kind}`} role={item.kind === 'error' ? 'alert' : 'status'}>
            <span className="ttm-notification-state" aria-hidden="true" />
            <span className="ttm-notification-message">{item.message}</span>
            {item.action && <button type="button" className="ttm-notification-action" onClick={item.action.run}>{item.action.label}</button>}
            <button type="button" aria-label="关闭通知" onClick={() => dismissNotification(item.id)}><Icon name="close" width={15} height={15} /></button>
        </div>
    )}</aside>, target);
}

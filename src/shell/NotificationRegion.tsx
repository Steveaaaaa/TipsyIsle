import { createPortal } from 'react-dom';
import { useLayoutEffect, useState } from 'react';
import { dismissNotification, notificationStore, showNotification } from '../store/notification-store';
import { Icon } from './Icon';
import { AnchoredDialog, topAppDialog } from './AnchoredDialog';
import './notifications.css';

const exportDialogClass = 'ttm-diagnostic-export-dialog';

export function NotificationRegion() {
    const items = notificationStore.useStore(state => state.items);
    const [target, setTarget] = useState<Element>(document.body);
    const [exportAnchor, setExportAnchor] = useState<HTMLElement | null>(null);
    useLayoutEffect(() => {
        const update = () => {
            const dialog = topAppDialog();
            if (!dialog?.classList.contains(exportDialogClass)) setTarget(dialog ?? document.body);
        };
        update(); window.addEventListener('tipsy-dialog-change', update);
        return () => window.removeEventListener('tipsy-dialog-change', update);
    }, []);
    return <>
        {createPortal(<aside className="ttm-notifications" data-ti-shell="notifications" aria-label="通知">{items.map(item =>
            <div key={item.id} data-notification-id={item.id} className={`ttm-notification is-${item.kind}`}>
                <span className="ttm-notification-state" aria-hidden="true" />
                <span className="ttm-notification-message" role={item.kind === 'error' ? 'alert' : 'status'}>{item.message}</span>
                {item.kind === 'error' ? <div className="ttm-notification-error-actions">
                    {item.secondaryAction && <button type="button" className="ttm-notification-action is-secondary" onClick={item.secondaryAction.run}>{item.secondaryAction.label}</button>}
                    {item.action && <button type="button" className="ttm-notification-action" onClick={item.action.run}>{item.action.label}</button>}
                    <button type="button" className="ttm-notification-action" aria-haspopup="dialog" onClick={event => setExportAnchor(event.currentTarget)}>
                        <Icon name="download" width={14} height={14} />导出错误日志
                    </button>
                </div> : (item.action || item.secondaryAction) && <div className="ttm-notification-actions">
                    {item.secondaryAction && <button type="button" className="ttm-notification-action is-secondary" onClick={item.secondaryAction.run}>{item.secondaryAction.label}</button>}
                    {item.action && <button type="button" className="ttm-notification-action" onClick={item.action.run}>{item.action.label}</button>}
                </div>}
                <button type="button" className="ttm-notification-close" aria-label="关闭通知" onClick={() => dismissNotification(item.id)}><Icon name="close" width={15} height={15} /></button>
            </div>
        )}</aside>, target)}
        {exportAnchor && createPortal(<DiagnosticExportDialog anchor={exportAnchor} onClose={() => setExportAnchor(null)} />, document.body)}
    </>;
}

function DiagnosticExportDialog({ anchor, onClose }: { anchor: HTMLElement; onClose: () => void }) {
    const [exporting, setExporting] = useState(false);
    const [failed, setFailed] = useState(false);
    const exportLog = async () => {
        setExporting(true); setFailed(false);
        try {
            const { exportDiagnosticReport } = await import('../core/diagnostics-report');
            if (await exportDiagnosticReport()) {
                onClose();
                showNotification('错误日志已导出。你可以把文件发给开发者。', { kind: 'success' });
            }
        } catch { setFailed(true); }
        finally { setExporting(false); }
    };
    return <AnchoredDialog title="导出错误日志" className={exportDialogClass} anchor={anchor} onClose={onClose} compact fitContent centered closeDisabled={exporting}>
        <p>将近期错误、运行环境和插件信息保存为一份 .txt 文件。遇到问题时，可以把这份文件发给开发者，帮助定位原因。</p>
        <p className="ttm-settings-note">文件只保存到你的设备，不会自动发送。</p>
        {failed && <p role="alert">无法导出错误日志，请换一个保存位置后重试。</p>}
        <div className="ttm-editor-actions">
            <button type="button" className="ttm-btn-secondary" disabled={exporting} onClick={onClose}>取消</button>
            <button type="button" className="ttm-btn-primary" disabled={exporting} onClick={() => void exportLog()}>
                <Icon name="download" width={16} height={16} />{exporting ? '正在导出…' : '导出日志'}
            </button>
        </div>
    </AnchoredDialog>;
}

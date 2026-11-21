import { useState } from 'react';
import { clearDiagnostics, diagnosticsStore, formatDiagnostic } from '../core/diagnostics';
import { exportDiagnosticReport } from '../core/diagnostics-report';
import { Icon } from './Icon';
import './diagnostic-log.css';

const pageSize = 30;

export function DiagnosticLogPanel() {
    const { entries, storageFailed } = diagnosticsStore.useStore();
    const [limit, setLimit] = useState(pageSize);
    const [exporting, setExporting] = useState(false);
    const [notice, setNotice] = useState('');
    const exportLog = async () => {
        setExporting(true); setNotice('');
        try {
            if (await exportDiagnosticReport()) setNotice('已导出诊断日志。');
        } catch { setNotice('无法导出诊断日志，请换一个保存位置后重试。'); }
        finally { setExporting(false); }
    };

    return <div className="ttm-diagnostic-log">
        <div className="ttm-diagnostic-actions">
            <button type="button" className="ttm-btn-secondary" disabled={exporting} onClick={() => void exportLog()}>
                <Icon name="download" width={16} height={16} />{exporting ? '正在导出…' : '导出诊断日志'}
            </button>
            <button type="button" className="ttm-btn-secondary" disabled={exporting || (!entries.length && !storageFailed)} onClick={() => {
                const saved = clearDiagnostics(); setLimit(pageSize);
                setNotice(saved ? '已清空日志。' : '本次记录已清空，无法更新设备上的日志。');
            }}>清空日志</button>
        </div>
        {notice && <p className="ttm-settings-note" role="status">{notice}</p>}
        {storageFailed && <p className="ttm-settings-note" role="status">无法保存到设备，当前仍可导出已有记录。</p>}
        <p className="ttm-settings-note">{entries.length ? `最近记录 · ${entries.length} 条` : '暂无日志记录。'}</p>
        {!!entries.length && <ul className="ttm-diagnostic-list">{entries.slice(-limit).reverse().map((row, index) => (
            <li key={`${row.at}:${row.operation ?? ''}:${row.area}:${row.action}:${row.result}:${entries.length - index}`}>
                <details>
                    <summary>
                        <time dateTime={new Date(row.at).toISOString()}>{new Date(row.at).toLocaleTimeString('zh-CN', { hour12: false })}</time>
                        <span>{row.area} · {row.action}{row.component ? ` · ${row.component}` : ''}</span>
                        <span data-result={row.result}>{row.result}</span>
                        <Icon name="chevron" width={14} height={14} />
                    </summary>
                    <p>{formatDiagnostic(row)}</p>
                </details>
            </li>
        ))}</ul>}
        {entries.length > limit && <button type="button" className="ttm-btn-ghost" onClick={() => setLimit(limit + pageSize)}>显示更早的记录</button>}
    </div>;
}

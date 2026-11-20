import { useEffect, useState } from 'react';
import { applyMvuRepair, canUndoMvuRepair, prepareMvuRepair, setStatusBanner, undoMvuRepair, workspaceStore, type MvuRepairPreview } from '../store/workspace-store';

export function MvuRepairPanel({ disabled }: { disabled: boolean }) {
    const state = workspaceStore.useStore();
    const [open, setOpen] = useState(false), [direction, setDirection] = useState(''), [preview, setPreview] = useState<MvuRepairPreview>();
    const [busy, setBusy] = useState(false), [error, setError] = useState('');
    useEffect(() => { setPreview(undefined); setOpen(false); setError(''); }, [state.activeChatId, state.activeLeafId]);
    const run = async (operation: () => Promise<void>) => {
        setBusy(true); setError('');
        try { await operation(); } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
        finally { setBusy(false); }
    };
    return <details className="ttm-panel-block" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
        <summary>增量校正变量</summary>
        <label htmlFor="mvu-repair-direction">核验方向（可选）</label>
        <textarea id="mvu-repair-direction" className="ttm-text-input" value={direction} disabled={busy} onChange={event => setDirection(event.target.value)} placeholder="例如：检查本轮物品消耗是否遗漏" />
        <button type="button" className="ttm-mini-btn" disabled={disabled || busy} onClick={() => void run(async () => { setPreview(await prepareMvuRepair(direction)); })}>
            {busy ? '正在处理…' : '生成校正预览'}
        </button>
        <button type="button" className="ttm-mini-btn" disabled={disabled || busy || !canUndoMvuRepair()} onClick={() => void run(async () => { setStatusBanner(await undoMvuRepair()); setPreview(undefined); })}>撤销最近校正</button>
        {preview && <>
            <p>以下是校正前后的变量。应用会保存变量并追加更新命令。</p>
            <details><summary>校正前</summary><pre className="ttm-json-preview">{JSON.stringify(preview.before, null, 2)}</pre></details>
            <details open><summary>校正后</summary><pre className="ttm-json-preview">{JSON.stringify(preview.after, null, 2)}</pre></details>
            <button type="button" className="ttm-mini-btn" disabled={disabled || busy} onClick={() => void run(async () => { setStatusBanner(await applyMvuRepair(preview)); setPreview(undefined); })}>应用校正</button>
            <button type="button" className="ttm-mini-btn" disabled={busy} onClick={() => setPreview(undefined)}>丢弃预览</button>
        </>}
        {error && <p role="alert">{error}</p>}
    </details>;
}

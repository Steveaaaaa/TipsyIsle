import { useState } from 'react';
import { lanSyncStore, resolveWorldbookReview } from '../core/sync/engine';
import { worldbookDifference } from '../core/sync/worldbook-diff';
import { AnchoredDialog } from './AnchoredDialog';
import './lan-sync.css';

export function WorldbookSyncReview() {
    const view = lanSyncStore.useStore();
    const [dismissed, setDismissed] = useState('');
    const [working, setWorking] = useState(false);
    const [error, setError] = useState('');
    const reviews = Object.entries(view.state?.worldbookReviews ?? {});
    const signature = reviews.map(([id, review]) => `${id}:${review.local.version}:${review.remote.version}`).join('|');
    if (!reviews.length || view.editingWorldbooks || signature === dismissed && !view.reviewPrompt) return null;
    const [id, review] = reviews[0];
    const differences = worldbookDifference(review.local, review.remote);
    const choose = async (choice: 'local' | 'remote') => {
        setWorking(true); setError('');
        try { await resolveWorldbookReview(id, choice, review.local.version, review.remote.version); }
        catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
        finally { setWorking(false); }
    };
    const close = () => { setDismissed(signature); setError(''); lanSyncStore.setState({ reviewPrompt: false }); };
    return <AnchoredDialog title="选择世界书版本" anchor={document.body} onClose={close} closeDisabled={working}>
        <div className="ttm-lan-sync">
            <p>两端分别修改了「{review.local.value?.name ?? review.remote.value?.name ?? '当前会话的世界书'}」，内容不同。选择后会同步到另一台设备。</p>
            <p className="ttm-settings-note">共 {reviews.length} 项待确认。稍后处理会保留本机版本和待确认的远端版本。</p>
            <div className="ttm-sync-differences">{differences.map((difference, index) => <section key={index}>
                <h3>{difference.field.replace(/^ \/ /, '')}</h3>
                <div className="ttm-sync-comparison">
                    <div><strong>本机 · {view.state?.deviceName}</strong><pre>{difference.local}</pre></div>
                    <div><strong>另一端 · {review.remote.device}</strong><pre>{difference.remote}</pre></div>
                </div>
            </section>)}</div>
            {error && <p className="ttm-lan-error" role="alert">{error}</p>}
            <div className="ttm-lan-actions">
                <button type="button" className="ttm-btn-primary" disabled={working || view.busy} onClick={() => void choose('local')}>保留本机版本</button>
                <button type="button" className="ttm-btn-secondary" disabled={working || view.busy} onClick={() => void choose('remote')}>采用另一端版本</button>
                <button type="button" className="ttm-btn-secondary" disabled={working} onClick={close}>稍后处理</button>
            </div>
        </div>
    </AnchoredDialog>;
}

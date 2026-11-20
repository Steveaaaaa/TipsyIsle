import { useEffect, useState } from 'react';
import { bindStoryGallery, pickGalleryArchive, readStoryGallery, unbindStoryGallery } from '../core/story-gallery';
import type { StoryGallery } from '../core/gallery-types';
import { refreshCompatibilityGallery } from '../compatibility/runtime-client';
import './story-gallery.css';

export function StoryGalleryPanel({ storyId, name, onChanged }: { storyId: string; name: string; onChanged: (bound: boolean) => void }) {
    const [gallery, setGallery] = useState<StoryGallery | null>(null);
    const [busy, setBusy] = useState(false);
    const [reading, setReading] = useState(true);
    const [progress, setProgress] = useState('');
    const [error, setError] = useState('');
    const [password, setPassword] = useState('');
    useEffect(() => { let active = true; void readStoryGallery(storyId).then(value => { if (active) setGallery(value); }).catch(error => { if (active) setError(String(error)); }).finally(() => { if (active) setReading(false); }); return () => { active = false; }; }, [storyId]);
    const bind = async () => {
        setError(''); setBusy(true);
        try {
            const archive = await pickGalleryArchive();
            if (!archive) return;
            setGallery(await bindStoryGallery(storyId, archive, setProgress, password || undefined));
            onChanged(true);
            refreshCompatibilityGallery(storyId);
            setProgress('图库已绑定。若页面已切换到网络备用图，重新打开故事即可使用本地图。');
        } catch (error) { setError(error instanceof Error ? error.message : String(error)); setProgress(''); }
        finally { setBusy(false); }
    };
    return <section className="ttm-gallery-panel" aria-busy={busy || reading}>
        <p className="ttm-asset-help">为「{name}」绑定作者提供的图库。图片保存在本机，只供这个故事使用。</p>
        {gallery ? <div className="ttm-gallery-summary"><strong>{gallery.name}</strong><span>{gallery.files.length} 张图片 · {(gallery.bytes / 1048576).toFixed(1)} MB</span></div> : <p className="ttm-asset-help">{reading ? '正在读取图库…' : '尚未绑定本地图库'}</p>}
        <p className="ttm-asset-help">支持 RAR、ZIP。保留压缩包中的原始文件名和文件夹；作者页面中的本地图片路径会自动对应。</p>
        <details><summary>RAR 压缩包需要密码</summary><label className="ttm-gallery-password">解压密码<input type="password" autoComplete="off" value={password} disabled={busy} onChange={event => setPassword(event.target.value)} /></label></details>
        <div className="ttm-gallery-actions"><button type="button" className="ttm-btn-primary" disabled={busy || reading} onClick={() => void bind()}>{busy ? '正在绑定…' : gallery ? '更换图库' : '选择图库压缩包'}</button>
            {gallery && <button type="button" className="ttm-btn-secondary" disabled={busy} onClick={async () => {
                setBusy(true); setError('');
                try { await unbindStoryGallery(storyId); setGallery(null); onChanged(false); refreshCompatibilityGallery(storyId); setProgress('已移除本机绑定的图库，原始压缩包保留。'); }
                catch (error) { setError(String(error)); } finally { setBusy(false); }
            }}>移除图库</button>}</div>
        {progress && <p className="ttm-asset-help" role="status">{progress}</p>}
        {error && <p className="ttm-gallery-error" role="alert">{error}</p>}
    </section>;
}

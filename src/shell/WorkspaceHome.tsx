import { Icon } from './Icon';
import { ShellArt } from '../theme/appearance-shell';
import type { Appearance } from '../theme/appearance-model';
import { freeChatName } from '../store/chat-archives';

interface WorkspaceHomeProps {
    skin?: Appearance;
    hasStory: boolean;
    hasCards: boolean;
    isFree: boolean;
    importing: boolean;
    clearing: boolean;
    generating: boolean;
    onResume: () => void;
    onShowLibrary: () => void;
    onImport: () => Promise<void>;
    onBeginFree: () => Promise<boolean>;
    onFinishGuide: () => void;
    onOpenPersona: (anchor: HTMLElement) => void;
    onOpenConnection: () => void;
    onReplayGuide: () => void;
}

export function WorkspaceHome({
    skin, hasStory, hasCards, isFree, importing, clearing, generating, onResume, onShowLibrary, onImport, onBeginFree, onFinishGuide, onOpenPersona, onOpenConnection, onReplayGuide,
}: WorkspaceHomeProps) {
    return (
        <div className="ttm-home-view"><section className="ttm-start-page" data-ti-shell="empty" aria-label="首页">
            <span className="ttm-welcome-mark" data-ti-part="welcome-art"><ShellArt skin={skin} id="welcome" fallback={<img className="ttm-home-mark" src="/icons/192x192.png" alt="" />} /></span>
            <h2 data-ti-type="heading">{skin?.text[hasCards ? 'empty-library' : 'empty'] ?? (hasStory ? '故事还在等你' : hasCards ? '选一个故事，继续你的旅程' : '下一段故事，从这里开始')}</h2>
            <div className="ttm-home-actions">
                {hasStory ? <button type="button" className="ttm-btn-primary" onClick={onResume}><Icon name="arrow" width={18} height={18} /><span>继续故事</span></button>
                    : hasCards ? <button type="button" className="ttm-btn-primary" onClick={onShowLibrary}><Icon name="book" width={18} height={18} /><span>打开馆藏</span></button>
                    : <button type="button" className="ttm-btn-primary" disabled={importing || clearing || generating} onClick={() => void onImport()}><Icon name="upload" width={18} height={18} /><span>{importing ? '正在导入…' : '导入角色卡'}</span></button>}
                <button type="button" className="ttm-btn-secondary ttm-home-model-chat" data-guide="model-chat" disabled={generating || clearing} onClick={event => {
                    const finishGuide = event.currentTarget.hasAttribute('data-guide-active');
                    void onBeginFree().then(started => { if (started && finishGuide) onFinishGuide(); });
                }}><Icon name="chat" width={18} height={18} /><span>{freeChatName}<span className="ttm-home-model-note">（和模型对话）</span></span></button>
            </div>
            {isFree && <button type="button" className="ttm-btn-ghost ttm-home-resume" onClick={onResume}>返回当前对话</button>}
            <nav className="ttm-home-links" aria-label="首页快捷入口">
                <button type="button" className="ttm-btn-ghost" onClick={event => onOpenPersona(event.currentTarget)}>个人资料</button>
                <button type="button" className="ttm-btn-ghost" onClick={() => onOpenConnection()}>模型连接</button>
                <button type="button" className="ttm-btn-ghost" onClick={onReplayGuide}>使用引导</button>
            </nav>
        </section></div>
    );
}

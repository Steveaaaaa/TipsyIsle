import { compatibilityOrigin } from '../core/native-runtime';
import { useEffect, useRef, useState } from 'react';
import { connectCompatibilityFrame } from './runtime-client';
import { themeEngineStore, readingThemeTokens } from '../theme/theme-engine';
import type { ReadingPresentation } from '../theme/reading-presentation';
import type { ReadingNavigationProps } from '../shell/reading-navigation';
import { readReadingBookmark } from '../shell/reading-bookmark';
import { CompatibilityLoading } from './CompatibilityLoading';

/** Separate origin: nested documents share APIs without accessing the application origin. */
export function CompatibilityChat({ session, visible = true, extensionPanel = false, closeExtensionPanel, replyId, jumpRequest, onReadingActivity, onReplyPosition }: {
    session: string; revision: unknown; visible?: boolean; extensionPanel?: boolean; closeExtensionPanel?: () => void;
} & ReadingNavigationProps) {
    const frame = useRef<HTMLIFrameElement>(null);
    const initialVisible = useRef(visible);
    const initialSession = useRef(session);
    const [failure, setFailure] = useState<string | null>(null);
    const [epoch, setEpoch] = useState(0);
    const [stopped, setStopped] = useState(false);
    const [readySession, setReadySession] = useState('');
    const [popupSession, setPopupSession] = useState('');
    const [startupStage, setStartupStage] = useState('等待兼容服务连接');
    useEffect(() => {
        const receive = (event: MessageEvent) => {
            if (event.source !== frame.current?.contentWindow || event.origin !== compatibilityOrigin || event.data?.session !== session) return;
            if (event.data.kind === 'compat:popup') { setPopupSession(event.data.visible === true ? session : ''); return; }
            if (!visible) return;
            if (event.data.kind === 'compat:reading-activity') onReadingActivity(event.data.activity === 'tap' ? 'tap' : 'scroll');
            if (event.data.kind === 'compat:reply-position' && event.data.replyId === replyId) onReplyPosition(event.data.away === true);
        };
        window.addEventListener('message', receive);
        return () => window.removeEventListener('message', receive);
    }, [session, visible, replyId, onReadingActivity, onReplyPosition]);
    useEffect(() => { setPopupSession(''); }, [epoch, failure, stopped]);
    const popupOpen = popupSession === session;
    useEffect(() => {
        if (!popupOpen) return;
        const restore = document.activeElement;
        frame.current?.contentWindow?.postMessage({ kind: 'compat:popup-focus', session }, compatibilityOrigin);
        return () => {
            if (restore instanceof HTMLElement && restore !== frame.current && restore.isConnected &&
                (document.activeElement === document.body || document.activeElement === frame.current)) restore.focus({ preventScroll: true });
        };
    }, [popupOpen, session]);
    const publishTarget = () => frame.current?.contentWindow?.postMessage({ kind: 'compat:reading-target', session, replyId }, compatibilityOrigin);
    useEffect(publishTarget, [session, replyId, readySession, visible, epoch]);
    const lastJump = useRef(jumpRequest);
    useEffect(() => {
        if (!visible || !replyId || !jumpRequest || lastJump.current === jumpRequest) return;
        lastJump.current = jumpRequest;
        frame.current?.contentWindow?.postMessage({ kind: 'compat:reading-jump', session, replyId }, compatibilityOrigin);
    }, [jumpRequest, replyId, session, visible]);
    const publishPresentation = () => {
        const { layoutMode, streamLoadingSprite } = themeEngineStore.getState();
        const tokens = readingThemeTokens();
        const presentation: ReadingPresentation = { tokens, layoutMode, streamLoadingSprite, colorScheme: document.documentElement.dataset.colorScheme === 'light' ? 'light' : 'dark' };
        frame.current?.contentWindow?.postMessage({ kind: 'compat:presentation', presentation }, compatibilityOrigin);
    };
    useEffect(() => {
        publishPresentation();
        publishTarget();
        window.addEventListener('tipsy-theme-change', publishPresentation);
        return () => window.removeEventListener('tipsy-theme-change', publishPresentation);
    }, []);
    useEffect(() => {
        setStartupStage('等待兼容服务连接');
        const progress = (event: Event) => {
            const detail = (event as CustomEvent<{ session: string; stage: string }>).detail;
            if (detail.session === session) setStartupStage(detail.stage);
        };
        window.addEventListener('tipsy-compatibility-stage', progress);
        return () => window.removeEventListener('tipsy-compatibility-stage', progress);
    }, [session, epoch]);
    useEffect(() => {
        const stop = () => setStopped(true);
        const ready = (event: Event) => setReadySession((event as CustomEvent<string>).detail);
        window.addEventListener('tipsy-compatibility-stop', stop);
        window.addEventListener('tipsy-compatibility-ready', ready);
        return () => { window.removeEventListener('tipsy-compatibility-stop', stop); window.removeEventListener('tipsy-compatibility-ready', ready); };
    }, []);
    useEffect(() => {
        const reload = () => { setStopped(false); setFailure(null); setReadySession(''); setEpoch(value => value + 1); };
        window.addEventListener('tipsy-compatibility-reload', reload);
        return () => window.removeEventListener('tipsy-compatibility-reload', reload);
    }, []);
    useEffect(() => { setFailure(null); }, [session]);
    useEffect(() => {
        const handle = (event: Event) => {
            const detail = (event as CustomEvent<{ session: string; message: string }>).detail;
            if (detail?.session === session) setFailure(detail.message);
        };
        window.addEventListener('tipsy-compatibility-fault', handle);
        return () => window.removeEventListener('tipsy-compatibility-fault', handle);
    }, [session]);
    const disconnectFrame = useRef<() => void>(() => {});
    useEffect(() => () => disconnectFrame.current(), [epoch, failure, stopped]);
    useEffect(() => {
        if (stopped) return;
        const win = frame.current?.contentWindow;
        if (win) disconnectFrame.current = connectCompatibilityFrame(win, session);
    }, [session, epoch, failure, stopped]);
    // Workspace host batches snapshot publication. A React effect here used to
    // send a second snapshot for every streamed token and variable write.
    const publishView = () => frame.current?.contentWindow?.postMessage({ kind: 'compat:view', visible, session,
        readingBookmark: visible ? readReadingBookmark(session) : undefined }, compatibilityOrigin);
    useEffect(publishView, [visible, session]);
    const panelOverlay = extensionPanel && !visible;
    const frameVisible = visible || extensionPanel || popupOpen;
    if (stopped) return null;
    if (failure) return <div role="alert" className="ttm-compatibility-error">
        <p>{failure}</p>
        <button type="button" className="ttm-btn-secondary" onClick={() => { setFailure(null); setReadySession(''); setEpoch(value => value + 1); }}>重新载入角色运行环境</button>
    </div>;
    const preparing = readySession !== session;
    return <>{preparing && !popupOpen && <div className="ttm-compatibility-loading-cover"><CompatibilityLoading key={`${session}:${epoch}`} stage={startupStage} /></div>}
        {extensionPanel && <button type="button" className="ttm-btn-secondary ttm-extension-panel-close" onClick={closeExtensionPanel}>返回聊天</button>}
        {popupOpen && visible && <div className="ttm-compatibility-chat" aria-hidden="true" />}
        <iframe key={epoch} ref={frame} hidden={!frameVisible} style={!frameVisible ? { display: 'none' } : undefined} aria-hidden={(preparing && !popupOpen) || !frameVisible} {...(preparing && !popupOpen ? { inert: '', tabIndex: -1 } : {})} onLoad={() => {
        publishPresentation();
        publishView();
        frame.current?.contentWindow?.postMessage({ kind: 'compat:ping' }, compatibilityOrigin);
    }} className={`ttm-compatibility-chat${panelOverlay ? ' ttm-extension-panel-frame' : ''}${popupOpen ? ' ttm-compat-popup-frame' : ''}`} title="角色卡兼容运行环境" allow="autoplay; fullscreen" allowFullScreen sandbox="allow-scripts allow-same-origin allow-modals" src={`${compatibilityOrigin}/compat.html?session=${encodeURIComponent(initialSession.current)}&view=${initialVisible.current ? 'chat' : 'worker'}`} /></>;
}

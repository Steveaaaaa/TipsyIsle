import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { CompatibilityChat } from '../compatibility/CompatibilityChat';
import { freeChatName } from '../store/chat-archives';
import { deleteChatMessage, editChatMessage, formatMessageForDisplay, getActiveChatMessages, getActivePersona, isMessageTemplatePending, replaceActiveWorldbookEntries, swipeChatMessage, workspaceStore, type WorkspaceState } from '../store/workspace-store';
import type { ThemeEngineState } from '../theme/theme-engine';
import type { ChatMessageNode, NormalizedCharacterCard, NormalizedLorebook, NormalizedPreset } from '../types';
import { MessageEditDialog } from './MessageEditDialog';
import { VirtualChatStream } from './VirtualChatStream';
import type { ReplyJumpMode } from './reading-navigation';
import type { useReadingMode } from './useReadingMode';

interface ConversationReadingProps {
    state: WorkspaceState;
    activeMessages: ChatMessageNode[];
    activeCharacter: NormalizedCharacterCard;
    activePreset: NormalizedPreset;
    activeLorebooks: NormalizedLorebook[];
    isFree: boolean;
    hasStory: boolean;
    hasChat: boolean;
    canPlay: boolean;
    workspaceReady: boolean;
    needsConnection: boolean;
    onOpenConnection: () => void;
    layoutMode: ThemeEngineState['layoutMode'];
    hasWallpaper: boolean;
    illustrationAnchor: RefObject<HTMLDivElement>;
    compatibilityView: boolean;
    extensionPanel: boolean;
    closeExtensionPanel: () => void;
    onReadingActivity: ReturnType<typeof useReadingMode>['onReadingActivity'];
    onIllustrateMessage?: (id: string) => void;
    runSlashCommand: (script: string) => Promise<string>;
    requestGenerate: (promptOverride?: string) => Promise<string>;
}

export function ConversationReading({
    state, activeMessages, activeCharacter, activePreset, activeLorebooks, isFree, hasStory,
    hasChat, canPlay, workspaceReady, needsConnection, onOpenConnection, layoutMode, hasWallpaper,
    illustrationAnchor, compatibilityView, extensionPanel, closeExtensionPanel, onReadingActivity, onIllustrateMessage, runSlashCommand,
    requestGenerate,
}: ConversationReadingProps) {
    const [replyPosition, setReplyPosition] = useState<{ id?: string; mode: ReplyJumpMode }>({ mode: 'none' });
    const [jumpRequest, setJumpRequest] = useState(0);
    const [jumpMode, setJumpMode] = useState<Exclude<ReplyJumpMode, 'none'>>('reply-start');
    const [jumpReveal, setJumpReveal] = useState(false);
    const [lastJumpMode, setLastJumpMode] = useState<Exclude<ReplyJumpMode, 'none'>>('reply-start');
    const hideTimerRef = useRef<ReturnType<typeof setTimeout>>();
    const pinnedRef = useRef(false);

    const latestMessage = activeMessages.at(-1);
    const latestReply = latestMessage?.role === 'assistant' && latestMessage.floor > 0 ? latestMessage : undefined;
    const replyId = useMemo(() => !state.isGenerating && !state.helperGenerationCount && !state.mvuExtraAnalysisActive && latestReply &&
        !latestReply.extra?.tipsy_generation_incomplete && (isFree || !isMessageTemplatePending(latestReply)) ? latestReply.id : undefined,
        [isFree, latestReply, state.isGenerating, state.helperGenerationCount, state.mvuExtraAnalysisActive, state.templateRenderRevision]);
    const activeJumpMode: ReplyJumpMode = replyPosition.mode === 'latest-bottom'
        ? 'latest-bottom'
        : replyPosition.mode === 'reply-start' && replyPosition.id === replyId
            ? 'reply-start'
            : 'none';

    useEffect(() => {
        if (activeJumpMode !== 'none') setLastJumpMode(activeJumpMode);
    }, [activeJumpMode]);

    const clearHideTimer = useCallback(() => {
        if (hideTimerRef.current !== undefined) {
            clearTimeout(hideTimerRef.current);
            hideTimerRef.current = undefined;
        }
    }, []);
    const scheduleHide = useCallback((duration: number) => {
        clearHideTimer();
        if (pinnedRef.current) return;
        hideTimerRef.current = setTimeout(() => { setJumpReveal(false); }, duration);
    }, [clearHideTimer]);
    const revealJump = useCallback((duration = 4000) => {
        setJumpReveal(true);
        scheduleHide(duration);
    }, [scheduleHide]);
    useEffect(() => () => clearHideTimer(), [clearHideTimer]);
    useEffect(() => {
        clearHideTimer();
        setJumpReveal(false);
        setReplyPosition({ mode: 'none' });
    }, [state.activeChatId, clearHideTimer]);

    const prevGeneratingRef = useRef(state.isGenerating);
    useEffect(() => {
        const wasGenerating = prevGeneratingRef.current;
        prevGeneratingRef.current = state.isGenerating;
        if (wasGenerating && !state.isGenerating && replyId) revealJump(8000);
    }, [state.isGenerating, replyId, revealJump]);

    const handleReadingActivity = useCallback((kind?: 'scroll' | 'tap') => {
        onReadingActivity(kind);
        if (kind !== 'tap') revealJump(4000);
    }, [onReadingActivity, revealJump]);

    const reportReplyPosition = useCallback((mode: ReplyJumpMode) => {
        setReplyPosition(previous => (previous.id === replyId && previous.mode === mode ? previous : { id: replyId, mode }));
    }, [replyId]);

    const showJumpPill = activeJumpMode !== 'none' && jumpReveal;
    const displayMode = activeJumpMode !== 'none' ? activeJumpMode : lastJumpMode;

    return (
        <>
            <div ref={illustrationAnchor} className={`ttm-reading-viewport${hasWallpaper && hasStory ? ' ttm-skin-story-surface' : ''}`} data-ti-protected={hasStory ? '' : undefined}>
            {workspaceReady && hasStory && <CompatibilityChat key={state.activeCharacterId} session={state.activeChatId} revision={state} visible={compatibilityView} extensionPanel={extensionPanel} closeExtensionPanel={closeExtensionPanel}
                replyId={replyId} jumpRequest={jumpRequest} jumpMode={jumpMode} onReadingActivity={handleReadingActivity} onReplyPosition={reportReplyPosition} />}
            {isFree && !activeMessages.length && <section className="ttm-start-page" aria-label={freeChatName}>
                <h2>想聊点什么？</h2>
                {needsConnection && <button type="button" className="ttm-btn-secondary" onClick={onOpenConnection}>连接模型</button>}
            </section>}
            {hasChat && canPlay && (isFree ? activeMessages.length > 0 : !compatibilityView) && <VirtualChatStream
                key={state.activeChatId}
                freeChat={isFree}
                messages={activeMessages}
                replyId={replyId}
                jumpRequest={jumpRequest}
                jumpMode={jumpMode}
                onReadingActivity={handleReadingActivity}
                onReplyPosition={reportReplyPosition}
                characterId={activeCharacter.id}
                characterName={isFree ? 'AI' : activeCharacter.name}
                characterAvatar={isFree ? '/icons/192x192.png' : activeCharacter.avatar}
                userAvatar={isFree ? undefined : getActivePersona(state)?.image}
                userName={isFree ? '你' : state.userName}
                chatId={state.activeChatId}
                presetId={activePreset.id}
                layoutMode={layoutMode}
                renderFormattedContent={isFree ? node => node.content : formatMessageForDisplay}
                onDeleteMessage={deleteChatMessage}
                onIllustrateMessage={isFree ? undefined : onIllustrateMessage}
                onSwipeMessage={swipeChatMessage}
                onTriggerSlash={runSlashCommand}
                onRequestGenerate={requestGenerate}
                onGetChatMessages={() => getActiveChatMessages(workspaceStore.getState())}
                onSetChatMessage={(floorOrId, newContent) => editChatMessage(String(floorOrId), newContent)}
                onGetWorldbook={() => activeLorebooks.flatMap((w) => w.entries)}
                onReplaceWorldbook={(entries) => Array.isArray(entries) && replaceActiveWorldbookEntries(entries)}
            />}
            <button
                type="button"
                data-ti-shell="reply-control"
                className={`ttm-reply-jump ${showJumpPill ? 'is-visible' : ''}`}
                tabIndex={showJumpPill ? 0 : -1}
                aria-hidden={!showJumpPill}
                onPointerEnter={() => { pinnedRef.current = true; clearHideTimer(); }}
                onPointerLeave={() => { pinnedRef.current = false; if (jumpReveal) scheduleHide(2200); }}
                onFocus={() => { pinnedRef.current = true; clearHideTimer(); }}
                onBlur={() => { pinnedRef.current = false; if (jumpReveal) scheduleHide(2200); }}
                onClick={() => {
                    if (activeJumpMode === 'none') return;
                    clearHideTimer();
                    pinnedRef.current = false;
                    setJumpMode(activeJumpMode);
                    setJumpRequest(value => value + 1);
                    setJumpReveal(false);
                }}
            >
                <span className="ttm-reply-jump-badge" aria-hidden="true">
                    {displayMode === 'latest-bottom' ? (
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M5 19h14M12 5v10m-5-5 5 5 5-5" />
                        </svg>
                    ) : (
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M5 5h14M12 19V9m-5 5 5-5 5 5" />
                        </svg>
                    )}
                </span>
                <span>{displayMode === 'latest-bottom' ? '回到最新' : '回到本楼开头'}</span>
            </button>
            </div>

            {(state.nativeToolPreview?.reasoning ?? state.streamingReasoning) && (
                <details className="ttm-reasoning-drawer">
                    <summary>思考过程</summary>
                    <p>{state.nativeToolPreview?.reasoning ?? state.streamingReasoning}</p>
                </details>
            )}
            <MessageEditDialog
                freeChat={isFree}
                userName={isFree ? '你' : state.userName}
                characterName={isFree ? 'AI' : activeCharacter.name}
            />
        </>
    );
}

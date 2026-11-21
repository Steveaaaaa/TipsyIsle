import { useCallback, useMemo, useState, type RefObject } from 'react';
import { CompatibilityChat } from '../compatibility/CompatibilityChat';
import { freeChatName } from '../store/chat-archives';
import { deleteChatMessage, editChatMessage, formatMessageForDisplay, getActiveChatMessages, getActivePersona, isMessageTemplatePending, replaceActiveWorldbookEntries, swipeChatMessage, workspaceStore, type WorkspaceState } from '../store/workspace-store';
import type { ThemeEngineState } from '../theme/theme-engine';
import type { ChatMessageNode, NormalizedCharacterCard, NormalizedLorebook, NormalizedPreset } from '../types';
import { Icon } from './Icon';
import { VirtualChatStream } from './VirtualChatStream';
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
    const [replyPosition, setReplyPosition] = useState<{ id?: string; away: boolean }>({ away: false });
    const [jumpRequest, setJumpRequest] = useState(0);
    const [dismissedReply, setDismissedReply] = useState('');
    const [fadingReply, setFadingReply] = useState('');
    const latestReply = useMemo(() => [...activeMessages].reverse().find(node => node.role === 'assistant'), [activeMessages]);
    const replyId = useMemo(() => !state.isGenerating && !state.helperGenerationCount && !state.mvuExtraAnalysisActive && latestReply &&
        !latestReply.extra?.tipsy_generation_incomplete && (isFree || !isMessageTemplatePending(latestReply)) ? latestReply.id : undefined,
        [isFree, latestReply, state.isGenerating, state.helperGenerationCount, state.mvuExtraAnalysisActive, state.templateRenderRevision]);
    const replyAway = replyPosition.id === replyId && replyPosition.away;
    const replyKey = replyId ? `${state.activeChatId}:${replyId}:${latestReply?.activeSwipeIndex}` : '';
    const reportReplyPosition = useCallback((away: boolean) => {
        setReplyPosition(previous => previous.id === replyId && previous.away === away ? previous : { id: replyId, away });
    }, [replyId]);
    return (
        <>
            <div ref={illustrationAnchor} className={`ttm-reading-viewport${hasWallpaper && hasStory ? ' ttm-skin-story-surface' : ''}`} data-ti-protected={hasStory ? '' : undefined}>
            {workspaceReady && hasStory && <CompatibilityChat session={state.activeChatId} revision={state} visible={compatibilityView} extensionPanel={extensionPanel} closeExtensionPanel={closeExtensionPanel}
                replyId={replyId} jumpRequest={jumpRequest} onReadingActivity={onReadingActivity} onReplyPosition={reportReplyPosition} />}
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
                onReadingActivity={onReadingActivity}
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
            {replyKey && dismissedReply !== replyKey && (replyAway || fadingReply === replyKey) && <button type="button" data-ti-shell="reply-control" className={`ttm-reply-start ttm-btn-secondary ${fadingReply === replyKey ? 'is-dismissed' : ''}`} disabled={fadingReply === replyKey}
                onClick={() => { setJumpRequest(value => value + 1); if (matchMedia('(prefers-reduced-motion: reduce)').matches) setDismissedReply(replyKey); else setFadingReply(replyKey); }}
                onAnimationEnd={event => { if (event.animationName === 'reply-dismiss') { setDismissedReply(replyKey); setFadingReply(''); } }}><Icon name="arrow" width={16} height={16} style={{ transform: 'rotate(-90deg)' }} />回到本次回复开头</button>}
            </div>

            {(state.nativeToolPreview?.reasoning ?? state.streamingReasoning) && (
                <details className="ttm-reasoning-drawer">
                    <summary>思考过程</summary>
                    <p>{state.nativeToolPreview?.reasoning ?? state.streamingReasoning}</p>
                </details>
            )}
        </>
    );
}

import { openStoryRoutes } from './StoryRoutes';
import { routesAt } from '../store/chat-tree';
import { workspaceStore, setStatusBanner } from '../store/workspace-store';
import { schemaRegistryStore } from '../registry/schema-registry';
import { helperRenderDepth, rendersMessageHtml } from '../compatibility/render-settings';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { extractHtmlSandboxBlocks } from '../pipeline/macro-regex-engine';
import { renderMessageMarkdown, renderMixedMessage } from '../pipeline/message-markdown';
import { getMessageStreamPreview, getMessageComponentTargets } from '../store/workspace-store';
import { StreamingMessage } from './StreamingMessage';
import { SandboxFrame } from '../sandbox/SandboxFrame';
import { SlotMount } from '../plugins/slot-registry';
import { PluginButtons } from '../plugins/native/PluginCommands';
import { Icon } from './Icon';
import { CharacterAvatar } from './CharacterAvatar';
import { storySpeakerName } from '../core/story-identity';
import { observeReadingActivity, type ReadingNavigationProps } from './reading-navigation';
import { captureReadingBookmark, readReadingBookmark, readingBookmarkAdjustment, readingSwipeId, trackReadingBookmark, writeReadingBookmark } from './reading-bookmark';
import type { ReactNode } from 'react';
import type { ChatMessageNode, LayoutMode } from '../types';

export interface VirtualChatStreamProps extends ReadingNavigationProps {
    introduction?: ReactNode;
    messages: ChatMessageNode[];
    characterId: string;
    characterName: string;
    characterAvatar?: string;
    userAvatar?: string;
    userName: string;
    chatId: string;
    presetId: string;
    layoutMode: LayoutMode;
    renderFormattedContent: (node: ChatMessageNode) => string;
    onDeleteMessage: (messageId: string) => void;
    onIllustrateMessage?: (messageId: string) => void;
    onSwipeMessage: (messageId: string, direction: 'prev' | 'next' | 'new_branch') => void;
    onTriggerSlash: (command: string) => Promise<string>;
    onRequestGenerate: (promptOverride?: string) => Promise<string>;
    onGetChatMessages: (range?: unknown) => unknown[];
    onSetChatMessage: (floorOrId: unknown, newContent: string) => boolean;
    onGetWorldbook: () => unknown;
    onReplaceWorldbook: (entries: unknown) => boolean;
}

const ESTIMATED_ROW_HEIGHT = 132;
const OVERSCAN_COUNT = 6;

function MessageProse({ source }: { source: string }) {
    const html = useMemo(() => renderMessageMarkdown(source), [source]);
    return <div className="ttm-msg-prose message-markdown" dangerouslySetInnerHTML={{ __html: html }} />;
}

export function VirtualChatStream({
    introduction,
    messages,
    characterId,
    characterName,
    characterAvatar,
    userAvatar,
    userName,
    chatId,
    presetId,
    layoutMode,
    renderFormattedContent,
    onDeleteMessage,
    onIllustrateMessage,
    onSwipeMessage,
    onTriggerSlash,
    onRequestGenerate,
    onGetChatMessages,
    onSetChatMessage,
    onGetWorldbook,
    onReplaceWorldbook,
    replyId, jumpRequest, onReadingActivity, onReplyPosition,
}: VirtualChatStreamProps) {
    const allMessages = workspaceStore.useStore(state => state.messages);
    const branchEpoch = workspaceStore.useStore(state => state.branchEpoch);
    const renderDepth = schemaRegistryStore.useStore(state => helperRenderDepth(state.values['helper.render_depth']));
    const containerRef = useRef<HTMLDivElement | null>(null);
    const introductionRef = useRef<HTMLDivElement | null>(null);
    const [introductionHeight, setIntroductionHeight] = useState(0);
    const hasIntroduction = Boolean(introduction);
    const heightCacheRef = useRef<Map<string, number>>(new Map());
    const [heightVersion, setHeightVersion] = useState(0);
    const [scrollTop, setScrollTop] = useState(0);
    const [viewportHeight, setViewportHeight] = useState(720);
    const [initialBookmark] = useState(() => readReadingBookmark(chatId));
    const restoreRef = useRef({ started: false, bookmark: initialBookmark });
    const followEnd = useRef(true);
    const previousMessages = useRef(messages);
    const stopRestoring = useCallback(() => { restoreRef.current.bookmark = undefined; }, []);
    const handleReadingActivity = useCallback((activity?: 'scroll' | 'tap') => {
        if (activity !== 'tap') stopRestoring();
        onReadingActivity(activity);
    }, [onReadingActivity, stopRestoring]);
    useEffect(() => {
        const element = containerRef.current;
        if (element) return observeReadingActivity(element, handleReadingActivity);
    }, [handleReadingActivity]);
    useLayoutEffect(() => {
        const container = containerRef.current!;
        return trackReadingBookmark(container, () => {
            if (!restoreRef.current.started || restoreRef.current.bookmark || !container.clientHeight) return;
            const rows = container.querySelectorAll<HTMLElement>(':scope > [data-message-id]');
            return captureReadingBookmark(container.getBoundingClientRect().top, rows.length, index => rows[index]);
        }, bookmark => writeReadingBookmark(chatId, bookmark));
    }, [chatId]);

    const [actionSheetNode, setActionSheetNode] = useState<ChatMessageNode | null>(null);
    const replaySource = actionSheetNode && [...messages].reverse().find(node => node.floor <= actionSheetNode.floor && node.role === 'assistant');
    const canRetry = !!replaySource && replaySource.floor > 0;
    const actionDialogRef = useRef<HTMLDialogElement | null>(null);
    useEffect(() => {
        if (actionSheetNode) actionDialogRef.current?.showModal();
    }, [actionSheetNode]);

    const touchStateRef = useRef<{
        id: string;
        startX: number;
        startY: number;
    } | null>(null);

    useEffect(() => {
        const el = containerRef.current;
        if (!el) return;
        const updateViewport = () => {
            setViewportHeight(el.clientHeight || 720);
            setScrollTop(el.scrollTop);
            setIntroductionHeight(introductionRef.current?.offsetHeight ?? 0);
        };
        updateViewport();
        const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(updateViewport) : null;
        ro?.observe(el);
        if (introductionRef.current) ro?.observe(introductionRef.current);
        return () => ro?.disconnect();
    }, [hasIntroduction]);

    const measureRowRef = useCallback((nodeId: string, el: HTMLElement | null) => {
        if (!el) return;
        const measured = Math.ceil(el.getBoundingClientRect().height) + 14;
        if (measured > 20 && heightCacheRef.current.get(nodeId) !== measured) {
            heightCacheRef.current.set(nodeId, measured);
            setHeightVersion((v) => v + 1);
        }
    }, []);

    const { offsets, totalHeight, startIndex, endIndex } = useMemo(() => {
        void heightVersion;
        const count = messages.length;
        const offs = new Array<number>(count);
        let running = 0;
        for (let i = 0; i < count; i++) {
            offs[i] = running;
            running += heightCacheRef.current.get(messages[i]!.id) ?? ESTIMATED_ROW_HEIGHT;
        }
        let start = 0;
        const messageScrollTop = Math.max(0, scrollTop - introductionHeight);
        while (start < count - 1 && (offs[start + 1] ?? 0) < messageScrollTop) {
            start++;
        }
        let end = start;
        const maxBottom = messageScrollTop + viewportHeight;
        while (end < count && (offs[end] ?? 0) < maxBottom) {
            end++;
        }
        return {
            offsets: offs,
            totalHeight: Math.max(running, viewportHeight * 0.5),
            startIndex: Math.max(0, start - OVERSCAN_COUNT),
            endIndex: Math.min(count, end + OVERSCAN_COUNT),
        };
    }, [messages, scrollTop, viewportHeight, heightVersion, introductionHeight]);

    const visibleSlice = useMemo(
        () => messages.slice(startIndex, endIndex),
        [messages, startIndex, endIndex],
    );

    // Interactive HTML and images can grow after the row's first render.
    useEffect(() => {
        const observer = new ResizeObserver(entries => {
            for (const entry of entries) {
                const row = entry.target as HTMLElement;
                measureRowRef(row.dataset.messageId!, row);
            }
        });
        containerRef.current?.querySelectorAll<HTMLElement>('[data-message-id]').forEach(row => observer.observe(row));
        return () => observer.disconnect();
    }, [visibleSlice, measureRowRef]);

    const navigationRef = useRef({ offsets, messages, introductionHeight });
    navigationRef.current = { offsets, messages, introductionHeight };
    useLayoutEffect(() => {
        const container = containerRef.current!;
        const restore = restoreRef.current;
        if (!messages.length || !container.clientHeight) return;
        const previous = previousMessages.current;
        previousMessages.current = messages;
        const last = messages[messages.length - 1];
        const previousLast = previous.at(-1);
        const appendedAtEnd = !!previousLast && messages.length > previous.length && messages[previous.length - 1]?.id === previousLast.id;
        if (!restore.started) {
            restore.started = true;
            if (!restore.bookmark && !hasIntroduction && messages.length > 1) {
                restore.bookmark = { messageId: last.id, swipeId: readingSwipeId(last), offset: -12 };
            }
        } else if (appendedAtEnd && followEnd.current && !restore.bookmark) {
            container.scrollTop = container.scrollHeight;
            setScrollTop(container.scrollTop);
            return;
        }
        const bookmark = restore.bookmark;
        if (!bookmark) return;
        const index = messages.findIndex(node => node.id === bookmark.messageId && readingSwipeId(node) === bookmark.swipeId);
        let release: ReturnType<typeof setTimeout> | undefined;
        if (index < 0) {
            restore.bookmark = !hasIntroduction && messages.length > 1 ? { messageId: last.id, swipeId: readingSwipeId(last), offset: -12 } : undefined;
            container.scrollTop = restore.bookmark ? introductionHeight + offsets[messages.length - 1] : 0;
        } else {
            const row = container.querySelectorAll<HTMLElement>(':scope > [data-message-id]')[index - startIndex];
            const top = container.getBoundingClientRect().top;
            if (row?.dataset.messageId === bookmark.messageId) {
                const adjustment = readingBookmarkAdjustment(bookmark, row, top);
                if (Math.abs(adjustment) > 1) container.scrollTop += adjustment;
                release = setTimeout(stopRestoring, 400);
            } else container.scrollTop = introductionHeight + offsets[index];
        }
        setScrollTop(container.scrollTop);
        return () => clearTimeout(release);
    }, [messages, offsets, startIndex, endIndex, introductionHeight, viewportHeight, hasIntroduction, stopRestoring]);
    const lastJump = useRef(jumpRequest);
    useEffect(() => {
        if (!replyId || !jumpRequest || jumpRequest === lastJump.current) return;
        lastJump.current = jumpRequest;
        const container = containerRef.current;
        if (!container) return;
        const data = navigationRef.current;
        const index = data.messages.findIndex(node => node.id === replyId);
        if (index < 0) return;
        stopRestoring();
        container.scrollTop = data.introductionHeight + data.offsets[index];
        setScrollTop(container.scrollTop);
        // The target may be outside the virtual window until the first scroll.
        let pending = 0;
        const align = (attempt: number) => {
            const target = [...container.querySelectorAll<HTMLElement>('[data-message-id]')].find(row => row.dataset.messageId === replyId);
            if (target) {
                container.scrollTop += target.getBoundingClientRect().top - container.getBoundingClientRect().top - 12;
                onReplyPosition(false);
            } else if (attempt < 3) pending = requestAnimationFrame(() => align(attempt + 1));
        };
        pending = requestAnimationFrame(() => align(0));
        return () => cancelAnimationFrame(pending);
    }, [replyId, jumpRequest, onReplyPosition, stopRestoring]);

    useEffect(() => {
        const container = containerRef.current;
        const index = messages.findIndex(node => node.id === replyId);
        if (!container || index < 0) { onReplyPosition(false); return; }
        const row = [...container.querySelectorAll<HTMLElement>('[data-message-id]')].find(item => item.dataset.messageId === replyId);
        const distance = row ? row.getBoundingClientRect().top - container.getBoundingClientRect().top : introductionHeight + offsets[index] - scrollTop;
        onReplyPosition(Math.abs(distance - 12) > 100);
    }, [replyId, messages, offsets, scrollTop, viewportHeight, introductionHeight, onReplyPosition]);

    const handleTouchStart = (node: ChatMessageNode, e: React.TouchEvent) => {
        if ((e.target as HTMLElement).closest('input, textarea, select, a, button, [contenteditable]')) return;
        const t = e.touches[0];
        if (!t) return;
        touchStateRef.current = {
            id: node.id,
            startX: t.clientX,
            startY: t.clientY,
        };
    };

    const handleTouchEnd = (node: ChatMessageNode, e: React.TouchEvent) => {
        const st = touchStateRef.current;
        if (!st || st.id !== node.id) return;
        touchStateRef.current = null;
        if (window.getSelection()?.toString()) return;
        const t = e.changedTouches[0];
        if (!t) return;
        const dx = t.clientX - st.startX;
        const dy = t.clientY - st.startY;
        if (node.floor > 0 && Math.abs(dx) > 56 && Math.abs(dy) < 40) {
            openStoryRoutes(node.id, e.currentTarget as HTMLElement);
        }
    };

    const topPadding = offsets[startIndex] ?? 0;
    const bottomPadding = Math.max(
        0,
        totalHeight - (endIndex < messages.length ? (offsets[endIndex] ?? totalHeight) : totalHeight),
    );

    return (
        <div
            ref={containerRef}
            className={`ttm-chat-stream is-layout-${layoutMode}`}
            tabIndex={0}
            aria-label="对话阅读区"
            onPointerDown={stopRestoring}
            onScroll={(e) => {
                const el = e.currentTarget;
                followEnd.current = el.scrollHeight - el.clientHeight - el.scrollTop < 64;
                setScrollTop(el.scrollTop);
            }}
        >
            {introduction && <div ref={introductionRef} className="ttm-stream-introduction">{introduction}</div>}
            { topPadding > 0 && <div style={{ height: `${topPadding}px`, flexShrink: 0 }} aria-hidden="true" /> }

            {visibleSlice.map((node) => {
                const speakerName = node.role === 'user' ? userName : node.role === 'assistant' ? storySpeakerName(node.speakerName, characterName) : node.speakerName;
                const formatted = renderFormattedContent(node);
                const streaming = getMessageStreamPreview(node);
                const blocks = streaming ? [] : extractHtmlSandboxBlocks(formatted);
                const renderHtml = rendersMessageHtml(node.floor, messages.length, renderDepth);

                return (
                    <article
                        key={node.id}
                        ref={(el) => measureRowRef(node.id, el)}
                        className={`ttm-msg-card is-${node.role}`}
                        data-floor={node.floor}
                        data-message-id={node.id}
                        data-reading-swipe={readingSwipeId(node)}
                        tabIndex={-1}
                        onContextMenu={(event) => {
                            if (matchMedia('(any-pointer: coarse)').matches || window.getSelection()?.toString()
                                || (event.target as HTMLElement).closest('input, textarea, select, a, button, [contenteditable]')) return;
                            event.preventDefault(); setActionSheetNode(node);
                        }}
                        onTouchStart={(e) => handleTouchStart(node, e)}
                        onTouchEnd={(e) => handleTouchEnd(node, e)}
                        onTouchCancel={() => { touchStateRef.current = null; }}
                    >
                        <header className="ttm-msg-header">
                            <div className="ttm-msg-identity"><CharacterAvatar className="ttm-message-avatar" name={speakerName} avatar={node.role === 'assistant' ? characterAvatar : node.role === 'user' ? userAvatar : undefined} /><strong className="ttm-speaker-name">{speakerName}</strong><small className="ttm-floor-badge">#{node.floor}</small></div>
                            <div className="ttm-msg-toolbar">
                            {node.floor > 0 && <button type="button" className="ttm-route-entry" onClick={event => openStoryRoutes(node.id, event.currentTarget)} aria-label={`查看第 ${node.floor} 楼的故事路线`}><Icon name="branch" width={15} height={15} />路线 · {routesAt(allMessages, node.id).length}</button>}
                            {node.floor === 0 && messages.length === 1 && node.swipes.length > 1 && <div className="ttm-msg-toolbar" role="group" aria-label="切换开场">
                                <button type="button" className="ttm-icon-btn" aria-label="上一个开场" disabled={node.activeSwipeIndex === 0} onClick={() => onSwipeMessage(node.id, 'prev')}><Icon name="chevron" width={16} height={16} style={{ transform: 'rotate(180deg)' }} /></button>
                                <small>开场 {node.activeSwipeIndex + 1} / {node.swipes.length}</small>
                                <button type="button" className="ttm-icon-btn" aria-label="下一个开场" disabled={node.activeSwipeIndex === node.swipes.length - 1} onClick={() => onSwipeMessage(node.id, 'next')}><Icon name="chevron" width={16} height={16} /></button>
                            </div>}
                            <button type="button" className="ttm-icon-btn" aria-label={`${speakerName} 第 ${node.floor} 层消息操作`} title="消息操作" aria-haspopup="dialog" onClick={() => setActionSheetNode(node)}><Icon name="more" /></button>
                            </div>
                        </header>
                            <div className="ttm-msg-body ttm-msg-bubble">
                                {streaming ? <StreamingMessage preview={streaming} renderComponents={renderHtml} /> : blocks.map((block, idx) => block.type === 'markdown' ? <MessageProse key={`${node.id}_prose_${idx}`} source={block.content} /> : !renderHtml ? <p key={`${node.id}_notice_${idx}`}>此楼互动内容超出渲染范围，可在角色卡运行设置中调整。</p> : (
                                    <SandboxFrame
                                        key={`${node.id}_${branchEpoch}_sbx_${idx}`}
                                        htmlContent={block.type === 'mixed' ? renderMixedMessage(block.content) : block.content}
                                        componentTargets={getMessageComponentTargets(node)}
                                        messageId={node.id}
                                        floor={node.floor}
                                        characterId={characterId}
                                        chatId={chatId}
                                        presetId={presetId}
                                        onTriggerSlash={onTriggerSlash}
                                        onRequestGenerate={onRequestGenerate}
                                        onGetChatMessages={onGetChatMessages}
                                        onSetChatMessage={onSetChatMessage}
                                        onGetWorldbook={onGetWorldbook}
                                        onReplaceWorldbook={onReplaceWorldbook}
                                        onReadingActivity={handleReadingActivity}
                                    />
                                ))}
                            </div>

                        <footer className="ttm-msg-footer">
                            <SlotMount name="message.footer" slotProps={{ message: node }} />
                        </footer>
                    </article>
                );
            })}

            { bottomPadding > 0 && <div style={{ height: `${bottomPadding}px`, flexShrink: 0 }} aria-hidden="true" /> }

            {actionSheetNode && (
                <dialog ref={actionDialogRef} className="ttm-action-dialog" aria-labelledby="message-actions-title" onCancel={() => setActionSheetNode(null)} onClick={event => { if (event.target === event.currentTarget) setActionSheetNode(null); }}>
                    <div className="ttm-bottom-sheet">
                        <div className="ttm-bottom-sheet-handle" />
                        <div className="ttm-section-head-row"><h3 id="message-actions-title">{actionSheetNode.speakerName} · #{actionSheetNode.floor}</h3><button type="button" className="ttm-icon-btn" aria-label="关闭消息操作" onClick={() => setActionSheetNode(null)}><Icon name="close" /></button></div>
                        <div className="ttm-bottom-sheet-actions">
                            {actionSheetNode.isHidden && <p>已从模型上下文隐藏</p>}
                            <SlotMount name="message.actions" slotProps={{ message: actionSheetNode }} />
                            <PluginButtons message={actionSheetNode} onOpen={() => setActionSheetNode(null)} />
                            {onIllustrateMessage && actionSheetNode.role === 'assistant' && !actionSheetNode.extra?.tipsy_generation_incomplete && <button type="button" className="ttm-btn-ghost" onClick={() => { onIllustrateMessage(actionSheetNode.id); setActionSheetNode(null); }}>本楼配图</button>}
                            {canRetry && <button
                                type="button"
                                className="ttm-btn-ghost"
                                onClick={() => {
                                    try { onSwipeMessage(actionSheetNode.id, 'new_branch'); setActionSheetNode(null); }
                                    catch (error) { setStatusBanner(error instanceof Error ? error.message : String(error)); }
                                }}
                            >
                                从这里重新选择
                            </button>}
                            <button
                                type="button"
                                className="ttm-btn-ghost is-danger"
                                onClick={() => {
                                    onDeleteMessage(actionSheetNode.id);
                                    setActionSheetNode(null);
                                }}
                            >
                                删除消息
                            </button>
                        </div>
                    </div>
                </dialog>
            )}
        </div>
    );
}

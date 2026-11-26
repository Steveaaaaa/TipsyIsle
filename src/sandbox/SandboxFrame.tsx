import { useEffect, useMemo, useRef, useState } from 'react';
import { buildSandboxSrcDoc } from './tavern-shim-source';
import { registerSandboxWindow } from './event-bus';
import { workspaceStore, captureMessageSnapshot } from '../store/workspace-store';
import { beginBranchOperation, mutatesStory } from '../store/branch-runtime';
import { readingThemeTokens } from '../theme/theme-engine';
import { rememberComponentSize, preserveReadingAnchor } from '../shell/stream-layout';
import { StreamingMessage } from '../shell/StreamingMessage';
import {
    deleteScopedVariable,
    getScopedVariables,
    insertOrAssignScopedVariables,
    replaceScopedVariables,
    resolveMergedVariables,
} from '../store/scoped-variable-store';
import type { MediaAction } from '../../packages/plugin-sdk/index.js';
import { saveExport } from '../core/platform-files';
import { nativePluginStore } from '../plugins/native/catalog';
import { latentFilm } from '../plugins/native/latent-film';
import { loadMedia, mediaIdentity } from '../plugins/native/media';
import { dispatchMediaAction, projectMedia, type MediaProjection } from '../plugins/native/reply-media';
import { clearSandboxMountedMedia, setSandboxMountedMedia } from '../plugins/native/sandbox-media-bridge';
import type { SandboxMediaPayload } from './sandbox-media-shim';
import type { ChatMessageNode, SandboxRpcRequest, SandboxRpcResponse, VariableScopeLevel } from '../types';

export interface SandboxFrameProps {
    componentTargets?: Array<{ key: string; selector: string }>;
    htmlContent: string;
    messageNode?: ChatMessageNode;
    messageId: string;
    floor: number;
    characterId: string;
    chatId: string;
    presetId: string;
    onTriggerSlash?: (command: string) => Promise<string>;
    onRequestGenerate?: (promptOverride?: string) => Promise<string>;
    onGetChatMessages?: (range?: unknown) => unknown[];
    onSetChatMessage?: (floorOrId: unknown, newContent: string) => boolean | Promise<boolean>;
    onGetWorldbook?: () => unknown;
    onReplaceWorldbook?: (entries: unknown) => boolean;
    onReadingActivity?: (kind?: 'scroll' | 'tap') => void;
}

let frameCounter = 0;

export function SandboxFrame({
    componentTargets,
    htmlContent,
    messageNode,
    messageId,
    floor,
    characterId,
    chatId,
    presetId,
    onTriggerSlash,
    onRequestGenerate,
    onGetChatMessages,
    onSetChatMessage,
    onGetWorldbook,
    onReplaceWorldbook,
    onReadingActivity,
}: SandboxFrameProps) {
    const iframeRef = useRef<HTMLIFrameElement | null>(null);
    const [frameHeight, setFrameHeight] = useState<number>(180);
    const latentItems = latentFilm.useStore((state) => state.items);
    const pluginCatalog = nativePluginStore.useStore((state) => state.catalog);
    const mediaSlotsRef = useRef<MediaProjection[]>([]);
    const mediaBlobCacheRef = useRef<Map<string, { blob: Blob; name: string }>>(new Map());
    const presentationVars = () => {
        const tokens = readingThemeTokens();
        return { '--tt-text': tokens.textPrimary, '--tt-bg': tokens.bgSurface, '--tt-accent': tokens.accentColor,
            '--tt-font': tokens.fontFamilyBody, '--tt-size': `${tokens.fontSizePx}px`, '--tt-leading': String(tokens.lineHeight) };
    };
    const colorScheme = () => document.documentElement.dataset.colorScheme === 'dark' ? 'dark' : 'light';
    const publishPresentation = () => iframeRef.current?.contentWindow?.postMessage({
        kind: 'tipsy:sandbox-theme', themeVars: presentationVars(), colorScheme: colorScheme(),
    }, '*');
    useEffect(() => {
        window.addEventListener('tipsy-theme-change', publishPresentation);
        return () => window.removeEventListener('tipsy-theme-change', publishPresentation);
    }, []);

    const frameId = useMemo(() => {
        frameCounter += 1;
        return `tipsy_sbx_${messageId}_${frameCounter}`;
    }, [messageId]);

    const scopeContext = useMemo(
        () => ({
            presetId,
            characterId,
            chatId,
            messageId,
            floor,
        }),
        [presetId, characterId, chatId, messageId, floor],
    );

    const srcDoc = useMemo(() => {
        const initialVars = {
            global: getScopedVariables('global', scopeContext),
            preset: getScopedVariables('preset', scopeContext),
            character: getScopedVariables('character', scopeContext),
            chat: getScopedVariables('chat', scopeContext),
            message: getScopedVariables('message', scopeContext),
            merged: resolveMergedVariables(scopeContext),
        };
        return buildSandboxSrcDoc({
            frameId,
            floor,
            messageId,
            chatId,
            htmlBody: htmlContent,
            initialVariables: initialVars,
            themeVars: presentationVars(),
            colorScheme: colorScheme(),
            componentTargets,
        });
    }, [frameId, floor, messageId, htmlContent, scopeContext, componentTargets]);
    const [loadedDocument, setLoadedDocument] = useState('');
    const loading = loadedDocument !== srcDoc;

    useEffect(() => {
        return () => clearSandboxMountedMedia(frameId);
    }, [frameId]);

    useEffect(() => {
        if (loadedDocument !== srcDoc) return;
        const targetWin = iframeRef.current?.contentWindow;
        if (!targetWin) return;
        let cancelled = false;
        const slots = messageNode ? projectMedia(messageNode) : [];
        mediaSlotsRef.current = slots;
        if (!slots.length) {
            targetWin.postMessage({ kind: 'tipsy:sandbox-media', slots: [] }, '*');
            setSandboxMountedMedia(messageId, frameId, []);
            return;
        }
        void (async () => {
            const payload: SandboxMediaPayload[] = [];
            for (const slot of slots) {
                const { item } = slot;
                const takes = item.takes ?? [];
                const takeIndex = takes.length ? Math.min(item.activeTake ?? 0, takes.length - 1) : 0;
                const mediaId = takes[takeIndex]?.id;
                let blob: Blob | undefined;
                if (mediaId) {
                    const cacheKey = `${slot.key}:${mediaId}`;
                    const cached = mediaBlobCacheRef.current.get(cacheKey);
                    if (cached) {
                        blob = cached.blob;
                    } else {
                        try {
                            const loaded = await loadMedia(mediaIdentity(slot.plugin), mediaId);
                            if (/^image\/(?:png|jpeg|webp)$/.test(loaded.blob.type)) {
                                blob = loaded.blob;
                                mediaBlobCacheRef.current.set(cacheKey, { blob: loaded.blob, name: loaded.handle.name });
                            }
                        } catch {
                            // Leave image blank when media blob is unavailable.
                        }
                    }
                }
                if (cancelled) return;
                payload.push({
                    key: slot.key,
                    slotId: item.slotId,
                    status: item.status,
                    label: item.label,
                    aspectRatio: item.aspectRatio,
                    palette: item.palette,
                    presentation: item.presentation,
                    anchor: item.anchor,
                    takeIndex,
                    takeCount: takes.length,
                    canStage: slot.plugin.grants.includes('ui.stage'),
                    mediaId,
                    blob,
                });
            }
            if (!cancelled) {
                targetWin.postMessage({ kind: 'tipsy:sandbox-media', slots: payload }, '*');
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [loadedDocument, srcDoc, messageNode, messageId, frameId, latentItems, pluginCatalog]);

    useEffect(() => {
        const win = iframeRef.current?.contentWindow;
        const branchEpoch = workspaceStore.getState().branchEpoch;
        const unregister = win ? registerSandboxWindow(win) : undefined;

        const handleMessage = async (event: MessageEvent) => {
            const data = event.data as SandboxRpcRequest | undefined;
            if (event.source !== iframeRef.current?.contentWindow || !data || data.jsonrpc !== '2.0' || data.frameId !== frameId) return;

            const reply = (result?: unknown, errorMessage?: string) => {
                const targetWin = iframeRef.current?.contentWindow;
                if (!targetWin) return;
                const response: SandboxRpcResponse = {
                    jsonrpc: '2.0',
                    id: data.id,
                    ...(errorMessage ? { error: { code: -32000, message: errorMessage } } : { result }),
                };
                targetWin.postMessage(response, '*');
            };

            const finish = mutatesStory(data.method) ? beginBranchOperation() : () => {};
            try {
                if (workspaceStore.getState().activeChatId !== chatId || workspaceStore.getState().branchEpoch !== branchEpoch) throw new Error('互动所属路线已切换');
                switch (data.method) {
                    case 'sandbox.componentSizes': {
                        const values = data.params?.values as Array<{ key: string; width: number; height: number }>;
                        values?.forEach(value => rememberComponentSize(value.key, value.width, value.height)); break;
                    }
                    case 'sandbox.resize': {
                        const rawH = Number(data.params?.height ?? 160);
                        const clamped = Number.isFinite(rawH) ? Math.max(48, Math.ceil(rawH)) : 180;
                        const restore = iframeRef.current ? preserveReadingAnchor(iframeRef.current) : () => {};
                        setFrameHeight(clamped); requestAnimationFrame(restore);
                        reply({ ok: true, height: clamped });
                        break;
                    }
                    case 'variables.get': {
                        const opt = (data.params?.option as { type?: VariableScopeLevel } | undefined) || {};
                        const level: VariableScopeLevel = opt.type || 'chat';
                        reply(getScopedVariables(level, scopeContext));
                        break;
                    }
                    case 'sandbox.reading': {
                        onReadingActivity?.(data.params?.activity === 'tap' ? 'tap' : 'scroll');
                        break;
                    }
                    case 'variables.replace': {
                        const vars = (data.params?.variables as Record<string, unknown>) || {};
                        const opt = (data.params?.option as { type?: VariableScopeLevel } | undefined) || {};
                        const level: VariableScopeLevel = opt.type || 'chat';
                        reply(replaceScopedVariables(level, vars, scopeContext));
                        break;
                    }
                    case 'variables.insertOrAssign': {
                        const vars = (data.params?.variables as Record<string, unknown>) || {};
                        const opt = (data.params?.option as { type?: VariableScopeLevel } | undefined) || {};
                        const level: VariableScopeLevel = opt.type || 'chat';
                        reply(insertOrAssignScopedVariables(level, vars, scopeContext));
                        break;
                    }
                    case 'variables.delete': {
                        const key = String(data.params?.key ?? '');
                        const opt = (data.params?.option as { type?: VariableScopeLevel } | undefined) || {};
                        const level: VariableScopeLevel = opt.type || 'chat';
                        reply(deleteScopedVariable(level, key, scopeContext));
                        break;
                    }
                    case 'slash.trigger': {
                        const cmd = String(data.params?.command ?? '');
                        const res = onTriggerSlash ? await onTriggerSlash(cmd) : '';
                        reply(res);
                        break;
                    }
                    case 'chat.getMessages': {
                        const list = onGetChatMessages ? onGetChatMessages(data.params?.range) : [];
                        reply(list);
                        break;
                    }
                    case 'chat.setMessage': {
                        const ok = onSetChatMessage
                            ? await onSetChatMessage(data.params?.floorOrId, String(data.params?.newContent ?? ''))
                            : false;
                        reply({ ok });
                        break;
                    }
                    case 'worldbook.get': {
                        reply(onGetWorldbook ? onGetWorldbook() : []);
                        break;
                    }
                    case 'worldbook.replace': {
                        const ok = onReplaceWorldbook ? onReplaceWorldbook(data.params?.entries) : false;
                        reply({ ok });
                        break;
                    }
                    case 'generation.generate': {
                        const promptOverride =
                            typeof data.params?.options === 'string'
                                ? data.params.options
                                : (data.params?.options as { prompt?: string } | undefined)?.prompt;
                        const out = onRequestGenerate ? await onRequestGenerate(promptOverride) : '';
                        reply(out);
                        break;
                    }
                    case 'sandbox.mediaMounted': {
                        const keys = Array.isArray(data.params?.keys) ? data.params.keys.map(String) : [];
                        setSandboxMountedMedia(messageId, frameId, keys);
                        reply({ ok: true });
                        break;
                    }
                    case 'sandbox.mediaAction': {
                        const key = String(data.params?.key ?? '');
                        const action = String(data.params?.action ?? '');
                        const slot = mediaSlotsRef.current.find((item) => item.key === key);
                        if (!slot) throw new Error('插图槽位已更新，请重试');
                        if (action === 'save') {
                            const takes = slot.item.takes ?? [];
                            const takeIndex = takes.length ? Math.min(slot.item.activeTake ?? 0, takes.length - 1) : 0;
                            const mediaId = takes[takeIndex]?.id;
                            if (!mediaId) throw new Error('当前槽位暂无可保存图片');
                            let cached = mediaBlobCacheRef.current.get(`${slot.key}:${mediaId}`);
                            if (!cached) {
                                const res = await loadMedia(mediaIdentity(slot.plugin), mediaId);
                                cached = { blob: res.blob, name: res.handle.name };
                            }
                            const base = (cached.name || slot.item.label || 'lumina-frame').replace(/[\\/:*?"<>|]/g, '-');
                            const ext = cached.blob.type.split('/')[1] || 'webp';
                            await saveExport(cached.blob, /\.\w{1,6}$/.test(base) ? base : `${base}.${ext}`);
                        } else if (action === 'reroll' || action === 'previous' || action === 'next' || action === 'bookmark' || action === 'stage') {
                            await dispatchMediaAction(slot, action as MediaAction['action']);
                        } else {
                            throw new Error(`不支持的插图操作：${action}`);
                        }
                        reply({ ok: true });
                        break;
                    }
                    default:
                        reply(undefined, `尚未实现的沙盒 API：${data.method}`);
                        break;
                }
            } catch (err) {
                reply(undefined, err instanceof Error ? err.message : String(err));
            } finally {
                finish();
                if (data.method.startsWith('variables.') && mutatesStory(data.method) && workspaceStore.getState().activeChatId === chatId && workspaceStore.getState().branchEpoch === branchEpoch) {
                    const leaf = workspaceStore.getState().activeLeafId; if (leaf) captureMessageSnapshot(leaf);
                }
            }
        };

        window.addEventListener('message', handleMessage);
        return () => {
            window.removeEventListener('message', handleMessage);
            unregister?.();
        };
    }, [
        frameId,
        scopeContext,
        onTriggerSlash,
        onRequestGenerate,
        onGetChatMessages,
        onSetChatMessage,
        onGetWorldbook,
        onReplaceWorldbook,
        onReadingActivity,
    ]);

    return (
        <div className="ttm-sandbox-container" style={{ position: 'relative' }}>
                {loading && <StreamingMessage preview={{ source: '', status: '', phase: 'layout', document: false, scope: frameId,
                    parts: [{ id: 'author-load', type: 'waiting', content: '', complete: true, key: componentTargets?.[0]?.key, label: '互动内容' }] }} />}
                <iframe
                    ref={iframeRef}
                    title={`互动内容 · 第 ${floor} 层`}
                    className="ttm-sandbox-iframe"
                    sandbox="allow-scripts"
                    srcDoc={srcDoc}
                    onLoad={() => { publishPresentation(); requestAnimationFrame(() => requestAnimationFrame(() => setLoadedDocument(srcDoc))); }}
                    style={{ height: `${frameHeight}px`, ...(loading ? { position: 'absolute', visibility: 'hidden' } as const : {}) }}
                />
        </div>
    );
}

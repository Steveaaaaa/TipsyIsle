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
import type { SandboxRpcRequest, SandboxRpcResponse, VariableScopeLevel } from '../types';

export interface SandboxFrameProps {
    componentTargets?: Array<{ key: string; selector: string }>;
    htmlContent: string;
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

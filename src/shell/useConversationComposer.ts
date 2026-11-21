import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { compatibilityComposer, connectCompatibilityComposer, connectCompatibilityComposerSubmit, editCompatibilityComposer } from '../compatibility/composer-bridge';
import { readExtensionVariables } from '../compatibility/extension-variables';
import { commandCompatibilityRuntime, compatibilityStoryReady, getCompatibilityScriptButtons, subscribeCompatibilityScriptButtons, getCompatibilityExtensionMenu, subscribeCompatibilityExtensionMenu } from '../compatibility/runtime-client';
import { resolvedQuickReplyConfig, quickReplyContextItems } from '../sandbox/quick-reply';
import { scopedVariableStore } from '../store/scoped-variable-store';
import { sendUserMessageAndGenerate, type WorkspaceState } from '../store/workspace-store';
import { runUiAction } from './workspace-ui-actions';

export function useConversationComposer(state: WorkspaceState, canPlay: boolean, needsConnection: boolean, openConnection: () => void) {
    const [inputDraft, setInputDraft] = useState('');
    const [freeDrafts, setFreeDrafts] = useState<Record<string, string>>({});
    const isFree = state.sessionKind === 'free';
    const freeDraft = freeDrafts[state.activeChatId] ?? '';
    useEffect(() => isFree ? undefined : connectCompatibilityComposer(inputDraft, setInputDraft), [isFree, inputDraft]);

    const scriptButtons = useSyncExternalStore(subscribeCompatibilityScriptButtons, getCompatibilityScriptButtons);
    const extensionMenu = useSyncExternalStore(subscribeCompatibilityExtensionMenu, getCompatibilityExtensionMenu);
    const variableState = scopedVariableStore.useStore();
    const quickReplySettings = readExtensionVariables(variableState.extension, 'quickReplyV2');
    const activeQuickReplies = useMemo(() => quickReplySettings.isEnabled
        ? resolvedQuickReplyConfig(quickReplySettings, state.activeChatId, state.activeCharacterId).setList.filter((link: any) => link.isVisible !== false)
            .flatMap((link: any) => link.set.qrList.filter((reply: any) => !reply.isHidden).map((reply: any) => ({ set: link.set.name, ...reply,
                menu: quickReplyContextItems(quickReplySettings, link.set.name, reply.id) }))) : [],
        [quickReplySettings, state.activeChatId, state.activeCharacterId]);

    const executeCommand = async (rawScript: string): Promise<string> => (await commandCompatibilityRuntime('slash', [rawScript], true)).pipe ?? '';
    const runSlashCommand = (rawScript: string): Promise<string> => runUiAction('执行指令', () => executeCommand(rawScript), '');
    const requestGenerate = (promptOverride?: string): Promise<string> =>
        compatibilityStoryReady(state.activeChatId) ? runUiAction('生成回复', () => sendUserMessageAndGenerate(promptOverride), '') : Promise.resolve('');

    const send = async (text = isFree ? freeDraft : inputDraft, fromAuthor = false) => {
        const trimmed = text.trim();
        if (isFree) {
            if (!trimmed || fromAuthor || !canPlay || state.isGenerating) return;
            if (needsConnection) { openConnection(); return; }
            const id = state.activeChatId;
            setFreeDrafts(previous => ({ ...previous, [id]: '' }));
            const sent = await runUiAction('发送消息', async () => { await sendUserMessageAndGenerate(trimmed); return true; }, false);
            if (!sent) setFreeDrafts(previous => previous[id] ? previous : { ...previous, [id]: text });
            return;
        }
        if (!trimmed || !fromAuthor && !compatibilityStoryReady(state.activeChatId) || state.isGenerating || state.helperGenerationCount > 0) return;
        compatibilityComposer('');
        const sent = await runUiAction('发送消息', async () => {
            if (trimmed.startsWith('/')) await executeCommand(trimmed);
            else await sendUserMessageAndGenerate(trimmed);
            return true;
        }, false);
        if (!sent && !compatibilityComposer()) compatibilityComposer(trimmed);
    };
    useEffect(() => isFree ? undefined : connectCompatibilityComposerSubmit(text => send(text, true)), [isFree, inputDraft, state.activeChatId, state.isGenerating, state.helperGenerationCount]);

    const editDraft = (value: string) => {
        if (isFree) setFreeDrafts(previous => ({ ...previous, [state.activeChatId]: value }));
        else editCompatibilityComposer(value);
    };
    const forgetFreeDraft = (id: string) => setFreeDrafts(previous => { const next = { ...previous }; delete next[id]; return next; });
    return { draft: isFree ? freeDraft : inputDraft, editDraft, forgetFreeDraft, send, runSlashCommand, requestGenerate, scriptButtons, extensionMenu, activeQuickReplies };
}

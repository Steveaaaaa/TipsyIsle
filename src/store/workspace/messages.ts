import { applyRegexScripts, orderedRegexScripts } from '../../pipeline/macro-regex-engine';
import { getScopedVariables, replaceScopedVariables } from '../scoped-variable-store';
import { swipeId, branchExcerpt } from '../chat-tree';
import { continueNativeRoute } from '../../plugins/native/route-graph';
import { tavernEventBus } from '../../sandbox/event-bus';
import { commandCompatibilityRuntime } from '../../compatibility/runtime-client';
import type { ChatMessageNode } from '../../types';
import { globalRegexes } from '../global-regex-store';
import { workspaceStore } from './state';
import { getActivePreset, getActiveCharacter } from './library';
import { refreshMessageTemplates, schedulePreview } from './prompt';
import { persistWorkspace } from './storage';
import { setStatusBanner } from './notice';
import { getActiveChatMessages } from './queries';
import { sealBranchPoint, captureMessageSnapshot } from './branches';

const messageNotifications = new Map<string, Promise<void>>();

export function messageNotification(id: string) { return messageNotifications.get(id); }

export function clearMessageNotification(id: string) { messageNotifications.delete(id); }

export function notifyMessage(event: string, node: ChatMessageNode): void {
    if (workspaceStore.getState().sessionKind === 'free') return;
    const session = workspaceStore.getState().activeChatId, epoch = workspaceStore.getState().branchEpoch;
    const promise = (async () => {
        await tavernEventBus.emit(event, node);
        if (workspaceStore.getState().activeChatId !== session || workspaceStore.getState().branchEpoch !== epoch) return;
        await commandCompatibilityRuntime('event', [event, node.floor]);
        if (workspaceStore.getState().activeChatId === session && !workspaceStore.getState().isGenerating) await refreshMessageTemplates();
        if (workspaceStore.getState().activeChatId === session && workspaceStore.getState().branchEpoch === epoch) {
            if (workspaceStore.getState().activeLeafId === node.id) sealBranchPoint();
            persistWorkspace();
        }
    })();
    messageNotifications.set(node.id, promise);
    if (messageNotifications.size > 64) messageNotifications.delete(messageNotifications.keys().next().value!);
    void promise.catch(error => setStatusBanner(String(error)));
}

export function appendChatMessage(role: 'user' | 'assistant' | 'system', content: string): ChatMessageNode {
    const state = workspaceStore.getState();
    const card = getActiveCharacter(state);
    const path = getActiveChatMessages(state);
    const floor = path.length;
    const prevNode = path.at(-1);
    if (prevNode) captureMessageSnapshot(prevNode.id);
    const id = `msg_${crypto.randomUUID()}`;
    if (role !== 'system' && state.sessionKind !== 'free') content = applyRegexScripts(content, orderedRegexScripts(globalRegexes(), getActivePreset(state).regexScripts, card.regexScripts), {
        stage: role === 'user' ? 'user_input' : 'ai_output', role,
        macroContext: { userName: state.userName, charName: card.name },
    });
    const newNode: ChatMessageNode = {
        id,
        messageId: id,
        parentId: prevNode ? (prevNode.id || null) : null,
        parentSwipeId: prevNode ? swipeId(prevNode) : undefined,
        floor,
        role,
        speakerName: role === 'user' ? state.sessionKind === 'free' ? '你' : state.userName : role === 'assistant' ? state.sessionKind === 'free' ? 'AI' : card.name : 'System',
        content,
        swipes: [content],
        activeSwipeIndex: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
    };
    continueNativeRoute(state.messages, path, newNode);

    if (state.sessionKind !== 'free') {
        newNode.extra = { ...(newNode.extra ?? {}), chatVariables: structuredClone(getScopedVariables('chat', { chatId: state.activeChatId })), timedStates: structuredClone(state.timedStates) };
        const inherited = { ...getScopedVariables('chat', { chatId: state.activeChatId }), ...(prevNode ? getScopedVariables('message', { messageId: prevNode.id }) : {}) };
        replaceScopedVariables(structuredClone(inherited), 'message', { messageId: id });
    }
    workspaceStore.setState((draft) => {
        draft.messages.push(newNode);
        const origin = draft.messages.find(node => node.id === prevNode?.id);
        if (origin?.branchOrigin && role === 'user') origin.branchLabel = branchExcerpt(content, 60);
        draft.activeLeafId = newNode.id;
        if (draft.sessionKind === 'free' && role === 'user' && !draft.freeChat?.title)
            draft.freeChat = { ...draft.freeChat, title: Array.from(content.replace(/\s+/g, ' ').trim()).slice(0, 32).join('') };
    });
    persistWorkspace();
    captureMessageSnapshot(newNode.id);
    notifyMessage(role === 'user' ? 'message_sent' : 'message_received', newNode);
    if (!state.isGenerating) schedulePreview();
    return newNode;
}

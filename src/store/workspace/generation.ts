import { rollbackStateChanges } from '../state-rollback';
import { diagnosticErrorKind, recordDiagnostic } from '../../core/diagnostics';
import { NO_PRESET } from '../../core/empty-workspace';
import { streamLlmCompletion, type CompletionResult } from '../../core/platform-bridge';
import { StorySummaryChannel, summaryContentHash } from '../../pipeline/story-summary';
import { presetSamplingParameters } from '../../core/generation-settings';
import { runPromptPipelineAsync } from '../../pipeline/pipeline-worker-client';
import { applyRegexScripts, evaluateMacros, orderedRegexScripts } from '../../pipeline/macro-regex-engine';
import { analyzeMvuReply } from '../../compatibility/mvu-extra-analysis';
import { appendMvuRepair, buildMvuRepairTask } from '../../pipeline/mvu-repair';
import _ from 'lodash';
import { findUpdateMarkupBlocks } from '../../pipeline/mvu-markup';
import { getSchemaValues } from '../../registry/schema-registry';
import { DEFAULT_CONTEXT_TOKENS, DEFAULT_RESPONSE_TOKENS } from '../../core/generation-defaults';
import { prepareTokenCounter, type TokenizerSelection } from '../../pipeline/token-counter';
import { scopedVariableStore, getScopedVariables } from '../scoped-variable-store';
import { activePath, swipeId } from '../chat-tree';
import type { BranchState } from '../branch-state';
import { executePluginHooks } from '../../plugins/plugin-host';
import { messageRef, settled } from '../../plugins/native/story-port';
import { nativeGenerationContributions, notifyNativeReplySaved } from '../../plugins/native/host';
import { prepareNativePrompt, readNativeAfterScan } from '../../plugins/native/generation-stages';
import { streamStoryWithNativeTools } from '../../plugins/native/generation-tools';
import { continueNativeRoute } from '../../plugins/native/route-graph';
import { applyNativeContributions } from '../../plugins/native/prompt';
import { tavernEventBus } from '../../sandbox/event-bus';
import { commandCompatibilityRuntime, publishNativeGenerationProgress, requireCompatibilityRouteReady, saveCompatibilityBeforeRouteChange } from '../../compatibility/runtime-client';
import type { VariableWrite } from '../../compatibility/contracts';
import { readMvuCommands, settleMvuWithoutScripts } from '../../pipeline/mvu-commands';
import type { AssembledPromptResult, ChatMessageNode } from '../../types';
import type { AssemblePromptInput } from '../../pipeline/prompt-assembler';
import { enqueuePersistentOperation, waitForReplicaCommit } from '../persistence';
import { globalRegexes } from '../global-regex-store';
import { workspaceStore } from './state';
import { getActivePreset, getActiveCharacter } from './library';
import { refreshMessageTemplates, schedulePreview, currentTemplateJobs, createPromptAssemblyInput, TemplateInputChangedError, ensureTemplatePreload } from './prompt';
import { persistWorkspace, persistWorkspaceNow, commitWorkspaceMutation } from './storage';
import { setStatusBanner } from './notice';
import { getActiveChatMessages, getEffectiveMvuSettings } from './queries';
import { getFreeChatConnection } from './sessions';
import { branchBusy } from './activity';
import { sealBranchPoint, readBranchState, restoreMessageSnapshot, captureMessageSnapshot, applyBranchState } from './branches';
import { saveHelperVariables, commitMvuMessage, validateHelperVariableWrite } from './story-variables';
import { getWorkspaceScripts } from './scripts';
import { appendChatMessage, messageNotification, clearMessageNotification } from './messages';
import { readNativeStory } from './runtime';
import { compatibilityRouteAddress, holdCompatibilityRoute } from '../../compatibility/route-address';
import { commitPromptTask } from './prompt-commit';

let activeAbortController: AbortController | null = null;

let generationNotificationMessage: string | undefined;
let extensionGenerationPreparation: AbortController | undefined;

export function getGenerationNotificationMessage() { return generationNotificationMessage; }
export function canAppendDuringGenerationPreparation() { return !!extensionGenerationPreparation && !extensionGenerationPreparation.signal.aborted; }

export function stopActiveGeneration(): void {
    if (activeAbortController) {
        activeAbortController.abort();
        activeAbortController = null;
    }
}

export async function regenerateLastAssistantMessage(): Promise<string> {
    return sendUserMessageAndGenerate(undefined, 'regenerate');
}

/** Explicit reprocessing starts from the preceding state, so additive commands run once. */
export async function reprocessLastMvuMessage(extraModel = false): Promise<string> {
    const state = workspaceStore.getState();
    if (state.isGenerating || state.helperGenerationCount) throw new Error('请等待当前生成结束后重算变量');
    const path = getActiveChatMessages(state), target = path.at(-1);
    if (!target || target.role !== 'assistant' || !target.parentId) throw new Error('请先选择需要重算的助手回复');
    if (extraModel && getEffectiveMvuSettings(state).settings['mvu.mode'] !== '额外模型解析') throw new Error('请先在 MVU 参数或角色配置中启用额外模型解析');
    const source = path.slice(0, -1).reverse().map(message => getScopedVariables('message', { messageId: message.id })).find(value => value.stat_data);
    if (!source) throw new Error('前序消息尚无可用于重算的 MVU 变量');
    const original = getScopedVariables('message', { messageId: target.id });
    const basis = { ...structuredClone(original) };
    for (const key of ['stat_data', 'display_data', 'delta_data', 'schema']) {
        if (Object.hasOwn(source, key)) basis[key] = structuredClone(source[key]); else delete basis[key];
    }
    const controller = new AbortController(); activeAbortController = controller;
    workspaceStore.setState({ isGenerating: true });
    let saved = false;
    try {
        let content = target.content;
        if (extraModel) {
            const last = findUpdateMarkupBlocks(content, 'update').at(-1);
            if (last) content = content.slice(0, last.start) + content.slice(last.end);
            saveHelperVariables(basis, { type: 'message', message_id: target.floor });
            workspaceStore.setState(draft => {
                const node = draft.messages.find(message => message.id === target.id)!;
                node.content = content;
                const swipe = node.swipes[node.activeSwipeIndex];
                node.swipes[node.activeSwipeIndex] = typeof swipe === 'string' ? content : { ...swipe, content };
            });
            content = await analyzeMvuReply(content, basis, controller.signal, true);
        }
        const before = extraModel ? getScopedVariables('message', { messageId: target.id }) : basis;
        const result = await commandCompatibilityRuntime('settle', [content, before], getWorkspaceScripts().some(script => script.enabled));
        const variables = result.variables ?? await settleMvuWithoutScripts(before, evaluateMacros(content, {
            userName: state.userName, charName: getActiveCharacter(state).name, variables: structuredClone(before) }),
            (command, error) => setStatusBanner(`MVU 命令 ${command.full_match}：${error instanceof Error ? error.message : String(error)}`));
        controller.signal.throwIfAborted();
        const current = getActiveChatMessages().at(-1)!;
        await commitMvuMessage({ session: state.activeChatId, id: target.id, swipe: target.activeSwipeIndex, content: current.content },
            { variables, writes: result.writes });
        workspaceStore.setState(draft => {
            const node = draft.messages.find(message => message.id === target.id)!;
            node.content = result.messageContent ?? content;
            const swipe = node.swipes[node.activeSwipeIndex];
            node.swipes[node.activeSwipeIndex] = typeof swipe === 'string' ? node.content : { ...swipe, content: node.content };
            node.updatedAt = Date.now(); node.extra = { ...node.extra }; delete node.extra.tipsy_generation_incomplete;
        });
        saved = true; captureMessageSnapshot(target.id);
        await persistWorkspaceNow();
        await refreshMessageTemplates(true);
        return extraModel ? '已重新请求额外模型并结算当前回复变量。' : '已从前序变量重新结算当前回复。';
    } finally {
        if (!saved && extraModel) {
            saveHelperVariables(original, { type: 'message', message_id: target.floor });
            workspaceStore.setState(draft => {
                const node = draft.messages.find(message => message.id === target.id)!;
                node.content = target.content; node.swipes[node.activeSwipeIndex] = structuredClone(target.swipes[target.activeSwipeIndex]);
            });
        }
        workspaceStore.setState({ isGenerating: false, mvuExtraAnalysisActive: false });
        activeAbortController = null; persistWorkspace(); schedulePreview();
    }
}

export interface MvuRepairPreview {
    expected: { session: string; id: string; swipe: number; content: string; variables: Record<string, unknown> };
    result: { variables: Record<string, unknown>; writes?: VariableWrite[]; messageContent: string };
    before: unknown; after: unknown;
}

let lastMvuRepairUndo: { session: string; id: string; swipe: number; before: ChatMessageNode; after: ChatMessageNode;
    beforeVariables: ReturnType<typeof scopedVariableStore.getState>; afterVariables: ReturnType<typeof scopedVariableStore.getState> } | undefined;

/** Preview performs the model request and author validation once; applying never reruns them. */
export async function prepareMvuRepair(direction = ''): Promise<MvuRepairPreview | undefined> {
    const state = workspaceStore.getState(), path = getActiveChatMessages(state), target = path.at(-1);
    if (state.isGenerating || state.helperGenerationCount) throw new Error('请等待当前生成结束后校正变量');
    if (!target || target.role !== 'assistant' || !target.parentId) throw new Error('请先选择需要校正的助手回复');
    const before = structuredClone(getScopedVariables('message', { messageId: target.id }));
    if (!before.stat_data) throw new Error('当前回复尚无已结算的 MVU 变量');
    const previous = path.slice(0, -1).reverse().map(message => getScopedVariables('message', { messageId: message.id })).find(value => value.stat_data);
    const expected = { session: state.activeChatId, id: target.id, swipe: target.activeSwipeIndex, content: target.content, variables: before };
    const controller = new AbortController(); activeAbortController = controller;
    workspaceStore.setState({ isGenerating: true });
    try {
        const block = await analyzeMvuReply(target.content, before, controller.signal, true, { task: buildMvuRepairTask(previous?.stat_data, before.stat_data), direction });
        controller.signal.throwIfAborted();
        if (!readMvuCommands(block).commands.length) { setStatusBanner('当前变量无需增量校正。'); return; }
        const content = appendMvuRepair(target.content, block);
        const result = await commandCompatibilityRuntime('settle', [block, before, { strict: true, messageContent: content }], getWorkspaceScripts().some(script => script.enabled));
        const variables = result.variables ?? await settleMvuWithoutScripts(before, evaluateMacros(block, {
            userName: state.userName, charName: getActiveCharacter(state).name, variables: structuredClone(before) }), (_command, error) => { throw error; });
        controller.signal.throwIfAborted();
        if (_.isEqual(variables.stat_data, before.stat_data)) { setStatusBanner('校正未产生变量变化，已保留原回复。'); return; }
        return { expected, result: { variables, writes: result.writes, messageContent: result.messageContent ?? content },
            before: before.stat_data, after: variables.stat_data };
    } finally {
        workspaceStore.setState({ isGenerating: false, mvuExtraAnalysisActive: false });
        activeAbortController = null; schedulePreview();
    }
}

export async function applyMvuRepair(preview: MvuRepairPreview): Promise<string> {
    if (workspaceStore.getState().isGenerating || workspaceStore.getState().helperGenerationCount) throw new Error('请等待当前生成结束后应用校正');
    const before = getActiveChatMessages().find(message => message.id === preview.expected.id);
    if (!before) throw new Error('校正所属消息已不存在');
    const beforeVariables = scopedVariableStore.getState();
    await commitMvuMessage(preview.expected, preview.result);
    captureMessageSnapshot(before.id);
    lastMvuRepairUndo = { session: preview.expected.session, id: before.id, swipe: preview.expected.swipe,
        before, after: getActiveChatMessages().find(message => message.id === before.id)!, beforeVariables, afterVariables: scopedVariableStore.getState() };
    await persistWorkspaceNow(); await refreshMessageTemplates(true);
    return '已应用增量校正，可撤销最近一次校正。';
}

export function canUndoMvuRepair(): boolean {
    const undo = lastMvuRepairUndo, state = workspaceStore.getState(), target = getActiveChatMessages(state).at(-1);
    return !!undo && undo.session === state.activeChatId && target?.id === undo.id && target.activeSwipeIndex === undo.swipe;
}

export async function undoMvuRepair(): Promise<string> {
    const undo = lastMvuRepairUndo;
    if (!undo || !canUndoMvuRepair()) throw new Error('当前消息没有可撤销的增量校正');
    if (workspaceStore.getState().isGenerating || workspaceStore.getState().helperGenerationCount) throw new Error('请等待生成结束后撤销校正');
    await enqueuePersistentOperation(() => commitWorkspaceMutation(() => {
        const target = getActiveChatMessages().at(-1)!;
        if (target.content !== undo.after.content || !_.isEqual(getScopedVariables('message', { messageId: undo.id }), undo.afterVariables.message[undo.id])) throw new Error('校正后正文或变量已修改，不能直接撤销');
        scopedVariableStore.setState(rollbackStateChanges(scopedVariableStore.getState(), undo.beforeVariables, undo.afterVariables));
        workspaceStore.setState(draft => { const index = draft.messages.findIndex(message => message.id === undo.id); draft.messages[index] = undo.before; });
    }));
    lastMvuRepairUndo = undefined; await refreshMessageTemplates(true); schedulePreview();
    return '已撤销最近一次增量校正。';
}

/** Script callers retain a single apply operation; the workspace offers a preview. */
export async function repairLastMvuMessage(direction = ''): Promise<string> {
    const preview = await prepareMvuRepair(direction);
    return preview ? applyMvuRepair(preview) : '当前变量无需增量校正。';
}

async function generateFreeReply(userText: string | undefined, regenerate: boolean): Promise<string> {
    const state = workspaceStore.getState();
    const settings = getSchemaValues();
    const connection = getFreeChatConnection(state, settings);
    if (!connection.baseUrl || !connection.model) throw new Error('请先在连接设置中填写接口地址和模型名称。');
    const text = userText?.trim();
    if (branchBusy()) throw new Error('请等待当前操作完成。');
    const previous = getActiveChatMessages(state).at(-1);
    const replaceReply = regenerate && previous?.role === 'assistant' && !!previous.parentId;
    if (!text && !replaceReply && !(regenerate && previous?.role === 'user')) return '';

    const controller = new AbortController();
    activeAbortController = controller;
    workspaceStore.setState({ isGenerating: true, streamingReasoning: '' });
    if (text) appendChatMessage('user', text);
    const leaf = replaceReply ? previous.parentId : workspaceStore.getState().activeLeafId;
    const path = activePath(workspaceStore.getState().messages, leaf);
    const parent = path.at(-1);
    const id = `msg_${crypto.randomUUID()}`;
    let content = '', reasoning = '';
    let placeholder = false;
    try {
        const count = await prepareTokenCounter(connection.model, (settings['sampler.tokenizer'] ?? 'auto') as TokenizerSelection);
        controller.signal.throwIfAborted();
        const parameters = presetSamplingParameters(NO_PRESET, settings);
        let remaining = Number(settings['sampler.context_max_tokens'] ?? DEFAULT_CONTEXT_TOKENS) - Number(parameters.max_tokens ?? DEFAULT_RESPONSE_TOKENS) - 3;
        const messages: import('../../types').AssembledPromptMessage[] = [];
        for (let index = path.length - 1; index >= 0; index--) {
            const { id: sourceId, role, content } = path[index];
            if ((role !== 'assistant' && role !== 'user') || !content) continue;
            const tokens = count(content) + 4;
            if (tokens > remaining) {
                if (!messages.length) throw new Error('这条消息超过了可用的上下文容量，请缩短消息或调整模型设置。');
                break;
            }
            messages.unshift({ sourceId, sourceLabel: '对话历史', role, content, tokens });
            remaining -= tokens;
        }
        while (messages[0]?.role === 'assistant') messages.shift();
        if (!messages.length) throw new Error('当前分支没有可发送的用户消息。');

        const node: ChatMessageNode = { id, messageId: id, parentId: leaf, parentSwipeId: parent ? swipeId(parent) : undefined,
            floor: path.length, role: 'assistant', speakerName: 'AI', content: '', swipes: [''], activeSwipeIndex: 0,
            branchOrigin: replaceReply ? previous.branchOrigin ?? previous.id : undefined,
            createdAt: Date.now(), updatedAt: Date.now(), extra: { tipsy_generation_incomplete: true } };
        workspaceStore.setState(draft => { draft.messages.push(node); draft.activeLeafId = id; });
        placeholder = true;
        const result = await streamLlmCompletion({ ...connection, messages, parameters, stream: settings['api.stream'] !== false,
            signal: controller.signal, requireReplyText: true, onToken: (text, thought = '') => {
                if (controller.signal.aborted) return;
                content += text; reasoning += thought;
                workspaceStore.setState(draft => {
                    const reply = draft.messages.at(-1)!;
                    reply.content = content; reply.swipes[0] = content;
                    draft.streamingReasoning = reasoning;
                });
            } });
        controller.signal.throwIfAborted();
        content = result.content; reasoning = result.reasoning;
        const candidates = (result.candidates ?? [result]).map(({ content, reasoning }) => ({ content, reasoning }));
        workspaceStore.setState(draft => {
            const reply = draft.messages.at(-1)!;
            Object.assign(reply, { content, reasoning, swipes: candidates, extra: undefined, updatedAt: Date.now() });
        });
        return content;
    } catch (error) {
        const stopped = controller.signal.aborted;
        if (!content.trim()) content = '';
        if (!stopped && !placeholder) recordDiagnostic('生成', '夜灯畅谈', '失败', { stage: '准备对话', code: diagnosticErrorKind(error) });
        if (placeholder) workspaceStore.setState(draft => {
            if (content) {
                const reply = draft.messages.at(-1)!;
                Object.assign(reply, { content, reasoning, swipes: [{ content, reasoning }], extra: undefined, updatedAt: Date.now() });
            } else {
                draft.messages.pop();
                draft.activeLeafId = replaceReply ? previous.id : leaf;
            }
        });
        setStatusBanner(stopped ? (content ? '已停止生成，已保留收到的回复。' : '已停止生成。')
            : `生成失败：${error instanceof Error ? error.message : String(error)}`, { kind: stopped ? 'info' : 'error' });
        return content;
    } finally {
        activeAbortController = null;
        workspaceStore.setState({ isGenerating: false, streamingReasoning: '' });
        persistWorkspace();
    }
}

export async function sendUserMessageAndGenerate(userText?: string, generationType: 'normal' | 'regenerate' = 'normal'): Promise<string> {
    await waitForReplicaCommit();
    if (workspaceStore.getState().sessionKind === 'free') return generateFreeReply(userText, generationType === 'regenerate');
    if (!getActiveCharacter().id) throw new Error('请先从馆藏选择一个故事。');
    if (workspaceStore.getState().isGenerating) return '';
    requireCompatibilityRouteReady();
    if (generationType === 'regenerate') await saveCompatibilityBeforeRouteChange();
    if (workspaceStore.getState().isGenerating) return '';
    const controller = new AbortController();
    activeAbortController = controller;
    workspaceStore.setState(draft => { draft.isGenerating = true; });
    let assembled: AssembledPromptResult;
    let assemblyInput: AssemblePromptInput;
    let nativeContributions: Awaited<ReturnType<typeof nativeGenerationContributions>> = [];
    let originalLeaf: string | undefined;
    let originalMetadata: ReturnType<typeof workspaceStore.getState>['chatMetadata'];
    let originalRoute: string | undefined;
    let releaseRoute: (() => void) | undefined;
    let regeneratedNodes: ChatMessageNode[] | undefined;
    let regeneratedDeletedIds: string[] | undefined;
    let regeneratedPlaceholderId: string | undefined;
    try {
        const { rendering } = currentTemplateJobs();
        if (rendering) {
            try { await rendering; }
            catch (error) { if (!(error instanceof TemplateInputChangedError)) throw error; }
        }
        await ensureTemplatePreload();
        controller.signal.throwIfAborted();
        if (generationType === 'regenerate') {
            const latest = getActiveChatMessages().at(-1);
            if (!latest || latest.role !== 'assistant' || !latest.parentId) throw new Error('当前没有可以重新生成的角色回复');
            originalLeaf = latest.id;
            const address = compatibilityRouteAddress();
            originalRoute = readNativeStory().route?.routeId;
            releaseRoute = holdCompatibilityRoute(address);
            captureMessageSnapshot(latest.id);
            const current = workspaceStore.getState();
            originalMetadata = current.chatMetadata;
            const removed = new Set<string>([latest.id]);
            for (let changed = true; changed;) {
                changed = false;
                for (const node of current.messages) if (node.parentId && removed.has(node.parentId) && !removed.has(node.id)) { removed.add(node.id); changed = true; }
            }
            regeneratedNodes = structuredClone(current.messages.filter(node => removed.has(node.id)));
            regeneratedDeletedIds = [...current.deletedMessageIds ?? []];
            workspaceStore.setState(draft => {
                draft.messages = draft.messages.filter(node => !removed.has(node.id));
                draft.deletedMessageIds = [...new Set([...(draft.deletedMessageIds ?? []), ...removed])];
                draft.activeLeafId = latest.parentId;
            });
            restoreMessageSnapshot(latest.parentId);
            workspaceStore.setState({ chatMetadata: originalMetadata });
        }
        const sent = userText?.trim() ? appendChatMessage('user', userText.trim()) : undefined;
        const pendingMessage = sent ?? getActiveChatMessages().at(-1);
        if (pendingMessage) {
            generationNotificationMessage = pendingMessage.id;
            await messageNotification(pendingMessage.id);
            clearMessageNotification(pendingMessage.id);
        }
        if (sent) {
            await refreshMessageTemplates(true);
            await commandCompatibilityRuntime('event', ['user_message_rendered', sent.floor]);
        }
        generationNotificationMessage = undefined;
        controller.signal.throwIfAborted();
        const required = getWorkspaceScripts().some(s => s.enabled);
        await tavernEventBus.emit('generation_started', { type: generationType, characterId: workspaceStore.getState().activeCharacterId });
        extensionGenerationPreparation = controller;
        const prepared = await commandCompatibilityRuntime('beforeGeneration', [generationType], required)
            .finally(() => { if (extensionGenerationPreparation === controller) extensionGenerationPreparation = undefined; });
        if (prepared.generationAborted) {
            if (originalLeaf) {
                const noticeAdded = workspaceStore.getState().activeLeafId !== regeneratedNodes?.find(node => node.id === originalLeaf)?.parentId;
                workspaceStore.setState(draft => {
                    if (regeneratedNodes?.length) draft.messages.push(...regeneratedNodes);
                    draft.deletedMessageIds = regeneratedDeletedIds;
                    if (!noticeAdded) draft.activeLeafId = originalLeaf!;
                });
                if (!noticeAdded) restoreMessageSnapshot(originalLeaf);
            }
            await commandCompatibilityRuntime('event', ['generation_stopped']).catch(error => console.warn('生成停止事件执行失败', error));
            await tavernEventBus.emit('generation_stopped', { intercepted: true });
            releaseRoute?.();
            if (originalLeaf) await commandCompatibilityRuntime('refreshRouteMemory').catch(error => console.warn('恢复路线记忆失败', error));
            workspaceStore.setState({ isGenerating: false });
            activeAbortController = null;
            persistWorkspace();
            return '';
        }
        ({ assembled, assemblyInput, nativeContributions } = await prepareStoryPrompt(prepared, generationType, controller));
    } catch (error) {
        if (!controller.signal.aborted) recordDiagnostic('生成', '故事续写', '失败', { stage: '准备提示词与故事状态', code: diagnosticErrorKind(error) });
        generationNotificationMessage = undefined;
        if (originalLeaf) {
            workspaceStore.setState(draft => {
                if (regeneratedNodes?.length) draft.messages.push(...structuredClone(regeneratedNodes));
                draft.deletedMessageIds = regeneratedDeletedIds;
                draft.activeLeafId = originalLeaf!;
            });
            restoreMessageSnapshot(originalLeaf);
        }
        const message = error instanceof Error ? error.message : String(error);
        setStatusBanner(controller.signal.aborted ? '已停止生成。' : `生成准备失败：${message}`, { kind: controller.signal.aborted ? 'info' : 'error' });
        try { await commandCompatibilityRuntime('event', ['generation_stopped']); }
        catch (eventError) { console.warn('生成停止事件执行失败', eventError); }
        try { await commandCompatibilityRuntime('event', ['generation_ended', getActiveChatMessages().length - 1]); }
        catch (eventError) { console.warn('生成结束事件执行失败', eventError); }
        await tavernEventBus.emit('generation_stopped', { error: message });
        await tavernEventBus.emit('generation_ended', { stopped: true });
        releaseRoute?.();
        if (originalLeaf) await commandCompatibilityRuntime('refreshRouteMemory').catch(error => console.warn('恢复路线记忆失败', error));
        workspaceStore.setState(draft => { draft.isGenerating = false; });
        activeAbortController = null;
        persistWorkspace();
        throw error;
    }
    const state = workspaceStore.getState();
    const card = getActiveCharacter(state);
    const schemaVals = getSchemaValues();

    const apiSource = String(schemaVals['api.chat_completion_source'] ?? 'openai');
    const baseUrl = String(schemaVals['api.custom_url'] ?? '').trim();
    const apiKey = String(schemaVals['api.key'] ?? '').trim();
    const model = String(schemaVals['api.model'] ?? 'gpt-4o-mini').trim();

    const path = getActiveChatMessages(state);
    const floor = path.length;
    const placeholderId = `msg_${crypto.randomUUID()}`;
    regeneratedPlaceholderId = placeholderId;
    const prevNode = path.at(-1);

    const assistantNode: ChatMessageNode = {
        id: placeholderId,
        branchOrigin: originalLeaf ? state.messages.find(node => node.id === originalLeaf)?.branchOrigin ?? originalLeaf : undefined,
        messageId: placeholderId,
        parentId: prevNode ? (prevNode.id || null) : null,
        parentSwipeId: prevNode ? swipeId(prevNode) : undefined,
        floor,
        role: 'assistant',
        speakerName: card.name,
        content: '',
        swipes: [''],
        activeSwipeIndex: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        tokenCount: 0,
        extra: { tipsy_generation_incomplete: true },
    };
    continueNativeRoute(state.messages, path, assistantNode, originalRoute);
    let completed = false;
    let firstCandidateSettled = false;
    let replyBase: BranchState | undefined;
    let failed = false;
    let resultContent = '';
    let stage = '准备回复节点';
    const summaryChannel = new StorySummaryChannel();
    try {
        if (prevNode) captureMessageSnapshot(prevNode.id);
        const assistantVariables = { ...getScopedVariables('chat', { chatId: state.activeChatId }), ...(prevNode ? getScopedVariables('message', { messageId: prevNode.id }) : {}) };
        workspaceStore.setState(draft => {
            draft.streamingReasoning = '';
            draft.nativeToolPreview = undefined;
            draft.messages.push(assistantNode);
            draft.activeLeafId = assistantNode.id;
            draft.timedStates = structuredClone(assembled.nextTimedStates);
        });
        saveHelperVariables(assistantVariables, { type: 'message', message_id: floor });
        captureMessageSnapshot(placeholderId);
        replyBase = readBranchState(workspaceStore.getState(), workspaceStore.getState().messages.find(node => node.id === placeholderId)!);

        stage = '生成回复';
        const streamed = await streamStoryReply(controller, state, assembled, assemblyInput, nativeContributions, placeholderId, floor, summaryChannel,
            { apiSource, baseUrl, apiKey, model, schemaVals });
        controller.signal.throwIfAborted();

        stage = '应用回复与分支状态';
        const firstContent = await settleStoryCandidates(streamed, summaryChannel, controller, state, card, assembled, placeholderId, floor, () => { firstCandidateSettled = true; });
        workspaceStore.setState(draft => {
            const target = draft.messages.find(message => message.id === placeholderId)!;
            target.extra = { ...target.extra }; delete target.extra.tipsy_generation_incomplete;
        });
        completed = true;
        resultContent = firstContent;
        generationNotificationMessage = placeholderId;
        stage = '触发回复事件与渲染';
        await commandCompatibilityRuntime('settledMessageReceived', [floor]);
        await tavernEventBus.emit('message_received', workspaceStore.getState().messages.find(message => message.id === placeholderId));
        await refreshMessageTemplates(true);
        await commandCompatibilityRuntime('event', ['character_message_rendered', floor]);
        resultContent = workspaceStore.getState().messages.find(message => message.id === placeholderId)?.content ?? firstContent;
    } catch (err) {
        if (!controller.signal.aborted) recordDiagnostic('生成', '故事续写', '失败', { stage, code: diagnosticErrorKind(err) });
        failed = true;
        const msg = err instanceof Error ? err.message : String(err);
        workspaceStore.setState((draft) => {
            draft.nativeToolPreview = undefined;
            const target = draft.messages.find((m) => m.id === placeholderId);
            if (target && !target.reasoning) target.reasoning = draft.streamingReasoning;
            if (target && !completed) {
                target.extra = { ...target.extra, tipsy_generation_terminal: { swipe: target.activeSwipeIndex,
                    phase: controller.signal.aborted ? 'stopped' : 'error', detail: controller.signal.aborted ? '' : msg } };
                target.updatedAt = Date.now();
            }
        });
        setStatusBanner(controller.signal.aborted ? '已停止生成，已保留收到的回复。' : completed ? `回复已保存，作者事件执行失败：${msg}` : `生成或变量结算失败：${msg}`, { kind: controller.signal.aborted ? 'info' : 'error' });
    } finally {
        if (regeneratedNodes?.length && !completed && regeneratedPlaceholderId) {
            const removedGenerated = new Set<string>();
            const currentMessages = workspaceStore.getState().messages;
            for (const node of currentMessages) if (node.id === regeneratedPlaceholderId) removedGenerated.add(node.id);
            for (let changed = true; changed;) {
                changed = false;
                for (const node of currentMessages) if (node.parentId && removedGenerated.has(node.parentId) && !removedGenerated.has(node.id)) { removedGenerated.add(node.id); changed = true; }
            }
            workspaceStore.setState(draft => {
                draft.messages = draft.messages.filter(node => !removedGenerated.has(node.id));
                draft.messages.push(...structuredClone(regeneratedNodes));
                draft.deletedMessageIds = regeneratedDeletedIds;
                draft.activeLeafId = originalLeaf!;
            });
            restoreMessageSnapshot(originalLeaf!);
        }
        releaseRoute?.();
        if (originalLeaf && !completed) await commandCompatibilityRuntime('refreshRouteMemory').catch(error => console.warn('恢复路线记忆失败', error));
        generationNotificationMessage = placeholderId;
        if (failed || controller.signal.aborted) {
            try { await commandCompatibilityRuntime('event', ['generation_stopped', floor]); }
            catch (eventError) { console.warn('生成停止事件执行失败', eventError); }
            await tavernEventBus.emit('generation_stopped', { messageId: placeholderId });
        }
        try { await commandCompatibilityRuntime('event', ['generation_ended', floor]); }
        catch (eventError) { setStatusBanner(`生成结束事件执行失败：${String(eventError)}`); }
        if (completed) resultContent = workspaceStore.getState().messages.find(message => message.id === placeholderId)?.content ?? resultContent;
        await tavernEventBus.emit('generation_ended', { messageId: placeholderId, content: resultContent, stopped: failed || controller.signal.aborted });
        if (!completed && !firstCandidateSettled && !(regeneratedNodes?.length && regeneratedPlaceholderId)) {
            if (replyBase) applyBranchState(replyBase);
            workspaceStore.setState(draft => { draft.timedStates = structuredClone(state.timedStates); });
        }
        captureMessageSnapshot(placeholderId);
        if (completed) sealBranchPoint(true);
        generationNotificationMessage = undefined;
        const readyStory = readNativeStory(), readyReply = readyStory.path.at(-1);
        const reply = completed && readyReply?.id === placeholderId && settled(readyReply) ? messageRef(readyReply) : undefined;
        workspaceStore.setState(draft => {
            draft.isGenerating = false; draft.mvuExtraAnalysisActive = false;
            if (reply && readyStory.ref) draft.nativeStoryReply = { id: crypto.randomUUID(), at: Date.now(), origin: 'local',
                kind: 'story.replySaved', chatId: readyStory.ref.chatId, route: readyStory.route ?? undefined, reply, generation: generationType };
        });
        activeAbortController = null;
        if (completed) {
            const view = readNativeStory();
            if (reply) {
                void persistWorkspaceNow().then(() => notifyNativeReplySaved(view, reply, generationType))
                    .catch(error => setStatusBanner(`保存失败：${error instanceof Error ? error.message : String(error)}`));
            } else persistWorkspace();
        } else persistWorkspace();
    }
    schedulePreview();
    return resultContent;
}

async function prepareStoryPrompt(prepared: { injections?: AssemblePromptInput['injections']; interceptedHistory?: AssemblePromptInput['interceptedHistory'] },
    generationType: 'normal' | 'regenerate', controller: AbortController) {
    let assembled: AssembledPromptResult;
    let nativeContributions: Awaited<ReturnType<typeof nativeGenerationContributions>>;
    const assemblyInput = createPromptAssemblyInput(prepared.injections);
    assemblyInput.interceptedHistory = prepared.interceptedHistory;
    assemblyInput.generationType = generationType;
    const legacyContributions = nativeGenerationContributions(generationType, controller.signal).catch(() => []);
    const stages = await prepareNativePrompt(assemblyInput, generationType, controller.signal);
    if (stages) assemblyInput.nativePrompt = stages.plan;
    try {
        [assembled, nativeContributions] = await Promise.all([runPromptPipelineAsync(assemblyInput, controller.signal, false, readNativeAfterScan), legacyContributions]);
    } finally { stages?.close(); }
    await commitPromptTask(assembled, assemblyInput, controller.signal);
    workspaceStore.setState(draft => { draft.lastAssembledPrompt = assembled; });
    if (assembled.compatibilityWarnings?.length) setStatusBanner(assembled.compatibilityWarnings[0], { kind: 'warning' });
    controller.signal.throwIfAborted();
    return { assembled, assemblyInput, nativeContributions };
}

async function streamStoryReply(controller: AbortController, state: ReturnType<typeof workspaceStore.getState>, assembled: AssembledPromptResult,
    assemblyInput: AssemblePromptInput, nativeContributions: Awaited<ReturnType<typeof nativeGenerationContributions>>,
    placeholderId: string, floor: number, summaryChannel: StorySummaryChannel,
    connection: { apiSource: string; baseUrl: string; apiKey: string; model: string; schemaVals: ReturnType<typeof getSchemaValues> }): Promise<CompletionResult> {
    const { apiSource, baseUrl, apiKey, model, schemaVals } = connection;
    let previewSummary = new StorySummaryChannel(summaryChannel.tag);
    if (!baseUrl) {
        const simulatedChunks = [
            '尚未配置模型连接，本条为本地演示提示。\n\n',
            '请在「参数与连接」中填写 OpenAI Chat Completions 兼容接口地址、API Key 和模型名称，再开始对话。',
        ];

        let built = '';
        for (const chunk of simulatedChunks) {
            await new Promise((r) => setTimeout(r, 90));
            controller.signal.throwIfAborted();
            built += chunk;
            workspaceStore.setState((draft) => {
                const target = draft.messages.find((m) => m.id === placeholderId);
                if (target) {
                    target.content = built;
                    target.swipes[target.activeSwipeIndex] = built;
                }
            });
            await tavernEventBus.emit('generation_stream_token', chunk);
        }

        return { content: built, reasoning: '' };
    }
    return await streamStoryWithNativeTools({
        source: apiSource,
        baseUrl,
        apiKey,
        model: assembled.generationSettings?.model ?? model,
        messages: await applyNativeContributions(assembled, assemblyInput, nativeContributions, summaryChannel.messages(assembled.messages), controller.signal),
        parameters: assembled.generationSettings?.parameters ?? presetSamplingParameters(getActivePreset(state), schemaVals),
        stream: assembled.generationSettings?.stream ?? schemaVals['api.stream'] !== false,
        signal: controller.signal,
        onToken: (deltaContent, deltaReasoning) => {
            if (controller.signal.aborted) return;
            deltaContent = summaryChannel.push(deltaContent);
            workspaceStore.setState((draft) => {
                draft.nativeToolPreview = undefined;
                if (deltaReasoning) {
                    draft.streamingReasoning += deltaReasoning;
                }
                const target = draft.messages.find((m) => m.id === placeholderId);
                if (target && deltaContent) {
                    target.content += deltaContent;
                    target.swipes[target.activeSwipeIndex] = target.content;
                }
            });
            void tavernEventBus.emit('generation_stream_token', deltaContent);
            const current = workspaceStore.getState();
            publishNativeGenerationProgress(placeholderId, floor, current.messages.find(message => message.id === placeholderId)?.content ?? '', current.streamingReasoning);
        },
    }, delta => {
        if (!delta) {
            previewSummary = new StorySummaryChannel(summaryChannel.tag);
            workspaceStore.setState({ nativeToolPreview: undefined });
            return;
        }
        if (controller.signal.aborted) return;
        const content = previewSummary.push(delta.content);
        if (!content && !delta.reasoning) return;
        workspaceStore.setState(draft => {
            const preview = draft.nativeToolPreview ??= { id: placeholderId, content: '', reasoning: '' };
            preview.content += content;
            preview.reasoning += delta.reasoning;
        });
    });
}

async function settleStoryCandidates(result: CompletionResult, summaryChannel: StorySummaryChannel, controller: AbortController,
    state: ReturnType<typeof workspaceStore.getState>, card: ReturnType<typeof getActiveCharacter>, assembled: AssembledPromptResult,
    placeholderId: string, floor: number, firstSettled: () => void): Promise<string> {
    const summaries = (result.candidates ?? [result]).map(candidate => summaryChannel.split(candidate.content));
    const streamed = { ...result, content: summaries[0].content, candidates: (result.candidates ?? [result]).map((candidate, index) => ({ ...candidate, content: summaries[index].content })) };
    publishNativeGenerationProgress(placeholderId, floor, streamed.content, streamed.reasoning, true);
    if (streamed.reasoning) await commandCompatibilityRuntime('event', ['stream_reasoning_done', streamed.reasoning, null, floor, 'done']);
    const candidates = streamed.candidates;
    const candidateBase = readBranchState(workspaceStore.getState(), workspaceStore.getState().messages.find(node => node.id === placeholderId)!);
    const candidateVariables = structuredClone(getScopedVariables('message', { messageId: placeholderId }));
    const candidateTemplateState = { injections: workspaceStore.getState().templateInjections, activations: workspaceStore.getState().templateActivations };
    workspaceStore.setState(draft => {
        const target = draft.messages.find(message => message.id === placeholderId)!;
        target.swipes = candidates.map(candidate => ({ content: candidate.content, reasoning: candidate.reasoning,
            extra: { reasoning_signature: candidate.reasoning_signature, tool_calls: candidate.tool_calls } }));
    });
    let firstContent = streamed.content;
    try {
        for (const [index, candidate] of candidates.entries()) {
            controller.signal.throwIfAborted();
            if (index > 0) applyBranchState(candidateBase);
            workspaceStore.setState(draft => {
                const target = draft.messages.find(message => message.id === placeholderId)!;
                target.activeSwipeIndex = index; target.content = candidate.content; target.reasoning = candidate.reasoning;
                draft.timedStates = structuredClone(assembled.nextTimedStates);
                draft.templateInjections = structuredClone(candidateTemplateState.injections);
                draft.templateActivations = structuredClone(candidateTemplateState.activations);
            });
            if (index > 0) saveHelperVariables(structuredClone(candidateVariables), { type: 'message', message_id: floor });
            // Each candidate starts at the same pre-reply state; additive MVU commands cannot leak between swipes.
            let before = getScopedVariables('message', { messageId: placeholderId });
            const analyzed = await analyzeMvuReply(candidate.content, before, controller.signal, false, undefined, placeholderId);
            before = getScopedVariables('message', { messageId: placeholderId });
            const settled = await commandCompatibilityRuntime('settle', [analyzed, before], getWorkspaceScripts().some(script => script.enabled));
            if (!settled.variables) settled.variables = await settleMvuWithoutScripts(before,
                evaluateMacros(analyzed, { userName: state.userName, charName: card.name, variables: structuredClone(before) }),
                (command, error) => setStatusBanner(`MVU 命令 ${command.full_match}：${error instanceof Error ? error.message : String(error)}`));
            controller.signal.throwIfAborted();
            const regexes = orderedRegexScripts(globalRegexes(), getActivePreset(state).regexScripts, card.regexScripts);
            const output = applyRegexScripts(settled.messageContent ?? analyzed, regexes, {
                stage: 'ai_output', role: 'assistant', macroContext: { userName: state.userName, charName: card.name } });
            const reasoning = applyRegexScripts(candidate.reasoning, regexes, {
                stage: 'reasoning', role: 'assistant', macroContext: { userName: state.userName, charName: card.name } });
            const content = await executePluginHooks('afterMessageReceive', output);
            if (typeof content !== 'string') throw new Error('消息处理插件必须返回字符串');
            controller.signal.throwIfAborted();
            const writes = [...(settled.writes ?? []), { variables: settled.variables, option: { type: 'message', message_id: floor } }];
            for (const write of writes) validateHelperVariableWrite(write.variables, write.option);
            for (const write of writes) saveHelperVariables(write.variables, write.option);
            workspaceStore.setState(draft => {
                const target = draft.messages.find(message => message.id === placeholderId)!;
                target.content = content; target.reasoning = reasoning;
                target.swipes[index] = { content, reasoning, extra: { reasoning_signature: candidate.reasoning_signature, tool_calls: candidate.tool_calls } };
                const summary = summaries[index];
                if (summary.summary && summary.source) (target.storySummaries ??= {})[swipeId(target, index)] = {
                    text: summary.summary, source: summary.source, contentHash: summaryContentHash(content),
                };
                target.updatedAt = Date.now();
            });
            captureMessageSnapshot(placeholderId);
            sealBranchPoint(true);
            if (index === 0) { firstContent = content; firstSettled(); }
        }
    } finally {
        workspaceStore.setState(draft => {
            const target = draft.messages.find(message => message.id === placeholderId)!;
            target.activeSwipeIndex = 0;
            const first = target.swipes[0];
            target.content = typeof first === 'string' ? first : first.content;
            target.reasoning = typeof first === 'string' ? '' : first.reasoning ?? '';
        });
        restoreMessageSnapshot(placeholderId);
    }
    return firstContent;
}

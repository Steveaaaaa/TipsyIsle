import { claimPromptTemplateTask, finishPromptTemplateTask } from '../../pipeline/pipeline-worker-client';
import { scopedVariableStore, getScopedVariables, insertOrAssignScopedVariables, deleteScopedVariableKey } from '../scoped-variable-store';
import { normalizeMvuVariableMap } from '../../pipeline/mvu-data';
import { readExtensionVariables } from '../../compatibility/extension-variables';
import type { AssembledPromptResult, ChatMessageNode } from '../../types';
import type { AssemblePromptInput } from '../../pipeline/prompt-assembler';
import { enqueuePersistentOperation } from '../persistence';
import { normalizeTemplateFeatures } from '../../pipeline/template-features';
import { workspaceStore } from './state';
import { getActiveLorebooks, getCharacterWorldbooks, getActiveCharacter, getAvailableWorldbooks, getWorldbookGroups } from './library';
import { createPromptAssemblyInput, TemplateInputChangedError } from './prompt';
import { persistWorkspace, commitWorkspaceMutation } from './storage';
import { getActiveChatMessages } from './queries';
import { captureMessageSnapshot } from './branches';
import { validateHelperVariableWrite, saveHelperVariables } from './story-variables';

/** Shared commit for template-requested writes; return-only Helper generations use the same scope semantics. */
export function commitPromptVariableChanges(assembled: AssembledPromptResult, expected?: AssemblePromptInput): void {
    const state = workspaceStore.getState();
    const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);
    const contentTask = expected?.templateTask?.type === 'render' ? expected.templateTask : undefined;
    if (assembled.templateMessageContent !== undefined && (typeof assembled.templateMessageContent !== 'string' || !contentTask || contentTask.dryRun)) throw new Error('模板原文改写必须来自有效的首次渲染任务');
    const changedContent = assembled.templateMessageContent !== undefined && contentTask;
    if (expected) {
        if (expected.templatePreparationKey && createPromptAssemblyInput([], false).templatePreparationKey !== expected.templatePreparationKey) throw new TemplateInputChangedError('模板执行期间角色、预设、快捷回复或世界书已改变，请重试操作');
        if (!same(normalizeTemplateFeatures(readExtensionVariables(scopedVariableStore.getState().extension, 'EjsTemplate')), normalizeTemplateFeatures(expected.templateFeatures))) throw new TemplateInputChangedError('模板执行期间插件设置已改变，请重试操作');
        if (!same(state.templateInjections, expected.templateInjections ?? [])) throw new TemplateInputChangedError('模板执行期间注入状态已变化，请重试操作');
        if (!same(state.templateActivations, expected.templateActivations ?? [])) throw new TemplateInputChangedError('模板执行期间世界书动态激活状态已变化，请重试操作');
        const path = getActiveChatMessages(state);
        if (state.activeChatId !== expected.chatId || state.activeCharacterId !== expected.character.id || state.activePresetId !== expected.preset.id ||
            path.length !== expected.messages.length || path.some((node, index) => {
                const before = expected.messages[index];
                return node.id !== before.id || node.activeSwipeIndex !== before.activeSwipeIndex || node.content !== before.content
                    || node.role !== before.role || node.speakerName !== before.speakerName || node.isHidden !== before.isHidden;
            })) throw new TemplateInputChangedError('模板执行期间角色、预设、消息或分支已改变，请重试生成');
        if (!same(getActiveLorebooks(state), expected.lorebooks) || expected.lorebookCatalog && !same(getAvailableWorldbooks(state), expected.lorebookCatalog) ||
            expected.characterWorldbooks && !same(getCharacterWorldbooks(getActiveCharacter(state), state), expected.characterWorldbooks) ||
            expected.worldbookGroups && !same(getWorldbookGroups(state), expected.worldbookGroups)) {
            throw new TemplateInputChangedError('模板执行期间世界书内容或绑定已改变，请重试生成');
        }
        for (const [scope, changes, before] of [['chat', assembled.variableChanges, expected.initialLocalVariables], ['global', assembled.globalVariableChanges, expected.initialGlobalVariables]] as const) {
            const current = getScopedVariables(scope, { chatId: state.activeChatId });
            if (Object.keys(changes).some(key => !same(current[key], before?.[key]))) throw new TemplateInputChangedError('模板执行期间变量已被其他操作修改，请重试生成');
        }
        for (const messageId of Object.keys(assembled.messageVariableChanges ?? {})) {
            if (!same(getScopedVariables('message', { messageId }), expected.initialMessageVariables?.[messageId] ?? {})) throw new TemplateInputChangedError('模板执行期间消息变量已被其他操作修改，请重试生成');
        }
        for (const [messageId, swipes] of Object.entries(assembled.messageSwipeVariableChanges ?? {})) {
            const current = path.find(node => node.id === messageId);
            const before = expected.messages.find(node => node.id === messageId);
            if (!current || !before) throw new TemplateInputChangedError('模板变量对应的消息分支已经改变');
            for (const swipe of Object.keys(swipes)) {
                const read = (node: ChatMessageNode) => (node.extra?.swipeVariables as Record<string, unknown> | undefined)?.[swipe] ?? {};
                if (!same(read(current), read(before))) throw new TemplateInputChangedError('模板执行期间 swipe 变量已被其他操作修改，请重试生成');
            }
        }
    }
    for (const [messageId, swipes] of Object.entries(assembled.messageSwipeVariableChanges ?? {})) {
        const node = getActiveChatMessages(state).find(message => message.id === messageId);
        if (!node || Object.keys(swipes).some(swipe => !/^\d+$/.test(swipe) || Number(swipe) >= node.swipes.length)) throw new Error('模板变量对应的消息 swipe 已不存在');
    }
    for (const [messageId, variables] of Object.entries(assembled.messageVariableChanges ?? {})) {
        const node = getActiveChatMessages(state).find(message => message.id === messageId);
        if (!node) throw new Error('模板变量对应的消息分支已经改变');
        validateHelperVariableWrite(variables, { type: 'message', message_id: node.floor });
    }
    const injectionsChanged = assembled.templateInjections !== undefined && !same(state.templateInjections, assembled.templateInjections);
    const activationsChanged = assembled.templateActivations !== undefined && !same(state.templateActivations, assembled.templateActivations);
    if (![assembled.variableChanges, assembled.globalVariableChanges, assembled.messageVariableChanges, assembled.messageSwipeVariableChanges, assembled.messageVariableInitializationChanges].some(changes => changes && Object.keys(changes).length) && !injectionsChanged && !activationsChanged && !changedContent) return;
    if (changedContent) {
        workspaceStore.setState(draft => { draft.messages = draft.messages.map(node => {
            if (node.id !== contentTask.messageId) return node;
            const previous = node.swipes[node.activeSwipeIndex];
            const swipes = [...node.swipes];
            swipes[node.activeSwipeIndex] = typeof previous === 'string' ? assembled.templateMessageContent! : { ...previous, content: assembled.templateMessageContent! };
            return { ...node, content: assembled.templateMessageContent!, swipes, updatedAt: Date.now(),
                extra: { ...node.extra, tipsy_template_source: { ...(node.extra?.tipsy_template_source as object ?? {}), [node.activeSwipeIndex]: node.content } } };
        }); });
    }
    if (injectionsChanged) workspaceStore.setState(draft => { draft.templateInjections = structuredClone(assembled.templateInjections!); });
    if (activationsChanged) workspaceStore.setState(draft => { draft.templateActivations = structuredClone(assembled.templateActivations!); });
    for (const scope of ['chat', 'global'] as const) {
        const changes = scope === 'chat' ? assembled.variableChanges : assembled.globalVariableChanges;
        for (const [key, value] of Object.entries(changes)) {
            if (value === undefined) deleteScopedVariableKey(key, scope, { chatId: state.activeChatId });
            else insertOrAssignScopedVariables({ [key]: value }, scope, { chatId: state.activeChatId });
        }
    }
    for (const [messageId, variables] of Object.entries(assembled.messageVariableChanges ?? {})) {
        const node = state.messages.find(message => message.id === messageId)!;
        saveHelperVariables(variables, { type: 'message', message_id: node.floor });
    }
    for (const [messageId, swipes] of Object.entries(assembled.messageSwipeVariableChanges ?? {})) {
        workspaceStore.setState(draft => {
            const target = draft.messages.find(message => message.id === messageId);
            if (target) target.extra = { ...target.extra, swipeVariables: { ...(target.extra?.swipeVariables as object ?? {}), ...structuredClone(normalizeMvuVariableMap(swipes).variables) } };
        });
    }
    if (assembled.messageVariableInitializationChanges) workspaceStore.setState(draft => {
        for (const node of draft.messages) {
            const swipes = assembled.messageVariableInitializationChanges?.[node.id];
            if (swipes?.length) node.extra = { ...node.extra, tipsy_template_variables_initialized: {
                ...(node.extra?.tipsy_template_variables_initialized as object ?? {}), ...Object.fromEntries(swipes.map(swipe => [swipe, true])),
            } };
        }
    });
    if ((injectionsChanged || activationsChanged) && state.activeLeafId) captureMessageSnapshot(state.activeLeafId);
    persistWorkspace();
}

export async function commitPromptTask(result: AssembledPromptResult, input: AssemblePromptInput, signal?: AbortSignal): Promise<void> {
    return enqueuePersistentOperation(() => commitPromptTaskNow(result, input, signal));
}

async function commitPromptTaskNow(result: AssembledPromptResult, input: AssemblePromptInput, signal?: AbortSignal): Promise<void> {
    let saved = false;
    try {
        signal?.throwIfAborted();
        await claimPromptTemplateTask(result);
        signal?.throwIfAborted();
        await commitWorkspaceMutation(() => { signal?.throwIfAborted(); commitPromptVariableChanges(result, input); });
        saved = true;
        await finishPromptTemplateTask(result, true);
    } catch (error) {
        // Once storage accepted the values, a lost acknowledgement must not roll
        // the author runtime back to before those values. finish is idempotent.
        await finishPromptTemplateTask(result, saved).catch(() => {});
        throw error;
    }
}

import _ from 'lodash';
import { scopedVariableStore, getScopedVariables, replaceScopedVariables, replaceExtensionVariables } from '../scoped-variable-store';
import { normalizeMvuVariables } from '../../pipeline/mvu-data';
import type { HelperVariableOption, VariableWrite } from '../../compatibility/contracts';
import { scriptsFromTrees } from '../../compatibility/script-trees';
import { validateExtensionVariableId } from '../../compatibility/extension-variables';
import { enqueuePersistentOperation } from '../persistence';
import { workspaceStore } from './state';
import { persistWorkspace, commitWorkspaceMutation } from './storage';
import { getActiveChatMessages, getEffectiveMvuSettings } from './queries';
import { mvuChatProjection } from './story-initialization';
import { captureMessageSnapshot, trackBranchExtension } from './branches';
import { getWorkspaceScripts, getWorkspaceScriptTrees, replaceWorkspaceScriptTrees } from './scripts';

export function validateHelperVariableWrite(variables: Record<string, unknown>, option: HelperVariableOption = {}): void {
    if (!variables || typeof variables !== 'object' || Array.isArray(variables)) throw new Error('变量表必须是对象');
    const type = option.type ?? 'chat';
    if (type === 'message') {
        const index = option.message_id === undefined || option.message_id === 'latest' ? -1 : Number(option.message_id);
        if (!Number.isInteger(index) || !getActiveChatMessages().at(index)) throw new Error('变量指定的消息楼层不存在');
    } else if (type === 'script') {
        if (!option.script_id || !getWorkspaceScripts().some(script => script.id === option.script_id)) throw new Error('脚本变量必须指定有效的 script_id');
    } else if (type === 'extension') {
        validateExtensionVariableId(option.extension_id);
    } else if (!['chat', 'character', 'preset', 'global'].includes(type)) throw new Error(`未支持的变量作用域：${type}`);
}

export function saveHelperVariables(variables: Record<string, unknown>, option: HelperVariableOption = {}): Record<string, unknown> {
    validateHelperVariableWrite(variables, option);
    if (!variables || typeof variables !== 'object' || Array.isArray(variables)) throw new Error('变量表必须是对象');
    const state = workspaceStore.getState();
    const path = getActiveChatMessages(state);
    const type = option.type ?? 'chat';
    const value = structuredClone(type === 'chat' || type === 'message' ? normalizeMvuVariables(variables).variables : variables);
    const ctx = { chatId: state.activeChatId, characterId: state.activeCharacterId, presetId: state.activePresetId };
    if (type === 'message') {
        const index = option.message_id === 'latest' || option.message_id === undefined ? -1 : Number(option.message_id);
        const node = path.at(index);
        if (!node || !Number.isInteger(index)) throw new Error('变量指定的消息楼层不存在');
        replaceScopedVariables(value, 'message', { ...ctx, messageId: node.id });
        if (node.id === path.at(-1)?.id) {
            const chat = getScopedVariables('chat', ctx);
            // Keep the MVU data and its declarations together in the current chat projection.
            if ('stat_data' in value && getEffectiveMvuSettings(state).settings['mvu.update_chat'] === true) {
                const projection = mvuChatProjection(value);
                for (const key of ['display_data', 'delta_data']) if (!(key in projection)) delete chat[key];
                replaceScopedVariables({ ...chat, ...projection }, 'chat', ctx);
            }
        }
        workspaceStore.setState(draft => {
            const target = draft.messages.find(m => m.id === node.id)!;
            const chatVariables = structuredClone(getScopedVariables('chat', ctx));
            target.extra = { ...target.extra, swipeVariables: { ...(target.extra?.swipeVariables as object ?? {}), [node.activeSwipeIndex]: value },
                ...(node.id === path.at(-1)?.id ? { chatVariables, swipeChatVariables: { ...(target.extra?.swipeChatVariables as object ?? {}), [node.activeSwipeIndex]: chatVariables } } : {}) };
        });
    } else if (type === 'script') {
        const trees = getWorkspaceScriptTrees(state);
        const type = (['character', 'preset', 'global'] as const).find(type => scriptsFromTrees(trees[type]).some(script => script.id === option.script_id))!;
        const next = structuredClone(trees[type]);
        let scriptIndex = 0;
        const visit = (scripts: any[]) => {
            if (!Array.isArray(scripts)) return;
            for (const script of scripts ?? []) {
                if (!script || typeof script !== 'object') continue;
                if (Array.isArray(script.scripts)) visit(script.scripts);
                else if (typeof script.content === 'string') {
                    if (String(script.id ?? scriptIndex) === option.script_id) script.data = structuredClone(value);
                    scriptIndex++;
                }
            }
        };
        visit(next);
        replaceWorkspaceScriptTrees(next, type, false);
    } else if (type === 'extension') {
        trackBranchExtension(option.extension_id!);
        replaceExtensionVariables(option.extension_id!, value);
    } else {
        if (!['chat', 'character', 'preset', 'global'].includes(type)) throw new Error(`未支持的变量作用域：${type}`);
        replaceScopedVariables(value, type as 'chat' | 'character' | 'preset' | 'global', ctx);
        if (type === 'chat' && path.at(-1)) captureMessageSnapshot(path.at(-1)!.id);
    }
    persistWorkspace();
    return value;
}

/** One checked publication for every greeting candidate. No partial per-swipe RPC writes. */
interface MvuInitializationPayload {
    expected: { session: string; messageId: string; swipes: string[]; swipe: number; variables: Record<string, unknown>;
        messageVariables: Record<string, any>[]; scopes: Record<string, Record<string, unknown>>; scriptVariables: Record<string, Record<string, unknown>>; extensionVariables: Record<string, Record<string, unknown>> };
    candidates: Record<string, any>[]; writes: VariableWrite[];
}

export async function commitMvuInitialization(payload: MvuInitializationPayload): Promise<void> {
    return enqueuePersistentOperation(() => commitWorkspaceMutation(() => applyMvuInitialization(payload)));
}

export async function commitMvuMessage(expected: { session: string; id: string; swipe: number; content: string; variables?: Record<string, unknown> },
    result: { variables: Record<string, unknown>; writes?: VariableWrite[]; messageContent?: string }): Promise<void> {
    await enqueuePersistentOperation(() => commitWorkspaceMutation(() => {
        const node = getActiveChatMessages().find(message => message.id === expected.id);
        if (workspaceStore.getState().activeChatId !== expected.session || !node || node.activeSwipeIndex !== expected.swipe || node.content !== expected.content) throw new Error('变量结算期间消息或候选已改变');
        if (expected.variables && !_.isEqual(getScopedVariables('message', { messageId: node.id }), expected.variables)) throw new Error('校正期间消息变量已改变，请重新发起校正');
        const writes = [...result.writes ?? [], { variables: result.variables, option: { type: 'message', message_id: node.floor } }];
        for (const write of writes) validateHelperVariableWrite(write.variables, write.option);
        for (const write of writes) saveHelperVariables(write.variables, write.option);
        if (result.messageContent !== undefined) workspaceStore.setState(draft => {
            const target = draft.messages.find(message => message.id === node.id)!;
            target.content = result.messageContent!;
            const swipe = target.swipes[target.activeSwipeIndex];
            target.swipes[target.activeSwipeIndex] = typeof swipe === 'string' ? target.content : { ...swipe, content: target.content };
            target.updatedAt = Date.now();
        });
    }));
}

function applyMvuInitialization(payload: MvuInitializationPayload): void {
    const state = workspaceStore.getState();
    const node = getActiveChatMessages(state)[0];
    const expected = payload.expected;
    const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);
    const ctx = { chatId: state.activeChatId, characterId: state.activeCharacterId, presetId: state.activePresetId };
    const swipes = node?.extra?.swipeVariables as Record<string, Record<string, any>> | undefined;
    if (!node || getActiveChatMessages(state).length !== 1 || state.activeChatId !== expected.session || node.id !== expected.messageId || node.activeSwipeIndex !== expected.swipe
        || !same(node.swipes.map(swipe => typeof swipe === 'string' ? swipe : swipe.content), expected.swipes)
        || !same(node.swipes.map((_, swipe) => swipe === node.activeSwipeIndex ? getScopedVariables('message', { messageId: node.id }) : swipes?.[swipe] ?? {}), expected.messageVariables)
        || !same(getScopedVariables('chat', { chatId: state.activeChatId }), expected.variables)
        || (['global', 'preset', 'character'] as const).some(scope => !same(getScopedVariables(scope, ctx), expected.scopes[scope]))
        || !same(Object.fromEntries(getWorkspaceScripts(state).map(script => [script.id, script.data])), expected.scriptVariables)
        || !same(scopedVariableStore.getState().extension, expected.extensionVariables)) throw new Error('开场初始化期间聊天或变量已改变，请重新读取');
    // Author MVU callbacks may deliberately update worldbooks during opening
    // initialization. Those writes are independently committed, not rolled back
    // with this variable publication, and must not invalidate their own result.
    if (!Array.isArray(payload.candidates) || payload.candidates.length !== node.swipes.length || !Array.isArray(payload.writes)) throw new Error('开场初始化结果不完整');
    const candidates = payload.candidates.map(value => {
        validateHelperVariableWrite(value, { type: 'message', message_id: 0 });
        return structuredClone(normalizeMvuVariables(value).variables);
    });
    for (const write of payload.writes) validateHelperVariableWrite(write.variables, write.option);
    for (const write of payload.writes) saveHelperVariables(write.variables, write.option);
    const previousChat = getScopedVariables('chat', { chatId: state.activeChatId });
    workspaceStore.setState(draft => {
        const target = draft.messages.find(message => message.id === node.id)!;
        target.extra = { ...target.extra, tipsy_mvu_initialized: true, tipsy_mvu_initialization_pending: false,
            swipeVariables: Object.fromEntries(candidates.map((value, swipe) => [swipe, value])),
            swipeChatVariables: Object.fromEntries(candidates.map((value, swipe) => [swipe, { ...previousChat, ...mvuChatProjection(value) }])) };
    });
    saveHelperVariables(candidates[node.activeSwipeIndex], { type: 'message', message_id: 0 });
    if (getActiveChatMessages().length === 1) captureMessageSnapshot(node.id);
    persistWorkspace();
}

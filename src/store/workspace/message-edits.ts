import { batchReactiveUpdates } from '../reactive-store';
import { applyRegexScripts, orderedRegexScripts } from '../../pipeline/macro-regex-engine';
import _ from 'lodash';
import { getScopedVariables, readScopedVariables, replaceScopedVariables } from '../scoped-variable-store';
import { activePath, swipeId, storyRoutes } from '../chat-tree';
import { continueNativeRoute } from '../../plugins/native/route-graph';
import { tavernEventBus } from '../../sandbox/event-bus';
import { commandCompatibilityRuntime } from '../../compatibility/runtime-client';
import type { ChatMessageNode } from '../../types';
import { waitForReplicaCommit } from '../persistence';
import { hostHiddenKey, hostIllustrationKey, hostMessageHidden, messageExtra, patchHelperMessage, validateMessageRefresh, type HostIllustration } from '../../compatibility/chat-message-codec';
import { globalRegexes } from '../global-regex-store';
import { workspaceStore } from './state';
import { getActivePreset, getActiveCharacter } from './library';
import { schedulePreview } from './prompt';
import { persistWorkspace, persistWorkspaceNow } from './storage';
import { setStatusBanner } from './notice';
import { getActiveChatMessages, getEffectiveMvuSettings } from './queries';
import { initialChatVariables, mvuChatProjection } from './story-initialization';
import { isNativeStorySaving } from './activity';
import { sealBranchPoint, restoreMessageSnapshot, rememberBranch, publishBranchChange, captureMessageSnapshot, selectChatBranch, preserveReplyVersion, remapBranchSnapshots, swipeBranchMessage } from './branches';
import { saveHelperVariables } from './story-variables';
import { getGenerationNotificationMessage } from './generation';
import { notifyMessage } from './messages';

type LegacyMessagePatch = { id: string; swipe: number; content: string; mes?: string; hidden?: boolean; extra?: Record<string, unknown>; variables?: Record<string, unknown> };

type LegacyMetadataPatch = { values: Record<string, unknown>; removed: string[] };

export function saveLegacyChat(rows: LegacyMessagePatch[], variables?: Record<string, unknown>, metadata: LegacyMetadataPatch = { values: {}, removed: [] }): boolean {
    const state = workspaceStore.getState();
    const path = new Map(getActiveChatMessages(state).map(node => [node.id, node]));
    const hidden = { ...state.chatMetadata?.[hostHiddenKey] as Record<string, boolean> | undefined };
    let hiddenChanged = false;
    const edits = new Map<string, { swipe: number; mes?: string; extra?: Record<string, unknown> }>();
    const writes: Array<{ floor: number; value: Record<string, unknown> }> = [];
    for (const message of rows) {
        const node = path.get(message.id);
        if (!node || message.swipe !== node.activeSwipeIndex || message.content !== node.content) {
            if (message.mes !== undefined) throw new Error('插件保存的正文对应的消息已改变');
            continue;
        }
        if (message.mes !== undefined && node.extra?.tipsy_generation_incomplete) throw new Error('不能保存尚在生成的消息正文');
        const extra = message.extra && !_.isEqual(message.extra, messageExtra(node)) ? message.extra : undefined;
        if (message.mes !== undefined || extra) edits.set(node.id, { swipe: node.activeSwipeIndex, mes: message.mes, extra });
        if (message.variables && !_.isEqual(message.variables, readScopedVariables('message', { messageId: node.id }))) writes.push({ floor: node.floor, value: message.variables });
        if (message.hidden !== undefined && message.hidden !== hostMessageHidden(node, state.chatMetadata) && !node.isHidden) {
            if (message.hidden) hidden[swipeId(node)] = true; else delete hidden[swipeId(node)];
            hiddenChanged = true;
        }
    }
    const next = { ...state.chatMetadata, ...metadata.values, ...(hiddenChanged ? { [hostHiddenKey]: hidden } : {}) };
    for (const key of metadata.removed) delete next[key];
    const metadataChanged = !_.isEqual(next, state.chatMetadata ?? {});
    const variablesChanged = !!variables && !_.isEqual(variables, readScopedVariables('chat', { chatId: state.activeChatId }));
    if (!edits.size && !metadataChanged && !variablesChanged && !writes.length) return false;
    batchReactiveUpdates(() => {
        if (edits.size) workspaceStore.setState(draft => {
            for (const node of draft.messages) {
                const patch = edits.get(node.id);
                if (!patch) continue;
                if (patch.extra) node.extra = { ...node.extra, helperSwipeInfo: { ...node.extra?.helperSwipeInfo as object, [patch.swipe]: patch.extra } };
                const key = swipeId(node, patch.swipe);
                if (patch.mes !== undefined) {
                    const previous = node.swipes[patch.swipe];
                    node.swipes[patch.swipe] = typeof previous === 'object' ? { ...previous, content: patch.mes } : patch.mes;
                    if (node.activeSwipeIndex === patch.swipe) node.content = patch.mes;
                    node.updatedAt = Date.now();
                    delete node.storySummaries?.[key];
                }
                // Keep saved choices pointing at the edited text without rolling back their variables.
                for (const point of [node.branchBases?.[key], node.branchStates?.[key]]) if (point?.reply) {
                    if (patch.mes !== undefined) {
                        point.reply.content = patch.mes;
                        const original = point.reply.swipe;
                        point.reply.swipe = typeof original === 'object' ? { ...original, content: patch.mes } : patch.mes;
                    }
                    if (patch.extra) point.reply.extra = { ...point.reply.extra,
                        helperSwipeInfo: { ...point.reply.extra?.helperSwipeInfo as object, [patch.swipe]: patch.extra } };
                }
            }
        });
        if (metadataChanged) workspaceStore.setState({ chatMetadata: next });
        for (const write of writes) saveHelperVariables(write.value, { type: 'message', message_id: write.floor });
        if (variablesChanged) saveHelperVariables(variables!, { type: 'chat' });
        if (state.activeLeafId) captureMessageSnapshot(state.activeLeafId);
    });
    if ([...edits.values()].some(edit => edit.mes !== undefined)) schedulePreview();
    return true;
}

export function editHelperChatMessage(floor: number | string, content: string, options: { swipe_id?: number; refresh?: 'none' | 'affected' | 'all' } = {}): boolean {
    const path = getActiveChatMessages();
    const node = path.find(m => m.id === floor) ?? path.at(Number(floor));
    if (!node) throw new Error('消息楼层不存在');
    const duringNotification = workspaceStore.getState().isGenerating && getGenerationNotificationMessage() === node.id;
    if (workspaceStore.getState().isGenerating && !duringNotification) throw new Error('生成期间不能修改消息');
    const swipe = options.swipe_id ?? node.activeSwipeIndex;
    if (swipe !== node.activeSwipeIndex && isNativeStorySaving()) throw new Error('正在保存插件数据，请稍后切换路线');
    if (!Number.isInteger(swipe) || swipe < 0 || swipe >= node.swipes.length) throw new Error('消息分支不存在');
    if (duringNotification && swipe !== node.activeSwipeIndex) throw new Error('生成事件中不能切换消息分支');
    if (node.floor > 0 && !duringNotification && swipe !== node.activeSwipeIndex) {
        const routes = storyRoutes(workspaceStore.getState().messages).filter(route => route.path.some(item => item.id === node.id && item.activeSwipeIndex === swipe));
        if (routes.length > 1) throw new Error('这个回复有多条后续，请从故事路线选择要继续的一条');
        if (routes.length === 1) {
            const current = node.swipes[swipe];
            if ((typeof current === 'string' ? current : current.content) === content) { selectChatBranch(routes[0].key, true); return true; }
        }
    }
    captureMessageSnapshot(node.id);
    const forksHistory = node.floor > 0 && !duringNotification && content !== node.content && node.id !== workspaceStore.getState().activeLeafId;
    if (forksHistory) preserveReplyVersion(workspaceStore.getState().messages.find(item => item.id === node.id)!);
    workspaceStore.setState(draft => {
        const target = draft.messages.find(m => m.id === node.id)!;
        target.swipes = [...target.swipes];
        const previous = target.swipes[swipe];
        target.swipes[swipe] = typeof previous === 'string' ? content : { ...previous, content };
        target.activeSwipeIndex = swipe; target.content = content; target.updatedAt = Date.now();
        if (target.floor === 0 && draft.activeLeafId === target.id && swipe !== node.activeSwipeIndex) draft.nativePluginRoute = node.nativePluginOpeningRoutes?.[swipeId(node, swipe)];
        if (swipe !== node.activeSwipeIndex) target.reasoning = typeof previous === 'string' ? '' : previous.reasoning ?? '';
        if (forksHistory) {
            target.branchBases = undefined; target.branchStates = undefined;
            draft.activeLeafId = target.id;
        }
    });
    if (node.floor > 0 && (forksHistory || swipe !== node.activeSwipeIndex)) restoreMessageSnapshot(node.id);
    else captureMessageSnapshot(node.id);
    if (forksHistory) { sealBranchPoint(true); publishBranchChange(false); }
    persistWorkspace();
    if (!duringNotification) {
        if (options.refresh !== 'none') schedulePreview();
        if (options.refresh === 'all') void commandCompatibilityRuntime('event', ['chat_changed', workspaceStore.getState().activeChatId]).catch(error => setStatusBanner(String(error)));
        else notifyMessage('message_edited', { ...node, content });
    }
    return true;
}

/** Validate the complete batch before publishing any mutation. */
export async function setHelperChatMessages(items: Array<Record<string, any>>, options: { refresh?: 'none' | 'affected' | 'all' } = {}): Promise<Array<{ message_id: number; role: ChatMessageNode['role'] }>> {
    await waitForReplicaCommit();
    if (!Array.isArray(items)) throw new Error('消息更新必须是数组');
    validateMessageRefresh(options.refresh);
    const state = workspaceStore.getState();
    const path = getActiveChatMessages();
    const merged = new Map<string, { node: ChatMessageNode; item: Record<string, any> }>();
    for (const item of items) {
        if (!item || typeof item !== 'object' || item.message_id == null) throw new Error('消息更新必须包含 message_id');
        const id = Number(item.message_id);
        if (!Number.isInteger(id)) throw new Error('message_id 必须为整数');
        const node = path.at(id);
        if (node) merged.set(node.id, { node, item: { ...merged.get(node.id)?.item, ...item, message_id: node.floor } });
    }
    const plans = [...merged.values()].sort((a, b) => a.node.floor - b.node.floor).map(({ node, item }) => {
        const variables = getScopedVariables('message', { messageId: node.id });
        const plan = patchHelperMessage(node, item, variables);
        if (node.floor === 0 && item.data === undefined && item.swipes_data === undefined) {
            // Changing the opening display does not roll back the author's live setup.
            plan.variables = variables;
            (plan.node.extra!.swipeVariables as Record<string, Record<string, unknown>>)[plan.node.activeSwipeIndex] = variables;
        }
        if (state.isGenerating && (getGenerationNotificationMessage() !== node.id || plan.node.activeSwipeIndex !== node.activeSwipeIndex
            || ['swipes', 'swipes_data', 'swipes_info', 'role', 'is_hidden'].some(key => item[key] !== undefined))) {
            throw new Error('生成期间不能修改其他消息或改变分支结构');
        }
        return plan;
    });
    if (!plans.length) return [];
    const changesChoice = plans.find(plan => plan.node.activeSwipeIndex !== path.find(node => node.id === plan.node.id)!.activeSwipeIndex);
    if (changesChoice && changesChoice.node.floor > 0 && plans.length === 1 && Object.keys(merged.get(changesChoice.node.id)!.item).every(key => ['message_id', 'swipe_id'].includes(key))) {
        const routes = storyRoutes(state.messages).filter(route => route.path.some(node => node.id === changesChoice.node.id && node.activeSwipeIndex === changesChoice.node.activeSwipeIndex));
        if (routes.length !== 1) throw new Error('这个回复有多条后续，请从故事路线选择');
        selectChatBranch(routes[0].key, true); return [{ message_id: changesChoice.node.floor, role: changesChoice.node.role }];
    }
    if (!state.isGenerating && plans.some(plan => {
        const original = path.find(node => node.id === plan.node.id)!;
        return original.floor > 0 && (original.id !== state.activeLeafId || state.messages.some(node => node.parentId === original.id))
            && (plan.node.content !== original.content || plan.node.activeSwipeIndex !== original.activeSwipeIndex
                || !_.isEqual(plan.node.swipes, original.swipes));
    })) {
        const edits = new Map(plans.map(plan => [plan.node.id, plan.node]));
        const first = Math.min(...plans.map(plan => plan.node.floor));
        const active = await publishHelperPath(path.map(node => edits.get(node.id) ?? node), first, new Map(plans.map(plan => [plan.node.id, plan.variables])));
        return active.slice(first).map(node => ({ message_id: node.floor, role: node.role }));
    }
    const byId = new Map(plans.map(plan => [plan.node.id, plan.node]));
    const previousHead = path.at(-1), nextHead = previousHead && byId.get(previousHead.id);
    workspaceStore.setState({ messages: state.messages.map(node => byId.get(node.id) ?? node),
        ...(nextHead?.floor === 0 && previousHead && swipeId(nextHead) !== swipeId(previousHead) && { nativePluginRoute: nextHead.nativePluginOpeningRoutes?.[swipeId(nextHead)] }) });
    for (const plan of plans) {
        replaceScopedVariables(plan.variables, 'message', { messageId: plan.node.id });
        if (plan.node.id === path.at(-1)?.id) {
            if (plan.node.floor > 0 && plan.node.activeSwipeIndex !== path.at(-1)!.activeSwipeIndex) restoreMessageSnapshot(plan.node.id);
            if ('stat_data' in plan.variables && getEffectiveMvuSettings(state).settings['mvu.update_chat'] === true) {
                const projection = mvuChatProjection(plan.variables);
                const chat = getScopedVariables('chat', { chatId: state.activeChatId });
                for (const key of ['display_data', 'delta_data']) if (!(key in projection)) delete chat[key];
                replaceScopedVariables({ ...chat, ...projection }, 'chat', { chatId: state.activeChatId });
            }
            captureMessageSnapshot(plan.node.id);
        }
    }
    await persistWorkspaceNow();
    if (!state.isGenerating) schedulePreview();
    return plans.map(plan => ({ message_id: plan.node.floor, role: plan.node.role }));
}

/** Structural edits fork the changed suffix, retaining inactive branches and their variables. */
async function publishHelperPath(next: ChatMessageNode[], from: number, newVariables = new Map<string, Record<string, unknown>>()): Promise<ChatMessageNode[]> {
    const state = workspaceStore.getState();
    if (isNativeStorySaving() || state.isGenerating || state.helperGenerationCount) throw new Error('请等待剧情保存或生成结束后更改消息结构');
    if (state.activeLeafId) captureMessageSnapshot(state.activeLeafId);
    const latest = workspaceStore.getState();
    const prefix = next.slice(0, from);
    const appended: ChatMessageNode[] = [];
    const remapped = new Map<string, string>();
    let continuing: string | undefined;
    for (const source of next.slice(from)) {
        const original = source;
        const id = `msg_${crypto.randomUUID()}`;
        const node = { ...structuredClone(original), id, messageId: id, parentId: appended.at(-1)?.id ?? prefix.at(-1)?.id ?? null,
            parentSwipeId: (appended.at(-1) ?? prefix.at(-1)) ? swipeId((appended.at(-1) ?? prefix.at(-1))!) : undefined,
            floor: prefix.length + appended.length, updatedAt: Date.now() };
        node.branchOrigin = original.branchOrigin ?? original.id;
        node.swipeIds ??= original.swipes.map((_, index) => swipeId(original, index));
        continuing ??= continueNativeRoute(latest.messages, prefix, node);
        node.nativeRouteAnchors = { [swipeId(node)]: continuing };
        remapped.set(original.id, id);
        if (newVariables.has(source.id)) {
            node.branchBases = undefined; node.branchStates = undefined;
            node.extra = { ...node.extra, chatVariables: structuredClone(getScopedVariables('chat', { chatId: state.activeChatId })),
                timedStates: structuredClone(state.timedStates), templateState: { injections: structuredClone(state.templateInjections), activations: structuredClone(state.templateActivations) } };
        }
        appended.push(node);
        replaceScopedVariables(structuredClone(newVariables.get(source.id) ?? getScopedVariables('message', { messageId: source.id })), 'message', { messageId: id });
    }
    for (const node of appended) remapBranchSnapshots(node, remapped);
    const active = [...prefix, ...appended];
    batchReactiveUpdates(() => {
        workspaceStore.setState({ messages: [...latest.messages, ...appended], activeLeafId: active.at(-1)?.id ?? null,
            ...(from < getActiveChatMessages(latest).length && { branchEpoch: (latest.branchEpoch ?? 0) + 1 }) });
        const leaf = active.at(-1);
        if (leaf) restoreMessageSnapshot(leaf.id);
        else {
            replaceScopedVariables(initialChatVariables(), 'chat', { chatId: state.activeChatId });
            workspaceStore.setState({ timedStates: {}, chatMetadata: undefined, nativePluginRoute: undefined, templateInjections: [], templateActivations: [] });
        }
        sealBranchPoint();
    });
    await persistWorkspaceNow(); schedulePreview();
    return active;
}

export async function createHelperChatMessages(items: Array<Record<string, any>>, options: { insert_at?: number | 'end'; insert_before?: number | 'end'; refresh?: 'none' | 'affected' | 'all' } = {}): Promise<Array<{ message_id: number; role: ChatMessageNode['role'] }>> {
    if (!Array.isArray(items)) throw new Error('消息创建参数必须是数组');
    validateMessageRefresh(options.refresh);
    const path = getActiveChatMessages();
    const position = options.insert_at ?? options.insert_before ?? 'end';
    if (position !== 'end' && !Number.isInteger(position)) throw new Error('消息插入位置必须为整数或 end');
    const rawIndex = position === 'end' ? path.length : Math.max(-path.length, Math.min(path.length, position));
    const index = rawIndex < 0 ? path.length + rawIndex : rawIndex;
    const variables = new Map<string, Record<string, unknown>>();
    // New messages inherit the preceding message's variables, as ordinary sends
    // do. Opening scripts can then remove their UI floor without losing MVU data.
    let inherited = { ...getScopedVariables('chat', { chatId: workspaceStore.getState().activeChatId }), ...(index > 0 ? getScopedVariables('message', { messageId: path[index - 1].id }) : {}) };
    const created = items.map(item => {
        if (!item || typeof item !== 'object' || !['system', 'user', 'assistant'].includes(item.role) || typeof item.message !== 'string') throw new Error('创建消息必须包含有效的 role 和 message');
        const unknown = Object.keys(item).filter(key => !['role', 'name', 'is_hidden', 'message', 'data', 'extra'].includes(key));
        if (unknown.length) throw new Error(`未知创建消息字段：${unknown.join('、')}`);
        const id = `new_${crypto.randomUUID()}`;
        const base: ChatMessageNode = { id, parentId: null, floor: 0, role: item.role, speakerName: item.role === 'user' ? workspaceStore.getState().userName : item.role === 'system' ? 'system' : getActiveCharacter().name,
            content: '', swipes: [''], activeSwipeIndex: 0, createdAt: Date.now() };
        const plan = patchHelperMessage(base, { ...item, message_id: 0 }, inherited);
        inherited = plan.variables;
        variables.set(id, plan.variables); return plan.node;
    });
    if (!created.length) return [];
    const active = await publishHelperPath([...path.slice(0, index), ...created, ...path.slice(index)], index, variables);
    return active.slice(index, index + created.length).map(node => ({ message_id: node.floor, role: node.role }));
}

export async function deleteHelperChatMessages(ids: number[], options: { refresh?: 'none' | 'affected' | 'all' } = {}): Promise<Array<{ message_id: number; role: ChatMessageNode['role'] }>> {
    if (!Array.isArray(ids) || ids.some(id => !Number.isInteger(id))) throw new Error('删除消息必须提供整数楼层数组');
    validateMessageRefresh(options.refresh);
    const path = getActiveChatMessages();
    const removed = new Set(ids.map(id => id < 0 ? path.length + id : id).filter(id => id >= 0 && id < path.length));
    if (!removed.size) return [];
    const first = Math.min(...removed);
    const active = await publishHelperPath(path.filter((_, index) => !removed.has(index)), first);
    return active.slice(first).map(node => ({ message_id: node.floor, role: node.role }));
}

export async function rotateHelperChatMessages(begin: number, middle: number, end: number, options: { refresh?: 'none' | 'affected' | 'all' } = {}): Promise<Array<{ message_id: number; role: ChatMessageNode['role'] }>> {
    if (![begin, middle, end].every(Number.isInteger)) throw new Error('消息旋转边界必须为整数');
    validateMessageRefresh(options.refresh);
    const path = getActiveChatMessages();
    const normalize = (value: number) => Math.max(0, Math.min(path.length, value < 0 ? path.length + value : value));
    begin = normalize(begin); end = normalize(end); middle = Math.max(begin, Math.min(end, normalize(middle)));
    if (begin >= end || begin === middle || middle === end) return [];
    const active = await publishHelperPath([...path.slice(0, begin), ...path.slice(middle, end), ...path.slice(begin, middle), ...path.slice(end)], begin);
    return active.slice(begin).map(node => ({ message_id: node.floor, role: node.role }));
}

export function editChatMessage(messageId: string, newContent: string): boolean {
    if (isNativeStorySaving() || workspaceStore.getState().isGenerating) return false;
    const visible = getActiveChatMessages();
    const resolvedId = visible.find(node => node.id === messageId)?.id ?? visible.find(node => String(node.floor) === String(messageId))?.id;
    const source = visible.find(node => node.id === resolvedId);
    if (source?.content === newContent) return true;
    if (source && source.floor > 0) { rememberBranch(); preserveReplyVersion(source); }
    let updated = false;
    workspaceStore.setState((draft) => {
        const target = draft.messages.find((m) => m.id === resolvedId);
        if (!target) return;
        if (draft.sessionKind !== 'free') newContent = applyRegexScripts(newContent, orderedRegexScripts(globalRegexes(), getActivePreset().regexScripts, getActiveCharacter().regexScripts), {
            stage: target.role === 'user' ? 'user_input' : 'ai_output', role: target.role, isEdit: true,
            macroContext: { userName: draft.userName, charName: getActiveCharacter().name },
        });
        target.content = newContent;
        const swipe = target.swipes[target.activeSwipeIndex];
        target.swipes[target.activeSwipeIndex] = typeof swipe === 'string' ? newContent : { ...swipe, content: newContent };
        target.updatedAt = Date.now();
        if (target.floor > 0) {
            target.branchBases = undefined; target.branchStates = undefined; draft.activeLeafId = target.id;
        }
        updated = true;
    });
    if (updated) {
        if (source!.floor > 0) { restoreMessageSnapshot(resolvedId!); sealBranchPoint(true); publishBranchChange(); }
        else captureMessageSnapshot(resolvedId!);
        persistWorkspace();
        const node = getActiveChatMessages().find(m => m.id === resolvedId);
        if (node) notifyMessage('message_edited', node);
        schedulePreview();
    }
    return updated;
}

export function attachReplyIllustration(expected: { chatId: string; branchEpoch?: number; messageId: string; swipeId: string; content: string }, illustration: HostIllustration): boolean {
    const current = workspaceStore.getState();
    const target = getActiveChatMessages(current).find(message => message.id === expected.messageId);
    if (current.activeChatId !== expected.chatId || current.branchEpoch !== expected.branchEpoch || !target
        || swipeId(target) !== expected.swipeId || target.content !== expected.content) return false;
    workspaceStore.setState(draft => {
        const message = draft.messages.find(message => message.id === expected.messageId)!;
        const table = (message.extra ??= {})[hostIllustrationKey] as Record<string, HostIllustration[]> | undefined;
        const key = expected.swipeId;
        message.extra[hostIllustrationKey] = { ...table, [key]: [...table?.[key] ?? [], illustration] };
    });
    return true;
}

export function deleteChatMessage(messageId: string): void {
    if (isNativeStorySaving() || workspaceStore.getState().isGenerating) return;
    const deletedFloor = getActiveChatMessages().find(m => m.id === messageId)?.floor;
    workspaceStore.setState(draft => {
        const target = draft.messages.find(node => node.id === messageId);
        if (!target) return;
        for (const child of draft.messages) if (child.parentId === messageId) { child.parentId = target.parentId; child.parentSwipeId = target.parentSwipeId; }
        draft.messages = draft.messages.filter(node => node.id !== messageId);
        if (!draft.deletedMessageIds?.includes(messageId)) (draft.deletedMessageIds ??= []).push(messageId);
        if (draft.activeLeafId === messageId) draft.activeLeafId = target.parentId ?? draft.messages.at(-1)?.id ?? null;
        for (const node of draft.messages) node.floor = activePath(draft.messages, node.id).length - 1;
    });
    if (workspaceStore.getState().sessionKind === 'free') { persistWorkspace(); return; }
    const leaf = workspaceStore.getState().activeLeafId;
    if (leaf) restoreMessageSnapshot(leaf);
    else {
        workspaceStore.setState({ chatMetadata: undefined, nativePluginRoute: undefined });
        replaceScopedVariables(initialChatVariables(), 'chat', { chatId: workspaceStore.getState().activeChatId });
    }
    persistWorkspace();
    void tavernEventBus.emit('message_deleted', { messageId });
    void commandCompatibilityRuntime('event', ['message_deleted', deletedFloor]).catch(error => setStatusBanner(String(error)));
    schedulePreview();
}

export function swipeChatMessage(messageId: string, direction: 'prev' | 'next' | 'new_branch'): void {
    swipeBranchMessage(messageId, direction, editHelperChatMessage);
}

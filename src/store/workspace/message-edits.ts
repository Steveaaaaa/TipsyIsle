import { batchReactiveUpdates } from '../reactive-store';
import { applyRegexScripts, orderedRegexScripts } from '../../pipeline/macro-regex-engine';
import _ from 'lodash';
import { getScopedVariables, readScopedVariables, replaceScopedVariables } from '../scoped-variable-store';
import { removeChatTreeNode, swipeId, storyRoutes } from '../chat-tree';
import { continueNativeRoute } from '../../plugins/native/route-graph';
import { tavernEventBus } from '../../sandbox/event-bus';
import { commandCompatibilityRuntime, resetCompatibilityBranch } from '../../compatibility/runtime-client';
import type { ChatMessageNode } from '../../types';
import { enqueuePersistentOperation, waitForReplicaCommit } from '../persistence';
import { hostHiddenKey, hostIllustrationKey, hostMessageHidden, messageExtra, patchHelperMessage, validateMessageRefresh, type HostIllustration } from '../../compatibility/chat-message-codec';
import { globalRegexes } from '../global-regex-store';
import { workspaceStore } from './state';
import { getActivePreset, getActiveCharacter } from './library';
import { schedulePreview } from './prompt';
import { commitWorkspaceMutation, persistWorkspace, persistWorkspaceNow } from './storage';
import { setStatusBanner } from './notice';
import { getActiveChatMessages, getEffectiveMvuSettings } from './queries';
import { initialChatVariables, mvuChatProjection } from './story-initialization';
import { readMvuCommands } from '../../pipeline/mvu-commands';
import { readMvuGreetingVariables } from '../../pipeline/initial-variables';
import { normalizeMvuVariables } from '../../pipeline/mvu-data';
import { isNativeStorySaving } from './activity';
import { sealBranchPoint, restoreMessageSnapshot, rememberBranch, publishBranchChange, captureMessageSnapshot, selectChatBranch, preserveReplyVersion, remapBranchSnapshots, swipeBranchMessage, settleRouteChange } from './branches';
import { saveHelperVariables } from './story-variables';
import { canAppendDuringGenerationPreparation, getGenerationNotificationMessage } from './generation';
import { notifyMessage } from './messages';
import { baibaiBody, baibaiHash, baibaiRouteFields, isBaibaiNoteEdit } from '../../compatibility/baibai-route';
import { remapRouteMessageData, routeContent, routeMessageDataKey, routeMessages, routeMessageKey, type RouteMessageData } from '../route-message-data';

type LegacyMessagePatch = { id: string; swipe: number; content: string; mes?: string; hidden?: boolean; extra?: Record<string, unknown>; swipeInfo?: Record<number, Record<string, unknown>>; topLevel?: Record<string, unknown>; variables?: Record<string, unknown> };

type LegacyMetadataPatch = { values: Record<string, unknown>; removed: string[] };

function textHasMvuSetup(text: string): boolean {
    if (!text) return false;
    try { return readMvuCommands(text).commands.length > 0 || !!readMvuGreetingVariables(text); }
    catch { return false; }
}

function shouldRestoreOpeningSwipeVariables(node: ChatMessageNode, targetSwipe: number, targetContent: string, currentVariables: Record<string, unknown>): boolean {
    if (targetSwipe === node.activeSwipeIndex) return false;
    if (textHasMvuSetup(targetContent)) return true;
    const snapshots = node.extra?.swipeVariables as Record<string, Record<string, unknown>> | undefined;
    const targetVariables = snapshots?.[targetSwipe];
    const originVariables = snapshots?.[node.activeSwipeIndex];
    if (!targetVariables || !Object.keys(targetVariables).length) return false;
    // If the user/script did not mutate the active opening swipe's variables since initialization,
    // or if the target swipe has its own distinct pre-settled snapshot, restore the target swipe's snapshot.
    if (originVariables && _.isEqual(currentVariables, originVariables)) return true;
    return originVariables ? !_.isEqual(targetVariables, originVariables) : false;
}

export function saveLegacyChat(rows: LegacyMessagePatch[], variables?: Record<string, unknown>, metadata: LegacyMetadataPatch = { values: {}, removed: [] }): boolean {
    const state = workspaceStore.getState();
    const path = new Map(getActiveChatMessages(state).map(node => [node.id, node]));
    const hidden = { ...state.chatMetadata?.[hostHiddenKey] as Record<string, boolean> | undefined };
    let hiddenChanged = false;
    const edits = new Map<string, { swipe: number; mes?: string; extra?: Record<string, unknown>; swipeInfo?: Record<number, Record<string, unknown>>; topLevel?: Record<string, unknown> }>();
    const routeEdits = new Map<string, RouteMessageData>();
    const writes: Array<{ floor: number; value: Record<string, unknown> }> = [];
    for (const message of rows) {
        const node = path.get(message.id);
        const visible = node && routeContent(node, state.chatMetadata);
        if (!node || message.swipe !== node.activeSwipeIndex) throw new Error('插件保存的消息已改变，请重试');
        if (message.mes !== undefined && message.mes !== visible && message.content !== visible) throw new Error('插件保存的消息已改变，请重试');
        if (message.mes !== undefined && node.extra?.tipsy_generation_incomplete) throw new Error('不能保存尚在生成的消息正文');
        const key = routeMessageKey(node);
        const prior = routeMessages(state.chatMetadata)?.[key];
        const scoped = { ...prior };
        let extra: Record<string, unknown> | undefined;
        let mes = message.mes;
        if (message.extra) {
            const baseline = messageExtra(node, node.activeSwipeIndex, state.chatMetadata);
            const fields = (value: Record<string, unknown>) => Object.fromEntries(baibaiRouteFields.filter(k => Object.hasOwn(value, k)).map(k => [k, value[k]]));
            if (!_.isEqual(fields(baseline), fields(message.extra))) scoped.extra = fields(message.extra);
            if (!_.isEqual(baseline.bbs_leaf, message.extra.bbs_leaf)) scoped.memoryBody = message.extra.bbs_leaf ? baibaiHash(baibaiBody(mes ?? visible!)) : undefined;
            const shared = messageExtra(node);
            extra = { ...message.extra };
            for (const k of baibaiRouteFields) {
                if (Object.hasOwn(shared, k)) extra[k] = shared[k]; else delete extra[k];
            }
            if (_.isEqual(extra, shared)) extra = undefined;
        }
        const swipeInfoUpdates: Record<number, Record<string, unknown>> = {};
        if (message.swipeInfo) {
            for (const [rawIndex, infoExtra] of Object.entries(message.swipeInfo)) {
                const swipeIndex = Number(rawIndex);
                if (!Number.isInteger(swipeIndex) || swipeIndex < 0 || !infoExtra || typeof infoExtra !== 'object') continue;
                const baselineSwipe = messageExtra(node, swipeIndex, state.chatMetadata);
                const cleaned = { ...infoExtra };
                for (const k of baibaiRouteFields) {
                    if (Object.hasOwn(baselineSwipe, k)) cleaned[k] = baselineSwipe[k]; else delete cleaned[k];
                }
                if (!_.isEqual(cleaned, baselineSwipe)) swipeInfoUpdates[swipeIndex] = cleaned;
            }
        }
        const currentTopLevel = (node.extra?.helperTopLevel as Record<string, unknown> | undefined) ?? {};
        const topLevel = message.topLevel && !_.isEqual(message.topLevel, currentTopLevel) ? structuredClone(message.topLevel) : undefined;
        if (mes !== undefined && isBaibaiNoteEdit(visible!, mes)) {
            scoped.content = { base: node.content, value: mes };
            mes = undefined;
        }
        if (!_.isEqual(scoped, prior ?? {})) routeEdits.set(key, scoped);
        if (mes !== undefined || extra || Object.keys(swipeInfoUpdates).length || topLevel) {
            edits.set(node.id, {
                swipe: node.activeSwipeIndex,
                mes,
                extra,
                ...(Object.keys(swipeInfoUpdates).length ? { swipeInfo: swipeInfoUpdates } : {}),
                ...(topLevel ? { topLevel } : {}),
            });
        }
        if (message.variables && !_.isEqual(message.variables, readScopedVariables('message', { messageId: node.id }))) writes.push({ floor: node.floor, value: message.variables });
        if (message.hidden !== undefined && message.hidden !== hostMessageHidden(node, state.chatMetadata) && !node.isHidden) {
            if (message.hidden) hidden[swipeId(node)] = true; else delete hidden[swipeId(node)];
            hiddenChanged = true;
        }
    }
    const next = { ...state.chatMetadata, ...metadata.values, ...(hiddenChanged ? { [hostHiddenKey]: hidden } : {}) };
    delete next[routeMessageDataKey];
    const previousRoute = routeMessages(state.chatMetadata);
    if (routeEdits.size) next[routeMessageDataKey] = { ...previousRoute, ...Object.fromEntries(routeEdits) };
    else if (previousRoute) next[routeMessageDataKey] = previousRoute;
    for (const key of metadata.removed) if (key !== routeMessageDataKey) delete next[key];
    const metadataChanged = !_.isEqual(next, state.chatMetadata ?? {});
    const variablesChanged = !!variables && !_.isEqual(variables, readScopedVariables('chat', { chatId: state.activeChatId }));
    if (!edits.size && !metadataChanged && !variablesChanged && !writes.length) return false;
    batchReactiveUpdates(() => {
        if (edits.size) workspaceStore.setState(draft => {
            for (const node of draft.messages) {
                const patch = edits.get(node.id);
                if (!patch) continue;
                if (patch.extra || patch.swipeInfo || patch.topLevel) {
                    node.extra = {
                        ...node.extra,
                        ...(patch.extra || patch.swipeInfo ? {
                            helperSwipeInfo: {
                                ...node.extra?.helperSwipeInfo as object,
                                ...patch.swipeInfo,
                                ...(patch.extra ? { [patch.swipe]: patch.extra } : {}),
                            },
                        } : {}),
                        ...(patch.topLevel ? { helperTopLevel: patch.topLevel } : {}),
                    };
                }
                const key = swipeId(node, patch.swipe);
                if (patch.mes !== undefined) {
                    const previous = node.swipes[patch.swipe];
                    const oldText = typeof previous === 'object' ? previous.content : previous;
                    node.swipes[patch.swipe] = typeof previous === 'object' ? { ...previous, content: patch.mes } : patch.mes;
                    if (node.activeSwipeIndex === patch.swipe) node.content = patch.mes;
                    node.updatedAt = Date.now();
                    delete node.storySummaries?.[key];
                    if (node.floor === 0 && path.size === 1 && patch.mes !== oldText && textHasMvuSetup(patch.mes)) {
                        node.extra = { ...node.extra, tipsy_mvu_initialization_pending: true };
                    }
                }
                // Keep saved choices pointing at the edited text without rolling back their variables.
                for (const point of [node.branchBases?.[key], node.branchStates?.[key]]) if (point?.reply) {
                    if (patch.mes !== undefined) {
                        point.reply.content = patch.mes;
                        const original = point.reply.swipe;
                        point.reply.swipe = typeof original === 'object' ? { ...original, content: patch.mes } : patch.mes;
                    }
                    const branchExtra = patch.extra ?? patch.swipeInfo?.[patch.swipe];
                    if (branchExtra || patch.topLevel) {
                        point.reply.extra = {
                            ...point.reply.extra,
                            ...(branchExtra ? { helperSwipeInfo: { ...point.reply.extra?.helperSwipeInfo as object, [patch.swipe]: branchExtra } } : {}),
                            ...(patch.topLevel ? { helperTopLevel: patch.topLevel } : {}),
                        };
                    }
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

export async function editHelperChatMessage(floor: number | string | undefined, content: string | { message?: string; data?: Record<string, unknown> }, options: { swipe_id?: number | 'current'; data?: Record<string, unknown>; refresh?: 'none' | 'affected' | 'all' | 'display_and_render_current' } = {}): Promise<boolean> {
    const path = getActiveChatMessages();
    const resolvedFloor = floor === undefined ? -1 : floor;
    const node = path.find(m => m.id === resolvedFloor) ?? path.at(Number(resolvedFloor));
    if (!node) throw new Error('消息楼层不存在');
    const duringNotification = workspaceStore.getState().isGenerating && getGenerationNotificationMessage() === node.id;
    if (workspaceStore.getState().isGenerating && !duringNotification) throw new Error('生成期间不能修改消息');
    const swipe = options.swipe_id === undefined || options.swipe_id === 'current' ? node.activeSwipeIndex : Number(options.swipe_id);
    if (swipe !== node.activeSwipeIndex && isNativeStorySaving()) throw new Error('正在保存插件数据，请稍后切换路线');
    if (!Number.isInteger(swipe) || swipe < 0 || swipe > 16384) throw new Error('消息分支不存在');
    if (duringNotification && swipe !== node.activeSwipeIndex) throw new Error('生成事件中不能切换消息分支');
    const fieldValues = typeof content === 'object' && content !== null ? content : { message: content, data: options.data };
    const existingSwipe = node.swipes[swipe];
    const existingText = existingSwipe === undefined ? '' : typeof existingSwipe === 'string' ? existingSwipe : existingSwipe.content;
    const nextContent = fieldValues.message !== undefined ? String(fieldValues.message) : existingText;
    const nextData = fieldValues.data ?? options.data;
    if (node.floor > 0 && !duringNotification && swipe !== node.activeSwipeIndex && swipe < node.swipes.length) {
        const routes = storyRoutes(workspaceStore.getState().messages).filter(route => route.path.some(item => item.id === node.id && item.activeSwipeIndex === swipe));
        if (routes.length > 1) throw new Error('这个回复有多条后续，请从故事路线选择要继续的一条');
        if (routes.length === 1) {
            const current = node.swipes[swipe];
            if ((typeof current === 'string' ? current : current.content) === nextContent && nextData === undefined) { await selectChatBranch(routes[0].key, true); return true; }
        }
    }
    if (!duringNotification && (swipe !== node.activeSwipeIndex || node.floor > 0 && node.id !== workspaceStore.getState().activeLeafId && nextContent !== node.content)) await settleRouteChange(true);
    const liveVariables = getScopedVariables('message', { messageId: node.id });
    const restoreOpeningSwipe = node.floor === 0 && nextData === undefined && shouldRestoreOpeningSwipeVariables(node, swipe, nextContent, liveVariables);
    const needsOpeningMvuInit = node.floor === 0 && path.length === 1 && nextContent !== existingText && textHasMvuSetup(nextContent);
    captureMessageSnapshot(node.id);
    const forksHistory = node.floor > 0 && !duringNotification && nextContent !== node.content && node.id !== workspaceStore.getState().activeLeafId;
    if (forksHistory) preserveReplyVersion(workspaceStore.getState().messages.find(item => item.id === node.id)!);
    workspaceStore.setState(draft => {
        const target = draft.messages.find(m => m.id === node.id)!;
        target.swipes = [...target.swipes];
        while (target.swipes.length <= swipe) target.swipes.push('');
        const previous = target.swipes[swipe];
        target.swipes[swipe] = typeof previous === 'string' || previous === undefined ? nextContent : { ...previous, content: nextContent };
        target.activeSwipeIndex = swipe; target.content = nextContent; target.updatedAt = Date.now();
        if (needsOpeningMvuInit) target.extra = { ...target.extra, tipsy_mvu_initialization_pending: true };
        if (target.floor === 0 && draft.activeLeafId === target.id && swipe !== node.activeSwipeIndex) draft.nativePluginRoute = node.nativePluginOpeningRoutes?.[swipeId(node, swipe)];
        if (swipe !== node.activeSwipeIndex) target.reasoning = typeof previous === 'string' || previous === undefined ? '' : previous.reasoning ?? '';
        if (forksHistory) {
            target.branchBases = undefined; target.branchStates = undefined;
            draft.activeLeafId = target.id;
        }
    });
    if (nextData !== undefined) {
        const normalized = normalizeMvuVariables(structuredClone(nextData)).variables;
        saveHelperVariables(normalized, { type: 'message', message_id: node.floor });
        captureMessageSnapshot(node.id);
    } else if (node.floor > 0 && (forksHistory || swipe !== node.activeSwipeIndex) || restoreOpeningSwipe) {
        restoreMessageSnapshot(node.id);
    } else {
        captureMessageSnapshot(node.id);
    }
    if (forksHistory) { sealBranchPoint(true); publishBranchChange(false); }
    persistWorkspace();
    if (!duringNotification) {
        if (options.refresh !== 'none') schedulePreview();
        if (options.refresh === 'all') void commandCompatibilityRuntime('event', ['chat_changed', workspaceStore.getState().activeChatId]).catch(error => setStatusBanner(String(error)));
        else if (options.refresh !== 'none') notifyMessage('message_edited', { ...node, activeSwipeIndex: swipe, content: nextContent });
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
        const restoreOpeningSwipe = node.floor === 0 && item.data === undefined && item.swipes_data === undefined
            && shouldRestoreOpeningSwipeVariables(node, plan.node.activeSwipeIndex, plan.node.content, variables);
        if (node.floor === 0 && item.data === undefined && item.swipes_data === undefined && !restoreOpeningSwipe) {
            // Changing the opening display does not roll back the author's live setup.
            plan.variables = variables;
            (plan.node.extra!.swipeVariables as Record<string, Record<string, unknown>>)[plan.node.activeSwipeIndex] = variables;
        }
        if (node.floor === 0 && path.length === 1 && (item.message !== undefined || item.swipes !== undefined)
            && plan.node.content !== node.content && textHasMvuSetup(plan.node.content)) {
            plan.node.extra = { ...plan.node.extra, tipsy_mvu_initialization_pending: true };
        }
        if (state.isGenerating && (getGenerationNotificationMessage() !== node.id || plan.node.activeSwipeIndex !== node.activeSwipeIndex
            || ['swipes', 'swipes_data', 'swipes_info', 'role', 'is_hidden'].some(key => item[key] !== undefined))) {
            throw new Error('生成期间不能修改其他消息或改变分支结构');
        }
        return { ...plan, restoreOpeningSwipe };
    });
    if (!plans.length) return [];
    const changesChoice = plans.find(plan => plan.node.activeSwipeIndex !== path.find(node => node.id === plan.node.id)!.activeSwipeIndex);
    if (changesChoice && changesChoice.node.floor > 0 && plans.length === 1 && Object.keys(merged.get(changesChoice.node.id)!.item).every(key => ['message_id', 'swipe_id'].includes(key))) {
        const routes = storyRoutes(state.messages).filter(route => route.path.some(node => node.id === changesChoice.node.id && node.activeSwipeIndex === changesChoice.node.activeSwipeIndex));
        if (routes.length !== 1) throw new Error('这个回复有多条后续，请从故事路线选择');
        await selectChatBranch(routes[0].key, true); return [{ message_id: changesChoice.node.floor, role: changesChoice.node.role }];
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
            if ((plan.node.floor > 0 || plan.restoreOpeningSwipe) && plan.node.activeSwipeIndex !== path.at(-1)!.activeSwipeIndex) restoreMessageSnapshot(plan.node.id);
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
async function publishHelperPath(next: ChatMessageNode[], from: number, newVariables = new Map<string, Record<string, unknown>>(), allowDuringPreparation = false): Promise<ChatMessageNode[]> {
    const state = workspaceStore.getState();
    const preparedAppend = allowDuringPreparation && canAppendDuringGenerationPreparation() && from === getActiveChatMessages(state).length;
    if (isNativeStorySaving() || state.isGenerating && !preparedAppend || state.helperGenerationCount) throw new Error('请等待剧情保存或生成结束后更改消息结构');
    const structuralChange = from < getActiveChatMessages(state).length;
    if (structuralChange && !state.isGenerating) await settleRouteChange(true);
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
        if (leaf) {
            restoreMessageSnapshot(leaf.id);
            if (structuralChange) workspaceStore.setState({ chatMetadata: remapRouteMessageData(latest.chatMetadata, remapped) });
        }
        else {
            replaceScopedVariables(initialChatVariables(), 'chat', { chatId: state.activeChatId });
            workspaceStore.setState({ timedStates: {}, chatMetadata: undefined, nativePluginRoute: undefined, templateInjections: [], templateActivations: [] });
        }
        sealBranchPoint();
    });
    await persistWorkspaceNow();
    if (!state.isGenerating) schedulePreview();
    return active;
}

export async function createHelperChatMessages(items: Array<Record<string, any>>, options: { insert_at?: number | 'end'; insert_before?: number | 'end'; refresh?: 'none' | 'affected' | 'all' } = {}, allowDuringPreparation = false): Promise<Array<{ message_id: number; role: ChatMessageNode['role'] }>> {
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
    const active = await publishHelperPath([...path.slice(0, index), ...created, ...path.slice(index)], index, variables, allowDuringPreparation);
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

export async function editChatMessage(messageId: string, newContent: string): Promise<boolean> {
    if (isNativeStorySaving() || workspaceStore.getState().isGenerating) return false;
    await settleRouteChange(true);
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

/**
 * Edit an existing message's active content in place without truncating subsequent floors
 * or triggering a full compatibility branch reset.
 */
export async function editMessageInPlace(messageId: string, newContent: string): Promise<boolean> {
    if (isNativeStorySaving() || workspaceStore.getState().isGenerating) {
        throw new Error('生成或保存期间不能修改消息');
    }
    const visible = getActiveChatMessages();
    const resolvedId = visible.find(node => node.id === messageId)?.id ?? visible.find(node => String(node.floor) === String(messageId))?.id;
    const source = visible.find(node => node.id === resolvedId);
    if (!source) return false;
    if (source.extra?.tipsy_generation_incomplete) {
        throw new Error('不能修改尚在生成的消息');
    }
    if (source.content === newContent) return true;
    if (workspaceStore.getState().sessionKind !== 'free') await settleRouteChange(true);
    let updated = false;
    workspaceStore.setState((draft) => {
        const target = draft.messages.find((m) => m.id === source.id);
        if (!target) return;
        const finalContent = draft.sessionKind !== 'free'
            ? applyRegexScripts(newContent, orderedRegexScripts(globalRegexes(), getActivePreset().regexScripts, getActiveCharacter().regexScripts), {
                stage: target.role === 'user' ? 'user_input' : 'ai_output',
                role: target.role,
                isEdit: true,
                macroContext: { userName: draft.userName, charName: getActiveCharacter().name },
            })
            : newContent;
        const key = swipeId(target);
        target.content = finalContent;
        const swipe = target.swipes[target.activeSwipeIndex];
        target.swipes[target.activeSwipeIndex] = typeof swipe === 'string' || swipe === undefined
            ? finalContent
            : { ...swipe, content: finalContent };
        target.updatedAt = Date.now();
        delete target.storySummaries?.[key];
        if (target.floor === 0 && visible.length === 1 && finalContent !== source.content && textHasMvuSetup(finalContent)) {
            target.extra = { ...target.extra, tipsy_mvu_initialization_pending: true };
        }
        for (const point of [target.branchBases?.[key], target.branchStates?.[key]]) {
            if (!point?.reply) continue;
            point.reply.content = finalContent;
            const original = point.reply.swipe;
            point.reply.swipe = typeof original === 'string' || original === undefined
                ? finalContent
                : { ...original, content: finalContent };
        }
        updated = true;
    });
    if (!updated) return false;
    const latestState = workspaceStore.getState();
    if (latestState.sessionKind !== 'free' && latestState.activeLeafId) {
        captureMessageSnapshot(latestState.activeLeafId);
    }
    persistWorkspace();
    schedulePreview();
    const updatedNode = getActiveChatMessages().find(m => m.id === source.id);
    if (updatedNode) notifyMessage('message_edited', updatedNode);
    return true;
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

export async function deleteChatMessage(messageId: string, internal = false): Promise<void> {
    await waitForReplicaCommit();
    await settleRouteChange(internal);
    const before = workspaceStore.getState();
    let deletedFloor: number | undefined;
    await enqueuePersistentOperation(() => commitWorkspaceMutation(() => {
        const state = workspaceStore.getState();
        if (state.activeChatId !== before.activeChatId || state.branchEpoch !== before.branchEpoch || state.isGenerating || isNativeStorySaving()) {
            throw new Error('剧情状态已变化，请重新操作');
        }
        const target = getActiveChatMessages(state).find(node => node.id === messageId);
        if (!target) return;
        deletedFloor = target.floor;
        const messages = removeChatTreeNode(state.messages, target);
        const leaf = state.activeLeafId === messageId ? target.parentId ?? messages.at(-1)?.id ?? null : state.activeLeafId;
        workspaceStore.setState({ messages, activeLeafId: leaf, deletedMessageIds: [...new Set([...(state.deletedMessageIds ?? []), messageId])] });
        if (state.sessionKind === 'free') return;
        if (leaf) {
            restoreMessageSnapshot(leaf);
            workspaceStore.setState({ chatMetadata: remapRouteMessageData(state.chatMetadata, new Map(getActiveChatMessages().map(node => [node.id, node.id])), undefined, false) });
            captureMessageSnapshot(leaf);
        } else {
            workspaceStore.setState({ chatMetadata: undefined, nativePluginRoute: undefined });
            replaceScopedVariables(initialChatVariables(), 'chat', { chatId: state.activeChatId });
        }
    }));
    if (deletedFloor === undefined || before.sessionKind === 'free') return;
    void tavernEventBus.emit('message_deleted', { messageId });
    if (!internal) {
        try { await commandCompatibilityRuntime('event', ['message_deleted', deletedFloor]); }
        catch (error) { setStatusBanner(String(error)); }
    }
    const current = workspaceStore.getState();
    if (current.activeChatId !== before.activeChatId || current.branchEpoch !== before.branchEpoch) return;
    workspaceStore.setState({ branchEpoch: (current.branchEpoch ?? 0) + 1 });
    persistWorkspace();
    if (!internal) resetCompatibilityBranch();
    schedulePreview();
}

export function swipeChatMessage(messageId: string, direction: 'prev' | 'next' | 'new_branch', internal = false): Promise<void> {
    return swipeBranchMessage(messageId, direction, editHelperChatMessage, internal);
}

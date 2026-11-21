import type { ArchivedChat } from '../chat-archives';
import { batchReactiveUpdates } from '../reactive-store';
import _ from 'lodash';
import { getSchemaValues, schemaRegistryStore } from '../../registry/schema-registry';
import { scopedVariableStore, getScopedVariables, readScopedVariables, replaceScopedVariables } from '../scoped-variable-store';
import { activePath, swipeId, routeKey, storyRoutes, withSwipe } from '../chat-tree';
import { branchMessageVariable, branchMessageVariables, captureVariablePages, createBranchVariableRemapper, type BranchState } from '../branch-state';
import { compatibilityComposer } from '../../compatibility/composer-bridge';
import { routeGraph, routeRootId } from '../../plugins/native/route-graph';
import { resetCompatibilityBranch, saveCompatibilityBeforeRouteChange } from '../../compatibility/runtime-client';
import type { ChatMessageNode, LorebookTimedState } from '../../types';
import type { TemplatePromptInjection } from '../../pipeline/template-injections';
import { workspaceStore, type WorkspaceState } from './state';
import { getActivePreset, getActiveLorebooks, getCharacterWorldbooks, getActiveCharacter, getActivePersona } from './library';
import { schedulePreview, invalidateTemplateEnvironment } from './prompt';
import { persistWorkspace } from './storage';
import { setStatusBanner } from './notice';
import { getActiveChatMessages } from './queries';
import { readWorkspaceInitialVariables, initialChatVariables, mvuChatProjection } from './story-initialization';
import { routePluginBucketsAt, routeWorldbooks } from './route-resources';
import { SYNC_EXTENSIONS, syncStorySetting, restoreChatExtensions } from './sessions';
import { branchBusy } from './activity';

/** Capture each swipe's variables, chat projection and lorebook timers as one logical snapshot. */
export function updateWorldbookTimedEffects(timedStates: WorkspaceState['timedStates'], leafId: string | null): void {
    workspaceStore.setState({ timedStates });
    if (leafId) captureMessageSnapshot(leafId);
}

export function captureMessageSnapshot(id: string): void {
    const state = workspaceStore.getState();
    if (state.sessionKind === 'free') return;
    const node = state.messages.find(message => message.id === id);
    if (!node) return;
    const variables = readScopedVariables('message', { messageId: id });
    const current = id === getActiveChatMessages(state).at(-1)?.id;
    const chatVariables = current ? readScopedVariables('chat', { chatId: state.activeChatId }) : node.extra?.chatVariables ?? {};
    const timedStates = current ? state.timedStates : node.extra?.timedStates ?? {};
    const templateState = current ? { injections: state.templateInjections, activations: state.templateActivations }
        : node.extra?.templateState ?? { injections: [], activations: [] };
    const checkpoint = current && node.floor > 0 ? readBranchState(state, node) : undefined;
    workspaceStore.setState(draft => {
        const target = draft.messages.find(message => message.id === id)!;
        target.swipeIds ??= target.swipes.map((_, index) => swipeId(target, index));
        if (checkpoint) (target.branchStates ??= {})[swipeId(target)] = checkpoint;
        if (current && node.floor === 0 && state.nativePluginRoute) (target.nativePluginOpeningRoutes ??= {})[swipeId(target)] = state.nativePluginRoute;
        target.extra = { ...target.extra, chatVariables, timedStates, templateState,
            ...(current && node.floor === 0 && (state.chatMetadata || target.extra?.swipeHostMetadata) ? {
                swipeHostMetadata: { ...(target.extra?.swipeHostMetadata as object ?? {}), [target.activeSwipeIndex]: state.chatMetadata },
            } : {}),
            swipeVariables: { ...(target.extra?.swipeVariables as object ?? {}), [target.activeSwipeIndex]: variables },
            swipeChatVariables: { ...(target.extra?.swipeChatVariables as object ?? {}), [target.activeSwipeIndex]: chatVariables },
            swipeTimedStates: { ...(target.extra?.swipeTimedStates as object ?? {}), [target.activeSwipeIndex]: timedStates },
            swipeTemplateStates: { ...(target.extra?.swipeTemplateStates as object ?? {}), [target.activeSwipeIndex]: templateState } };
    });
}

export function restoreMessageSnapshot(id: string): void {
    const state = workspaceStore.getState();
    if (state.sessionKind === 'free') return;
    const node = state.messages.find(message => message.id === id);
    if (!node) return;
    const swipe = node.activeSwipeIndex;
    const checkpoint = node.floor > 0 ? node.branchStates?.[swipeId(node)] : undefined;
    if (checkpoint && state.activeLeafId === id) { applyBranchState(checkpoint); return; }
    const extra = node.extra ?? {};
    const snapshots = extra.swipeVariables as Record<string, Record<string, unknown>> | undefined;
    const parent = state.messages.find(message => message.id === node.parentId);
    const variables = snapshots?.[swipe] ?? (swipe === 0 ? getScopedVariables('message', { messageId: node.id }) :
        parent ? getScopedVariables('message', { messageId: parent.id }) : readWorkspaceInitialVariables(state));
    replaceScopedVariables(structuredClone(variables), 'message', { messageId: node.id });
    if (node.id !== getActiveChatMessages(state).at(-1)?.id) return;
    const chatSnapshots = extra.swipeChatVariables as Record<string, Record<string, unknown>> | undefined;
    const timerSnapshots = extra.swipeTimedStates as Record<string, Record<string, LorebookTimedState>> | undefined;
    const chat = chatSnapshots?.[swipe] ?? (snapshots?.[swipe] || swipe === 0 ? extra.chatVariables : parent?.extra?.chatVariables ?? initialChatVariables(state)) ?? {};
    const projection = chatSnapshots?.[swipe] ? {} : mvuChatProjection(variables);
    replaceScopedVariables(structuredClone({ ...chat as object, ...projection }), 'chat', { chatId: state.activeChatId });
    const timedStates = timerSnapshots?.[swipe] ?? (snapshots?.[swipe] || swipe === 0 ? extra.timedStates : parent?.extra?.timedStates) ?? {};
    const templateSnapshots = extra.swipeTemplateStates as Record<string, { injections: TemplatePromptInjection[]; activations: WorkspaceState['templateActivations'] }> | undefined;
    const templateState = templateSnapshots?.[swipe] ?? (swipe === 0 ? extra.templateState : parent?.extra?.templateState) as { injections: TemplatePromptInjection[]; activations: WorkspaceState['templateActivations'] } | undefined;
    const parentSwipe = parent && node.parentSwipeId ? parent.swipes.findIndex((_, index) => swipeId(parent, index) === node.parentSwipeId) : parent?.activeSwipeIndex;
    const hostMetadata = (extra.swipeHostMetadata as Record<number, Record<string, unknown>> | undefined)?.[swipe];
    const parentMetadata = node.floor > 0 && parent && parentSwipe !== undefined && parentSwipe >= 0
        ? parent.branchStates?.[swipeId(parent, parentSwipe)]?.continuation.chatMetadata
            ?? (parent.extra?.swipeHostMetadata as Record<number, Record<string, unknown>> | undefined)?.[parentSwipe] : undefined;
    workspaceStore.setState(draft => {
        draft.timedStates = structuredClone(timedStates) as Record<string, LorebookTimedState>;
        draft.chatMetadata = hostMetadata ?? parentMetadata;
        draft.nativePluginRoute = routePluginBucketsAt(getActiveChatMessages(state));
        draft.templateInjections = structuredClone(templateState?.injections ?? []);
        draft.templateActivations = structuredClone(templateState?.activations ?? []);
    });
}

export function readBranchState(state: WorkspaceState, node: ChatMessageNode): BranchState {
    const variables = scopedVariableStore.getState();
    const path = getActiveChatMessages(state);
    const parent = path.at(-2);
    const previous = node.branchStates?.[swipeId(node)] ?? (parent && parent.branchStates?.[swipeId(parent)]);
    const messageVariablePages = captureVariablePages(path, variables.message, previous);
    const continuation: NonNullable<ArchivedChat['continuation']> = {
        portable: state.portableStory,
        chatMetadata: state.chatMetadata,
        nativePluginRoute: state.nativePluginRoute,
        variables: { global: variables.global, character: { [state.activeCharacterId]: readScopedVariables('character', { characterId: state.activeCharacterId }) },
            preset: { [state.activePresetId]: readScopedVariables('preset', { presetId: state.activePresetId }) },
            chat: { [state.activeChatId]: variables.chat[state.activeChatId] ?? {} },
            message: {} },
        extensions: Object.fromEntries([...new Set([...SYNC_EXTENSIONS, ...state.branchExtensionKeys ?? []])].filter(key => key in variables.extension).map(key => [key, variables.extension[key]])),
        extensionKeys: state.branchExtensionKeys,
        activePresetId: state.activePresetId, inUsePreset: getActivePreset(state), activeLorebookIds: state.activeLorebookIds,
        userName: state.userName, activePersonaId: state.activePersonaId,
        settings: Object.fromEntries(Object.entries(getSchemaValues()).filter(([key]) => syncStorySetting(key))),
        worldbooks: getActiveLorebooks(state), characterBinding: getCharacterWorldbooks(getActiveCharacter(state), state),
        character: getActiveCharacter(state), persona: getActivePersona(state) };
    return { continuation, messageVariablePages, reply: { content: node.content, reasoning: node.reasoning, swipe: node.swipes[node.activeSwipeIndex], extra: node.extra },
        worldbookName: state.chatWorldbookBindings[state.activeChatId] ?? null, timedStates: state.timedStates, templateInjections: state.templateInjections, templateActivations: state.templateActivations };
}

export function applyBranchState(checkpoint: BranchState, keepLibraryBooks = false): void {
    const c = checkpoint.continuation;
    const currentMessageVariables = scopedVariableStore.getState().message;
    const current = workspaceStore.getState();
    const currentSettings = structuredClone(getSchemaValues());
    const currentPresetId = current.activePresetId;
    const currentPreset = current.inUsePreset ? structuredClone(current.inUsePreset) : undefined;
    const currentLorebooks = [...current.activeLorebookIds];
    const currentChatWorldbook = current.chatWorldbookBindings[current.activeChatId] ?? null;
    const currentBinding = current.storyCharacterBinding ? structuredClone(current.storyCharacterBinding) : undefined;
    batchReactiveUpdates(() => {
    scopedVariableStore.setState(draft => {
        if (!c.portable) draft.global = c.variables.global;
        for (const scope of ['character', 'preset', 'chat'] as const) Object.assign(draft[scope], c.variables[scope]);
        for (const [id, value] of Object.entries(branchMessageVariables(checkpoint))) if (currentMessageVariables[id] !== value) draft.message[id] = value;
        restoreChatExtensions(draft.extension, c, current.activeChatId, current.branchExtensionKeys);
    });
    // A route checkpoint restores story state, but it must not undo a user's
    // current runtime choices made after that checkpoint was created.
    schemaRegistryStore.setState(draft => { Object.assign(draft.values, currentSettings); });
    workspaceStore.setState({ timedStates: structuredClone(checkpoint.timedStates),
        chatMetadata: c.chatMetadata,
        nativePluginRoute: c.nativePluginRoute,
        templateInjections: structuredClone(checkpoint.templateInjections), templateActivations: structuredClone(checkpoint.templateActivations),
        activePresetId: currentPresetId, inUsePreset: currentPreset, activeLorebookIds: c.portable ? c.activeLorebookIds : currentLorebooks,
        storyCharacter: c.character, storyWorldbooks: keepLibraryBooks && !c.portable ? routeWorldbooks(c.worldbooks, current) : c.worldbooks,
        storyCharacterBinding: c.portable ? c.characterBinding : currentBinding ?? c.characterBinding, storyPersona: c.persona,
        activePersonaId: c.activePersonaId, userName: c.userName, branchExtensionKeys: c.extensionKeys ?? [], lastAssembledPrompt: null });
    workspaceStore.setState(draft => { draft.chatWorldbookBindings[draft.activeChatId] = c.portable ? checkpoint.worldbookName ?? null : currentChatWorldbook; });
    });
}

export function sealBranchPoint(replace = false): void {
    const state = workspaceStore.getState(), node = getActiveChatMessages(state).at(-1);
    if (state.sessionKind === 'free') return;
    if (!node || node.extra?.tipsy_generation_incomplete && !replace) return;
    captureMessageSnapshot(node.id);
    if (node.floor === 0) { persistWorkspace(); return; }
    workspaceStore.setState(draft => {
        const target = draft.messages.find(item => item.id === node.id)!;
        const key = swipeId(target);
        target.branchBases ??= {};
        if (replace || !target.branchBases[key]) target.branchBases[key] = target.branchStates![key];
    });
    persistWorkspace();
}

export function remapBranchSnapshots(node: ChatMessageNode, oldId: string | Map<string, string>): void {
    const ids = typeof oldId === 'string' ? new Map([[oldId, node.id]]) : oldId;
    const remap = createBranchVariableRemapper(ids);
    for (const field of ['branchBases', 'branchStates'] as const) if (node[field]) {
        node[field] = Object.fromEntries(Object.entries(node[field]!).map(([key, point]) => [key, remap(point)]));
    }
}

/** Preserve an existing candidate and its descendants before an in-place author edit. */
export function preserveReplyVersion(node: ChatMessageNode): void {
    const state = workspaceStore.getState();
    const hasChildren = state.messages.some(item => item.parentId === node.id);
    if (state.isGenerating || !node.branchBases?.[swipeId(node)] && !hasChildren) return;
    const graph = routeGraph(state.messages);
    const originalRoutes = Object.fromEntries(node.swipes.map((_, index) => [swipeId(node, index), graph.vertices.get(routeKey(node, index))?.routeId ?? routeRootId(node, index)]));
    const copy = structuredClone(node), id = `msg_${crypto.randomUUID()}`;
    copy.id = id; copy.messageId = id; copy.branchOrigin = node.branchOrigin ?? node.id;
    copy.branchLabel = node.branchLabel ?? '修改前的路线';
    copy.swipeIds ??= node.swipes.map((_, index) => swipeId(node, index));
    copy.nativeRouteAnchors = hasChildren ? originalRoutes : undefined;
    remapBranchSnapshots(copy, node.id);
    workspaceStore.setState(draft => {
        draft.messages.push(copy);
        const target = draft.messages.find(item => item.id === node.id)!;
        target.branchOrigin ??= node.id;
        target.nativeRouteAnchors = hasChildren ? Object.fromEntries(node.swipes.map((_, index) => [swipeId(node, index), `route:edit:${id}:${index}`])) : originalRoutes;
        const descendants = new Set([node.id]);
        for (let changed = true; changed;) {
            changed = false;
            for (const child of draft.messages) if (child.parentId && descendants.has(child.parentId) && !descendants.has(child.id)) { descendants.add(child.id); changed = true; }
        }
        for (const child of draft.messages) if (child.id !== node.id && descendants.has(child.id)) {
            if (child.parentId === node.id) child.parentId = id;
            remapBranchSnapshots(child, new Map([[node.id, id]]));
        }
    });
    scopedVariableStore.setState(draft => { draft.message[id] = draft.message[node.id] ?? {}; });
}

const branchDrafts = new Map<string, string>();

export function trackBranchExtension(id: string): void {
    const key = String(_.toPath(id)[0]);
    workspaceStore.setState(draft => { if (!draft.branchExtensionKeys?.includes(key)) (draft.branchExtensionKeys ??= []).push(key); });
}

export function rememberBranch(): void {
    const state = workspaceStore.getState(), leaf = getActiveChatMessages(state).at(-1);
    if (!leaf) return;
    captureMessageSnapshot(leaf.id);
    if (state.sessionKind !== 'free') branchDrafts.set(`${state.activeChatId}:${routeKey(leaf)}`, compatibilityComposer());
}

export function publishBranchChange(restartRuntime = true): void {
    const state = workspaceStore.getState(), leaf = getActiveChatMessages(state).at(-1);
    workspaceStore.setState({ branchEpoch: (state.branchEpoch ?? 0) + 1 });
    if (state.sessionKind !== 'free') compatibilityComposer(leaf ? branchDrafts.get(`${state.activeChatId}:${routeKey(leaf)}`) ?? '' : '');
    persistWorkspace();
    if (restartRuntime && state.sessionKind !== 'free') resetCompatibilityBranch();
    window.dispatchEvent(new Event('tipsy-branch-changed'));
    schedulePreview();
}

export function activateBranch(id: string, index: number, keepLibraryBooks = false): void {
    workspaceStore.setState(draft => {
        const target = draft.messages.find(node => node.id === id)!;
        Object.assign(target, withSwipe(target, index));
        const path = activePath(draft.messages, id);
        for (const item of path) {
            const stored = draft.messages.find(node => node.id === item.id)!;
            Object.assign(stored, withSwipe(stored, item.activeSwipeIndex));
        }
        draft.activeLeafId = id;
    });
    if (workspaceStore.getState().sessionKind === 'free') return;
    const path = getActiveChatMessages();
    const leaf = path.at(-1);
    const checkpoint = leaf?.branchStates?.[swipeId(leaf)];
    if (checkpoint) {
        // A route checkpoint already includes the whole path. Replaying per-floor
        // variable writes would run author listeners against intermediate states.
        applyBranchState(checkpoint, keepLibraryBooks);
    } else {
        for (const node of path) restoreMessageSnapshot(node.id);
    }
}

export async function retryStoryFrom(id: string, index?: number, internal = false): Promise<void> {
    const state = workspaceStore.getState();
    const path = activePath(state.messages, id);
    const source = [...path].reverse().find(node => node.role === 'assistant');
    if (!source || source.floor === 0 && state.sessionKind !== 'free') throw new Error('这一条消息不能用来创建分支');
    if (branchBusy(internal)) throw new Error('请等待本轮生成和变量结算结束后重新选择');
    const selected = source.id === id ? index ?? source.activeSwipeIndex : source.activeSwipeIndex;
    if (state.sessionKind === 'free') {
        const id = `msg_${crypto.randomUUID()}`;
        const copy = withSwipe(source, selected);
        const fork = { ...copy, id, messageId: id, branchOrigin: source.branchOrigin ?? source.id,
            activeSwipeIndex: 0, swipes: [copy.swipes[selected]], swipeIds: undefined, nativeRouteAnchors: undefined,
            branchLabel: '新分支', extra: undefined, createdAt: Date.now(), updatedAt: Date.now() };
        workspaceStore.setState(draft => { draft.messages.push(fork); draft.activeLeafId = id; });
        publishBranchChange(false);
        return;
    }
    await settleRouteChange(internal);
    const checkpoint = workspaceStore.getState().messages.find(node => node.id === source.id)?.branchBases?.[swipeId(source, selected)];
    if (!checkpoint?.reply) throw new Error('这段剧情没有完整的选择前快照，暂不能从这里重新选择');
    rememberBranch();
    invalidateTemplateEnvironment();
    batchReactiveUpdates(() => {
        const copy = { ...withSwipe(source, selected) }, nextId = `msg_${crypto.randomUUID()}`;
        const selectedKey = swipeId(source, selected);
        copy.id = nextId; copy.messageId = nextId; copy.branchOrigin = source.branchOrigin ?? source.id;
        copy.nativeRouteAnchors = { [selectedKey]: `route:fork:${nextId}` };
        copy.branchLabel = '重新选择'; copy.createdAt = Date.now(); copy.updatedAt = Date.now();
        if (checkpoint.reply) {
            copy.content = checkpoint.reply.content; copy.reasoning = checkpoint.reply.reasoning;
            copy.extra = structuredClone(checkpoint.reply.extra);
        }
        copy.swipes = [structuredClone(checkpoint.reply?.swipe ?? copy.swipes[selected])]; copy.swipeIds = [selectedKey]; copy.activeSwipeIndex = 0;
        const replies = source.nativePluginReplies?.[selectedKey];
        copy.nativePluginReplies = replies ? { [selectedKey]: replies } : undefined;
        for (const key of ['swipeVariables', 'swipeChatVariables', 'swipeTimedStates', 'swipeTemplateStates', 'helperSwipeInfo', 'tipsy_template_source', 'tipsy_template_render', 'tipsy_template_variables_initialized']) {
            const table = copy.extra?.[key] as Record<string, unknown> | undefined;
            if (table) copy.extra![key] = { 0: table[selected] };
        }
        copy.extra = { ...copy.extra, swipeVariables: { 0: branchMessageVariable(checkpoint, source.id) ?? {} },
            swipeChatVariables: { 0: structuredClone(checkpoint.continuation.variables.chat[workspaceStore.getState().activeChatId] ?? {}) },
            swipeTimedStates: { 0: structuredClone(checkpoint.timedStates) },
            swipeTemplateStates: { 0: { injections: structuredClone(checkpoint.templateInjections), activations: structuredClone(checkpoint.templateActivations) } } };
        delete copy.extra.tipsy_generation_incomplete;
        delete copy.extra.tipsy_generation_terminal;
        const point = createBranchVariableRemapper(new Map([[source.id, nextId]]))(checkpoint);
        point.reply = { content: copy.content, reasoning: copy.reasoning, swipe: copy.swipes[0], extra: copy.extra };
        copy.branchBases = { [selectedKey]: point };
        copy.branchStates = { [selectedKey]: point };
        const parent = path[source.floor - 1];
        copy.parentId = parent?.id ?? null;
        copy.parentSwipeId = parent ? swipeId(parent) : undefined;
        copy.floor = source.floor;
        workspaceStore.setState(draft => { draft.messages.push(copy); draft.activeLeafId = copy.id; });
        activateBranch(copy.id, 0);
    });
    publishBranchChange(!internal);
    setStatusBanner(`新路线已回到第 ${source.floor} 楼，可以重新选择；此后的消息保留在原路线。`);
}

let settlingRoute = false;
export async function settleRouteChange(internal = false): Promise<void> {
    const before = workspaceStore.getState();
    if (settlingRoute || branchBusy(internal)) throw new Error('请等待剧情结算完成');
    settlingRoute = true;
    try {
        if (before.sessionKind !== 'free') await saveCompatibilityBeforeRouteChange();
        const current = workspaceStore.getState();
        if (current.activeChatId !== before.activeChatId || current.branchEpoch !== before.branchEpoch || branchBusy(internal)) {
            throw new Error('剧情状态已变化，请重新操作');
        }
    } finally { settlingRoute = false; }
}

export async function selectChatBranch(id: string, internal = false): Promise<void> {
    const state = workspaceStore.getState();
    const route = storyRoutes(state.messages).find(item => item.key === id);
    const target = state.messages.find(node => node.id === (route?.nodeId ?? id));
    if (!target) return;
    if (target.floor === 0 && state.sessionKind !== 'free') throw new Error('开场不参与剧情分支，请新建会话更换开局');
    if (branchBusy(internal)) throw new Error('请等待本轮生成和变量结算结束后切换路线');
    await settleRouteChange(internal);
    rememberBranch();
    invalidateTemplateEnvironment();
    batchReactiveUpdates(() => activateBranch(target.id, route?.swipe ?? target.activeSwipeIndex));
    publishBranchChange(!internal);
}

export async function swipeBranchMessage(messageId: string, direction: 'prev' | 'next' | 'new_branch', editOpening: (id: string, content: string, options: { swipe_id: number }) => boolean | Promise<boolean>, internal = false): Promise<void> {
    if (direction === 'new_branch') return retryStoryFrom(messageId, undefined, internal);
    const previous = workspaceStore.getState();
    const source = getActiveChatMessages(previous).find(node => node.id === messageId);
    if (!source || direction === 'prev' && source.activeSwipeIndex === 0 || direction === 'next' && source.activeSwipeIndex === source.swipes.length - 1) return;
    const nextIndex = source.activeSwipeIndex + (direction === 'prev' ? -1 : 1);
    if (source.floor === 0) {
        const selected = source.swipes[nextIndex];
        await editOpening(source.id, typeof selected === 'string' ? selected : selected.content, { swipe_id: nextIndex });
        return;
    }
    if (branchBusy(internal)) return;
    const routes = storyRoutes(previous.messages).filter(route => route.path.some(node => node.id === messageId && node.activeSwipeIndex === nextIndex));
    if (routes.length > 1) { window.dispatchEvent(new CustomEvent('tipsy-open-branches', { detail: { messageId } })); return; }
    if (routes.length === 1) await selectChatBranch(routes[0].key, internal);
}

/**
 * 统计当前会话树中的总分支数（含各楼层平行 swipe 与 parentId 分叉）
 */
export function getChatBranchStats(messages = workspaceStore.getState().messages): {
    totalBranches: number;
    forkFloors: number[];
} {
    let extraBranches = 0;
    const forkFloors: number[] = [];
    for (const m of messages) {
        if (m.swipes && m.swipes.length > 1) {
            extraBranches += m.swipes.length - 1;
            forkFloors.push(m.floor);
        }
    }
    return {
        totalBranches: 1 + extraBranches,
        forkFloors,
    };
}

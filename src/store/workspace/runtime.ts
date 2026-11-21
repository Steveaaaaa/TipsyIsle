import { syncRuntimeReady } from '../../core/sync/activity';
import { listChatArchives, loadChatArchive, type ArchivedChat } from '../chat-archives';
import { swipeId } from '../chat-tree';
import { pendingBranchOperations, runBranchOperation } from '../branch-runtime';
import { assertCurrentStory, findStoryMessage, installNativeStoryPort, makeStoryTracker, settled, type StoryCommit } from '../../plugins/native/story-port';
import type { PluginBucket, PluginBuckets } from '../../plugins/native/storage';
import type { NativeAssetPatch } from '../../plugins/native/asset-data';
import { PluginApiError } from '../../plugins/native/errors';
import { activeAddress, routeGraph } from '../../plugins/native/route-graph';
import type { ChatMessageNode } from '../../types';
import { enqueuePersistentOperation, waitForReplicaCommit, holdReplicaCommit } from '../persistence';
import { workspaceStore } from './state';
import { getActiveChatMessages, preserveAuthorMessageRevision } from './queries';
import { setNativeStorySaving, branchBusy } from './activity';
import { readBranchState, rememberBranch, activateBranch, publishBranchChange, settleRouteChange } from './branches';
import { commitWorkspaceMutation, persistWorkspaceNow } from './storage';
import { batchReactiveUpdates } from '../reactive-store';
import { scopedVariableStore, registerAssetVariableAccess } from '../scoped-variable-store';
import type { RouteAddress } from '../../../packages/plugin-sdk/index.js';
import { resetCompatibilityBranch } from '../../compatibility/runtime-client';
import { getActivePreset, getActiveCharacter } from './library';
import { schedulePreview, invalidateTemplateEnvironment } from './prompt';
import { openArchivedChat } from './sessions';

const trackNativeStory = makeStoryTracker();

export function isNativeStoryBusy(state = workspaceStore.getState()) {
    return !syncRuntimeReady() || state.isGenerating || state.helperGenerationCount > 0 || state.mvuExtraAnalysisActive || pendingBranchOperations() > 0;
}

export function readNativeStory() {
    const state = workspaceStore.getState();
    if (state.sessionKind === 'free') return { ...trackNativeStory('', 0, [], undefined, false), route: null };
    const view = trackNativeStory(state.activeChatId, state.branchEpoch ?? 0, getActiveChatMessages(state), state.nativePluginRoute, isNativeStoryBusy(state));
    return { ...view, get route() {
        let i = view.path.length;
        while (i && !settled(view.path[i - 1])) i--;
        return activeAddress(state.activeChatId, state.messages, view.path[i - 1]);
    } };
}

export function installWorkspaceStoryRuntime() {
    installNativeStoryPort({ current: readNativeStory, busy: isNativeStoryBusy, subscribe: listener => workspaceStore.subscribe(listener),
        commit: commitNativePluginState, buckets: localNativePluginBuckets });
}

function commitNativePluginState(input: StoryCommit): Promise<void> {
    return enqueuePersistentOperation(async () => {
        await waitForReplicaCommit();
        const release = holdReplicaCommit();
        setNativeStorySaving(true);
        try { await commitWorkspaceMutation(() => {
            input.check();
            const state = workspaceStore.getState(), view = readNativeStory(), target = input.target && findStoryMessage(view, input.target);
            assertCurrentStory(input.view, view);
            const { pluginId, route, reply } = input;
            if (route && route.before !== view.storage?.[pluginId] || reply && (!input.target || !target
                || reply.before !== target.nativePluginReplies?.[input.target.swipeId]?.[pluginId])) throw new PluginApiError('STORAGE_CONFLICT', '另一项操作刚更新了插件数据，请重试');
            const head = view.path.at(-1);
            if (route && !head) throw new Error('请先打开一段剧情');
            const key = head ? swipeId(head) : '';
            const checkpoint = route && head && head.floor > 0 && !head.branchStates?.[key] ? readBranchState(state, head) : undefined;
            workspaceStore.setState(draft => {
                if (reply && target && input.target) {
                    const node = draft.messages.find(item => item.id === target.id)!;
                    const swipes = node.nativePluginReplies ??= {};
                    (swipes[input.target.swipeId] ??= {})[pluginId] = reply.after;
                }
                if (route && head) {
                    const buckets = { ...state.nativePluginRoute, [pluginId]: route.after };
                    draft.nativePluginRoute = buckets;
                    const node = draft.messages.find(item => item.id === head.id)!;
                    if (node.floor === 0) (node.nativePluginOpeningRoutes ??= {})[key] = buckets;
                    else {
                        if (checkpoint) (node.branchStates ??= {})[key] = { ...checkpoint, continuation: { ...checkpoint.continuation, nativePluginRoute: buckets } };
                        else node.branchStates![key].continuation.nativePluginRoute = buckets;
                        // Update only native data in the before-choice checkpoint.
                        const base = node.branchBases?.[key];
                        if (base) base.continuation.nativePluginRoute = { ...base.continuation.nativePluginRoute, [pluginId]: route.after };
                    }
                }
            });
            preserveAuthorMessageRevision(state.messages, workspaceStore.getState().messages);
        }, input.extras, true);
            input.committed?.();
        } finally { setNativeStorySaving(false); release(); }
    });
}

async function* localNativePluginBuckets(id: string) {
    const visited = new WeakSet<object>();
    function* add(scope: 'route' | 'reply', bucket?: PluginBucket) {
        if (!bucket || visited.has(bucket)) return;
        visited.add(bucket); yield { scope, bucket };
    }
    function* scan(messages: ChatMessageNode[], route?: PluginBuckets) {
        yield* add('route', route?.[id]);
        for (const node of messages) {
            for (const buckets of Object.values(node.nativePluginOpeningRoutes ?? {})) yield* add('route', buckets[id]);
            for (const buckets of Object.values(node.nativePluginReplies ?? {})) yield* add('reply', buckets[id]);
            for (const states of [node.branchStates, node.branchBases]) for (const checkpoint of Object.values(states ?? {})) {
                yield* add('route', checkpoint.continuation.nativePluginRoute?.[id]);
            }
        }
    }
    const workspace = workspaceStore.getState();
    yield* scan(workspace.messages, workspace.nativePluginRoute);
    for (const summary of await listChatArchives()) {
        if (summary.id === workspace.activeChatId) continue;
        const chat = await loadChatArchive(summary.id);
        if (chat) yield* scan(chat.messages, chat.continuation?.nativePluginRoute);
    }
}

export function installWorkspaceAssetVariables() {
    registerAssetVariableAccess({
        read: (scope, id) => {
            const state = workspaceStore.getState();
            const extensions = scope === 'character' ? (state.activeCharacterId === id ? getActiveCharacter(state) : state.characters.find(card => card.id === id))?.extensions
                : (id === state.activePresetId ? getActivePreset(state) : state.presets.find(preset => preset.id === id))?.rawData?.extensions as Record<string, any> | undefined;
            return ((extensions?.tavern_helper ?? extensions?.TavernHelper) as any)?.variables;
        },
        write: (scope, id, value) => {
            const current = scope === 'preset' ? getActivePreset() : undefined;
            workspaceStore.setState(draft => {
                if (scope === 'character') {
                    if (id === draft.activeCharacterId) draft.storyCharacter ??= structuredClone(getActiveCharacter());
                    const card = draft.storyCharacter?.id === id ? draft.storyCharacter : draft.characters.find(item => item.id === id); if (!card) throw new Error('角色变量目标不存在');
                    card.extensions = { ...card.extensions, tavern_helper: { ...(card.extensions?.tavern_helper ?? card.extensions?.TavernHelper ?? {}) as object, variables: value } };
                } else {
                    if (id === draft.activePresetId && !draft.inUsePreset) draft.inUsePreset = structuredClone(current!);
                    const preset = id === draft.activePresetId ? draft.inUsePreset : draft.presets.find(item => item.id === id);
                    if (!preset) throw new Error('预设变量目标不存在');
                    const extensions = preset.rawData?.extensions as any ?? {};
                    preset.rawData = { ...preset.rawData, extensions: { ...extensions, tavern_helper: { ...extensions.tavern_helper, variables: value } } };
                }
            });
        },
    });
}

/** Called in the serialized storage lane; keep only the publication and its disk write exclusive. */
export async function commitNativeWorkspace(check: () => void, publish: () => void, extras: Record<string, unknown>, refresh = true) {
    await waitForReplicaCommit();
    if (isNativeStoryBusy()) throw new PluginApiError('STORY_BUSY', '请等待本轮剧情结算结束');
    const release = holdReplicaCommit();
    setNativeStorySaving(true);
    try { await commitWorkspaceMutation(() => { check(); publish(); }, extras); }
    finally { setNativeStorySaving(false); release(); }
    if (refresh) { invalidateTemplateEnvironment(); resetCompatibilityBranch(); schedulePreview(); }
}

export function commitNativeAssetEdit(check: () => void, patch: NativeAssetPatch, extras: Record<string, unknown>): Promise<void> {
    return commitNativeWorkspace(check, () => workspaceStore.setState(patch), extras);
}

export function applyNativeChatEdit(chat: ArchivedChat, activate: boolean, pluginOnly = false) {
    const state = workspaceStore.getState();
    if (state.activeChatId !== chat.id) throw new PluginApiError('STALE_ROUTE', '当前会话已切换');
    const continuation = chat.continuation;
    if (activate && continuation && !pluginOnly) scopedVariableStore.setState(draft => {
        draft.chat[chat.id] = continuation.variables.chat[chat.id] ?? {};
        Object.assign(draft.message, continuation.variables.message);
        for (const id of chat.deletedMessageIds ?? []) if (!chat.messages.some(node => node.id === id)) delete draft.message[id];
    });
    workspaceStore.setState({ messages: chat.messages, deletedMessageIds: chat.deletedMessageIds,
        ...(activate && pluginOnly ? { nativePluginRoute: continuation?.nativePluginRoute } : activate ? { activeLeafId: chat.activeLeafId, timedStates: chat.timedStates, templateInjections: chat.templateInjections ?? [],
            templateActivations: chat.templateActivations ?? [], chatMetadata: continuation?.chatMetadata, nativePluginRoute: continuation?.nativePluginRoute,
            branchEpoch: (state.branchEpoch ?? 0) + 1, lastAssembledPrompt: null } : {}) });
    if (pluginOnly) preserveAuthorMessageRevision(state.messages, chat.messages);
}

export async function openNativePluginRoute(address: RouteAddress, check: () => void) {
    await waitForReplicaCommit();
    const state = workspaceStore.getState();
    if (branchBusy()) throw new PluginApiError('STORY_BUSY', '请等待剧情结算完成后再切换路线');
    await settleRouteChange();
    if (address.chatId !== state.activeChatId) {
        const chat = await loadChatArchive(address.chatId);
        check();
        if (!chat) throw new PluginApiError('NOT_FOUND', '会话已不存在');
        const tip = routeGraph(chat.messages).tips.get(address.routeId);
        if (!tip) throw new PluginApiError('NOT_FOUND', '路线已不存在');
        await runBranchOperation(() => openArchivedChat(chat.id, tip.key, true, check));
        resetCompatibilityBranch();
        return;
    }
    const tip = routeGraph(state.messages).tips.get(address.routeId);
    if (!tip) throw new PluginApiError('NOT_FOUND', '路线已不存在');
    if (state.activeLeafId === tip.node.id && state.messages.find(node => node.id === tip.node.id)?.activeSwipeIndex === tip.index) return;
    check();
    rememberBranch(); invalidateTemplateEnvironment();
    batchReactiveUpdates(() => activateBranch(tip.node.id, tip.index, true));
    publishBranchChange();
    await persistWorkspaceNow();
}

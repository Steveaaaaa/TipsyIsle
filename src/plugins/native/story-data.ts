import { z } from 'zod';
import _ from 'lodash';
import type { EditPreview, MessageRef, RouteAddress, RouteVersion, StoryStateValue } from '../../../packages/plugin-sdk/index.js';
import { listChatArchives, loadChatArchive, type ArchivedChat } from '../../store/chat-archives';
import { branchMessageVariables, captureVariablePages, type BranchState } from '../../store/branch-state';
import { branchExcerpt, routeKey, swipeId, withSwipe } from '../../store/chat-tree';
import { mvuProjectionKeys, normalizeMvuVariables, reconcileMvuVariables } from '../../pipeline/mvu-data';
import { resolveMvuSettings } from '../../pipeline/mvu-settings';
import { commandCompatibilityRuntime, CompatibilityConnectionChangedError } from '../../compatibility/runtime-client';
import { scriptsFromTrees } from '../../compatibility/script-trees';
import { getSchemaValues } from '../../registry/schema-registry';
import type { ChatMessageNode } from '../../types';
import { candidateRef, messageRef, sameMessageRef, settled, toStoryMessage } from './story-port';
import { routeGraph, routeInfo, treeRow, vertexPath } from './route-graph';
import { conflict, cursorSchema, idSchema, jsonEditsSchema, limitSchema, missing, operationSchema, page, patchObject, pathSchema, readJsonPath, refSchema, roleSchema, routeSchema, signature, sliceInt } from './edits';
import { PluginApiError } from './errors';

const workspace = () => import('../../store/workspace-store');
const paging = { cursor: cursorSchema, limit: limitSchema };
const queryFields = { route: routeSchema, revision: idSchema.optional() };
export interface LoadedRoute { chat: ArchivedChat; path: ChatMessageNode[]; point?: BranchState; version: RouteVersion; active: boolean }
export const storyEditSchema = z.strictObject({ route: routeSchema, expectedRevision: idSchema, operationId: operationSchema,
    edits: z.array(z.discriminatedUnion('type', [
        z.strictObject({ type: z.literal('fork'), at: refSchema, label: z.string().max(100).optional() }),
        z.strictObject({ type: z.literal('message'), target: refSchema, text: z.string().max(120_000) }),
        z.strictObject({ type: z.literal('variables'), scope: z.enum(['chat', 'message', 'mvu']), edits: jsonEditsSchema, target: refSchema.optional() }),
        z.strictObject({ type: z.literal('append'), role: roleSchema, text: z.string().min(1).max(120_000) }),
    ])).min(1).max(32),
});
export type StoryRequest = z.infer<typeof storyEditSchema>;
export async function readChat(id: string): Promise<ArchivedChat> {
    const w = await workspace();
    const chat = w.readNativeChat(id) ?? await loadChatArchive(id);
    if (!chat) throw missing('会话');
    return chat;
}
export const selectedLeaf = (chat: ArchivedChat) => chat.messages.find(node => node.id === chat.activeLeafId);
function pointAt(chat: ArchivedChat, path: ChatMessageNode[], node: ChatMessageNode, base = false): BranchState | undefined {
    const key = swipeId(node), index = node.activeSwipeIndex;
    const saved = (base ? node.branchBases : node.branchStates)?.[key];
    if (!base && chat.continuation && chat.activeLeafId === node.id && selectedLeaf(chat)?.activeSwipeIndex === index) {
        return { continuation: chat.continuation, timedStates: chat.timedStates, templateInjections: chat.templateInjections ?? [],
            templateActivations: chat.templateActivations ?? [], worldbookName: chat.worldbookName };
    }
    if (saved) return saved;
    if (!chat.continuation || node.floor !== 0) return undefined;
    const extra = node.extra ?? {};
    const vars = (extra.swipeVariables as Record<number, Record<string, unknown>> | undefined)?.[index];
    const local = (extra.swipeChatVariables as Record<number, Record<string, unknown>> | undefined)?.[index];
    if (!vars || !local) return undefined;
    const timed = (extra.swipeTimedStates as Record<number, BranchState['timedStates']> | undefined)?.[index];
    const template = (extra.swipeTemplateStates as Record<number, { injections: BranchState['templateInjections']; activations: BranchState['templateActivations'] }> | undefined)?.[index];
    return { continuation: { ...chat.continuation, nativePluginRoute: node.nativePluginOpeningRoutes?.[key],
        variables: { ...chat.continuation.variables, chat: { [chat.id]: local }, message: { [node.id]: vars } } },
        timedStates: timed ?? {}, templateInjections: template?.injections ?? [], templateActivations: template?.activations ?? [] };
}
const projected = new WeakMap<ChatMessageNode, string>();
const pointVariables = (point: BranchState | undefined, path: ChatMessageNode[]) => {
    const variables = point && branchMessageVariables(point);
    return Object.fromEntries(path.map(node => [node.id, variables?.[node.id] ?? (node.extra?.swipeVariables as Record<number, Record<string, unknown>> | undefined)?.[node.activeSwipeIndex] ?? {}]));
};
async function fingerprint(path: ChatMessageNode[], point?: BranchState) {
    const messages = path.map(node => {
        let value = projected.get(node);
        if (!value) {
            value = JSON.stringify([messageRef(node), node.role, node.speakerName, !!node.isHidden, node.reasoning, node.nativePluginReplies?.[swipeId(node)], node.storySummaries?.[swipeId(node)]]);
            projected.set(node, value);
        }
        return value;
    });
    return signature([messages, pointVariables(point, path), point?.continuation.variables.chat, point?.timedStates,
        point?.templateInjections, point?.templateActivations, point?.continuation.chatMetadata, point?.continuation.nativePluginRoute]);
}
export async function resolveRoute(chat: ArchivedChat, route: RouteAddress, expected?: string): Promise<LoadedRoute> {
    const graph = routeGraph(chat.messages);
    const tip = graph.tips.get(route.routeId);
    const leaf = selectedLeaf(chat);
    // The selected floor can be a shared story point while its existing continuation is parked.
    const selected = leaf && graph.vertices.get(routeKey(leaf));
    const head = tip ?? (selected?.routeId === route.routeId ? selected : undefined);
    if (!head) throw missing('路线');
    const path = vertexPath(head), point = pointAt(chat, path, path.at(-1)!);
    const version = { ...routeInfo(chat.id, head, leaf), checkpoint: !!point, revision: await fingerprint(path, point) };
    if (expected !== undefined && version.revision !== expected) throw conflict();
    return { chat, path, point, version, active: version.active };
}
function find(path: ChatMessageNode[], ref: MessageRef) {
    const node = path.find(row => row.id === ref.messageId && swipeId(row) === ref.swipeId);
    if (!node) throw missing('候选回复');
    if (!sameMessageRef(messageRef(node), ref)) throw new PluginApiError('STALE_REPLY', '候选回复已有更新');
    return node;
}
export async function storyRead(method: string, args: unknown) {
    if (method === 'listChats') {
        const { characterId, cursor, limit } = z.strictObject({ characterId: idSchema.optional(), ...paging }).parse(args);
        const w = await workspace(), current = w.readNativeChat(w.workspaceStore.getState().activeChatId);
        const list = (await listChatArchives()).filter(item => item.id !== current?.id);
        const rows = [...(current ? [{ id: current.id, characterId: current.characterId, messageCount: current.messages.length }] : []),
            ...list.map(({ id, characterId, messageCount, syncLabel }) => ({ id, characterId, messageCount, label: syncLabel }))]
            .filter(row => !characterId || row.characterId === characterId).sort((a, b) => a.id.localeCompare(b.id));
        return page(rows, cursor, limit);
    }
    if (method === 'listRoutes' || method === 'tree') {
        const { chatId, cursor, limit } = z.strictObject({ chatId: idSchema, ...paging }).parse(args);
        const chat = await readChat(chatId), graph = routeGraph(chat.messages), leaf = selectedLeaf(chat);
        const rows = method === 'tree' ? [...graph.vertices.values()].sort((a, b) => a.floor - b.floor || a.key.localeCompare(b.key))
            : [...graph.tips.values()].sort((a, b) => a.routeId.localeCompare(b.routeId));
        const version = await signature(rows.map(v => [v.key, candidateRef(v.node, v.index).revision, v.parent?.key, v.routeId, v.node.branchLabel]));
        const selected = page(rows, cursor, limit, version);
        return { ...selected, items: selected.items.map(v => method === 'tree' ? treeRow(v, graph.tips) : routeInfo(chatId, v, leaf)) };
    }
    if (method === 'version') {
        const route = routeSchema.parse(args);
        return (await resolveRoute(await readChat(route.chatId), route)).version;
    }
    if (method === 'readText') {
        const { route, target, offset = 0, length = 24_000 } = z.strictObject({ route: routeSchema, target: refSchema,
            offset: sliceInt.optional(), length: sliceInt.min(1).max(48_000).optional() }).parse(args);
        const { path } = await resolveRoute(await readChat(route.chatId), route);
        const node = find(path, target);
        const text = node.content.slice(offset, offset + length);
        return { text, next: offset + length < node.content.length ? offset + length : null };
    }
    if (method === 'state') {
        const options = z.strictObject({ ...queryFields, scope: z.enum(['chat', 'message', 'runtime']), at: refSchema.optional(), path: pathSchema.optional() }).parse(args);
        const route = await resolveRoute(await readChat(options.route.chatId), options.route, options.revision);
        const node = options.at ? find(route.path, options.at) : route.path.at(-1)!;
        const point = options.at ? pointAt(route.chat, route.path, node) : route.point;
        const value = options.scope === 'message' ? (point && branchMessageVariables(point)[node.id]) ?? (node.extra?.swipeVariables as any)?.[node.activeSwipeIndex] ?? {}
            : !point ? null : options.scope === 'chat' ? point.continuation.variables.chat[route.chat.id] ?? {} : {
                timedStates: point.timedStates, templateInjections: point.templateInjections, templateActivations: point.templateActivations,
            };
        const output: StoryStateValue = { version: route.version, at: messageRef(node), value: readJsonPath(value, options.path) };
        return output;
    }
    const query = z.strictObject({ ...queryFields, ...paging, query: z.string().min(1).max(300).optional() }).parse(args);
    const route = await resolveRoute(await readChat(query.route.chatId), query.route, query.revision);
    const needle = query.query?.normalize('NFKC').toLocaleLowerCase();
    const rows = needle ? route.path.filter(row => row.content.normalize('NFKC').toLocaleLowerCase().includes(needle)) : route.path;
    const result = page(rows, query.cursor, Math.min(query.limit ?? 12, 16), `${route.version.revision}${needle ? ':' + await signature(needle) : ''}`);
    return { items: result.items.map(toStoryMessage), next: result.next, version: route.version };
}

export interface StoryPlan { after: ArchivedChat; address: RouteAddress; before: ArchivedChat; changed: string[]; added: string[]; affectsActive: boolean; preview: EditPreview['changes']; validation?: string }
const replaceNode = (nodes: ChatMessageNode[], node: ChatMessageNode) => nodes.map(row => row.id === node.id ? node : row);
function copyHead(node: ChatMessageNode, parent: ChatMessageNode | undefined, point: BranchState, anchor: string, copyId: string, label?: string): ChatMessageNode {
    const key = swipeId(node), reply = point.reply;
    const extra = { ...(reply ? reply.extra : node.extra) };
    for (const field of ['swipeVariables', 'swipeChatVariables', 'swipeTimedStates', 'swipeTemplateStates', 'swipeHostMetadata',
        'helperSwipeInfo', 'tipsy_template_source', 'tipsy_template_render', 'tipsy_template_variables_initialized']) {
        const table = extra[field] as Record<number, unknown> | undefined;
        if (table) extra[field] = { 0: table[node.activeSwipeIndex] };
    }
    delete extra.tipsy_generation_incomplete;
    delete extra.tipsy_generation_terminal;
    return { ...node, id: copyId, messageId: copyId, parentId: parent?.id ?? null, parentSwipeId: parent && swipeId(parent),
        branchOrigin: node.branchOrigin ?? node.id, content: reply?.content ?? node.content, reasoning: reply ? reply.reasoning : node.reasoning,
        branchLabel: label ?? '插件创建的路线', swipes: [reply?.swipe ?? node.swipes[node.activeSwipeIndex]], swipeIds: [key], activeSwipeIndex: 0,
        nativeRouteAnchors: { [key]: anchor }, nativePluginReplies: node.nativePluginReplies?.[key] ? { [key]: node.nativePluginReplies[key] } : undefined,
        storySummaries: node.storySummaries?.[key] ? { [key]: node.storySummaries[key] } : undefined, branchBases: undefined, branchStates: undefined, extra };
}

async function variableRules(loaded: LoadedRoute, point: BranchState, source: ChatMessageNode) {
    const w = await workspace(), state = w.workspaceStore.getState(), c = point.continuation;
    const current = w.getActiveChatMessages(state).at(-1);
    const ownsRuntime = loaded.active && state.activeChatId === loaded.chat.id && !!current && sameMessageRef(messageRef(current), messageRef(source));
    const card = c.character ?? state.characters.find(card => card.id === loaded.chat.characterId);
    const preset = c.inUsePreset;
    const embedded = card?.characterBook ?? card?.embeddedLorebook;
    const declared = typeof card?.primaryWorldbook === 'string' ? card.primaryWorldbook : card?.primaryWorldbook?.name;
    const primary = c.characterBinding?.primary ?? declared ?? embedded?.name;
    const book = c.worldbooks?.find(item => item.name === primary) ?? (embedded?.name === primary ? embedded : undefined);
    const updateChat = (ownsRuntime ? w.getEffectiveMvuSettings(state) : resolveMvuSettings({ ...getSchemaValues(), ...c.settings }, book ?? undefined)).settings['mvu.update_chat'] === true;
    const scriptTree = (extensions: any) => (extensions?.tavern_helper ?? extensions?.TavernHelper)?.scripts ?? [];
    const widgets = [source.content, ...(card?.regexScripts.map(rule => rule.replaceString) ?? []),
        ...(preset?.regexScripts?.map((rule: { replaceString?: string }) => rule.replaceString) ?? [])];
    const authorRules = (ownsRuntime && w.getWorkspaceScripts(state).some(script => script.enabled))
        || [card?.extensions, preset?.rawData?.extensions, c.extensions].some(value => scriptsFromTrees(scriptTree(value)).some(script => script.enabled))
        || widgets.some(text => /<script\b|<%|\bregister(?:Mvu|Variable)Schema\b/i.test(text ?? ''));
    return { updateChat, async validate(scope: 'chat' | 'message' | 'mvu', before: Record<string, unknown>, candidate: Record<string, unknown>) {
        let next = normalizeMvuVariables(candidate).variables;
        const changesMvu = scope === 'mvu' || !_.isEqual(before.stat_data, next.stat_data);
        if ('stat_data' in next && !_.isPlainObject(next.stat_data)) throw new PluginApiError('INVALID_ARGUMENT', 'MVU stat_data 必须为对象');
        const required = authorRules || before.schema === '没有用别管这个' || c.variables.chat[loaded.chat.id]?.schema === '没有用别管这个'
            || branchMessageVariables(point)[source.id]?.schema === '没有用别管这个';
        if (required && !ownsRuntime) throw new PluginApiError('UNAVAILABLE', '这条路线需要作者的变量规则，请先打开它再预演变量改动');
        if (ownsRuntime) {
            if (w.workspaceStore.getState().activeChatId !== loaded.chat.id || w.workspaceStore.getState().branchEpoch !== state.branchEpoch) throw conflict();
            if (w.workspaceStore.getState().isGenerating) throw new PluginApiError('STORY_BUSY', '请等待剧情结算完成');
            try {
                const checked = await commandCompatibilityRuntime('validatePluginVariables', [loaded.chat.id, state.branchEpoch ?? 0,
                    current.id, current.activeSwipeIndex, scope === 'chat' ? 'chat' : 'message', before, next, changesMvu], required);
                next = checked.variables ?? next;
            } catch (error) {
                if (error instanceof CompatibilityConnectionChangedError) throw conflict();
                throw new PluginApiError('INVALID_ARGUMENT', `变量不符合作者规则：${error instanceof Error ? error.message : String(error)}`);
            }
        }
        if ('stat_data' in next && !_.isPlainObject(next.stat_data)) throw new PluginApiError('INVALID_ARGUMENT', 'MVU stat_data 必须为对象');
        return (changesMvu || !_.isEqual(before.stat_data, next.stat_data)) && 'stat_data' in next ? reconcileMvuVariables(next) : next;
    } };
}
export async function planStory(request: StoryRequest, chat: ArchivedChat, seed: string): Promise<StoryPlan> {
    const loaded = await resolveRoute(chat, request.route, request.expectedRevision);
    let path = [...loaded.path], head = path.at(-1)!, point = loaded.point;
    let routeId = loaded.version.routeId;
    let validationSource = head;
    const changed = new Set<string>(), added = new Set<string>();
    const preview: EditPreview['changes'] = [];
    let messages = chat.messages, nextId = 0;
    const makeId = () => `msg_plugin_${seed}_${++nextId}`;
    const first = request.edits[0];
    const selectFork = first.type === 'fork';
    if (request.edits.slice(1).some(edit => edit.type === 'fork')) throw new PluginApiError('INVALID_ARGUMENT', '创建分支必须是第一项改动');
    if (selectFork) {
        const source = find(path, first.at);
        if (source.floor === 0) throw new PluginApiError('INVALID_ARGUMENT', '开场不参与分支，请另建会话');
        validationSource = source;
        point = pointAt(chat, path, source, true) ?? pointAt(chat, path, source);
        const sourcePath = path.slice(0, source.floor + 1);
        if (!point) throw new PluginApiError('UNAVAILABLE', '该楼层缺少完整的剧情检查点');
        const id = makeId(); routeId = `route:${id}`;
        head = copyHead(source, sourcePath.at(-2), point, routeId, id, first.label);
        const sourceVars = pointVariables(point, sourcePath);
        const { [source.id]: sourceValue, ...others } = sourceVars;
        point = { ...point, messageVariablePages: undefined, continuation: { ...point.continuation,
            variables: { ...point.continuation.variables, message: { ...others, [id]: sourceValue } } } };
        path = [...sourcePath.slice(0, -1), head]; messages = [...messages, head]; added.add(id);
        preview.push({ target: '创建路线', before: `第 ${source.floor} 楼 · ${branchExcerpt(source.content)}`, after: first.label ?? '插件创建的路线' });
    }
    if (!point) throw new PluginApiError('UNAVAILABLE', '这条路线没有可用的剧情检查点');
    if (!settled(head)) throw new PluginApiError('STORY_BUSY', '请等待剧情结算完成');
    let values = pointVariables(point, path);
    let local = point.continuation.variables.chat[chat.id] ?? {};
    const variables = request.edits.some(edit => edit.type === 'variables') ? await variableRules(loaded, point, validationSource) : undefined;
    const validated: unknown[] = [];
    const requestedHead = first.type === 'fork' ? first.at : loaded.version.head;
    const stamp = (node: ChatMessageNode) => {
        const key = swipeId(node), index = node.activeSwipeIndex;
        const extra = { ...node.extra, chatVariables: local, timedStates: point!.timedStates,
            templateState: { injections: point!.templateInjections, activations: point!.templateActivations },
            swipeVariables: { ...node.extra?.swipeVariables as object, [index]: values[node.id] ?? {} },
            swipeChatVariables: { ...node.extra?.swipeChatVariables as object, [index]: local },
            swipeTimedStates: { ...node.extra?.swipeTimedStates as object, [index]: point!.timedStates },
            swipeTemplateStates: { ...node.extra?.swipeTemplateStates as object, [index]: { injections: point!.templateInjections, activations: point!.templateActivations } } };
        const { variables, ...context } = point!.continuation;
        const continuation = { ...context, variables: { ...variables, chat: { [chat.id]: local }, message: {} } };
        const saved: BranchState = { ...point!, continuation, messageVariablePages: captureVariablePages(path, values, point),
            reply: { content: node.content, reasoning: node.reasoning, swipe: node.swipes[index], extra } };
        const base = node.branchBases?.[key] ?? saved;
        return { ...node, extra, branchStates: { ...node.branchStates, [key]: saved }, branchBases: { ...node.branchBases, [key]: base } };
    };
    const publishHead = () => {
        head = stamp(head);
        if (!added.has(head.id)) changed.add(head.id);
        const stored = messages.find(row => row.id === head.id)!;
        const index = stored.activeSwipeIndex;
        const projected = index === head.activeSwipeIndex ? head : { ...withSwipe(head, index), extra: { ...head.extra,
            chatVariables: stored.extra?.chatVariables, timedStates: stored.extra?.timedStates, templateState: stored.extra?.templateState } };
        messages = replaceNode(messages, projected);
        path[path.length - 1] = head;
    };
    const hasDescendants = !selectFork && chat.messages.some(node => node.parentId === head.id && (node.parentSwipeId ?? swipeId(head)) === swipeId(head));
    if (hasDescendants) throw new PluginApiError('INVALID_ARGUMENT', '该楼层已有后续剧情，请先从这里试演一条新路线');
    for (const edit of request.edits) {
        if (edit.type === 'fork') continue;
        if (edit.type === 'append') {
            publishHead();
            const id = makeId();
            head = { id, messageId: id, parentId: head.id, parentSwipeId: swipeId(head), floor: path.length, role: edit.role,
                speakerName: edit.role === 'assistant' ? point.continuation.character?.name ?? '角色' : edit.role === 'user' ? point.continuation.userName : 'System',
                content: edit.text, swipes: [edit.text], activeSwipeIndex: 0, createdAt: Date.now(), nativeRouteAnchors: { [`${id}:0`]: routeId } };
            values = { ...values, [id]: { ...local, ...values[path.at(-1)!.id] } };
            added.add(id); path.push(head); messages = [...messages, head];
            preview.push({ target: `新增第 ${head.floor} 楼`, before: '', after: branchExcerpt(edit.text, 240) });
            continue;
        }
        const ref = edit.target;
        if (ref && (!sameMessageRef(ref, requestedHead) || head.id !== requestedHead.messageId && (!selectFork || added.size > 1))) {
            throw new PluginApiError('INVALID_ARGUMENT', '正文与变量修改仅作用于目标路线的当前楼层；更早的楼层可先从那里创建分支');
        }
        if (edit.type === 'message') {
            const before = head.content, swipes = [...head.swipes];
            const prior = swipes[head.activeSwipeIndex];
            swipes[head.activeSwipeIndex] = typeof prior === 'string' ? edit.text : { ...prior, content: edit.text };
            const extra = { ...head.extra };
            for (const field of ['tipsy_template_render', 'tipsy_template_source']) {
                if (!extra[field]) continue;
                const remaining = { ...extra[field] as object } as Record<number, unknown>;
                delete remaining[head.activeSwipeIndex]; extra[field] = remaining;
            }
            const key = swipeId(head), base = head.branchBases?.[key];
            const branchBases = base ? { ...head.branchBases, [key]: { ...base, reply: { content: edit.text, reasoning: head.reasoning, swipe: swipes[head.activeSwipeIndex], extra } } } : head.branchBases;
            const storySummaries = { ...head.storySummaries };
            delete storySummaries[key];
            head = { ...head, content: edit.text, swipes, extra, branchBases, storySummaries, updatedAt: Date.now() };
            preview.push({ target: `第 ${head.floor} 楼正文`, before: branchExcerpt(before, 240), after: branchExcerpt(edit.text, 240) });
        } else {
            const before = edit.scope === 'chat' ? local : edit.scope === 'mvu' ? (values[head.id]?.stat_data as Record<string, unknown> ?? {}) : values[head.id] ?? {};
            const patched = patchObject(before, edit.edits);
            let result: Record<string, unknown>;
            if (edit.scope === 'chat') result = local = await variables!.validate('chat', before, patched);
            else {
                const previous = values[head.id] ?? {};
                const next = await variables!.validate(edit.scope, previous, edit.scope === 'mvu' ? { ...previous, stat_data: patched } : patched);
                values = { ...values, [head.id]: next };
                if (variables!.updateChat && (!_.isEqual(previous.stat_data, next.stat_data) || edit.scope === 'mvu')) {
                    local = { ...local };
                    for (const key of mvuProjectionKeys) {
                        if (key in next) local[key] = next[key];
                        else delete local[key];
                    }
                }
                result = edit.scope === 'mvu' ? next.stat_data as Record<string, unknown> : next;
            }
            validated.push([values[head.id], local]);
            for (const change of edit.edits) preview.push({ target: `${edit.scope} · ${change.path.join('.')}`,
                before: JSON.stringify(readJsonPath(before, change.path)).slice(0, 160), after: JSON.stringify(readJsonPath(result, change.path)).slice(0, 160) });
        }
    }
    publishHead();
    const affectsActive = loaded.active && !selectFork;
    // A trial creates a saved route; switching to it is a separate explicit action.
    const last = head.branchStates![swipeId(head)];
    if (affectsActive) {
        const chosen = new Map(path.map(node => [node.id, node.activeSwipeIndex]));
        messages = messages.map(node => node.id === head.id ? head : chosen.has(node.id) ? withSwipe(node, chosen.get(node.id)!) : node);
    }
    const after = { ...chat, messages, ...(affectsActive ? {
        activeLeafId: head.id, continuation: { ...last.continuation, variables: { ...last.continuation.variables,
            message: { ...chat.continuation?.variables.message, ...values } } },
        timedStates: last.timedStates, templateInjections: last.templateInjections, templateActivations: last.templateActivations,
    } : {}) };
    return { before: chat, after, address: { chatId: chat.id, routeId }, changed: [...changed], added: [...added], affectsActive, preview,
        validation: variables && await signature([variables.updateChat, validated]) };
}

export async function openPluginRoute(route: RouteAddress, check: () => void) {
    const w = await workspace();
    await w.openNativePluginRoute(route, check);
}

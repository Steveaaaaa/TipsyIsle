import type { AssetRef, EditPreview, EditReceipt, RouteAddress } from '../../../packages/plugin-sdk/index.js';
import { platformStorage } from '../../core/platform-bridge';
import { enqueuePersistentOperation } from '../../store/persistence';
import { updateChatArchive, type ArchivedChat } from '../../store/chat-archives';
import { scopedVariableStore } from '../../store/scoped-variable-store';
import { branchMessageVariables } from '../../store/branch-state';
import { schemaRegistryStore } from '../../registry/schema-registry';
import { conflict, idSchema, missing, signature } from './edits';
import { assetAt, assetInfo, assetPublication, assetEditSchema, planAssets, prepareAssetPublication, type AssetPlan, type AssetRequest } from './asset-data';
import { planStory, readChat, resolveRoute, storyEditSchema, type StoryPlan, type StoryRequest } from './story-data';
import { PluginApiError } from './errors';
import { nativeStoryBusy } from './story-port';

type StoryEntry = { kind: 'story'; request: StoryRequest; seed: string; plan: StoryPlan };
type AssetEntry = { kind: 'assets'; request: AssetRequest; plan: AssetPlan; publication?: ReturnType<typeof assetPublication> };
type Entry = (StoryEntry | AssetEntry) & { owner: string; hash: string; expires: number };
type Undo = { entry: Entry; receipt: EditReceipt; expires: number };
type Receipt = { kind: Entry['kind']; hash: string; receipt: EditReceipt; undone?: EditReceipt };
export interface EditAccess { owner: string; check(): void; permit(asset: AssetRef): void; allowVariables(): void }
const traces = new Map<string, Entry>();
const undo = new Map<string, Undo>();
const receiptKey = (owner: string) => `native_plugin_edits:${owner}`;
const receiptWindow = 128;
const workspace = () => import('../../store/workspace-store');
const previewMs = 15 * 60_000, undoMs = 30 * 60_000;
const sweep = () => {
    const now = Date.now();
    for (const map of [traces, undo] as const) for (const [id, item] of map.entries()) if (item.expires < now || map.size > 48) map.delete(id);
};
const readReceipts = (owner: string) => platformStorage.loadSnapshot<Receipt[]>(receiptKey(owner), []);
function checkedReceipt(rows: Receipt[], operationId: string, kind: Entry['kind'], hash: string) {
    const previous = rows.find(row => row.receipt.operationId === operationId);
    if (previous && (previous.kind !== kind || previous.hash !== hash)) throw new PluginApiError('VERSION_CONFLICT', '同一个操作编号不能用于不同的改动');
    return previous;
}

export async function previewEdit(kind: Entry['kind'], args: unknown, access: EditAccess): Promise<EditPreview> {
    sweep();
    const request = kind === 'story' ? storyEditSchema.parse(args) : assetEditSchema.parse(args);
    const hash = await signature(request), token = crypto.randomUUID();
    const prior = checkedReceipt(await readReceipts(access.owner), request.operationId, kind, hash);
    access.check();
    const common = { owner: access.owner, hash, expires: Date.now() + previewMs };
    if (prior) return { token: `replay:${request.operationId}:${hash}`, changes: [] };
    let entry: Entry;
    if (kind === 'story') {
        const request = storyEditSchema.parse(args);
        if (request.edits.some(edit => edit.type === 'variables')) access.allowVariables();
        const chat = await readChat(request.route.chatId);
        const w = await workspace();
        if (w.workspaceStore.getState().activeChatId === chat.id && nativeStoryBusy()) throw new PluginApiError('STORY_BUSY', '请等待剧情结算结束再预演改动');
        entry = { ...common, kind, request, seed: token, plan: await planStory(request, chat, token) };
    } else {
        const w = await workspace(), request = assetEditSchema.parse(args);
        entry = { ...common, kind, request, plan: await planAssets(w.workspaceStore.getState(), request, access.permit) };
    }
    access.check(); traces.set(token, entry);
    return { token, changes: entry.plan.preview.slice(0, 80), forks: entry.kind === 'story' && entry.plan.address.routeId !== entry.request.route.routeId };
}

export async function editStory<T>(address: RouteAddress, access: Pick<EditAccess, 'check'>, build: (current: ArchivedChat) => Promise<{
    chat: ArchivedChat; activate: boolean; extras: Record<string, unknown>; result: T; pluginOnly?: boolean;
}>) {
    const w = await workspace(), active = w.readNativeChat(address.chatId);
    if (!active) {
        return (await updateChatArchive<T>(address.chatId, async chat => {
            if (!chat) throw missing('会话');
            if (w.workspaceStore.getState().activeChatId === address.chatId) throw conflict();
            const output = await build(chat);
            access.check();
            if (w.workspaceStore.getState().activeChatId === address.chatId) throw conflict();
            return { ...output, silent: output.pluginOnly };
        }))!;
    }
    if (nativeStoryBusy()) throw new PluginApiError('STORY_BUSY', '请等待剧情结算结束再提交改动');
    const before = w.workspaceStore.getState(), variables = scopedVariableStore.getState(), settings = schemaRegistryStore.getState().values;
    const output = await build(active);
    await w.commitNativeWorkspace(() => {
        access.check();
        const now = w.workspaceStore.getState();
        if (now.messages !== before.messages || now.activeChatId !== before.activeChatId || now.activeLeafId !== before.activeLeafId
            || now.branchEpoch !== before.branchEpoch || now.templateInjections !== before.templateInjections || now.templateActivations !== before.templateActivations
            || now.timedStates !== before.timedStates || now.chatMetadata !== before.chatMetadata || now.nativePluginRoute !== before.nativePluginRoute
            || now.characters !== before.characters || now.storyCharacter !== before.storyCharacter || now.inUsePreset !== before.inUsePreset
            || now.activePresetId !== before.activePresetId || now.lorebooks !== before.lorebooks || now.storyWorldbooks !== before.storyWorldbooks
            || now.storyCharacterBinding !== before.storyCharacterBinding || now.characterWorldbookBindings !== before.characterWorldbookBindings
            || variables !== scopedVariableStore.getState() || settings !== schemaRegistryStore.getState().values) throw conflict();
    }, () => w.applyNativeChatEdit(output.chat, output.activate, output.pluginOnly), output.extras, output.activate && !output.pluginOnly);
    return output.result;
}

export function commitEdit(kind: Entry['kind'], args: unknown, access: EditAccess) {
    const token = idSchema.parse(args);
    return enqueuePersistentOperation(async () => {
        access.check(); sweep();
        const rows = await readReceipts(access.owner);
        const replay = /^replay:(.*):([a-f0-9]{64})$/.exec(token);
        if (replay) {
            const prior = checkedReceipt(rows, replay[1], kind, replay[2]);
            if (prior) return prior.receipt;
        }
        const entry = traces.get(token);
        if (!entry || entry.owner !== access.owner || entry.kind !== kind) throw new PluginApiError('EXPIRED', '预演已失效，请重新预演');
        const operationId = entry.request.operationId, previous = checkedReceipt(rows, operationId, kind, entry.hash);
        if (previous) return previous.receipt;
        const undoId = crypto.randomUUID();
        const extra = (receipt: EditReceipt) => ({ [receiptKey(access.owner)]: [...rows, { kind, hash: entry.hash, receipt }].slice(-receiptWindow) });
        let receipt: EditReceipt;
        if (entry.kind === 'story') {
            if (entry.request.edits.some(edit => edit.type === 'variables')) access.allowVariables();
            receipt = await editStory(entry.request.route, access, async current => {
                const next = await planStory(entry.request, current, entry.seed);
                if (next.validation !== entry.plan.validation) throw conflict();
                entry.plan = next;
                const { after, address, affectsActive } = entry.plan;
                const route = (await resolveRoute(after, address)).version;
                const result = { operationId, undo: undoId, route };
                return { chat: after, activate: affectsActive, extras: extra(result), result };
            });
        } else {
            const w = await workspace(), state = w.workspaceStore.getState();
            const planned = await planAssets(state, entry.request, access.permit);
            if (planned.linked.some(link => link.grant?.revision !== entry.plan.linked.find(book => book.id === link.id)?.grant?.revision)) throw conflict();
            const after = prepareAssetPublication(state, planned), publication = assetPublication(state, after);
            const assets = await Promise.all(planned.after.map(asset => assetInfo(assetAt(after, asset.kind, asset.value.id)!)));
            const result = { operationId, undo: undoId, assets };
            await w.commitNativeWorkspace(() => { access.check(); publication.validate(w.workspaceStore.getState()); },
                () => w.workspaceStore.setState(publication.patch), extra(result));
            entry.plan = planned; entry.publication = publication;
            receipt = result;
        }
        undo.set(undoId, { entry, receipt, expires: Date.now() + undoMs });
        return receipt;
    });
}

export function undoEdit(kind: Entry['kind'], args: unknown, access: EditAccess) {
    const token = idSchema.parse(args);
    return enqueuePersistentOperation(async () => {
        access.check(); sweep();
        const rows = await readReceipts(access.owner), prior = rows.find(row => row.kind === kind && row.receipt.undo === token);
        if (prior?.undone) return prior.undone;
        const item = undo.get(token);
        if (!item || item.entry.owner !== access.owner || item.entry.kind !== kind) throw new PluginApiError('EXPIRED', '撤销记录已过期');
        const { entry, receipt } = item;
        const extra = (result: EditReceipt) => ({ [receiptKey(access.owner)]: rows.map(row => row === prior ? { ...row, undone: result } : row) });
        let result: EditReceipt;
        if (entry.kind === 'story') {
            if (entry.request.edits.some(edit => edit.type === 'variables')) access.allowVariables();
            result = await editStory(entry.plan.address, access, async current => {
                const view = await resolveRoute(current, entry.plan.address, receipt.route!.revision);
                const { before, changed, added } = entry.plan;
                const drop = new Set(added);
                if (current.messages.some(node => node.parentId && drop.has(node.parentId) && !drop.has(node.id))) throw conflict();
                if (entry.plan.address.routeId !== entry.request.route.routeId && view.active) throw new PluginApiError('VERSION_CONFLICT', '请先切回其他路线再撤销这条试演路线');
                const restore = new Map(before.messages.filter(node => changed.includes(node.id)).map(node => [node.id, node]));
                const written = new Map(entry.plan.after.messages.filter(node => restore.has(node.id) || drop.has(node.id)).map(node => [node.id, node]));
                for (const node of current.messages) if (written.has(node.id) && await signature(node) !== await signature(written.get(node.id))) throw conflict();
                const activate = view.active;
                const values = current.continuation?.variables;
                const original = before.continuation?.variables;
                const message = { ...values?.message };
                for (const id of drop) delete message[id];
                for (const id of restore.keys()) if (original?.message[id]) message[id] = original.message[id]; else delete message[id];
                const chat = { ...current, messages: current.messages.filter(node => !drop.has(node.id)).map(node => restore.get(node.id) ?? node),
                    deletedMessageIds: [...new Set([...current.deletedMessageIds ?? [], ...drop])] };
                if (activate) {
                    const restored = await resolveRoute(before, entry.request.route);
                    const point = restored.point;
                    if (!point) throw conflict();
                    Object.assign(message, point.continuation.variables.message, branchMessageVariables(point));
                    Object.assign(chat, { activeLeafId: restored.version.head.messageId, timedStates: point.timedStates,
                        templateInjections: point.templateInjections, templateActivations: point.templateActivations,
                        continuation: current.continuation && values ? { ...current.continuation, chatMetadata: point.continuation.chatMetadata,
                            nativePluginRoute: point.continuation.nativePluginRoute, variables: { ...values, chat: { ...values.chat, ...point.continuation.variables.chat }, message } } : undefined,
                    });
                }
                const output: EditReceipt = { operationId: receipt.operationId, undo: '', route: (await resolveRoute(chat, entry.request.route)).version };
                return { chat, activate, extras: extra(output), result: output };
            });
        } else {
            const w = await workspace(), state = w.workspaceStore.getState();
            for (const ref of receipt.assets!) {
                access.permit(ref);
                const current = assetAt(state, ref.kind, ref.id);
                if (!current || (await assetInfo(current)).revision !== ref.revision) throw conflict();
            }
            for (const link of entry.plan.linked) if (link.grant) access.permit(link.grant);
            const patch = entry.publication!.reverse(state), after = { ...state, ...patch };
            result = { operationId: receipt.operationId, undo: '', assets: await Promise.all(entry.plan.before.map(asset => assetInfo(assetAt(after, asset.kind, asset.value.id)!))) };
            const publication = assetPublication(state, after);
            await w.commitNativeWorkspace(() => { access.check(); publication.validate(w.workspaceStore.getState()); },
                () => w.workspaceStore.setState(patch), extra(result));
        }
        undo.delete(token); return result;
    });
}

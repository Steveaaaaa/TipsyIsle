import { z } from 'zod';
import type { MessageRef, Permission } from '../../../packages/plugin-sdk/index.js';
import { enqueuePersistentOperation } from '../../store/persistence';
import type { ArchivedChat } from '../../store/chat-archives';
import { swipeId } from '../../store/chat-tree';
import { readPluginBucket } from './catalog';
import { routeSchema, refSchema, sliceInt, missing, conflict } from './edits';
import type { PluginPackage } from './package';
import { readChat, resolveRoute } from './story-data';
import { applyPluginPatch } from './storage';
import { messageRef, sameMessageRef } from './story-port';
import { PluginApiError } from './errors';
import { editStory } from './transactions';

const target = { route: routeSchema, reply: refSchema.optional() };
const readTarget = z.strictObject(target);
const patchTarget = z.strictObject({ ...target, expectedVersion: sliceInt, patch: z.unknown() });
export async function addressedStorage(pkg: PluginPackage, method: 'readAt' | 'patchAt', args: unknown, permit: (p: Permission) => void, check: () => void, signal: AbortSignal) {
    const patchInput = method === 'patchAt' ? patchTarget.parse(args) : undefined;
    const input = patchInput ?? readTarget.parse(args);
    const scope = input.reply ? 'reply' : 'route';
    permit('story.history'); permit(`storage.${scope}`);
    const pluginId = pkg.manifest.id;
    const open = async (chat: ArchivedChat) => {
        const loaded = await resolveRoute(chat, input.route), head = loaded.path.at(-1)!;
        const find = (reply: MessageRef) => {
            const node = loaded.path.find(item => item.id === reply.messageId && swipeId(item) === reply.swipeId);
            if (!node) throw missing('候选回复');
            if (!sameMessageRef(messageRef(node), reply)) throw new PluginApiError('STALE_REPLY', '该候选回复已有修改');
            return node;
        };
        const node = input.reply ? find(input.reply) : head, key = swipeId(node);
        const bucket = input.reply ? node.nativePluginReplies?.[key]?.[pluginId] : loaded.point?.continuation.nativePluginRoute?.[pluginId];
        const before = await readPluginBucket(pkg, bucket, scope, signal);
        return { loaded, node, key, before };
    };
    if (!patchInput) {
        const { before } = await open(await readChat(input.route.chatId));
        return { version: before.version, values: before.values };
    }
    const { expectedVersion, patch } = patchInput;
    return enqueuePersistentOperation(() => editStory(input.route, { check }, async chat => {
        const { loaded, node, key, before } = await open(chat);
        const after = await applyPluginPatch(before, patch, crypto.randomUUID());
        if (after === before) return { chat, activate: false, extras: {}, result: { version: before.version, values: before.values }, pluginOnly: true };
        if (before.version !== expectedVersion) throw conflict();
        const source = chat.messages.find(row => row.id === node.id)!;
        const result = { version: after.version, values: after.values };
        let next = source;
        let continuation = chat.continuation;
        if (scope === 'reply') next = { ...source, nativePluginReplies: { ...source.nativePluginReplies,
            [key]: { ...source.nativePluginReplies?.[key], [pluginId]: after } } };
        else {
            if (!loaded.point) throw new PluginApiError('UNAVAILABLE', '此路线没有可保存插件数据的检查点');
            const buckets = { ...loaded.point.continuation.nativePluginRoute, [pluginId]: after };
            if (node.floor === 0) next = { ...source, nativePluginOpeningRoutes: { ...source.nativePluginOpeningRoutes, [key]: buckets } };
            else {
                const state = source.branchStates?.[key] ?? loaded.point;
                const base = source.branchBases?.[key];
                next = { ...source, branchStates: { ...source.branchStates, [key]: { ...state, continuation: { ...state.continuation, nativePluginRoute: buckets } } },
                    ...(base && { branchBases: { ...source.branchBases, [key]: { ...base, continuation: { ...base.continuation,
                        nativePluginRoute: { ...base.continuation.nativePluginRoute, [pluginId]: after } } } } }) };
            }
            if (loaded.active && continuation) continuation = { ...continuation, nativePluginRoute: buckets };
        }
        return { chat: { ...chat, continuation, messages: chat.messages.map(row => row.id === source.id ? next : row) },
            activate: loaded.active && scope === 'route', extras: {}, result, pluginOnly: true };
    }));
}

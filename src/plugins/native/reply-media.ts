import { z } from 'zod';
import type { MediaAction, ReplyMediaItem } from '../../../packages/plugin-sdk/index.js';
import type { ChatMessageNode } from '../../types';
import { activePlugins, type InstalledPlugin } from './catalog';
import { invokeNativePlugin } from './host';
import { ratio } from './image-protocol';
import { latentFilm } from './latent-film';
import { liveStory, messageRef } from './story-port';

export const tintSchema = z.string().regex(/^#[0-9a-f]{6}$/i);

const itemSchema = z.strictObject({
    slotId: z.string().regex(/^[\w-]{1,80}$/),
    status: z.enum(['developing', 'ready', 'failed']),
    label: z.string().max(160),
    revision: z.string().max(200).optional(),
    generationId: z.string().max(480).optional(),
    aspectRatio: ratio.optional(),
    palette: z.tuple([tintSchema, tintSchema]).optional(),
    presentation: z.enum(['editorial', 'bookmark', 'polaroid']).optional(),
    anchor: z.discriminatedUnion('kind', [
        z.strictObject({ kind: z.literal('footer') }),
        z.strictObject({ kind: z.literal('marker'), token: z.string().min(1).max(100) }),
        z.strictObject({
            kind: z.literal('paragraph'),
            index: z.number().int().nonnegative(),
            excerpt: z.string().max(180).optional(),
        }),
    ]).optional(),
    takes: z.array(z.strictObject({
        id: z.string().uuid(),
        seed: z.number().int().optional(),
        prompt: z.string().max(4000).optional(),
        createdAt: z.number().finite(),
    })).max(64).optional(),
    activeTake: z.number().int().nonnegative().optional(),
});

const cueSchema = z.strictObject({
    revision: z.string().max(200),
    backdropMediaId: z.string().uuid().optional(),
    blurPx: z.number().min(0).max(80).optional(),
    dimming: z.number().min(0).max(1).optional(),
    ambientTint: tintSchema.optional(),
    overrideThemeWallpaper: z.boolean().optional(),
});

export interface MediaProjection {
    key: string;
    node: ChatMessageNode;
    plugin: InstalledPlugin;
    item: ReplyMediaItem;
    cue?: z.infer<typeof cueSchema>;
}

export function projectMedia(node: ChatMessageNode): MediaProjection[] {
    const ref = messageRef(node);
    const buckets = node.nativePluginReplies?.[ref.swipeId];
    return activePlugins().flatMap<MediaProjection>((plugin) => {
        const bucket = buckets?.[plugin.manifest.id];
        if (!plugin.grants.includes('media.manage') || !plugin.grants.includes('ui.surface')) return [];
        const pendingItems = latentFilm.getState().items.filter(
            (old) =>
                old.message === node.id &&
                old.swipe === ref.swipeId &&
                old.owner === plugin.manifest.id &&
                old.digest === plugin.digest,
        );
        if (!bucket?.values.replyMedia) {
            return pendingItems.map((pending) => ({
                key: JSON.stringify([node.id, ref.swipeId, plugin.manifest.id, pending.item.slotId]),
                node,
                plugin,
                item: pending.item,
            }));
        }
        if (bucket.owner !== plugin.fingerprint) return [];
        const slots = z.array(itemSchema).max(8).safeParse(bucket.values.replyMedia);
        if (!slots.success) return [];
        const cue = plugin.grants.includes('ui.stage') ? cueSchema.safeParse(bucket.values.stage).data : undefined;
        const settledItems = slots.data
            .filter((item) => !item.revision || item.revision === ref.revision)
            .map((item) => ({
                key: JSON.stringify([node.id, ref.swipeId, plugin.manifest.id, item.slotId]),
                node,
                plugin,
                item,
                cue,
            }));
        const settledSlotIds = new Set(settledItems.map((entry) => entry.item.slotId));
        for (const pending of pendingItems) {
            if (!settledSlotIds.has(pending.item.slotId)) {
                settledItems.push({
                    key: JSON.stringify([node.id, ref.swipeId, plugin.manifest.id, pending.item.slotId]),
                    node,
                    plugin,
                    item: pending.item,
                    cue,
                });
            }
        }
        return settledItems;
    });
}

export function resolveActiveStage(nodes: ChatMessageNode[], activeIndex: number): MediaProjection | undefined {
    if (!nodes.length) return undefined;
    const start = Math.min(Math.max(0, activeIndex), nodes.length - 1);
    for (let index = start; index >= 0; index--) {
        const hit = projectMedia(nodes[index]).find((slot) => slot.cue !== undefined);
        if (hit) return hit;
    }
    return undefined;
}

export async function dispatchMediaAction(slot: MediaProjection, action: MediaAction['action']) {
    const view = liveStory();
    const target = messageRef(slot.node);
    const current = view.path.find((node) => node.id === target.messageId);
    if (!current || !projectMedia(current).some((item) => item.key === slot.key) || messageRef(current).revision !== target.revision) {
        throw new Error('插图所属回复已改变');
    }
    await invokeNativePlugin({
        mode: 'mediaAction',
        id: crypto.randomUUID(),
        view,
        plugin: slot.plugin,
        target,
        input: { target, slotId: slot.item.slotId, action },
    });
}

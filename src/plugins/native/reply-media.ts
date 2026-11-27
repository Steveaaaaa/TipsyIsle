import { z } from 'zod';
import type { MediaAction, ReplyMediaItem } from '../../../packages/plugin-sdk/index.js';
import type { ChatMessageNode } from '../../types';
import { activePlugins, type InstalledPlugin } from './catalog';
import { invokeNativePlugin } from './host';
import { latentFilm } from './latent-film';
import { cueSchema, replyMediaItemSchema } from './reply-media-schema';
import { liveStory, messageRef } from './story-port';

export { cueSchema, replyMediaItemSchema, smallSurfaceId, surfaceActionSchema, tintSchema } from './reply-media-schema';

export interface MediaProjection {
    key: string;
    node: ChatMessageNode;
    plugin: InstalledPlugin;
    item: ReplyMediaItem;
    cue?: z.infer<typeof cueSchema>;
}

function sanitizeRawMediaItem(raw: unknown): unknown {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
    const obj = raw as Record<string, unknown>;
    const next: Record<string, unknown> = { ...obj };
    if (typeof next.label === 'string' && next.label.length > 160) {
        next.label = next.label.slice(0, 160);
    }
    if (typeof next.subtitle === 'string') {
        const trimmed = next.subtitle.slice(0, 120);
        if (trimmed) next.subtitle = trimmed;
        else delete next.subtitle;
    }
    if (Array.isArray(next.takes)) {
        next.takes = next.takes.slice(0, 64).map((take) => {
            if (!take || typeof take !== 'object' || Array.isArray(take)) return take;
            const copy: Record<string, unknown> = { ...(take as Record<string, unknown>) };
            if (typeof copy.prompt === 'string' && copy.prompt.length > 4000) {
                copy.prompt = copy.prompt.slice(0, 4000);
            }
            if (copy.seed !== undefined) {
                if (typeof copy.seed === 'number' && Number.isFinite(copy.seed)) {
                    copy.seed = Math.trunc(copy.seed);
                } else {
                    delete copy.seed;
                }
            }
            return copy;
        });
    }
    return next;
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
        const ownerMatches = !!bucket && bucket.owner === plugin.fingerprint;
        const cue = ownerMatches && plugin.grants.includes('ui.stage')
            ? cueSchema.safeParse(bucket.values.stage).data
            : undefined;
        const settledItems: MediaProjection[] = [];
        if (ownerMatches && Array.isArray(bucket.values.replyMedia)) {
            for (const rawEntry of bucket.values.replyMedia.slice(0, 8)) {
                const parsed = replyMediaItemSchema.safeParse(sanitizeRawMediaItem(rawEntry));
                if (!parsed.success) continue;
                const item = parsed.data;
                settledItems.push({
                    key: JSON.stringify([node.id, ref.swipeId, plugin.manifest.id, item.slotId]),
                    node,
                    plugin,
                    item,
                    cue,
                });
            }
        }
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

export async function dispatchMediaAction(slot: MediaProjection, action: MediaAction['action'], customId?: string) {
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
        input: { target, slotId: slot.item.slotId, action, ...(customId ? { customId } : {}) },
    });
}

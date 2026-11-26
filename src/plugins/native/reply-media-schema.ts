import { z } from 'zod';
import { ratio } from './image-protocol';

export const tintSchema = z.string().regex(/^#[0-9a-f]{6}$/i);
export const smallSurfaceId = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);

export const surfaceActionSchema = z.strictObject({
    id: smallSurfaceId,
    label: z.string().min(1).max(24),
    title: z.string().max(80).optional(),
    kind: z.enum(['action', 'command']).optional(),
    commandId: smallSurfaceId.optional(),
});

const takeSchema = z.strictObject({
    id: z.string().uuid(),
    seed: z.number().int().optional(),
    prompt: z.string().max(4000).optional(),
    createdAt: z.number().finite(),
});

export const replyMediaItemSchema = z.strictObject({
    slotId: z.string().regex(/^[\w-]{1,80}$/),
    status: z.enum(['developing', 'ready', 'failed']),
    label: z.string().max(160),
    subtitle: z.string().max(120).optional(),
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
    commandId: smallSurfaceId.optional(),
    actions: z.array(surfaceActionSchema).max(4).optional(),
    takes: z.array(takeSchema).max(64).optional(),
    activeTake: z.number().int().nonnegative().optional(),
});

export const latentPreviewSchema = z.strictObject({
    slotId: z.string().regex(/^[\w-]{1,80}$/),
    status: z.enum(['developing', 'ready']).optional(),
    label: z.string().min(1).max(160),
    subtitle: z.string().max(120).optional(),
    aspectRatio: ratio,
    palette: z.tuple([tintSchema, tintSchema]).optional(),
    presentation: z.enum(['editorial', 'bookmark', 'polaroid']).optional(),
    anchor: z.strictObject({
        kind: z.literal('paragraph'),
        index: z.number().int().min(0).max(24),
        excerpt: z.string().max(180).optional(),
    }),
    commandId: smallSurfaceId.optional(),
    actions: z.array(surfaceActionSchema).max(4).optional(),
    takes: z.array(takeSchema).max(8).optional(),
    activeTake: z.number().int().nonnegative().optional(),
});

export const cueSchema = z.strictObject({
    revision: z.string().max(200),
    backdropMediaId: z.string().uuid().optional(),
    blurPx: z.number().min(0).max(80).optional(),
    dimming: z.number().min(0).max(1).optional(),
    ambientTint: tintSchema.optional(),
    overrideThemeWallpaper: z.boolean().optional(),
});

import { z } from 'zod';
import type { ReplyCheckpoint, ReplyMediaItem } from '../../../packages/plugin-sdk/index.js';
import { createReactiveStore } from '../../store/reactive-store';
import { ratio } from './image-protocol';

const tint = z.string().regex(/^#[0-9a-f]{6}$/i);
const preview = z.strictObject({
    slotId: z.string().regex(/^[\w-]{1,80}$/),
    status: z.enum(['developing', 'ready']).optional(),
    label: z.string().min(1).max(160),
    aspectRatio: ratio,
    palette: z.tuple([tint, tint]).optional(),
    presentation: z.enum(['editorial', 'bookmark', 'polaroid']).optional(),
    anchor: z.strictObject({
        kind: z.literal('paragraph'),
        index: z.number().int().min(0).max(24),
        excerpt: z.string().max(180).optional(),
    }),
    takes: z.array(z.strictObject({
        id: z.string().uuid(),
        seed: z.number().int().optional(),
        prompt: z.string().max(4000).optional(),
        createdAt: z.number().finite(),
    })).max(8).optional(),
    activeTake: z.number().int().nonnegative().optional(),
});

interface Latent {
    message: string;
    swipe: string;
    owner: string;
    digest: string;
    item: ReplyMediaItem;
}

export const latentFilm = createReactiveStore<{ items: Latent[] }>(() => ({ items: [] }));

function upsertLatentEntry(
    entry: Latent,
    completion: Promise<unknown>,
    signal: AbortSignal,
) {
    const same = (old: Latent) =>
        old.message === entry.message &&
        old.swipe === entry.swipe &&
        old.owner === entry.owner &&
        old.item.slotId === entry.item.slotId;
    if (signal.aborted) return;
    let isNew = false;
    latentFilm.setState((state) => {
        const idx = state.items.findIndex(same);
        if (idx >= 0) {
            state.items[idx] = entry;
        } else {
            isNew = true;
            state.items.push(entry);
        }
    });
    if (isNew) {
        const remove = () => latentFilm.setState((state) => {
            state.items = state.items.filter((old) => !same(old));
        });
        void completion.then(() => setTimeout(remove, 12000), remove);
    }
}

export function developPreview(
    event: ReplyCheckpoint,
    owner: string,
    digest: string,
    input: unknown,
    completion: Promise<unknown>,
    signal: AbortSignal,
) {
    const parsed = preview.parse(input);
    const item: ReplyMediaItem = {
        ...parsed,
        status: parsed.status ?? 'developing',
        generationId: event.generationId,
    };
    upsertLatentEntry(
        {
            owner,
            digest,
            message: event.draft.messageId,
            swipe: event.draft.swipeId,
            item,
        },
        completion,
        signal,
    );
}

export function updateJobPreview(
    generationId: string,
    owner: string,
    digest: string,
    input: unknown,
    completion: Promise<unknown>,
    signal: AbortSignal,
    fallbackMessage?: { messageId: string; swipeId: string },
) {
    if (signal.aborted) return;
    const parsed = preview.parse(input);
    const existing = latentFilm.getState().items.find(
        (old) =>
            old.owner === owner &&
            old.digest === digest &&
            (old.item.generationId === generationId || (fallbackMessage && old.message === fallbackMessage.messageId && old.swipe === fallbackMessage.swipeId)) &&
            old.item.slotId === parsed.slotId,
    );
    const message = existing?.message ?? fallbackMessage?.messageId;
    const swipe = existing?.swipe ?? fallbackMessage?.swipeId;
    if (!message || !swipe) return;
    const item: ReplyMediaItem = {
        ...parsed,
        status: parsed.status ?? 'developing',
        generationId,
    };
    upsertLatentEntry({ owner, digest, message, swipe, item }, completion, signal);
}

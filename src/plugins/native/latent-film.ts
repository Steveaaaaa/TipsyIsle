import type { ReplyCheckpoint, ReplyMediaItem } from '../../../packages/plugin-sdk/index.js';
import { createReactiveStore } from '../../store/reactive-store';
import { latentPreviewSchema as preview } from './reply-media-schema';

interface Latent {
    message: string;
    swipe: string;
    owner: string;
    digest: string;
    item: ReplyMediaItem;
}

interface EntryRecord {
    seq: number;
    timer?: ReturnType<typeof setTimeout>;
}

const POST_REPLY_LATENT_TTL_MS = 360_000;
const entryRecords = new Map<string, EntryRecord>();

export const latentFilm = createReactiveStore<{ items: Latent[] }>(() => ({ items: [] }));

const entryKey = (entry: Pick<Latent, 'message' | 'swipe' | 'owner'> & { item: { slotId: string } }) =>
    JSON.stringify([entry.message, entry.swipe, entry.owner, entry.item.slotId]);

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
    const key = entryKey(entry);
    latentFilm.setState((state) => {
        const idx = state.items.findIndex(same);
        if (idx >= 0) {
            state.items[idx] = entry;
        } else {
            state.items.push(entry);
        }
    });
    const record = entryRecords.get(key) ?? { seq: 0 };
    const seq = ++record.seq;
    if (record.timer) {
        clearTimeout(record.timer);
        record.timer = undefined;
    }
    entryRecords.set(key, record);
    const removeIfCurrent = () => {
        const current = entryRecords.get(key);
        if (!current || current.seq !== seq) return;
        if (current.timer) clearTimeout(current.timer);
        entryRecords.delete(key);
        latentFilm.setState((state) => {
            state.items = state.items.filter((old) => !same(old));
        });
    };
    signal.addEventListener('abort', removeIfCurrent, { once: true });
    void completion.then(
        () => {
            const current = entryRecords.get(key);
            if (!current || current.seq !== seq) return;
            current.timer = setTimeout(removeIfCurrent, POST_REPLY_LATENT_TTL_MS);
        },
        removeIfCurrent,
    );
}

export function clearLatentForGeneration(
    generationId: string,
    owner: string,
    digest: string,
    delayMs = 0,
    slotId?: string,
) {
    const matches = (old: Latent) =>
        old.owner === owner &&
        old.digest === digest &&
        (old.item.generationId === generationId || old.message === generationId) &&
        (!slotId || old.item.slotId === slotId);
    const drop = () => {
        const targets = latentFilm.getState().items.filter(matches);
        if (!targets.length) return;
        for (const target of targets) {
            const key = entryKey(target);
            const current = entryRecords.get(key);
            if (current?.timer) clearTimeout(current.timer);
            entryRecords.delete(key);
        }
        latentFilm.setState((state) => {
            state.items = state.items.filter((old) => !matches(old));
        });
    };
    if (delayMs > 0) setTimeout(drop, delayMs);
    else drop();
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

import { z } from 'zod';
import { Immer } from 'immer';
import _ from 'lodash';
import type { AssetInfo, AssetRef, EditPreview, JsonMap } from '../../../packages/plugin-sdk/index.js';
import type { WorkspaceState } from '../../store/workspace-store';
import type { NormalizedCharacterCard, NormalizedLorebook, NormalizedPreset } from '../../types';
import { serializeCharacterCard, serializeEntry, serializeLorebook, serializeRegexRule } from '../../pipeline/asset-serializer';
import { normalizeCharacterCard, normalizeLorebook, normalizePreset } from '../../pipeline/normalizer';
import { rollbackStateChanges } from '../../store/state-rollback';
import { conflict, cursorSchema, idSchema, jsonEditsSchema, jsonObject, limitSchema, missing, operationSchema, page, patchObject, pathSchema, readJsonPath, signature, uidSchema } from './edits';
import { PluginApiError } from './errors';

const kindSchema = z.enum(['character', 'worldbook', 'preset']);
const ref = z.strictObject({ kind: kindSchema, id: idSchema, revision: idSchema });
export const assetEditSchema = z.strictObject({ operationId: operationSchema, edits: z.array(z.discriminatedUnion('type', [
    z.strictObject({ type: z.literal('patch'), asset: ref, edits: jsonEditsSchema }),
    z.strictObject({ type: z.literal('entry.put'), asset: ref, uid: uidSchema, document: z.unknown() }),
    z.strictObject({ type: z.literal('entry.remove'), asset: ref, uid: uidSchema }),
])).min(1).max(64) });
export type AssetRequest = z.infer<typeof assetEditSchema>;
export type Asset = { kind: 'character'; value: NormalizedCharacterCard } | { kind: 'worldbook'; value: NormalizedLorebook } | { kind: 'preset'; value: NormalizedPreset };
export const assetGrant = (asset: Pick<AssetRef, 'kind' | 'id'>) => `${asset.kind}:${asset.id}`;

function catalog(state: Pick<WorkspaceState, 'characters' | 'lorebooks' | 'presets'>, kind: AssetRef['kind']): Asset[] {
    if (kind === 'character') return state.characters.map(value => ({ kind, value }));
    if (kind === 'preset') return state.presets.map(value => ({ kind, value }));
    const books = new Map(state.characters.flatMap(card => [card.characterBook, card.embeddedLorebook]).filter((book): book is NormalizedLorebook => !!book).map(book => [book.id, book]));
    for (const book of state.lorebooks) books.set(book.id, book);
    return [...books.values()].map(value => ({ kind, value }));
}
export const resourceChoices = (state: Pick<WorkspaceState, 'characters' | 'lorebooks' | 'presets'>) => (['character', 'worldbook', 'preset'] as const)
    .flatMap(kind => catalog(state, kind).map(asset => ({ id: assetGrant({ kind, id: asset.value.id }), label: asset.value.name, kind })));
export const assetAt = (state: WorkspaceState, kind: AssetRef['kind'], id: string) => catalog(state, kind).find(asset => asset.value.id === id);
const cardData = (document: Record<string, unknown>) => document.data && typeof document.data === 'object' && !Array.isArray(document.data)
    ? document.data as Record<string, unknown> : document;
function documentOf(asset: Asset): Record<string, unknown> {
    if (asset.kind === 'worldbook') return serializeLorebook(asset.value);
    if (asset.kind === 'character') {
        const document = serializeCharacterCard(asset.value), data = cardData(document);
        for (const container of new Set([document, data])) {
            delete container.embeddedLorebook; delete container.characterBook; delete container.character_book;
        }
        const book = asset.value.characterBook ?? asset.value.embeddedLorebook;
        if (book) data.character_book = serializeLorebook(book);
        return document;
    }
    const preset = asset.value;
    const { prompt_order, prompts, ...raw } = preset.rawData ?? {};
    return { ...raw, name: preset.name, promptSlots: preset.promptSlots ?? preset.prompts ?? [],
        regexScripts: preset.regexScripts?.map(serializeRegexRule), parameters: preset.parameters, apiId: preset.apiId,
        temperature: preset.temperature, topP: preset.topP, topK: preset.topK, minP: preset.minP, repetitionPenalty: preset.repetitionPenalty,
        frequencyPenalty: preset.frequencyPenalty, presencePenalty: preset.presencePenalty, maxContextTokens: preset.maxContextTokens, maxResponseTokens: preset.maxResponseTokens };
}
const revisions = new WeakMap<object, Promise<string>>();
export async function assetInfo(asset: Asset): Promise<AssetInfo> {
    let revision = revisions.get(asset.value);
    if (!revision) { revision = signature(asset.value); revisions.set(asset.value, revision); }
    return { id: asset.value.id, name: asset.value.name, kind: asset.kind, revision: await revision };
}

export async function assetRead(state: WorkspaceState, method: string, args: unknown) {
    if (method === 'list') {
        const { kind, cursor, limit } = z.strictObject({ kind: kindSchema, cursor: cursorSchema, limit: limitSchema }).parse(args);
        const all = catalog(state, kind).sort((a, b) => a.value.id.localeCompare(b.value.id));
        const rows = page(all, cursor, limit, await signature(all.map(item => item.value.id)));
        return { ...rows, items: await Promise.all(rows.items.map(assetInfo)) };
    }
    if (method === 'get') {
        const { kind, id, path } = z.strictObject({ kind: kindSchema, id: idSchema, path: pathSchema.optional() }).parse(args);
        const asset = assetAt(state, kind, id);
        if (!asset) throw missing('资源');
        const document = documentOf(asset);
        if (kind === 'worldbook') delete document.entries;
        return { ...await assetInfo(asset), document: readJsonPath(document, path) };
    }
    const { id, revision, cursor, limit, uid, path } = z.strictObject({ id: idSchema, revision: idSchema.optional(), cursor: cursorSchema, limit: limitSchema,
        uid: uidSchema.optional(), path: pathSchema.optional() }).parse(args);
    const asset = assetAt(state, 'worldbook', id);
    if (!asset || asset.kind !== 'worldbook') throw missing('世界书');
    const version = await assetInfo(asset);
    if (revision !== undefined && revision !== version.revision) throw conflict();
    if (method === 'entry') {
        const entry = asset.value.entries.find(row => String(row.uid) === String(uid));
        if (!entry) throw missing('条目');
        return readJsonPath(serializeEntry(entry), path);
    }
    const rows = page(asset.value.entries, cursor, Math.min(limit ?? 12, 16), version.revision);
    return { ...rows, items: rows.items.map(entry => ({ uid: entry.uid, label: entry.comment, enabled: !entry.disabled,
        content: entry.content.slice(0, 10_000), keys: entry.keys, document: JSON.stringify(serializeEntry(entry)).length <= 20_000 ? serializeEntry(entry) : null })) };
}

interface LinkedBook { id: string; after?: Asset; grant?: AssetRef }
export interface AssetPlan { before: Asset[]; after: Asset[]; linked: LinkedBook[]; preview: EditPreview['changes'] }
const display = (value: unknown) => JSON.stringify(value ?? null).slice(0, 180);
export async function planAssets(state: WorkspaceState, input: AssetRequest, permit: (asset: AssetRef) => void): Promise<AssetPlan> {
    const before = new Map<string, Asset>(), after = new Map<string, Asset>(), expected = new Map<string, AssetInfo>(), preview: EditPreview['changes'] = [];
    for (const edit of input.edits) {
        permit(edit.asset);
        const key = assetGrant(edit.asset);
        let asset = after.get(key);
        if (!asset) {
            asset = assetAt(state, edit.asset.kind, edit.asset.id);
            if (!asset) throw missing('资源');
            before.set(key, asset); expected.set(key, await assetInfo(asset));
        }
        if (expected.get(key)?.revision !== edit.asset.revision) throw conflict();
        if (edit.type === 'patch') {
            const source = documentOf(asset), patched = patchObject(source, edit.edits);
            const { id, name } = asset.value;
            const next = asset.kind === 'character' ? { ...normalizeCharacterCard(patched), id, avatar: asset.value.avatar }
                : asset.kind === 'worldbook' ? { ...normalizeLorebook(patched, name), id } : { ...normalizePreset(patched, name), id };
            if (asset.kind === 'character') {
                const card = next as NormalizedCharacterCard;
                const prior = asset.value.characterBook ?? asset.value.embeddedLorebook;
                if (_.isEqual(cardData(source).character_book, card.embeddedLorebook ? serializeLorebook(card.embeddedLorebook) : undefined)) {
                    card.characterBook = asset.value.characterBook;
                    card.embeddedLorebook = asset.value.embeddedLorebook;
                } else if (card.embeddedLorebook) card.embeddedLorebook.id = prior?.id ?? `${id}:embedded`;
            }
            after.set(key, { kind: asset.kind, value: next } as Asset);
            for (const item of edit.edits) preview.push({ target: `${name} · ${item.path.join('.')}`,
                before: display(readJsonPath(source, item.path)), after: display(readJsonPath(patched, item.path)) });
        } else {
            if (asset.kind !== 'worldbook') throw new PluginApiError('INVALID_ARGUMENT', '这项改动只能用于世界书条目');
            const book = asset.value;
            const previous = book.entries.find(entry => String(entry.uid) === String(edit.uid));
            if (edit.type === 'entry.remove' && !previous) throw missing('条目');
            const entry = edit.type === 'entry.put' ? normalizeLorebook({ name: book.name, entries: [{ ...jsonObject(edit.document), uid: edit.uid }] }).entries[0]! : undefined;
            const entries = previous ? book.entries.flatMap(item => item === previous ? entry ? [entry] : [] : [item]) : [...book.entries, entry!];
            after.set(key, { kind: 'worldbook', value: { ...book, entries } });
            preview.push({ target: `${book.name} · ${entry?.comment ?? previous?.comment}`, before: previous ? display(serializeEntry(previous)) : '', after: entry ? display(serializeEntry(entry)) : '' });
        }
    }
    const linked: LinkedBook[] = [];
    for (const [key, asset] of before) if (asset.kind === 'character') {
        const next = after.get(key)!.value as NormalizedCharacterCard;
        const old = asset.value.characterBook ?? asset.value.embeddedLorebook;
        const book = next.characterBook ?? next.embeddedLorebook;
        if (old === book || !old && !book) continue;
        const id = (old ?? book)!.id;
        if (before.has(`worldbook:${id}`)) throw new PluginApiError('INVALID_ARGUMENT', '同一批改动请只选内嵌世界书的一个修改入口');
        const previous = assetAt(state, 'worldbook', id);
        const grant = previous && await assetInfo(previous);
        if (grant) permit(grant);
        linked.push({ id, after: book ? { kind: 'worldbook', value: book } : undefined, grant });
    }
    const proposed = new Map<string, Asset | undefined>([...after, ...linked.map(book => [`worldbook:${book.id}`, book.after] as const)]);
    for (const [key, asset] of proposed) {
        if (!asset || assetAt(state, asset.kind, asset.value.id)?.value.name === asset.value.name) continue;
        const peers = new Map(catalog(state, asset.kind).map(peer => [assetGrant({ kind: peer.kind, id: peer.value.id }), peer]));
        for (const [id, next] of proposed) if (next?.kind === asset.kind) peers.set(id, next); else if (!next) peers.delete(id);
        const name = asset.value.name.trim().normalize('NFC').toLocaleLowerCase();
        if (!name || [...peers].some(([id, peer]) => id !== key && peer.value.name.trim().normalize('NFC').toLocaleLowerCase() === name))
            throw new PluginApiError('INVALID_ARGUMENT', `已有同名资源「${asset.value.name}」，请改用另一个名称`);
    }
    return { before: [...before.values()], after: [...after.values()], linked, preview };
}

function publishAssets(draft: WorkspaceState, updates: Asset[], linked: LinkedBook[]) {
    const previousBooks = new Map(catalog(draft, 'worldbook').map(book => [book.value.id, book.value.name]));
    const books = new Map<string, NormalizedLorebook | null>();
    const names = new Map<string, string | null>();
    for (const asset of updates) if (asset.kind === 'character') {
        const next = asset.value;
        draft.characters = draft.characters.map(item => item.id === next.id ? next : item);
        if (draft.storyCharacter?.id === next.id) { draft.storyCharacter = next; draft.storyCharacterBinding = undefined; }
    }
    for (const book of linked) books.set(book.id, (book.after?.value as NormalizedLorebook | undefined) ?? null);
    for (const asset of updates) if (asset.kind === 'worldbook') books.set(asset.value.id, asset.value);
    if (books.size) {
        for (const [id, next] of books) {
            const name = previousBooks.get(id);
            if (name && name !== next?.name && ![...previousBooks].some(([peer, other]) => peer !== id && (books.has(peer) ? books.get(peer)?.name : other) === name)) {
                names.set(name, next?.name ?? null);
            }
        }
        draft.lorebooks = draft.lorebooks.flatMap(book => books.has(book.id) ? books.get(book.id) ? [books.get(book.id)!] : [] : [book]);
        for (const book of books.values()) if (book && !draft.lorebooks.some(item => item.id === book.id)) draft.lorebooks.push(book);
        draft.activeLorebookIds = draft.activeLorebookIds.filter(id => !books.has(id) || !!books.get(id));
        const renamed = (name: string | null) => name && names.has(name) ? names.get(name)! : name;
        const binding = (value: NonNullable<WorkspaceState['storyCharacterBinding']>) => ({
            primary: renamed(value.primary), additional: value.additional.flatMap(name => renamed(name) ?? []),
        });
        const updateCard = (card: NormalizedCharacterCard): NormalizedCharacterCard => {
            const oldBook = card.characterBook ?? card.embeddedLorebook;
            const next = oldBook && books.get(oldBook.id);
            const primary = card.primaryWorldbook;
            const replacement = typeof primary === 'string' ? renamed(primary) : primary && books.has(primary.id) ? books.get(primary.id) : primary;
            const additional = card.additionalWorldbooks;
            const extra = additional?.flatMap(name => renamed(name) ?? []);
            if (oldBook && books.has(oldBook.id)) card = { ...card,
                ...(card.characterBook ? { characterBook: next } : {}), ...(card.embeddedLorebook ? { embeddedLorebook: next } : {}) };
            if (replacement === primary && _.isEqual(additional, extra)) return card;
            const extensions = { ...card.extensions, world: typeof replacement === 'string' ? replacement : replacement?.name ?? '', extra_worlds: extra ?? [] };
            return { ...card, primaryWorldbook: replacement, additionalWorldbooks: extra, extensions };
        };
        draft.characters = draft.characters.map(updateCard);
        if (draft.storyCharacter) draft.storyCharacter = updateCard(draft.storyCharacter);
        if (draft.storyWorldbooks) draft.storyWorldbooks = draft.storyWorldbooks.flatMap(book => books.has(book.id) ? books.get(book.id) ? [books.get(book.id)!] : [] : [book]);
        if (names.size) {
            for (const [id, current] of Object.entries(draft.characterWorldbookBindings)) {
                const next = binding(current);
                if (!_.isEqual(current, next)) draft.characterWorldbookBindings[id] = next;
            }
            if (draft.storyCharacterBinding) draft.storyCharacterBinding = binding(draft.storyCharacterBinding);
            for (const [id, name] of Object.entries(draft.chatWorldbookBindings)) draft.chatWorldbookBindings[id] = renamed(name);
            const updatePersona = (persona: WorkspaceState['personas'][number]) => names.has(persona.lorebook)
                ? { ...persona, lorebook: renamed(persona.lorebook) ?? '' } : persona;
            draft.personas = draft.personas.map(updatePersona);
            if (draft.storyPersona) draft.storyPersona = updatePersona(draft.storyPersona);
            draft.templateActivations = draft.templateActivations.flatMap(item => names.has(item.world)
                ? renamed(item.world) ? [{ ...item, world: renamed(item.world)! }] : [] : [item]);
            const ordered = [...names].sort(([a], [b]) => b.length - a.length);
            draft.timedStates = Object.fromEntries(Object.entries(draft.timedStates).flatMap(([key, value]) => {
                const match = ordered.find(([name]) => key.startsWith(`${name}::`));
                return !match ? [[key, value]] : match[1] ? [[match[1] + key.slice(match[0].length), value]] : [];
            }));
        }
    }
    for (const asset of updates) if (asset.kind === 'preset') {
        const next = asset.value;
        draft.presets = draft.presets.map(item => item.id === next.id ? next : item);
        if (draft.activePresetId === next.id) draft.inUsePreset = next;
    }
}

const assetDraft = new Immer({ autoFreeze: false });
export const prepareAssetPublication = (state: WorkspaceState, plan: AssetPlan) =>
    assetDraft.produce<WorkspaceState, WorkspaceState>(state, draft => publishAssets(draft, plan.after, plan.linked));
const storyFields = ['storyCharacter', 'storyWorldbooks', 'storyCharacterBinding', 'storyPersona', 'timedStates', 'templateActivations'] as const;
const assetFields = ['characters', 'lorebooks', 'presets', 'inUsePreset', 'activeLorebookIds', 'characterWorldbookBindings', 'chatWorldbookBindings', 'personas', ...storyFields] as const;
export type NativeAssetPatch = Partial<Pick<WorkspaceState, typeof assetFields[number]>>;
export function assetPublication(before: WorkspaceState, after: WorkspaceState) {
    const keys = assetFields.filter(key => before[key] !== after[key]);
    const select = (state: WorkspaceState, fields = keys) => Object.fromEntries(fields.map(key => [key, state[key]])) as NativeAssetPatch;
    const validate = (current: WorkspaceState) => {
        if (keys.some(key => current[key] !== before[key]) || current.activePresetId !== before.activePresetId
            || current.activeChatId !== before.activeChatId || current.branchEpoch !== before.branchEpoch) throw conflict();
    };
    return { validate, patch: select(after), reverse(current: WorkspaceState) {
        const sameStory = current.activeChatId === before.activeChatId && current.branchEpoch === before.branchEpoch;
        const fields = keys.filter(key => (key !== 'inUsePreset' || current.activePresetId === before.activePresetId)
            && (sameStory || !storyFields.some(field => field === key)));
        return rollbackStateChanges(select(current, fields), select(before, fields), select(after, fields));
    } };
}

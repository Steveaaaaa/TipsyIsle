import type { NormalizedCharacterCard, UserPersona } from '../../types';
import type { ArchivedChat } from '../../store/chat-archives';
import { canonical, revise, type SyncState } from './protocol';

function guideContent(card: NormalizedCharacterCard): string {
    const value = structuredClone(card);
    delete (value as Partial<NormalizedCharacterCard>).id;
    // Older builds put the built-in ID only inside data; both forms describe the same card.
    if (value.rawData) delete value.rawData.id;
    return canonical(value);
}

export function remapGuidePersona(persona: UserPersona, aliases: Record<string, string>): void {
    for (const link of persona.connections) {
        if (link.type !== 'character') continue;
        if (aliases[link.id]) link.id = aliases[link.id];
        else if (link.id.endsWith('.png') && aliases[link.id.slice(0, -4)]) link.id = `${aliases[link.id.slice(0, -4)]}.png`;
    }
}

/** Repair only unchanged built-in guides. Ordinary imports and edited guides keep their identities. */
export function deduplicateGuides(state: SyncState, guide: NormalizedCharacterCard): Set<string> {
    const changed = new Set<string>();
    const targetId = `characters:${guide.id}`;
    const target = state.records[targetId];
    const content = guideContent(guide);
    const hasBinding = (id: string) => {
        const binding = state.records[`binding:${id}`]?.value ?? state.records[`characters:${id}`]?.links?.characterBinding;
        return binding && (binding.primary || binding.additional?.length);
    };
    if (target && (target.value === null || guideContent(target.value) !== content || hasBinding(guide.id))) return changed;
    const aliases = state.guideAliases ??= {};
    const update = (id: string, value: any, links = state.records[id]?.links) => {
        const version = state.records[id]?.version;
        revise(state, id, value, links);
        if (state.records[id].version !== version) changed.add(id);
    };
    for (const record of Object.values(state.records)) {
        if (!record.id.startsWith('characters:') || record.id === targetId || !record.value) continue;
        const card = record.value as NormalizedCharacterCard;
        if ((card.rawData?.data as { id?: string } | undefined)?.id !== guide.id || guideContent(card) !== content || hasBinding(card.id)
            || state.records[`gallery:${card.id}`]?.value) continue;
        if (!state.records[targetId]) update(targetId, structuredClone(guide), { characterBinding: null });
        aliases[card.id] = guide.id;
        update(record.id, null);
        if (state.records[`binding:${card.id}`]?.value) update(`binding:${card.id}`, null);
    }
    if (!Object.keys(aliases).length) return changed;
    for (const record of Object.values(state.records)) {
        if (!record.value) continue;
        if (record.id.startsWith('chat:')) {
            if (!aliases[record.value.characterId]) continue;
            const chat = structuredClone(record.value) as ArchivedChat;
            const oldId = chat.characterId;
            chat.characterId = aliases[oldId];
            const continuation = chat.continuation;
            if (continuation?.character) continuation.character.id = chat.characterId;
            if (continuation?.variables.character?.[oldId]) {
                continuation.variables.character[chat.characterId] = continuation.variables.character[oldId];
                delete continuation.variables.character[oldId];
            }
            if (continuation?.persona) remapGuidePersona(continuation.persona, aliases);
            update(record.id, chat);
        } else if (record.id.startsWith('personas:')) {
            const persona = structuredClone(record.value) as UserPersona;
            remapGuidePersona(persona, aliases);
            update(record.id, persona);
        }
    }
    state.conflicts = state.conflicts.filter(conflict => !changed.has(conflict.id) || state.records[conflict.id].value !== null);
    return changed;
}

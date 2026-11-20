import { isRetiredGuide, isRetiredPreset, removeStarterContinuation, RETIRED_GUIDE } from '../retired-starter-content';
import { revise, type SyncState } from './protocol';

export function retireStarterContent(state: SyncState): Set<string> {
    const changed = new Set<string>();
    const guideIds = new Set([RETIRED_GUIDE.id, ...state.retiredGuideIds ?? [], ...Object.keys(state.guideAliases ?? {})]);
    const update = (id: string, value: any) => {
        const previous = state.records[id];
        revise(state, id, value, previous?.links);
        if (previous !== state.records[id]) changed.add(id);
    };
    for (const record of Object.values(state.records)) {
        if (record.id.startsWith('characters:') && record.value) {
            if (isRetiredGuide(record.value)) { guideIds.add(record.value.id); update(record.id, null); }
            else guideIds.delete(record.value.id);
        }
        if (record.id.startsWith('presets:') && record.value && isRetiredPreset(record.value)) update(record.id, null);
    }
    state.retiredGuideIds = [...guideIds];
    for (const record of Object.values(state.records)) {
        if (!record.id.startsWith('chat:') || !record.value) continue;
        const chat = record.value;
        if (guideIds.has(chat.characterId) && chat.messages.length <= 1
            && chat.messages.every(message => message.role === 'assistant' && message.content === RETIRED_GUIDE.firstMessage)) { update(record.id, null); continue; }
        if (chat.continuation) {
            const continuation = removeStarterContinuation(chat.continuation);
            if (continuation !== chat.continuation) update(record.id, { ...chat, continuation });
        }
    }
    state.conflicts = state.conflicts.filter(item => !changed.has(item.id) || state.records[item.id].value !== null);
    return changed;
}

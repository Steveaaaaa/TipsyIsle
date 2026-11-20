import { isUnchangedBuiltinWorldbook, removeRetiredBuiltinWorldbooks } from '../builtin-worldbook';
import { revise, type SyncState } from './protocol';

/** Persist retirement as deletions so old paired devices cannot reintroduce it. */
export function retireBuiltinWorldbooks(state: SyncState): Set<string> {
    const changed = new Set<string>();
    const removed = new Set([...state.retiredWorldbookIds ?? [], ...Object.keys(state.worldbookAliases ?? {})]);
    const update = (id: string, value: any) => {
        const previous = state.records[id];
        revise(state, id, value, previous?.links);
        if (state.records[id] !== previous) changed.add(id);
    };
    for (const record of Object.values(state.records)) {
        if (!record.id.startsWith('lorebooks:') || !record.value) continue;
        if (!isUnchangedBuiltinWorldbook(record.value)) { removed.delete(record.value.id); continue; }
        removed.add(record.value.id);
        update(record.id, null);
    }
    state.retiredWorldbookIds = [...removed];
    for (const record of Object.values(state.records)) {
        if (!record.id.startsWith('chat:') || !record.value?.continuation) continue;
        const continuation = removeRetiredBuiltinWorldbooks(record.value.continuation, state.retiredWorldbookIds);
        if (continuation !== record.value.continuation) update(record.id, { ...record.value, continuation });
    }
    state.conflicts = state.conflicts.filter(conflict => !changed.has(conflict.id) || state.records[conflict.id].value !== null);
    for (const id of changed) if (state.records[id].value === null && state.worldbookReviews) delete state.worldbookReviews[id];
    return changed;
}

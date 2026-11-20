import { current, isDraft } from 'immer';
import _ from 'lodash';
const same = (a: unknown, b: unknown) => a === b || _.isEqual(a, b);
const plain = (value: any) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Undo only this operation's edits. Later edits to the same leaf win; unrelated
 * changes survive. Arrays with stable IDs (messages/cards/books) merge by ID. */
function undoValue(now: any, before: any, after: any): any {
    const value = isDraft(now) ? current(now) : now;
    if (same(value, after)) return before;
    if (same(before, after)) return value;
    if (Array.isArray(value) && Array.isArray(before) && Array.isArray(after)
        && [...value, ...before, ...after].every(item => plain(item) && typeof item.id === 'string')) {
        const previous = new Map(before.map(item => [item.id, item]));
        const changed = new Map(after.map(item => [item.id, item]));
        const present = new Set(value.map(item => item.id));
        const result = value.flatMap(item => {
            const old = previous.get(item.id); const written = changed.get(item.id);
            if (!old && written && same(item, written)) return [];
            return [old && written ? undoValue(item, old, written) : item];
        });
        for (const item of before) if (!changed.has(item.id) && !present.has(item.id)) {
            const nextId = before.slice(before.indexOf(item) + 1).find(next => result.some(candidate => candidate.id === next.id))?.id;
            const index = result.findIndex(candidate => candidate.id === nextId);
            result.splice(index < 0 ? result.length : index, 0, item);
        }
        return result;
    }
    if (!plain(value) || !plain(before) || !plain(after)) return value;
    const result = { ...value };
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
        if (same(before[key], after[key]) && Object.hasOwn(before, key) === Object.hasOwn(after, key)) continue;
        if (Object.hasOwn(result, key) !== Object.hasOwn(after, key)) continue;
        if (same(result[key], after[key])) {
            if (Object.hasOwn(before, key)) result[key] = before[key]; else delete result[key];
        } else if (Object.hasOwn(before, key) && Object.hasOwn(after, key)) result[key] = undoValue(result[key], before[key], after[key]);
    }
    return result;
}

export function rollbackStateChanges<S extends object>(now: S, before: S, after: S): S {
    return undoValue(now, before, after) as S;
}

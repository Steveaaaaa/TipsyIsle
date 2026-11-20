import _ from 'lodash';
import { jsonrepair } from 'jsonrepair';
import { parse as parseYaml } from 'yaml';
import JSON5 from 'json5';
import { normalizeMvuVariables, reconcileMvuVariables } from './mvu-data';
import { findUpdateMarkupBlocks } from './mvu-markup';
import { mvuJsonValue } from './mvu-values';
import type { NormalizedCharacterCard, NormalizedLorebook } from '../types';

const merge = (target: Record<string, any>, source: Record<string, any>) => _.mergeWith(target, source, (_a: any, b: any) => Array.isArray(b) ? structuredClone(b) : undefined);
function parseInitial(text: string, label: string): Record<string, any> {
    const initial = findUpdateMarkupBlocks(text, 'initial');
    if (initial.some(block => !block.closed)) throw new Error(`初始变量「${label}」的 initvar 标签不完整`);
    const contents = initial.length ? initial.map(block => text.slice(block.contentStart, block.contentEnd)) : [text];
    const result: Record<string, any> = {};
    for (const raw of contents) {
        const content = raw.trim().replace(/^```(?:json5?|ya?ml)?\s*/i, '').replace(/\s*```$/, '').trim();
        let value: any;
        if (/^[\[{]/.test(content)) {
            try { value = JSON5.parse(content); }
            catch { try { value = JSON.parse(jsonrepair(content)); } catch { value = parseYaml(content, { maxAliasCount: 100, merge: true }); } }
        } else {
            try { value = parseYaml(content, { maxAliasCount: 100, merge: true }); }
            catch { try { value = JSON5.parse(content); } catch { value = JSON.parse(jsonrepair(content)); } }
        }
        if (!_.isPlainObject(value)) throw new Error(`初始变量「${label}」必须为对象`);
        merge(result, mvuJsonValue(value));
    }
    return result;
}

/** Prepare all books before mutating the caller. Existing top-level values win;
 * entries inside one book deep-merge with replacement (not merging) of arrays. */
export function loadMvuInitialVariables(variables: Record<string, any>, books: NormalizedLorebook[], substitute: (text: string) => string = text => text): boolean {
    const source = variables.initialized_lorebooks;
    const initialized: Record<string, any[]> = Array.isArray(source) ? Object.fromEntries(source.map(name => [String(name), []]))
        : _.isPlainObject(source) ? structuredClone(source) : {};
    let next = structuredClone(variables);
    let changed = Array.isArray(source);
    for (const book of books) {
        if (Object.hasOwn(initialized, book.name)) continue;
        const merged: Record<string, any> = {};
        for (const entry of book.entries) if (/\[initvar\]/i.test(entry.comment)) merge(merged, parseInitial(substitute(entry.content), `${book.name}/${entry.comment}`));
        if (Object.keys(merged).length || next.stat_data) next.stat_data = { ...merged, ...next.stat_data };
        Object.defineProperty(initialized, book.name, { value: [], enumerable: true, configurable: true, writable: true });
        changed = true;
    }
    if (changed) {
        next.initialized_lorebooks = initialized;
        next = next.stat_data ? reconcileMvuVariables(next) : next;
        Object.assign(variables, next);
    }
    return changed;
}

export function readMvuGreetingVariables(text: string): Record<string, any> | undefined {
    return findUpdateMarkupBlocks(text, 'initial').length ? parseInitial(text, '开场白') : undefined;
}

/** MVU initvar entries supply data even when disabled for prompt scanning. */
export function readInitialVariables(card: NormalizedCharacterCard, books = [card.characterBook ?? card.embeddedLorebook].filter((book): book is NormalizedLorebook => !!book),
    substitute?: (text: string) => string): Record<string, any> {
    const extension = (card.extensions?.tavern_helper ?? card.extensions?.TavernHelper) as { variables?: Record<string, any> } | undefined;
    const variables = structuredClone(extension?.variables ?? {});
    loadMvuInitialVariables(variables, books, substitute);
    return normalizeMvuVariables(variables).variables;
}

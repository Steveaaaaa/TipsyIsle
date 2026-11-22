import type { NormalizedLorebook } from '../types';
import { compileMvuRegex } from './mvu-settings';

export interface MvuWorldbookFilter { primary: string | null; character: string[]; whitelist: string; blacklist: string; characterWhitelist?: string; characterBlacklist?: string; inlineMode?: boolean }
export function supportsMvuExtraAnalysis(books: NormalizedLorebook[], primary: string | null): boolean {
    return !!primary && !!books.find(book => book.name === primary)?.entries.some(entry => /\[mvu_(?:plot|update)\]/i.test(entry.comment));
}

const extraOnlyPlotLine = /^(?:[^\n]*(?:不得输出\s*<UpdateVariable>|不要在正文中主动写\s*<UpdateVariable>|本条只供\s*MVU\s*的额外变量模型使用|不输出\s*MVU\s*变量分析)[^\n]*)$/gim;

/** Match the pinned MVU stage rules on request-local books, retaining activation settings. */
export function filterMvuWorldbooks(books: NormalizedLorebook[], filter: MvuWorldbookFilter, extra: boolean, warn: (message: string) => void = () => {}): NormalizedLorebook[] {
    if (!supportsMvuExtraAnalysis(books, filter.primary)) return books;
    if (filter.inlineMode && !extra) {
        return books.map(book => {
            const hasActiveUpdate = book.entries.some(entry => !entry.disabled && /\[mvu_update\]/i.test(entry.comment));
            if (!hasActiveUpdate) return book;
            return {
                ...book,
                entries: book.entries.map(entry => {
                    if (!/\[mvu_(?:plot|update)\]/i.test(entry.comment)) return entry;
                    const cleaned = entry.content.replace(extraOnlyPlotLine, '').replace(/\n{3,}/g, '\n\n').trim();
                    return cleaned === entry.content ? entry : { ...entry, content: cleaned };
                }),
            };
        });
    }
    const compile = (source: string, label: string) => { const result = compileMvuRegex(source); if (result.error) warn(`${label}正则已忽略：${result.error}`); return result.regex; };
    const whitelist = extra ? [compile(filter.whitelist, '全局白名单'), compile(filter.characterWhitelist ?? '', '角色白名单')].filter((r): r is RegExp => !!r) : [];
    const blacklist = extra ? [compile(filter.blacklist, '全局黑名单'), compile(filter.characterBlacklist ?? '', '角色黑名单')].filter((r): r is RegExp => !!r) : [];
    const matches = (regex: RegExp, text: string) => { regex.lastIndex = 0; return regex.test(text); };
    return books.map(book => {
        const supported = book.entries.some(entry => /\[mvu_(?:plot|update)\]/i.test(entry.comment));
        if (extra && !supported && !filter.character.includes(book.name)) return { ...book, entries: [] };
        return { ...book, entries: book.entries.filter(entry => {
            const update = /\[mvu_update\]/i.test(entry.comment), plot = /\[mvu_plot\]/i.test(entry.comment);
            if (extra ? plot && !update : update && !plot) return false;
            return !extra || update || (!whitelist.length || whitelist.some(regex => matches(regex, entry.comment))) && !blacklist.some(regex => matches(regex, entry.comment));
        }) };
    });
}

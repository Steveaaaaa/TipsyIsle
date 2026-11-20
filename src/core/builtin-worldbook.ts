import { normalizeLorebook } from '../pipeline/normalizer';
import type { NormalizedLorebook } from '../types';
import { canonical } from './sync/protocol';

// Recognition data for removing the retired bundled book from older saves only.
const RETIRED_LOREBOOK = normalizeLorebook({
    id: 'wb_tipsy_isle_core',
    name: '微醺屿·世界与日常设定集',
    entries: {
        0: {
            uid: 0, comment: '微醺屿（TipsyIsle）空间设定',
            key: ['微醺屿', 'TipsyIsle', '酒馆', '工作台'], keysecondary: [], selectiveLogic: 0,
            content: '微醺屿（TipsyIsle）是面向角色扮演用户的阅读与对话应用，支持导入社区角色卡、世界书和预设。',
            constant: true, enabled: true, position: 'before_char', depth: 4, order: 100, sticky: 0, cooldown: 0, delay: 0,
        },
    },
});

function content(book: NormalizedLorebook): string {
    const { id: _id, rawData, ...value } = book;
    const { id: _rawId, ...raw } = rawData ?? {};
    return canonical({ ...value, rawData: raw });
}
const defaultContent = content(RETIRED_LOREBOOK);
export function isUnchangedBuiltinWorldbook(book: NormalizedLorebook): boolean {
    return book.name === RETIRED_LOREBOOK.name && content(book) === defaultContent;
}

interface WorldbookReferences {
    lorebooks?: NormalizedLorebook[];
    storyWorldbooks?: NormalizedLorebook[];
    worldbooks?: NormalizedLorebook[];
    activeLorebookIds?: string[];
}

/** Retire bundled content without deleting imported or user-edited worldbooks. */
export function removeRetiredBuiltinWorldbooks<T extends WorldbookReferences>(source: T, knownIds: string[] = []): T {
    const collections = ['lorebooks', 'worldbooks', 'storyWorldbooks'] as const;
    const books = collections.flatMap(key => source[key] ?? []);
    const removed = new Set(['wb_tipsy_isle_core', ...knownIds]);
    for (const book of books) if (isUnchangedBuiltinWorldbook(book)) removed.add(book.id);
    // A saved story can intentionally retain an edited version of an old ID.
    for (const book of books) if (!isUnchangedBuiltinWorldbook(book)) removed.delete(book.id);
    const patch: WorldbookReferences = {};
    for (const key of collections) {
        const current = source[key];
        if (current?.some(book => removed.has(book.id))) patch[key] = current.filter(book => !removed.has(book.id));
    }
    if (source.activeLorebookIds?.some(id => removed.has(id))) patch.activeLorebookIds = source.activeLorebookIds.filter(id => !removed.has(id));
    return Object.keys(patch).length ? { ...source, ...patch } : source;
}

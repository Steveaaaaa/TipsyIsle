import { removeLibraryWorldbook, workspaceStore, persistWorkspaceNow, worldbooksChanged, getAvailableWorldbooks, getCharacterWorldbooks,
    writeHelperWorldbook, replaceHelperGlobalWorldbookBindings, bindHelperCharacterWorldbooks, bindHelperChatWorldbook,
    updateWorldbookTimedEffects, getActiveChatMessages } from '../store/workspace-store';
import { normalizeLorebook } from '../pipeline/normalizer';
import { fromHelperWorldbookEntries, toHelperWorldbook, toNativeWorldbookEntry } from './worldbook-codec';
import type { NormalizedLorebook } from '../types';
import { fromLegacyWorldbookEntries, toLegacyWorldbook, filterLegacyEntries } from './legacy-worldbook-codec';
import _ from 'lodash';
import { characterAvatarId } from './asset-identity';
import { scopedVariableStore, replaceExtensionVariables } from '../store/scoped-variable-store';
import { defaultWorldinfoSettings } from '../pipeline/worldinfo-settings';
import { serializeLorebook } from '../pipeline/asset-serializer';
import { setSchemaValue, schemaRegistryStore } from '../registry/schema-registry';
import { WorldInfoTimedEffects } from '../pipeline/worldinfo-effects';
import { mvuCharacterConfigEntries, serializeMvuCharacterConfig } from '../pipeline/mvu-settings';

let settingsSources: unknown[] = [];
let cachedSettings: typeof defaultWorldinfoSettings & { selected_global_lorebooks: string[] };
export function worldinfoSettings() {
    const live = schemaRegistryStore.getState().values;
    const bindings = worldbookBindings();
    const sources = [live, scopedVariableStore.getState().extension.tipsy_worldinfo, bindings.global];
    if (cachedSettings && sources.every((value, index) => value === settingsSources[index])) return cachedSettings;
    settingsSources = sources;
    return cachedSettings = { ...defaultWorldinfoSettings, ...scopedVariableStore.getState().extension.tipsy_worldinfo,
        context_percentage: Number(live['lorebook.budget_percent'] ?? defaultWorldinfoSettings.context_percentage),
        scan_depth: Number(live['lorebook.scan_depth'] ?? 6), max_recursion_steps: Number(live['lorebook.max_recursion_steps'] ?? 4),
        selected_global_lorebooks: bindings.global };
}
export type ReturnWorldinfoSettings = ReturnType<typeof worldinfoSettings>;

export function allWorldbooks(): NormalizedLorebook[] {
    return getAvailableWorldbooks();
}
function find(name: string, required = true): NormalizedLorebook | undefined {
    if (typeof name !== 'string' || !name.trim()) throw new Error('世界书名称必须是非空字符串');
    const candidates = allWorldbooks().filter(book => book.name === name);
    if (candidates.length > 1) throw new Error(`存在同名世界书「${name}」，请先在资源中消除重名`);
    if (!candidates.length && required) throw new Error(`未能找到世界书「${name}」`);
    return candidates[0];
}
let bindingSources: unknown[] = [];
let cachedBindings: import('./contracts').WorldbookBindingsSnapshot;
export function worldbookBindings() {
    const state = workspaceStore.getState();
    const sources = [state.storyWorldbooks, state.storyCharacterBinding, state.characters, state.lorebooks, state.characterWorldbookBindings, state.activeLorebookIds,
        state.chatWorldbookBindings, state.activeChatId];
    if (cachedBindings && sources.every((value, index) => value === bindingSources[index])) return cachedBindings;
    bindingSources = sources;
    const byCharacter = Object.fromEntries(state.characters.map(card => [card.id, getCharacterWorldbooks(card, state)]));
    return cachedBindings = { names: [...new Set(allWorldbooks().map(book => book.name))], global: state.activeLorebookIds.flatMap(id => allWorldbooks().find(book => book.id === id)?.name ?? []),
        characters: state.characters.map(card => ({ id: card.id, name: card.name, avatar: characterAvatarId(card), books: byCharacter[card.id] })),
        chat: state.chatWorldbookBindings[state.activeChatId] ?? null };
}
function renderOption(options: any = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => key !== 'render') ||
        options.render !== undefined && !['immediate', 'debounced', 'none'].includes(options.render)) throw new Error('世界书 render 参数无效');
}
async function saved() { await persistWorkspaceNow(); worldbooksChanged(); }
function ensureCurrentChat(chat: unknown) { if (chat !== 'current') throw new Error('目前仅支持当前聊天世界书'); }
function names(values: unknown): string[] {
    if (!Array.isArray(values) || values.some(name => typeof name !== 'string')) throw new Error('世界书绑定必须是名称数组');
    values.forEach(name => find(name)); return [...new Set(values)];
}
/** Writes are serialized by the RPC adapter; updates also compare the exact read snapshot. */
let requests: Promise<unknown> = Promise.resolve();
// Immutable workspace book identities provide cheap revisions for Helper RPCs.
const helperBooks = new WeakMap<NormalizedLorebook, { entries: ReturnType<typeof toHelperWorldbook>; version: string }>();
let helperBookRevision = 0;
function helperBook(book: NormalizedLorebook) {
    let value = helperBooks.get(book);
    if (!value) {
        value = { entries: toHelperWorldbook(book), version: String(++helperBookRevision) };
        helperBooks.set(book, value);
    }
    return value;
}
export function requestWorldbook(method: string, params: Record<string, any>): Promise<unknown> {
    const session = workspaceStore.getState().activeChatId;
    const epoch = workspaceStore.getState().branchEpoch;
    const run = requests.then(() => {
        if (workspaceStore.getState().activeChatId !== session || workspaceStore.getState().branchEpoch !== epoch) throw new Error('世界书操作所属路线已切换');
        return executeWorldbookRequest(method, params);
    });
    requests = run.catch(() => {});
    return run;
}
function serializeNativeWorldbook(book: NormalizedLorebook) {
    return { ...serializeLorebook(book), entries: Object.fromEntries(book.entries.map(entry => [entry.uid, toNativeWorldbookEntry(entry)])) };
}

async function executeWorldbookRequest(method: string, params: Record<string, any>): Promise<unknown> {
    const state = workspaceStore.getState();
    if (method === 'worldbook.mvu.config') {
        const book = find(params.name)!;
        const content = serializeMvuCharacterConfig(String(params.content));
        const entries = toHelperWorldbook(book);
        const existing = mvuCharacterConfigEntries(book)[0];
        if (existing) entries.find(entry => entry.uid === Number(existing.uid))!.content = content;
        else entries.push({ uid: Math.max(-1, ...entries.map(entry => entry.uid)) + 1, name: '[config_override]', enabled: false, content } as any);
        writeHelperWorldbook(fromHelperWorldbookEntries(book, entries)); await saved(); return;
    }
    if (method === 'worldbook.effect.get' || method === 'worldbook.effect.set') {
        const book = find(params.name)!;
        const entry = book.entries.find(entry => String(entry.uid) === String(params.uid));
        if (!entry) throw new Error(`世界书条目不存在：${params.uid}`);
        const effects = new WorldInfoTimedEffects(book.entries.map(entry => ({ ...entry })), state.timedStates, getActiveChatMessages(state).length);
        const effect = String(params.effect);
        if (!effects.isValidEffectType(effect)) throw new Error(`未知世界书计时类型：${effect}`);
        const metadata = effects.getEffectMetadata(effect, entry);
        if (method.endsWith('.get')) return params.format === 'number' ? String(metadata ? metadata.end - getActiveChatMessages(state).length : 0) : String(!!metadata);
        if (!entry[effect]) throw new Error('请先在世界书中设置该条目的计时长度');
        const value = String(params.value).trim().toLowerCase();
        const enabled = ['toggle', 't', ''].includes(value) ? !metadata : /^(true|on|yes|1)$/.test(value) ? true : /^(false|off|no|0)$/.test(value) ? false : !!metadata;
        effects.setTimedEffect(effect, entry, enabled);
        updateWorldbookTimedEffects(effects.snapshot(), state.activeLeafId);
        await persistWorkspaceNow();
        return '';
    }
    if (method.startsWith('worldbook.native.')) {
        if (method === 'worldbook.native.list') {
            const seen = new Set<string>();
            return allWorldbooks()
                .filter(book => !seen.has(book.name) && !!seen.add(book.name))
                .map(book => ({
                    file_id: book.name,
                    name: book.name,
                    extensions: _.isPlainObject(book.rawData?.extensions) ? structuredClone(book.rawData!.extensions) : {},
                }))
                .sort((a, b) => a.name.localeCompare(b.name));
        }
        if (method === 'worldbook.native.load') {
            const book = params.name ? find(params.name, false) : undefined;
            return book ? serializeNativeWorldbook(book) : null;
        }
        if (method === 'worldbook.native.get') {
            const book = find(params.name, false);
            return book ? serializeNativeWorldbook(book) : { entries: {} };
        }
        if (method === 'worldbook.native.save') {
            if (!params.name || !params.data) return;
            const book = find(params.name, false);
            const previousDisabled = new Map(book?.entries.map(entry => [String(entry.uid), !!entry.disabled]));
            const entries = Object.values(params.data.entries ?? {}).map((entry: any) => {
                if (!entry || typeof entry !== 'object') return entry;
                const uidKey = entry.uid !== undefined ? String(entry.uid) : entry.id !== undefined ? String(entry.id) : undefined;
                const previous = uidKey !== undefined ? previousDisabled.get(uidKey) : undefined;
                let disablePatch: Record<string, boolean> | undefined;
                if (typeof entry.disable === 'boolean' && (previous === undefined || entry.disable === previous)) {
                    if (typeof entry.disabled === 'boolean' && entry.disabled !== entry.disable) disablePatch = { disable: entry.disabled };
                    else if (typeof entry.enabled === 'boolean' && entry.enabled === entry.disable) disablePatch = { disable: !entry.enabled };
                }
                const extensions = entry.position !== undefined ? { ...entry.extensions, position: entry.position } : entry.extensions;
                return { ...entry, ...disablePatch, ...(extensions !== undefined ? { extensions } : {}) };
            });
            const updated = normalizeLorebook({ ...params.data, name: params.name, entries }, params.name);
            writeHelperWorldbook({ ...updated, ...(book ? { id: book.id } : {}) }); await saved(); return;
        }
        const book = find(params.name)!;
        const document = serializeLorebook(book) as Record<string, any>;
        const entries: any[] = Object.values(document.entries ?? {});
        if (method === 'worldbook.native.read') return book.entries.map(toNativeWorldbookEntry);
        if (method === 'worldbook.native.create') {
            const used = new Set(entries.map(entry => Number(entry.uid ?? entry.id))); let uid = 0; while (used.has(uid)) uid++;
            entries.push({ uid, key: params.key ? [params.key] : [], keysecondary: [], comment: params.key ?? '', content: params.content ?? '',
                constant: false, selective: true, order: 100, position: 0, disable: false });
            writeHelperWorldbook({ ...normalizeLorebook({ ...document, name: book.name, entries }), id: book.id }); await saved(); return String(uid);
        }
        if (method !== 'worldbook.native.field') throw new Error(`未知世界书操作：${method}`);
        const entry = entries.find(entry => String(entry.uid ?? entry.id) === String(params.uid));
        if (!entry) throw new Error(`世界书条目不存在：${params.uid}`);
        const field = String(params.field);
        if (['__proto__', 'prototype', 'constructor', 'uid', 'id'].includes(field)) throw new Error('不可修改的世界书字段');
        let value: unknown = params.value;
        const booleanFields = new Set(['constant', 'selective', 'disable', 'excludeRecursion', 'preventRecursion', 'useProbability', 'groupOverride', 'useGroupScoring', 'caseSensitive', 'matchWholeWords', 'ignoreBudget', 'vectorized',
            'matchPersonaDescription', 'matchCharacterDescription', 'matchCharacterPersonality', 'matchCharacterDepthPrompt', 'matchScenario', 'matchCreatorNotes', 'characterFilterExclude']);
        const numberFields = new Set(['order', 'position', 'depth', 'role', 'probability', 'selectiveLogic', 'scanDepth', 'groupWeight', 'sticky', 'cooldown', 'delay', 'delayUntilRecursion']);
        const arrayFields = new Set(['key', 'keysecondary', 'triggers', 'characterFilterNames', 'characterFilterTags']);
        if (booleanFields.has(field)) value = value === 'null' && ['caseSensitive', 'matchWholeWords', 'useGroupScoring'].includes(field) ? null : /^(true|on|yes|1)$/i.test(String(value));
        else if (numberFields.has(field)) value = value === 'null' ? null : Number(value);
        else if (arrayFields.has(field)) { try { value = JSON.parse(String(value)); } catch { value = String(value).split(',').map(item => item.trim()).filter(Boolean); } }
        const filterFields: Record<string, string> = { characterFilterNames: 'names', characterFilterTags: 'tags', characterFilterExclude: 'isExclude' };
        if (filterFields[field]) (entry.characterFilter ??= { isExclude: false, names: [], tags: [] })[filterFields[field]] = value;
        else {
            entry[field] = value;
            const aliases: Record<string, string> = { position: 'position', scanDepth: 'scan_depth', caseSensitive: 'case_sensitive', matchWholeWords: 'match_whole_words', useGroupScoring: 'use_group_scoring' };
            if (aliases[field]) (entry.extensions ??= {})[aliases[field]] = value;
        }
        writeHelperWorldbook({ ...normalizeLorebook({ ...document, name: book.name, entries }), id: book.id }); await saved(); return '';
    }
    if (method === 'worldbook.settings') {
        const { selected_global_lorebooks, ...settings } = params.settings;
        replaceExtensionVariables('tipsy_worldinfo', { ...scopedVariableStore.getState().extension.tipsy_worldinfo, ...settings });
        if (settings.scan_depth !== undefined) setSchemaValue('lorebook.scan_depth', settings.scan_depth);
        if (settings.max_recursion_steps !== undefined) setSchemaValue('lorebook.max_recursion_steps', settings.max_recursion_steps);
        if (settings.context_percentage !== undefined) setSchemaValue('lorebook.budget_percent', settings.context_percentage);
        if (selected_global_lorebooks) replaceHelperGlobalWorldbookBindings(() => names(selected_global_lorebooks).map(name => find(name)!.id));
        await saved(); return;
    }
    if (method === 'worldbook.read') {
        const book = find(params.name)!;
        const current = helperBook(book);
        return params.version === current.version ? { version: current.version } : current;
    }
    if (method === 'worldbook.update') {
        renderOption(params.options);
        const book = find(params.name)!;
        const current = helperBook(book);
        if (params.version !== current.version) throw new Error('世界书已被其他操作修改，请重新读取后更新');
        const entries = [...current.entries];
        for (const change of params.changes) {
            if (!Number.isInteger(change.index) || !entries[change.index] || entries[change.index].uid !== change.uid) throw new Error('世界书更新条目不匹配');
            const entry = { ...entries[change.index], ...change.fields };
            for (const key of change.removed) delete entry[key];
            entries[change.index] = entry;
        }
        if (!_.isEqual(entries, current.entries)) {
            const updated = fromHelperWorldbookEntries(book, entries);
            writeHelperWorldbook(updated); await saved();
        }
        const updated = helperBook(find(params.name)!);
        // Return normalization changes too, without retransmitting unchanged content.
        const changes = updated.entries.flatMap((entry, index) => _.isEqual(entry, current.entries[index]) ? [] : [{ index, entry }]);
        return { version: updated.version, changes };
    }
    if (method.startsWith('worldbook.legacy.')) {
        const book = find(params.name)!;
        const entries = toLegacyWorldbook(book);
        if (method === 'worldbook.legacy.read') return { entries: filterLegacyEntries(entries, params.filter), version: JSON.stringify(book) };
        if (params.version !== undefined && params.version !== JSON.stringify(book)) throw new Error('世界书已被其他操作修改，请重新读取后更新');
        let next: Array<Record<string, any>>;
        const new_uids: number[] = [];
        let delete_occurred = false;
        if (method === 'worldbook.legacy.delete') {
            if (!Array.isArray(params.uids) || params.uids.some((uid: unknown) => !Number.isSafeInteger(uid))) throw new Error('旧版世界书删除参数必须为 UID 数组');
            next = entries.filter(entry => !params.uids.includes(entry.uid)); delete_occurred = next.length !== entries.length;
        } else {
            if (!Array.isArray(params.entries)) throw new Error('旧版世界书条目必须是数组');
            if (method === 'worldbook.legacy.replace') next = params.entries;
            else if (method === 'worldbook.legacy.set') {
                next = structuredClone(entries);
                for (const patch of params.entries) {
                    if (!patch || typeof patch !== 'object' || !Number.isSafeInteger(patch.uid)) throw new Error('修改条目必须包含 UID');
                    const target = next.find(entry => entry.uid === patch.uid);
                    if (target) _.merge(target, patch);
                }
            } else if (method === 'worldbook.legacy.append') {
                const used = new Set(entries.map(entry => entry.uid));
                let candidate = 0;
                const added = params.entries.map((entry: any) => {
                    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('新增条目必须为对象');
                    while (used.has(candidate)) candidate++;
                    if (candidate >= 1_000_000) throw new Error('世界书没有可用 UID');
                    const uid = candidate++; used.add(uid); new_uids.push(uid); return { ...entry, uid };
                });
                next = [...entries, ...added];
            } else throw new Error(`未知旧版世界书接口：${method}`);
        }
        const updated = fromLegacyWorldbookEntries(book, next);
        writeHelperWorldbook(updated); await saved();
        return { entries: toLegacyWorldbook(updated), new_uids, delete_occurred };
    }
    if (method === 'worldbook.bindGlobal') {
        const selected = names(params.names);
        replaceHelperGlobalWorldbookBindings(() => selected.map(name => find(name)!.id));
        await saved(); return;
    }
    if (method === 'worldbook.bindCharacter') {
        const candidates = state.characters.filter(card => params.character === 'current' ? card.id === state.activeCharacterId : [card.id, card.name, characterAvatarId(card)].includes(params.character));
        if (candidates.length !== 1) throw new Error(`角色不存在或名称不唯一：${params.character}`);
        const binding = params.books;
        if (!binding || (binding.primary !== null && typeof binding.primary !== 'string')) throw new Error('角色世界书 primary 必须是名称或 null');
        if (binding.primary !== null) find(binding.primary);
        const additional = names(binding.additional);
        bindHelperCharacterWorldbooks(candidates[0].id, binding.primary, additional);
        await saved(); return;
    }
    if (method === 'worldbook.bindChat' || method === 'worldbook.getOrCreateChat') {
        ensureCurrentChat(params.chat);
        if (method === 'worldbook.bindChat' && params.name === null) {
            bindHelperChatWorldbook(state.activeChatId, null);
            await saved(); return;
        }
        const existing = state.chatWorldbookBindings[state.activeChatId];
        if (method.endsWith('getOrCreateChat') && existing && find(existing, false)) return existing;
        const name = method.endsWith('bindChat') ? params.name : params.name ?? `Chat_${state.activeChatId}`;
        if (!find(name, false)) {
            if (method.endsWith('bindChat')) throw new Error(`未能找到世界书「${name}」`);
            writeHelperWorldbook(normalizeLorebook({ name, entries: [] }));
        }
        bindHelperChatWorldbook(state.activeChatId, name);
        await saved(); return method.endsWith('getOrCreateChat') ? name : undefined;
    }
    const book = find(params.name, false);
    if (method === 'worldbook.delete') {
        if (!book) return false;
        removeLibraryWorldbook(book.id);
        await saved(); return true;
    }
    renderOption(params.options);
    if (method === 'worldbook.create' && book) return false;
    if (method === 'worldbook.replace' && !book) throw new Error(`未能找到世界书「${params.name}」`);
    if (method === 'worldbook.append' && !book) throw new Error(`未能找到世界书「${params.name}」`);
    if (params.entries !== undefined && !Array.isArray(params.entries)) throw new Error('世界书条目必须是数组');
    if (['worldbook.append', 'worldbook.replace'].includes(method) && !Array.isArray(params.entries)) throw new Error('世界书条目必须是数组；updater 必须返回条目数组');
    if (!['worldbook.create', 'worldbook.createOrReplace', 'worldbook.replace', 'worldbook.append'].includes(method)) throw new Error(`未知世界书操作：${method}`);
    if (params.version !== undefined && (!book || params.version !== helperBook(book).version)) throw new Error('世界书已被其他操作修改，请重新读取后更新');
    const source = book ?? normalizeLorebook({ name: params.name, entries: [] });
    const values = method === 'worldbook.append' ? [...toHelperWorldbook(source), ...params.entries] : params.entries ?? [];
    // Chapter controllers often toggle entries already in the requested state.
    // Keep version validation above, but avoid publishing and persisting an
    // unchanged book (which also invalidates character and template resources).
    if (book && method === 'worldbook.replace' && _.isEqual(values, toHelperWorldbook(book))) return values;
    const updated = fromHelperWorldbookEntries(source, values);
    const worldbook = toHelperWorldbook(updated);
    writeHelperWorldbook(updated); await saved();
    if (method === 'worldbook.replace') return worldbook;
    if (method === 'worldbook.append') return { worldbook, new_entries: worldbook.slice(source.entries.length) };
    return !book;
}

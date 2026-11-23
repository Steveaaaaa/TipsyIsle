import { workspaceStore, getActiveCharacter, getActivePreset, getCharacterWorldbooks, updateCharacterDocument, persistWorkspaceNow,
    worldbooksChanged, selectPreset, applyPresetSettings, deleteWorkspaceCharacter, setHelperCharacterAvatar, addHelperCharacter,
    importHelperCharacter, importHelperWorldbook, writeHelperPreset, removeHelperPreset, renameHelperPreset } from '../store/workspace-store';
import { normalizeCharacterCard, normalizeLorebook, normalizePreset } from '../pipeline/normalizer';
import { importCharacterFile } from '../core/character-import';
import { serializeCharacterCard, serializeRegexRule } from '../pipeline/asset-serializer';
import { characterAvatarId } from './asset-identity';
import { fromTavernRegexes, toTavernRegex } from './regex-codec';
import { defaultHelperPreset, fromHelperPreset, toHelperPreset } from './preset-codec';
import type { NormalizedCharacterCard, NormalizedPreset } from '../types';
import { getSchemaValues, schemaRegistryStore } from '../registry/schema-registry';

export function findHelperCharacter(name: string): NormalizedCharacterCard | undefined {
    return name === 'current' ? getActiveCharacter() : workspaceStore.getState().characters.find(card => [card.id, card.name, characterAvatarId(card)].includes(name));
}
function characterData(card: NormalizedCharacterCard) {
    return { avatar: characterAvatarId(card), version: card.characterVersion, creator: card.creator ?? '', creator_notes: card.creatorNotes,
        worldbook: getCharacterWorldbooks(card).primary, description: card.description, first_messages: [card.firstMessage, ...card.alternateGreetings],
        extensions: { ...structuredClone(card.extensions ?? {}), tavern_helper: { scripts: [], variables: {}, ...(card.extensions?.tavern_helper as object ?? {}) }, regex_scripts: card.regexScripts.map(toTavernRegex) } };
}
let previousSources: unknown[] = []; let cachedCatalog: ReturnType<typeof buildCatalog>;
const rawCharacters = new WeakMap<NormalizedCharacterCard, any>();
const helperPresets = new WeakMap<NormalizedPreset, ReturnType<typeof toHelperPreset>>();
let characterSource: unknown; let characterList: Array<{ id: string; avatar: string; name: string; image: string; raw: any }> = [];
let presetSource: unknown; let presetList: Array<{ id: string; name: string; data: ReturnType<typeof toHelperPreset> }> = [];
function presetData(preset: NormalizedPreset) {
    let value = helperPresets.get(preset);
    if (!value) { value = toHelperPreset(preset); helperPresets.set(preset, value); }
    return value;
}
function rawCharacter(card: NormalizedCharacterCard) {
    let value = rawCharacters.get(card);
    if (!value) {
        const slimCard: NormalizedCharacterCard = {
            ...card,
            embeddedLorebook: null,
            characterBook: null,
            extensions: card.extensions ? Object.fromEntries(Object.entries(card.extensions).filter(([k]) => k !== 'tavern_helper')) : undefined,
        };
        const raw = serializeCharacterCard(slimCard); const data = raw.data ?? raw;
        if (data && typeof data === 'object') delete (data as Record<string, unknown>).character_book;
        delete raw.character_book;
        value = { ...raw, ...data as object, name: card.name, avatar: characterAvatarId(card), data, creatorcomment: card.creatorNotes };
        rawCharacters.set(card, value);
    }
    return value;
}
function buildCatalog() {
    const state = workspaceStore.getState();
    if (characterSource !== state.characters) { characterSource = state.characters; characterList = state.characters.map(card => ({ id: card.id, avatar: characterAvatarId(card), name: card.name, image: card.avatar, raw: rawCharacter(card) })); }
    if (presetSource !== state.presets) { presetSource = state.presets; presetList = state.presets.map(preset => ({ id: preset.id, name: preset.name, data: presetData(preset) })); }
    const active = presetData(getActivePreset()); const live = getSchemaValues();
    const settings = { ...active.settings };
    for (const [name, key] of Object.entries({ max_context: 'sampler.context_max_tokens', max_completion_tokens: 'sampler.max_tokens', should_stream: 'api.stream',
        temperature: 'sampler.temperature', frequency_penalty: 'sampler.frequency_penalty', presence_penalty: 'sampler.presence_penalty', top_p: 'sampler.top_p', top_k: 'sampler.top_k', min_p: 'sampler.min_p', reasoning_effort: 'sampler.reasoning_effort' })) {
        if (live[key] !== undefined) settings[name] = live[key];
    }
    return { characters: characterList, presets: presetList,
        loadedPresetName: state.presets.find(item => item.id === state.activePresetId)?.name ?? '', inUsePreset: { ...active, settings } };
}
export function assetCatalog() {
    const state = workspaceStore.getState();
    const sources = [state.characters, state.presets, state.activePresetId, state.inUsePreset, schemaRegistryStore.getState().values];
    if (!cachedCatalog || sources.some((value, i) => value !== previousSources[i])) { cachedCatalog = buildCatalog(); previousSources = sources; }
    return cachedCatalog;
}
export type AssetCatalog = ReturnType<typeof buildCatalog>;

async function writeCharacter(name: string, value: Record<string, any>, previous?: NormalizedCharacterCard) {
    const document = previous ? serializeCharacterCard(previous) : { spec: 'chara_card_v3', spec_version: '3.0', data: { name: name.replace(/\.png$/i, '') } };
    const data = (document.data ?? document) as Record<string, any>;
    for (const [source, target] of Object.entries({ version: 'character_version', creator: 'creator', creator_notes: 'creator_notes', description: 'description' })) {
        if (value[source] !== undefined) data[target] = value[source];
    }
    if (value.first_messages !== undefined) { data.first_mes = value.first_messages[0] ?? ''; data.alternate_greetings = value.first_messages.slice(1); }
    for (const key of ['firstMessage', 'alternateGreetings', 'characterVersion', 'creatorNotes']) delete data[key];
    if (value.extensions?.regex_scripts !== undefined) { delete data.regexScripts; delete data.regex_scripts; }
    data.extensions = { ...data.extensions, ...value.extensions };
    if (value.extensions?.regex_scripts !== undefined) data.extensions.regex_scripts = fromTavernRegexes(value.extensions.regex_scripts, previous?.regexScripts).map(serializeRegexRule);
    if (value.worldbook !== undefined) data.extensions.world = value.worldbook ?? '';
    let avatar = previous?.avatar;
    if (value.avatar instanceof Blob) avatar = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error); reader.readAsDataURL(value.avatar);
    });
    if (previous) {
        updateCharacterDocument(previous.id, document);
        if (avatar !== previous.avatar) setHelperCharacterAvatar(previous.id, avatar!);
    } else {
        const card = normalizeCharacterCard(document); card.id = name.endsWith('.png') ? name : `${name}.png`;
        if (avatar) card.avatar = avatar;
        addHelperCharacter(card);
    }
}
export async function requestAsset(method: string, params: Record<string, any>): Promise<unknown> {
    const state = workspaceStore.getState(); const name = String(params.name ?? '');
    if (method.startsWith('asset.import.')) {
        const kind = method.slice('asset.import.'.length);
        if (kind === 'character') {
            const content: Blob = params.content;
            const bytes = new Uint8Array(await content.slice(0, 8).arrayBuffer());
            const png = bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78;
            const previous = findHelperCharacter(`${name.replace(/\.(png|json)$/i, '')}.png`) ?? findHelperCharacter(name.replace(/\.(png|json)$/i, ''));
            const card = await importCharacterFile(content, png);
            card.id = previous?.id ?? `${name.replace(/\.(png|json)$/i, '')}.png`;
            importHelperCharacter(card, previous);
        } else if (kind === 'preset') {
            const previous = state.presets.find(item => item.name === name);
            const preset = normalizePreset({ ...JSON.parse(params.content), name }, name);
            preset.id = previous?.id ?? `preset_${crypto.randomUUID()}`;
            writeHelperPreset(preset, previous?.id);
        } else if (kind === 'worldbook') {
            const previous = state.lorebooks.find(item => item.name === name);
            const book = normalizeLorebook({ ...JSON.parse(params.content), name }, name); book.id = previous?.id ?? book.id;
            importHelperWorldbook(book, previous?.id);
        } else throw new Error(`未知导入类型：${kind}`);
        await persistWorkspaceNow(); worldbooksChanged(); return true;
    }
    if (method.startsWith('asset.character.')) {
        const previous = findHelperCharacter(name);
        const operation = method.slice('asset.character.'.length);
        if (operation === 'get') { if (!previous) throw new Error(`找不到角色：${name}`); return characterData(previous); }
        if (operation === 'delete') return previous ? deleteWorkspaceCharacter(previous.id, !!params.options?.delete_chats) : false;
        if (operation === 'create' && (previous || name === 'current')) return false;
        if (operation === 'replace' && !previous) throw new Error(`找不到角色：${name}`);
        if (!name.trim()) throw new Error('角色名称不能为空');
        await writeCharacter(name, params.value ?? {}, previous);
        await persistWorkspaceNow(); worldbooksChanged();
        return operation === 'replace' ? undefined : !previous;
    }
    if (!method.startsWith('asset.preset.')) throw new Error(`未知资源接口：${method}`);
    const operation = method.slice('asset.preset.'.length);
    const previous = name === 'in_use' ? getActivePreset() : state.presets.find(item => item.name === name);
    if (operation === 'load') { if (!previous || name === 'in_use') return false; selectPreset(previous.id); await persistWorkspaceNow(); return true; }
    if (operation === 'delete') {
        if (!previous || name === 'in_use' || state.presets.length === 1) return false;
        removeHelperPreset(previous.id, state.activePresetId === previous.id);
    } else if (operation === 'rename') {
        if (!previous || name === 'in_use' || !params.newName?.trim() || params.newName === 'in_use' || state.presets.some(item => item.name === params.newName)) return false;
        renameHelperPreset(previous.id, params.newName);
    } else {
        if (operation === 'create' && (previous || name === 'in_use')) return false;
        if (operation === 'replace' && !previous) throw new Error(`找不到预设：${name}`);
        if (!name.trim()) throw new Error('预设名称不能为空');
        const input = params.value ?? defaultHelperPreset;
        const next = fromHelperPreset({ ...input, settings: { ...(name === 'in_use' ? assetCatalog().inUsePreset.settings : previous ? toHelperPreset(previous).settings : {}), ...input.settings } }, previous?.name ?? name, previous);
        writeHelperPreset(next, previous?.id, name === 'in_use');
        if (name === 'in_use' || !state.inUsePreset && state.activePresetId === next.id) applyPresetSettings(next);
        await persistWorkspaceNow(); worldbooksChanged();
        return operation === 'replace' ? undefined : !previous;
    }
    await persistWorkspaceNow(); worldbooksChanged(); return true;
}

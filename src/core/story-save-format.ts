import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { normalizeChatPayload } from '../pipeline/normalizer';
import { normalizeMvuVariables } from '../pipeline/mvu-data';
import type { ArchivedChat } from '../store/chat-archives';
import type { BranchState } from '../store/branch-state';
import { swipeId } from '../store/chat-tree';
import type { ChatMessageNode, NormalizedCharacterCard } from '../types';
import { packSyncImages, unpackSyncImages } from './snapshot-codec';

export const storySaveLimit = 96 * 1024 * 1024;
export const storySaveExtension = '.tipsy-story';
const format = 'tipsy-story';
type Bag = Record<string, any>;
const object = (value: unknown): Bag => value && typeof value === 'object' && !Array.isArray(value) ? value as Bag : {};
const text = (value: unknown) => typeof value === 'string' ? value : '';
const pick = (value: unknown, keys: string[]) => Object.fromEntries(keys.filter(key => Object.hasOwn(object(value), key)).map(key => [key, object(value)[key]]));
type Continuation = NonNullable<ArchivedChat['continuation']>;
const sensitive = /^(?:api[-_ ]?key|api[-_ ]?token|access[-_ ]?token|refresh[-_ ]?token|client[-_ ]?secret|authorization|password|apikeys|secrets?)$/i;
const storySettings = /^(?:sampler\.|lorebook\.|mvu\.(?:mode|automatic|update_chat|sendas_assistant|prompt_strategy|random_header|disable_thinking|pseudo_stream)$)/;

export interface TavernStory {
    kind: 'tavern'; fingerprint: string; characterName: string; userName: string;
    messages: ChatMessageNode[]; variables: Bag; variableReplies: number; candidates: number;
    quickReply?: Bag; hasOtherMetadata: boolean;
}
export interface TipsyStory {
    kind: 'tipsy'; fingerprint: string; chat: ArchivedChat; character: NormalizedCharacterCard;
}
export type StoryImport = TavernStory | TipsyStory;

// Export story data without device connection settings or plugin-owned storage.
function portableStory(source: ArchivedChat, card: NormalizedCharacterCard) {
    const seen = new WeakMap<object, any>();
    const clean = (value: any): any => {
        if (!value || typeof value !== 'object') return value;
        if (seen.has(value)) return seen.get(value);
        if (Array.isArray(value)) { const next: any[] = []; seen.set(value, next); for (const item of value) next.push(clean(item)); return next; }
        const next = Object.create(null);
        seen.set(value, next);
        for (const [key, item] of Object.entries(value)) if (!sensitive.test(key) && !['__proto__', 'prototype', 'constructor'].includes(key)) next[key] = clean(item);
        return next;
    };
    const limit = (value: Continuation): Continuation => {
        const quickReply = value.extensions?.quickReplyV2?.chatConfigs?.[source.id];
        return { ...value, portable: true, nativePluginRoute: undefined, extensionKeys: [],
        variables: { ...value.variables, global: {}, chat: { [source.id]: value.variables.chat?.[source.id] ?? {} } },
        settings: Object.fromEntries(Object.entries(value.settings ?? {}).filter(([key]) => storySettings.test(key))),
        extensions: Array.isArray(quickReply?.setList) ? { quickReplyV2: { chatConfigs: { [source.id]: quickReply } } } : {} };
    };
    const points = (states?: Record<string, BranchState>) => states && Object.fromEntries(Object.entries(states).map(([id, point]) => [id, { ...point, continuation: limit(point.continuation) }]));
    return clean({ character: card, chat: { ...source, importedFrom: undefined,
        continuation: source.continuation && limit(source.continuation), messages: source.messages.map(node => ({ ...node,
            nativePluginReplies: undefined, nativePluginOpeningRoutes: undefined, nativeRouteAnchors: undefined,
            branchBases: points(node.branchBases), branchStates: points(node.branchStates) })) } }) as { chat: ArchivedChat; character: NormalizedCharacterCard };
}

async function fingerprint(bytes: Uint8Array<ArrayBuffer>) {
    const hash = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}

function readTavern(source: string, hash: string): TavernStory {
    const rows: Bag[] = [];
    let header: Bag = {};
    let foundHeader = false;
    let characterName = '';
    let variableReplies = 0;
    for (const [index, line] of source.replace(/^\uFEFF/, '').split(/\r?\n/).entries()) {
        if (!line.trim()) continue;
        let row: Bag;
        try { row = object(JSON.parse(line)); }
        catch { throw new Error(`第 ${index + 1} 行不是有效的 JSON。请从酒馆重新导出聊天。`); }
        if (row.is_group === true || row.group_id != null || row.original_avatar || object(row.chat_metadata).group_id != null) {
            throw new Error('首版只支持单角色聊天，暂不能导入群聊。');
        }
        if (!foundHeader && !rows.length && !('mes' in row) && ('chat_metadata' in row || 'user_name' in row || 'character_name' in row)) {
            header = row; foundHeader = true; continue;
        }
        if (typeof row.mes !== 'string') throw new Error(`第 ${index + 1} 行缺少聊天正文。请从酒馆重新导出聊天。`);
        if (!characterName && !row.is_user && !row.is_system) characterName = text(row.name);
        const swipes = Array.isArray(row.swipes) && row.swipes.length && row.swipes.every((item: unknown) => typeof item === 'string') ? [...row.swipes] as string[] : [row.mes];
        const selected = Number.isInteger(row.swipe_id) && row.swipe_id >= 0 && row.swipe_id < swipes.length ? row.swipe_id : 0;
        swipes[selected] = row.mes;
        const saved = Array.isArray(row.variables) ? row.variables : { [selected]: row.variables };
        const variables = swipes.map((_, i) => {
            const info = object(row.swipe_info?.[i]);
            const value = { ...object(i === selected ? object(row.extra).variables : undefined), ...object(info.variables), ...object(object(info.extra).variables), ...object(saved[i]) };
            if (Object.keys(value).length) variableReplies++;
            return normalizeMvuVariables(value).variables;
        });
        rows.push({ uid: `msg_${crypto.randomUUID()}`, mes: row.mes, name: row.name,
            is_user: row.is_user === true, send_date: typeof row.send_date === 'number' && Number.isFinite(new Date(row.send_date).getTime()) ? new Date(row.send_date).toISOString() : row.send_date,
            swipes, swipe_id: selected, variables, variables_initialized: row.variables_initialized,
            extra: pick(row.extra, ['reasoning', 'bias', 'type']), swipe_info: swipes.map((_, i) => {
                const info = object(row.swipe_info?.[i]);
                return { ...pick(info, ['send_date']), ...pick(info.extra, ['reasoning', 'bias', 'type']), ...pick(info, ['reasoning']) };
            }), hidden: row.is_system === true || row.is_hidden === true });
    }
    if (!rows.length) throw new Error('没有读到聊天消息。请在酒馆中选择「导出为 JSONL」。');
    const metadata = object(header.chat_metadata);
    const variables = normalizeMvuVariables(object(metadata.variables)).variables;
    const messages = normalizeChatPayload(rows);
    for (const [index, message] of messages.entries()) {
        message.isHidden = rows[index].hidden;
        message.swipeIds = message.swipes.map((_, swipe) => swipeId(message, swipe));
        if (index) message.parentSwipeId = swipeId(messages[index - 1]);
        // Only the selected timeline has a known set of chat variables, at its latest floor.
        const last = index === messages.length - 1;
        const bySwipe = object(message.extra?.swipeVariables);
        const active = object(bySwipe[message.activeSwipeIndex]);
        message.extra = { ...message.extra, ...(last ? { chatVariables: variables } : {}), variables: active,
            swipeVariables: Object.fromEntries(Object.entries(bySwipe).filter(([, value]) => Object.keys(object(value)).length)) };
    }
    return { kind: 'tavern', fingerprint: hash, characterName: (text(header.character_name) === 'unused' ? '' : text(header.character_name)) || characterName,
        userName: text(header.user_name) === 'unused' ? '' : text(header.user_name), messages, variables, variableReplies,
        candidates: messages.reduce((total, node) => total + node.swipes.length - 1, 0), hasOtherMetadata: Object.keys(metadata).some(key => !['variables', 'quickReply', 'integrity'].includes(key)),
        quickReply: Array.isArray(metadata.quickReply?.setList) ? { setList: metadata.quickReply.setList } : undefined };
}

function readTipsy(bytes: Uint8Array, hash: string): TipsyStory {
    let inflated = 0;
    const files = unzipSync(bytes, { filter: file => {
        if (!['manifest.json', 'story.json'].includes(file.name)) return false;
        inflated += file.originalSize;
        if (inflated > storySaveLimit * 3) throw new Error('解压后的故事存档太大。');
        return true;
    } });
    if (!files['manifest.json'] || !files['story.json']) throw new Error('故事存档缺少必要文件。');
    const manifest = JSON.parse(strFromU8(files['manifest.json']));
    if (manifest?.format !== format) throw new Error('这不是 TipsyIsle 故事存档。');
    if (manifest.version !== 1) throw new Error('不支持这个故事存档版本，请更新 TipsyIsle 后重试。');
    const envelope = JSON.parse(strFromU8(files['story.json']));
    if (envelope?.$format !== 'tipsy-sync-images-v2') throw new Error('无法读取存档内容。');
    const { chat, character } = unpackSyncImages(envelope) as TipsyStory;
    if (!character?.id || typeof character.name !== 'string' || !Array.isArray(character.regexScripts) || !Array.isArray(character.alternateGreetings)
        || !chat?.id || chat.characterId !== character.id || !Array.isArray(chat.messages) || !chat.messages.length
        || !chat.continuation?.variables || !Array.isArray(chat.continuation.activeLorebookIds)) throw new Error('存档缺少角色或故事数据。');
    const nodes = new Map<string, ChatMessageNode>();
    for (const node of chat.messages) {
        if (!node?.id || nodes.has(node.id) || !node.swipes?.length || !Number.isInteger(node.activeSwipeIndex) || !node.swipes[node.activeSwipeIndex] && node.swipes[node.activeSwipeIndex] !== '') {
            throw new Error('存档的回复版本不完整。');
        }
        nodes.set(node.id, node);
    }
    const visited = new Set<string>();
    for (const node of chat.messages) {
        const path = new Set<string>();
        let current: ChatMessageNode | undefined = node;
        while (current && !visited.has(current.id)) {
            if (path.has(current.id)) throw new Error('存档的路线形成了循环。');
            path.add(current.id);
            const parent = current.parentId ? nodes.get(current.parentId) : undefined;
            if (current.parentId && (!parent || current.parentSwipeId && !parent.swipes.some((_, i) => swipeId(parent, i) === current!.parentSwipeId))) {
                throw new Error('存档的路线缺少关联的回复。');
            }
            current = parent;
        }
        for (const id of path) visited.add(id);
    }
    if (!chat.activeLeafId || !nodes.has(chat.activeLeafId)) throw new Error('存档缺少当前路线。');
    return { kind: 'tipsy', fingerprint: hash, ...portableStory(chat, character) };
}

export async function decodeStoryFile(file: File): Promise<StoryImport> {
    if (file.size > storySaveLimit) throw new Error('故事存档超过 96 MB，暂不能导入。');
    const bytes = new Uint8Array(await file.arrayBuffer());
    const hash = await fingerprint(bytes);
    if (bytes[0] === 0x50 && bytes[1] === 0x4b) return readTipsy(bytes, hash);
    if (file.name.toLowerCase().endsWith(storySaveExtension)) throw new Error('这份 TipsyIsle 存档不是有效的 ZIP 文件。');
    return readTavern(strFromU8(bytes), hash);
}

export function countStoryRoutes(messages: ChatMessageNode[]) {
    const nodes = new Map(messages.map(node => [node.id, node]));
    const continued = new Set(messages.flatMap(node => {
        const parent = node.parentId ? nodes.get(node.parentId) : undefined;
        return parent ? [JSON.stringify([parent.id, node.parentSwipeId ?? swipeId(parent)])] : [];
    }));
    return Math.max(1, messages.reduce((total, node) => total + (node.floor === 0 ? 0 : node.swipes.reduce((count, _, i) =>
        count + Number(!continued.has(JSON.stringify([node.id, swipeId(node, i)]))), 0)), 0));
}

export async function encodeStoryFile(chat: ArchivedChat, character: NormalizedCharacterCard): Promise<Uint8Array<ArrayBuffer>> {
    const manifest = { format, version: 1, character: character.name, messages: chat.messages.length, routes: countStoryRoutes(chat.messages),
        resources: { character: character.name, preset: chat.continuation?.inUsePreset?.name, worldbooks: chat.continuation?.worldbooks?.map(book => book.name), persona: chat.continuation?.persona?.name },
        dependencies: ['model-connection', 'external-resources'] };
    const story = strToU8(JSON.stringify(await packSyncImages(portableStory(chat, character))));
    if (story.byteLength > storySaveLimit * 3) throw new Error('故事数据太大，暂不能导出为单个文件。');
    const bytes = zipSync({ 'manifest.json': strToU8(JSON.stringify(manifest)), 'story.json': story }, { level: 3 });
    if (bytes.byteLength > storySaveLimit) throw new Error('压缩后的故事存档超过 96 MB。');
    return new Uint8Array(bytes);
}

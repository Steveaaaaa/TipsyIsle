import { contentHash } from '../../pipeline/content-hash';
import { worldbookDifference } from './worldbook-diff';
import { mergeStoryChats, openingPluginConflict } from './story-merge';
import { createBranchVariableRemapper, type BranchState } from '../../store/branch-state';
import type { ArchivedChat } from '../../store/chat-archives';
import { routeGraph } from '../../plugins/native/route-graph';
import { swipeId } from '../../store/chat-tree';
/** Transport-independent revision graph. Deletes are durable revisions as well. */
export interface SyncRevision {
    id: string;
    version: string;
    ancestors: string[];
    device: string;
    modified: number;
    value: any | null;
    links?: { characterBinding?: any };
}
export interface SyncOptions { automatic: boolean; appearance: boolean; galleries: boolean; imageReferences?: boolean }
export interface SyncPeer { id: string; name: string; address: string; secret: string }
export interface NearbyDevice { deviceId: string; name: string; address: string; seen: number }
export interface SyncState {
    protocol: 2;
    deviceId: string;
    deviceName: string;
    records: Record<string, SyncRevision>;
    peer?: SyncPeer;
    hostingSecret?: string;
    remoteDeviceId?: string;
    remoteOptions?: SyncOptions;
    enabled?: boolean;
    inbox?: SyncPacket[];
    options: SyncOptions;
    remoteHeads: Record<string, string>;
    guideAliases?: Record<string, string>;
    worldbookAliases?: Record<string, string>;
    retiredWorldbookIds?: string[];
    retiredGuideIds?: string[];
    worldbookReviews?: Record<string, { local: SyncRevision; remote: SyncRevision }>;
    lastSync?: number;
    conflicts: Array<{ id: string; label: string; device: string; modified: number }>;
}
export interface SyncPacket {
    protocol: 3;
    deviceId: string;
    deviceName: string;
    heads: Record<string, string>;
    changes: SyncRevision[];
    options: SyncOptions;
}
export interface SealedPacket { iv: string; ciphertext: string }
export interface LanStatus {
    enabled: boolean;
    deviceId: string;
    name: string;
    secret: string;
    addresses: string[];
    incoming?: { id: string; packet: SealedPacket };
    outgoing?: SealedPacket;
    nearby?: NearbyDevice[];
    queue?: Array<{ id: string; packet: SealedPacket }>;
}
export const SYNC_KEY = 'lan_sync_state';
/** Revision payloads are immutable. Copy the mutable envelope, not all story bodies. */
export function copySyncState(source: SyncState): SyncState {
    return { ...source, records: { ...source.records }, options: { ...source.options },
        peer: source.peer ? { ...source.peer } : undefined, remoteOptions: source.remoteOptions ? { ...source.remoteOptions } : undefined,
        remoteHeads: { ...source.remoteHeads }, inbox: [...source.inbox ?? []], conflicts: [...source.conflicts],
        guideAliases: { ...source.guideAliases }, worldbookAliases: { ...source.worldbookAliases },
        retiredWorldbookIds: [...source.retiredWorldbookIds ?? []], retiredGuideIds: [...source.retiredGuideIds ?? []], worldbookReviews: { ...source.worldbookReviews } };
}
export const canonical = (value: any): string => JSON.stringify(value, (_key, item) =>
    item && typeof item === 'object' && !Array.isArray(item)
        ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);

export function sameRevisionValue(left: any, right: any): boolean {
    if (left === right) return true;
    if (!Array.isArray(left?.messages) || !Array.isArray(right?.messages)) return canonical(left) === canonical(right);
    return sameStoryValue(left, right);
}

const withoutPluginRoute = ({ nativePluginRoute, ...point }: NonNullable<ArchivedChat['continuation']>) => point;

function withoutPluginMessage({ nativePluginReplies, nativePluginOpeningRoutes, nativeRouteAnchors, branchStates, branchBases, ...node }: ArchivedChat['messages'][number]) {
    const withoutState = (states: typeof branchStates) => states && Object.fromEntries(Object.entries(states).map(([key, point]) =>
        [key, { ...point, continuation: withoutPluginRoute(point.continuation) }]));
    return { ...node, branchStates: withoutState(branchStates), branchBases: withoutState(branchBases) };
}

/** Reuse the author runtime only when the entire story, including checkpoints, matches. */
export function sameAuthorStory(left: ArchivedChat, right: ArchivedChat): boolean {
    return sameStoryValue(left, right, true);
}

function sameStoryValue(left: ArchivedChat, right: ArchivedChat, authorOnly = false): boolean {
    const { messages: leftMessages, continuation: leftContinuation, ...leftFields } = left;
    const { messages: rightMessages, continuation: rightContinuation, ...rightFields } = right;
    if (authorOnly) { delete leftFields.syncLabel; delete rightFields.syncLabel; delete leftFields.title; delete rightFields.title; }
    return leftMessages.length === rightMessages.length && canonical(leftFields) === canonical(rightFields)
        && leftMessages.every((message, index) => {
            const peer = rightMessages[index];
            if (message === peer) return true;
            return message.id === peer.id && canonical(authorOnly ? withoutPluginMessage(message) : message)
                === canonical(authorOnly ? withoutPluginMessage(peer) : peer);
        })
        && sameStoryContinuation(authorOnly && leftContinuation ? withoutPluginRoute(leftContinuation) : leftContinuation,
            authorOnly && rightContinuation ? withoutPluginRoute(rightContinuation) : rightContinuation);
}

function sameStoryContinuation(left: any, right: any): boolean {
    if (left === right) return true;
    if (!left || !right) return false;
    const { variables: leftVariables, ...leftFields } = left;
    const { variables: rightVariables, ...rightFields } = right;
    const { message: leftMessages, ...leftScopes } = leftVariables;
    const { message: rightMessages, ...rightScopes } = rightVariables;
    return canonical(leftFields) === canonical(rightFields) && canonical(leftScopes) === canonical(rightScopes)
        && Object.keys(leftMessages).length === Object.keys(rightMessages).length
        && Object.entries(leftMessages).every(([id, bucket]) => bucket === rightMessages[id] || canonical(bucket) === canonical(rightMessages[id]));
}

export function revise(state: SyncState, id: string, value: any, links?: SyncRevision['links']): void {
    const previous = state.records[id];
    if (previous && sameRevisionValue(previous.value, value) && canonical(previous.links) === canonical(links)) return;
    state.records[id] = { id, value, links, version: crypto.randomUUID(),
        ancestors: previous ? [...previous.ancestors, previous.version] : [],
        device: state.deviceName, modified: Date.now() };
}

/** Deterministic winner gives both replicas the same main copy; the other survives. */
export function materializeValue(record: SyncRevision): any {
    if (record.value === null) return null;
    const value = structuredClone(record.value);
    const split = record.id.indexOf(':'), kind = record.id.slice(0, split), id = record.id.slice(split + 1);
    if (!id.includes('~')) return value;
    if (kind === 'chat') {
        if (value.id !== id) {
            const oldId = value.id;
            const suffix = contentHash(id).toString(36);
            const ids = new Map<string, string>(value.messages.map(message => [message.id, `${message.id}~${suffix}`]));
            const anchors = new Map<string, Record<string, string>>();
            for (const vertex of routeGraph(value.messages).vertices.values()) {
                const keys = anchors.get(vertex.node.id) ?? {};
                keys[swipeId(vertex.node, vertex.index)] = vertex.routeId;
                anchors.set(vertex.node.id, keys);
            }
            const remapPoint = createBranchVariableRemapper(ids);
            const moved = new WeakSet<object>();
            const moveContinuation = (continuation: any, remapMessages = true) => {
                if (moved.has(continuation)) return;
                moved.add(continuation);
                continuation.variables = { ...continuation.variables,
                    chat: { [id]: continuation.variables.chat[oldId] ?? continuation.variables.chat[id] ?? {} },
                    message: remapMessages ? Object.fromEntries(Object.entries(continuation.variables.message).map(([key, item]) => [ids.get(key) ?? key, item])) : continuation.variables.message };
                const qr = continuation.extensions.quickReplyV2;
                if (qr?.chatConfigs?.[oldId]) {
                    const chatConfigs = { ...qr.chatConfigs, [id]: qr.chatConfigs[oldId] };
                    delete chatConfigs[oldId];
                    continuation.extensions = { ...continuation.extensions, quickReplyV2: { ...qr, chatConfigs } };
                }
            };
            for (const message of value.messages) {
                if (anchors.has(message.id)) message.nativeRouteAnchors = anchors.get(message.id);
                message.swipeIds ??= message.swipes.map((_, index) => `${message.id}:${index}`);
                if (message.parentId && !message.parentSwipeId) { const parent = value.messages.find(item => item.id === message.parentId); if (parent) message.parentSwipeId = parent.swipeIds?.[parent.activeSwipeIndex] ?? `${parent.id}:${parent.activeSwipeIndex}`; }
                if (message.branchOrigin) message.branchOrigin = ids.get(message.branchOrigin) ?? message.branchOrigin;
                for (const field of ['branchBases', 'branchStates'] as const) if (message[field]) {
                    message[field] = Object.fromEntries(Object.entries<BranchState>(message[field]).map(([key, point]) => {
                        const remapped = remapPoint(point);
                        moveContinuation(remapped.continuation, false);
                        return [key, remapped];
                    }));
                }
                message.id = ids.get(message.id); message.parentId = ids.get(message.parentId) ?? message.parentId;
                if (message.messageId && ids.has(message.messageId)) message.messageId = ids.get(message.messageId);
            }
            value.activeLeafId = ids.get(value.activeLeafId) ?? value.activeLeafId;
            if (value.continuation) moveContinuation(value.continuation);
            if (value.deletedMessageIds) value.deletedMessageIds = value.deletedMessageIds.map(key => ids.get(key) ?? key);
        }
        value.id = id; value.syncLabel = `${record.device}的剧情副本`;
    } else if (['characters', 'lorebooks', 'presets', 'personas'].includes(kind)) {
        const copied = value[kind === 'personas' ? 'avatar_id' : 'id'] !== id;
        value[kind === 'personas' ? 'avatar_id' : 'id'] = id;
        if (kind === 'personas' && value.avatar === record.value.avatar_id) value.avatar = id;
        if (!String(value.name).includes(' · 副本')) value.name = `${value.name ?? '未命名'} · 副本（${record.device}）`;
        if (kind === 'characters' && copied) {
            for (const field of ['characterBook', 'embeddedLorebook']) if (value[field]) {
                const old = value[field].name;
                value[field].id = `${value[field].id}~${contentHash(id).toString(36)}`;
                value[field].name = `${old} · 副本（${record.device}）`;
                if (value.primaryWorldbook === old) value.primaryWorldbook = value[field].name;
                if (value.extensions?.world === old) value.extensions.world = value[field].name;
            }
        }
    }
    return value;
}

export function mergeRevisions(state: SyncState, incoming: SyncRevision[]): Set<string> {
    const changed = new Set<string>();
    for (const remote of incoming) {
        const local = state.records[remote.id];
        if (local?.version === remote.version || local?.ancestors.includes(remote.version)) continue;
        if (!local || remote.ancestors.includes(local.version)) {
            if (state.worldbookReviews) delete state.worldbookReviews[remote.id];
            state.records[remote.id] = structuredClone(remote); changed.add(remote.id); continue;
        }
        if (remote.id === 'profile:default' && (!local.value?.personaId || !remote.value?.personaId) && (local.value?.personaId || remote.value?.personaId)) {
            const selected = local.value?.personaId ? local : remote;
            state.records[remote.id] = { ...structuredClone(selected), version: `merge-${contentHash([local.version, remote.version].sort().join(':')).toString(36)}`,
                ancestors: [...new Set([...local.ancestors, local.version, ...remote.ancestors, remote.version])] };
            changed.add(remote.id); continue;
        }
        if (worldbookDifference(local, remote).length) {
            const previous = state.worldbookReviews?.[remote.id]?.remote;
            if (previous?.ancestors.includes(remote.version)) continue;
            (state.worldbookReviews ??= {})[remote.id] = { local: structuredClone(local), remote: structuredClone(remote) };
            continue;
        }
        if (state.worldbookReviews) delete state.worldbookReviews[remote.id];
        let [winner, other] = [local, remote].sort((a, b) => a.version < b.version ? -1 : a.version > b.version ? 1 : 0);
        const deletedHere = remote.id.startsWith('chat:') && local.value?.deletedMessageIds?.some(id => remote.value?.messages.some(node => node.id === id));
        const deletedThere = remote.id.startsWith('chat:') && remote.value?.deletedMessageIds?.some(id => local.value?.messages.some(node => node.id === id));
        const messageDeleteConflict = deletedHere || deletedThere;
        if (deletedHere && !deletedThere) [winner, other] = [local, remote];
        if (deletedThere && !deletedHere) [winner, other] = [remote, local];
        const openingMetadataConflict = remote.id.startsWith('chat:') && winner.value && other.value && (
            openingPluginConflict(winner.value, other.value) || winner.value.messages.length === 1 && other.value.messages.length === 1
            && canonical(winner.value.continuation?.chatMetadata ?? {}) !== canonical(other.value.continuation?.chatMetadata ?? {}));
        if (remote.id.startsWith('chat:') && winner.value !== null && other.value !== null
            && !messageDeleteConflict && !openingMetadataConflict && winner.value.id === other.value.id && winner.value.characterId === other.value.characterId) {
            state.records[remote.id] = { ...winner, value: mergeStoryChats(winner.value, other.value, other.version),
                version: `merge-${contentHash(`${winner.version}:${other.version}`).toString(36)}`,
                ancestors: [...new Set([...local.ancestors, local.version, ...remote.ancestors, remote.version])] };
            changed.add(remote.id); continue;
        }
        if (remote.id.startsWith('chat:') && (winner.value === null) !== (other.value === null)) {
            const edited = winner.value === null ? other : winner;
            const deleted = winner.value === null ? winner : other;
            const id = `${remote.id}~${edited.version}`;
            const value = materializeValue({ ...edited, id });
            value.syncLabel = `删除后保留的续写 · ${edited.device}`;
            state.records[id] ??= { ...edited, id, value, version: `copy-${contentHash(id).toString(36)}`, ancestors: [] };
            state.records[remote.id] = { ...deleted, version: `merge-${contentHash(`${winner.version}:${other.version}`).toString(36)}`,
                ancestors: [...new Set([...local.ancestors, local.version, ...remote.ancestors, remote.version])] };
            if (!state.conflicts.some(item => item.id === id)) state.conflicts.push({ id, label: '会话已删除，另一端有新的续写', device: edited.device, modified: edited.modified });
            changed.add(id); changed.add(remote.id); continue;
        }
        const survivor = winner.value === null ? other : winner;
        const extra = winner.value === null ? winner : other;
        if (extra.value !== null && (!sameRevisionValue(extra.value, survivor.value) || canonical(extra.links) !== canonical(survivor.links))) {
            const id = `${remote.id}~${extra.version}`;
            const value = materializeValue({ ...extra, id });
            if (messageDeleteConflict) value.syncLabel = `消息删除后保留的续写 · ${extra.device}`;
            state.records[id] ??= { ...extra, id, value,
                version: `copy-${contentHash(`${id}:${canonical(value)}:${canonical(extra.links)}`).toString(36)}`, ancestors: [] };
            changed.add(id);
            if (!state.conflicts.some(conflict => conflict.id === id)) state.conflicts.push({
                id, label: messageDeleteConflict ? '消息已删除，另一端有不同进度' : openingMetadataConflict ? '开场的插件状态不同' : remote.id === 'appearance:shell' ? extra.value.skin?.name ?? '默认外观' : extra.value.name ?? extra.value.label ?? '剧情存档', device: extra.device, modified: extra.modified,
            });
        }
        // A deterministic merge revision acknowledges both heads, including delete/edit conflicts.
        state.records[remote.id] = { ...survivor, id: remote.id, version: `merge-${contentHash([winner.version, other.version].sort().join(':')).toString(36)}`,
            ancestors: [...new Set([...local.ancestors, local.version, ...remote.ancestors, remote.version])] };
        changed.add(remote.id);
    }
    return changed;
}

export function bytes64(bytes: Uint8Array): string {
    let value = ''; for (let offset = 0; offset < bytes.length; offset += 32768) value += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
    return btoa(value);
}
export function from64(value: string): Uint8Array<ArrayBuffer> { return Uint8Array.from(atob(value), c => c.charCodeAt(0)); }
export async function authToken(secret: string): Promise<string> {
    return bytes64(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`tipsy-auth:${secret}`))));
}
async function encryptionKey(secret: string) {
    return crypto.subtle.importKey('raw', await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret)), 'AES-GCM', false, ['encrypt', 'decrypt']);
}
export async function seal(value: unknown, secret: string): Promise<SealedPacket> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await encryptionKey(secret), new TextEncoder().encode(JSON.stringify(value)));
    return { iv: bytes64(iv), ciphertext: bytes64(new Uint8Array(ciphertext)) };
}
export async function unseal<T>(packet: SealedPacket, secret: string): Promise<T> {
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: from64(packet.iv) }, await encryptionKey(secret), from64(packet.ciphertext));
    return JSON.parse(new TextDecoder().decode(plaintext));
}

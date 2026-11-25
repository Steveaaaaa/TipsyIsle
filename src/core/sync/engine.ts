import { pendingBranchOperations } from '../../store/branch-runtime';
import { resetCompatibilityBranch } from '../../compatibility/runtime-client';
import { Immer } from 'immer';
import { rollbackStateChanges } from '../../store/state-rollback';
import { platformStorage, registerSnapshotCommitHook } from '../platform-bridge';
import { batchReactiveUpdates, createReactiveStore } from '../../store/reactive-store';
import { workspaceStore, captureMessageSnapshot, captureChatContinuation, getActiveCharacter, getActiveLorebooks, getActivePersona, getCharacterWorldbooks, persistWorkspaceNow, preserveAuthorMessageRevision, publishSyncedWorkspace, rollbackWorkspacePublication, restoreChatExtensions, SYNC_EXTENSIONS, worldbooksChanged } from '../../store/workspace-store';
import { scopedVariableStore } from '../../store/scoped-variable-store';
import { APPEARANCE_SNAPSHOT, appearanceStore, decodeAppearance, isAppearanceLibrarySnapshot } from '../../theme/appearance-store';
import { listChatArchives, loadChatArchive, summarizeChat, type ArchivedChat } from '../../store/chat-archives';
import { enqueuePersistentOperation, persistStateTransaction, registeredSnapshots } from '../../store/persistence';
import { lanControl, requestPeer } from './transport';
import { SYNC_KEY, copySyncState, revise, mergeRevisions, materializeValue, canonical, sameAuthorStory, sameRevisionValue, authToken, type SyncState, type SyncPacket, type SyncOptions, type LanStatus, type SealedPacket } from './protocol';
import { carryNativePluginState } from './story-merge';
import { captureGalleries, applyGalleries } from './galleries';
import { schemaRegistryStore, storySettings } from '../../registry/schema-registry';
import { tavernEventBus } from '../../sandbox/event-bus';
import { remapGuidePersona } from './guide-dedup';
import { retireStarterContent } from './retired-starter';
import { isRetiredPreset, removeStarterGlobals } from '../retired-starter-content';
import { emptyStory } from '../empty-workspace';
import { retireBuiltinWorldbooks } from './retired-worldbook';
import { removeRetiredBuiltinWorldbooks } from '../builtin-worldbook';
import type { SyncRevision } from './protocol';
import { sealPacket, unsealPacket } from './packet-client';
import { beginSyncAssetEdit, canResumeRemoteStory, syncAssetsEditing, syncIsQuiet, syncRuntimeReady, waitForSyncQuiet } from './activity';
import { compatibilityComposer } from '../../compatibility/composer-bridge';
import { worldbookDifference } from './worldbook-diff';

interface SyncView {
    ready: boolean; busy: boolean; message: string; error: string; pending: number;
    online: boolean; waiting: boolean; localChangesPending?: boolean; state?: SyncState; host?: LanStatus; archiveRevision: number;
    editingWorldbooks?: boolean; reviewPrompt?: boolean;
}
export const lanSyncStore = createReactiveStore<SyncView>(() => ({ ready: false, busy: false, message: '开启后自动发现附近设备', error: '', pending: 0, online: false, waiting: false, archiveRevision: 0 }));
let state: SyncState;
let cache: Record<string, any> = {};
let started: Promise<void> | undefined;
let running: Promise<void> | undefined;
let applying = false;
let dirty = false;
let host: LanStatus | undefined;
let nextConnection = 0;
let finishWorldbookEdit: (() => void) | undefined;
let manualSyncRequested = false;
const IDLE_SYNC_MS = 120000;
const CHANGE_DELAY_MS = 8000;
let changeTimer: ReturnType<typeof setTimeout> | undefined;
let peerWasNearby = false;
let outgoingCache: { signature: string; packet: SealedPacket } | undefined;
let publishedIv: string | undefined;
let sentIv: string | undefined;
let receivedIv: string | undefined;
let historyLoading: Promise<void> | undefined;
let historyReady = false;
let captureBaseline: Record<string, any> = {};
let referenceBaseline: Record<string, any> = {};
let references: Record<string, any> = {};
const revisionCandidate = () => copySyncState(state);
const replicaImmer = new Immer({ autoFreeze: false });
class SyncApplyDeferred extends Error {}
function scheduleChangedSync() {
    if (!state?.enabled || !state.options.automatic || syncAssetsEditing() || busy()) return;
    clearTimeout(changeTimer);
    changeTimer = setTimeout(async () => {
        changeTimer = undefined;
        await waitCycle();
        if (!state.enabled || !state.options.automatic) return;
        if (!syncIsQuiet() || busy() || syncAssetsEditing()) { scheduleChangedSync(); return; }
        nextConnection = 0;
        void cycle(false);
    }, CHANGE_DELAY_MS);
}
async function publishPacket(): Promise<SealedPacket> {
    const signature = canonical({ heads: heads(), remoteHeads: state.remoteHeads, options: state.options,
        remoteOptions: state.remoteOptions, name: state.deviceName, secret: state.hostingSecret });
    if (outgoingCache?.signature !== signature) {
        const outgoing = packet();
        outgoingCache = { signature, packet: await sealPacket(outgoing, state.hostingSecret!, !!state.remoteOptions?.imageReferences) };
    }
    if (publishedIv !== outgoingCache.packet.iv) {
        await lanControl('publish', { packet: outgoingCache.packet });
        publishedIv = outgoingCache.packet.iv;
    }
    return outgoingCache.packet;
}
const busy = () => { const s = workspaceStore.getState(); return s.isGenerating || s.helperGenerationCount > 0 || s.mvuExtraAnalysisActive || pendingBranchOperations() > 0; };
const permitted = (id: string, options = state.options) => (id === 'appearance:shell' ? options.appearance : !id.startsWith('appearance:'))
    && (!/^(gallery|blob):/.test(id) || options.galleries);
const shared = (id: string) => permitted(id) && (!/^(gallery|blob|appearance):/.test(id) || !!state.remoteOptions && permitted(id, state.remoteOptions));
const heads = (source = state) => Object.fromEntries(Object.values(source.records).filter(record => permitted(record.id, source.options)).map(record => [record.id, record.version]));
const newSecret = () => [...crypto.getRandomValues(new Uint8Array(12))].map(value => value.toString(16).padStart(2, '0')).join('');
function publishView(message?: string) {
    const pending = Object.values(state.records).filter(record => shared(record.id) && state.remoteHeads[record.id] !== record.version).length;
    const worldbookReviews = Object.fromEntries(Object.entries(state.worldbookReviews ?? {}).map(([id, review]) =>
        [id, { ...review, local: state.records[id] ?? review.local }]));
    lanSyncStore.setState({ ready: true, state: { ...state, options: { ...state.options }, peer: state.peer ? { ...state.peer } : undefined,
        conflicts: [...state.conflicts], worldbookReviews, records: {}, inbox: [] },
        host: host ? { ...host, incoming: undefined, queue: undefined } : undefined, pending,
        waiting: !!state.inbox?.length, localChangesPending: dirty, ...(message ? { message } : {}) });
}
function scanCollection(target: SyncState, prefix: string, items: any[], identity = 'id', previous: any[] = [], current = items) {
    const old = new Map(previous.map(item => [item[identity], item]));
    const latest = new Map(current.map(item => [item[identity], item]));
    const present = new Set(items.map(item => `${prefix}:${item[identity]}`));
    for (const item of items) if (!latest.has(item[identity]) || old.get(item[identity]) !== latest.get(item[identity]) || !target.records[`${prefix}:${item[identity]}`]) revise(target, `${prefix}:${item[identity]}`, item);
    for (const record of Object.values(target.records)) if (record.id.startsWith(`${prefix}:`) && !present.has(record.id) && record.value !== null) revise(target, record.id, null);
}
/** Read the serialized durable candidate, not live stores which may already be on a later edit. */
function capture(target: SyncState, sources: Record<string, any>, previous: Record<string, any> = captureBaseline, sourceReferences = references): void {
    if (syncAssetsEditing()) return;
    if (!sources.workspace_snapshot || !sources.workspace_assets || !sources.scoped_variables) return;
    const workspace = { ...workspaceStore.getState(), ...sources.workspace_snapshot, ...sources.workspace_assets };
    const variables = sources.scoped_variables;
    if (sources.workspace_assets !== previous.workspace_assets || sources.workspace_snapshot?.characterWorldbookBindings !== previous.workspace_snapshot?.characterWorldbookBindings) {
    const oldCards = new Map((referenceBaseline.workspace_assets?.characters ?? []).map(card => [card.id, card]));
    const currentCards = new Map((sourceReferences.workspace_assets?.characters ?? []).map(card => [card.id, card]));
    for (const card of workspace.characters) if (!target.records[`characters:${card.id}`] || !currentCards.has(card.id) || oldCards.get(card.id) !== currentCards.get(card.id) || workspace.characterWorldbookBindings[card.id] !== previous.workspace_snapshot?.characterWorldbookBindings?.[card.id])
        revise(target, `characters:${card.id}`, card, { characterBinding: workspace.characterWorldbookBindings[card.id] ?? null });
    for (const record of Object.values(target.records)) if (record.id.startsWith('characters:') && !workspace.characters.some(card => `characters:${card.id}` === record.id)) revise(target, record.id, null);
    scanCollection(target, 'lorebooks', workspace.lorebooks, 'id', referenceBaseline.workspace_assets?.lorebooks, sourceReferences.workspace_assets?.lorebooks);
    scanCollection(target, 'presets', workspace.presets, 'id', referenceBaseline.workspace_assets?.presets, sourceReferences.workspace_assets?.presets);
    }
    if (sources.workspace_snapshot !== previous.workspace_snapshot) {
    scanCollection(target, 'personas', workspace.personas, 'avatar_id', referenceBaseline.workspace_snapshot?.personas, sourceReferences.workspace_snapshot?.personas);
    const defaultPersona = workspace.personas.find(persona => persona.is_default);
    revise(target, 'profile:default', { personaId: defaultPersona?.avatar_id ?? null,
        userName: defaultPersona?.name ?? (workspace.activePersonaId ? '用户' : workspace.userName) });
    for (const [id, value] of Object.entries(workspace.characterWorldbookBindings)) revise(target, `binding:${id}`, value);
    for (const record of Object.values(target.records)) if (record.id.startsWith('binding:') && !record.id.includes('~') && !Object.hasOwn(workspace.characterWorldbookBindings, record.id.slice(8))) revise(target, record.id, null);
    }
    const chats = new Set<string>();
    for (const summary of sources.chat_archive_index ?? []) {
        if (summary.kind === 'free') continue;
        chats.add(`chat:${summary.id}`);
        const chat = sources[`chat_archive:${summary.id}`];
        if (chat && (chat !== previous[`chat_archive:${summary.id}`] || !target.records[`chat:${chat.id}`]) && chat.id !== workspace.activeChatId && !chat.messages.some(message => message.extra?.tipsy_generation_incomplete && !message.extra?.tipsy_generation_terminal)) revise(target, `chat:${chat.id}`, chat);
    }
    const key = `chat:${workspace.activeChatId}`; chats.add(key);
    if (workspace.sessionKind !== 'free' && ['workspace_snapshot', 'workspace_assets', 'scoped_variables', 'story_settings'].some(key => sources[key] !== previous[key]) && workspace.activeChatId && !workspace.messages.some(message => message.extra?.tipsy_generation_incomplete && !message.extra?.tipsy_generation_terminal)) {
        const chat: ArchivedChat = { id: workspace.activeChatId, title: workspace.storyChatTitle, characterId: workspace.activeCharacterId, importedFrom: workspace.storyImportFingerprint, messages: workspace.messages, deletedMessageIds: workspace.deletedMessageIds,
            activeLeafId: workspace.activeLeafId, timedStates: workspace.timedStates,
            worldbookName: workspace.chatWorldbookBindings[workspace.activeChatId] ?? null,
            templateInjections: workspace.templateInjections, templateActivations: workspace.templateActivations,
            continuation: captureChatContinuation(workspace, variables, sources.story_settings ?? storySettings()) };
        if (target.records[key]?.value?.syncLabel) chat.syncLabel = target.records[key].value.syncLabel;
        revise(target, key, chat);
    }
    for (const record of Object.values(target.records)) if (record.id.startsWith('chat:') && !chats.has(record.id)) revise(target, record.id, null);
    for (const key of SYNC_EXTENSIONS) if (variables.extension[key] !== previous.scoped_variables?.extension[key]) revise(target, `extension:${key}`, variables.extension[key] ?? null);
    const appearance = sources[APPEARANCE_SNAPSHOT];
    if (target.options.appearance && appearance && (appearance.saved !== previous[APPEARANCE_SNAPSHOT]?.saved || !target.records['appearance:shell']
        || !sameRevisionValue(target.records['appearance:shell'].value?.skin, appearance.saved))) {
        // Null marks a reset; an untouched default should not overwrite a first package from another device.
        if (appearance.saved || target.records['appearance:shell']) revise(target, 'appearance:shell', { skin: appearance.saved });
    }
}
async function saveState(next = state, baseline = state) {
    const base = new Map(Object.entries(baseline.records).map(([id, record]) => [id, record.version]));
    const proposed = { ...structuredClone({ ...next, records: undefined }), records: { ...next.records } } as SyncState;
    await platformStorage.saveSnapshots({ [SYNC_KEY]: proposed }, false, async () => {
        const merged = revisionCandidate();
        for (const key of new Set([...Object.keys(state), ...Object.keys(proposed)])) {
            if (key === 'records') continue;
            if (key in proposed) merged[key] = proposed[key]; else delete merged[key];
        }
        for (const [id, record] of Object.entries(proposed.records)) if (base.get(id) !== record.version) merged.records[id] = record;
        return { values: { [SYNC_KEY]: merged }, committed() { state = merged; publishView(); } };
    });
}
async function capturePending() {
    if (busy() || !syncRuntimeReady() || applying || syncAssetsEditing() || !dirty) return;
    const leaf = workspaceStore.getState().activeLeafId;
    if (leaf) captureMessageSnapshot(leaf);
    await persistWorkspaceNow();
    if (busy() || !syncRuntimeReady() || applying || syncAssetsEditing() || !dirty) return;
    const sources = cache, sourceReferences = references;
    const next = revisionCandidate(); capture(next, sources, captureBaseline, sourceReferences);
    retireStarterContent(next);
    if (canonical(heads(next)) !== canonical(heads())) { await saveState(next); if (!running) scheduleChangedSync(); }
    captureBaseline = sources;
    referenceBaseline = sourceReferences;
    dirty = cache !== sources;
    publishView();
}
function packet(): SyncPacket {
    return { protocol: 3, deviceId: state.deviceId, deviceName: state.deviceName, heads: heads(), options: state.options,
        changes: Object.values(state.records).filter(record => shared(record.id) && state.remoteHeads[record.id] !== record.version) };
}

/** Both directions persist their inbox before acknowledging receipt. Applying is a separate step. */
async function receive(remote: SyncPacket) {
    if (remote.protocol !== 3 || remote.deviceId === state.deviceId) throw new Error('两端的故事存档版本不一致，请将电脑和手机更新到同一版本');
    if (state.peer && state.peer.id !== remote.deviceId) throw new Error('收到未配对设备的数据，请先忘记旧设备再重新配对');
    lanSyncStore.setState({ online: true, error: '' });
    if (state.peer && state.remoteDeviceId === remote.deviceId && state.peer.name === remote.deviceName
        && canonical(state.remoteHeads) === canonical(remote.heads) && canonical(state.remoteOptions) === canonical(remote.options)) return;
    const next = copySyncState(state);
    if (!next.peer) {
        const nearby = host?.nearby?.find(item => item.deviceId === remote.deviceId);
        next.peer = { id: remote.deviceId, name: remote.deviceName, address: nearby?.address ?? '', secret: next.hostingSecret! };
    }
    const signature = canonical(remote.heads);
    if ((next.inbox ?? []).some(item => item.deviceId === remote.deviceId && item.deviceName === remote.deviceName && canonical(item.heads) === signature && canonical(item.options) === canonical(remote.options))) return;
    (next.inbox ??= []).push(remote);
    await saveState(next);
    lanSyncStore.setState({ online: true, error: '' });
}

async function applyInbox(repairGuides = false, resolution?: SyncRevision, force = false): Promise<void> {
    if (!historyReady) return;
    if (busy() || !syncRuntimeReady() || syncAssetsEditing() || !state.inbox?.length && !repairGuides && !resolution) return;
    const resumeStory = workspaceStore.getState().sessionKind !== 'free' && (force || canResumeRemoteStory() && !compatibilityComposer().trim());
    const canApply = () => force || syncIsQuiet() && (!resumeStory || canResumeRemoteStory() && !compatibilityComposer().trim());
    if (!canApply()) { publishView('远端更新已暂存，空闲后处理'); return; }
    await enqueuePersistentOperation(async () => {
        await capturePending();
        if (busy() || !syncRuntimeReady() || syncAssetsEditing() || !canApply()) return;
            const mergeBase = state;
            const next = copySyncState(state), changed = new Set<string>();
            const deferred: SyncPacket[] = [];
            const activeChat = `chat:${workspaceStore.getState().activeChatId}`;
            for (const remote of next.inbox ?? []) {
                const updates = remote.changes.filter(record => permitted(record.id));
                const applies = (record: SyncRevision) => {
                    if (resumeStory || record.id !== activeChat && !record.id.startsWith('extension:')) return true;
                    const local = next.records[record.id];
                    // Reviewing worldbook-only conflicts does not replace the played story.
                    return record.id === activeChat && !!local && local.version !== record.version
                        && !local.ancestors.includes(record.version) && !record.ancestors.includes(local.version)
                        && worldbookDifference(local, record).length > 0;
                };
                const accepted = updates.filter(applies);
                for (const id of mergeRevisions(next, accepted)) changed.add(id);
                const waiting = updates.filter(record => !accepted.includes(record) && next.records[record.id]?.version !== record.version
                    && !next.records[record.id]?.ancestors.includes(record.version));
                if (waiting.length) deferred.push(waiting.length === remote.changes.length ? remote : { ...remote, changes: waiting });
                next.remoteOptions = remote.options; next.remoteDeviceId = remote.deviceId; next.remoteHeads = remote.heads;
                if (next.peer) next.peer.name = remote.deviceName;
            }
            if (resolution) for (const id of mergeRevisions(next, [resolution])) changed.add(id);
            next.inbox = deferred;
            for (const id of retireStarterContent(next)) changed.add(id);
            for (const id of retireBuiltinWorldbooks(next)) changed.add(id);
            const revisionsChanged = changed.size > 0;
            const reviewsChanged = canonical(next.worldbookReviews) !== canonical(state.worldbookReviews);
            // Acknowledgements and ancestry merges do not change the workspace.
            // Persist sync metadata without suspending user actions or restarting author scripts.
            for (const id of changed) {
                if (sameRevisionValue(state.records[id]?.value, next.records[id].value)
                    && canonical(state.records[id]?.links) === canonical(next.records[id].links)) changed.delete(id);
            }
            if (!changed.size) {
                const receiptChanged = next.remoteDeviceId !== state.remoteDeviceId || next.peer?.name !== state.peer?.name
                    || canonical(next.remoteHeads) !== canonical(state.remoteHeads) || canonical(next.remoteOptions) !== canonical(state.remoteOptions)
                    || next.inbox.length !== (state.inbox?.length ?? 0) || next.inbox.some((item, index) => item !== state.inbox?.[index]);
                if (!revisionsChanged && !reviewsChanged && !receiptChanged) return;
                const pending = Object.values(next.records).some(record => shared(record.id) && next.remoteHeads[record.id] !== record.version);
                if (!pending && !next.inbox.length && !Object.keys(next.worldbookReviews ?? {}).length) next.lastSync = Date.now();
                await saveState(next);
                if (reviewsChanged) lanSyncStore.setState({ reviewPrompt: true });
                return;
            }
        if (next.options.galleries && [...changed].some(id => id.startsWith('gallery:'))) {
            await applyGalleries(next, changed, message => lanSyncStore.setState({ message }));
            await capturePending();
            // Edits made during gallery IO are merged on the next pass, never overwritten.
            if (state !== mergeBase || busy() || syncAssetsEditing() || !canApply()) return;
        }
        const before = { workspace: workspaceStore.getState(), variables: scopedVariableStore.getState(),
            settings: schemaRegistryStore.getState().values, appearance: appearanceStore.getState() };
        const incomingSkin = changed.has('appearance:shell') ? next.records['appearance:shell'].value : undefined;
        const remoteAppearance = incomingSkin && Object.hasOwn(incomingSkin, 'skin')
            ? { ...before.appearance, saved: incomingSkin.skin ? decodeAppearance(incomingSkin.skin) : null, activePackId: null,
                previous: before.appearance.saved, previousPackId: before.appearance.activePackId }
            : before.appearance;
        const authorResourcesChanged = [...changed].some(id => /^(characters|lorebooks|binding|personas|profile|presets|extension):/.test(id));
        let restore = false, missing = false, pluginOnly = false;
        const after = replicaImmer.produce(before, draft => {
            if ([...changed].every(id => id.startsWith('appearance:'))) return;
            const { workspace, variables, settings } = draft;
            const changedKind = (kind: string) => [...changed].some(id => id.startsWith(`${kind}:`));
            // Resource catalogs may update while this device owns the current story.
            // Keep its author scripts, worldbooks and persona on the played version.
            if (!resumeStory && [...changed].some(id => /^(characters|lorebooks|binding|personas|profile):/.test(id))) {
                const current = before.workspace;
                workspace.storyCharacter ??= getActiveCharacter(current);
                workspace.storyWorldbooks ??= getActiveLorebooks(current);
                workspace.storyCharacterBinding ??= getCharacterWorldbooks(getActiveCharacter(current), current);
                workspace.storyPersona ??= getActivePersona(current);
            }
            const list = (kind: string, current: any[], identity = 'id') => {
                if (!changedKind(kind)) return current;
                const existing = new Map(current.map(item => [item[identity], item]));
                return Object.values(next.records).filter(record => record.id.startsWith(`${kind}:`) && record.value !== null)
                    .map(record => !changed.has(record.id) && existing.has(record.value[identity])
                        ? existing.get(record.value[identity]) : structuredClone(record.value));
            };
            const aliases = next.guideAliases ?? {};
            workspace.activeCharacterId = aliases[workspace.activeCharacterId] ?? workspace.activeCharacterId;
            if (workspace.storyCharacter && aliases[workspace.storyCharacter.id]) workspace.storyCharacter.id = aliases[workspace.storyCharacter.id];
            if (workspace.storyPersona) remapGuidePersona(workspace.storyPersona, aliases);
            for (const [oldId, id] of Object.entries(aliases)) {
                if (workspace.streamDisplayModes[oldId]) {
                    workspace.streamDisplayModes[id] ??= workspace.streamDisplayModes[oldId];
                    delete workspace.streamDisplayModes[oldId];
                }
                if (variables.character[oldId]) {
                    variables.character[id] = { ...variables.character[oldId], ...variables.character[id] };
                    delete variables.character[oldId];
                }
            }
            workspace.characters = list('characters', workspace.characters); workspace.lorebooks = list('lorebooks', workspace.lorebooks);
            const worldbooks = removeRetiredBuiltinWorldbooks({ lorebooks: workspace.lorebooks, storyWorldbooks: workspace.storyWorldbooks,
                activeLorebookIds: workspace.activeLorebookIds }, next.retiredWorldbookIds);
            Object.assign(workspace, worldbooks);
            workspace.presets = list('presets', workspace.presets); workspace.personas = list('personas', workspace.personas, 'avatar_id');
            if (workspace.inUsePreset && isRetiredPreset(workspace.inUsePreset)) { workspace.activePresetId = ''; workspace.inUsePreset = undefined; }
            const profile = next.records['profile:default']?.value;
            if (profile) {
                for (const persona of workspace.personas) persona.is_default = persona.avatar_id === profile.personaId;
                if (changed.has('profile:default') && !workspace.storyPersona) {
                    const persona = workspace.personas.find(item => item.connections.some(link => link.type === 'character' && [workspace.activeCharacterId, `${workspace.activeCharacterId}.png`].includes(link.id)))
                        ?? workspace.personas.find(item => item.avatar_id === profile.personaId);
                    workspace.activePersonaId = persona?.avatar_id ?? null;
                    workspace.userName = persona?.name ?? profile.userName;
                }
            }
            if (changedKind('binding') || changedKind('characters')) workspace.characterWorldbookBindings = Object.fromEntries(Object.values(next.records).filter(record => record.id.startsWith('binding:') && record.value !== null && !record.id.includes('~')).map(record => [record.id.slice(8), record.value]));
            if (changedKind('binding') || changedKind('characters')) for (const card of workspace.characters) {
                const record = next.records[`characters:${card.id}`];
                if (!card.id.includes('~') || !record.links?.characterBinding) continue;
                const binding = structuredClone(record.links.characterBinding), embedded = card.characterBook ?? card.embeddedLorebook;
                if (embedded && binding.primary && embedded.name.startsWith(`${binding.primary} · 副本`)) binding.primary = embedded.name;
                workspace.characterWorldbookBindings[card.id] = binding;
            }
            for (const record of Object.values(next.records)) {
                if (!record.id.startsWith('lorebooks:') || record.value !== null) continue;
                const id = record.id.slice(10);
                for (const card of workspace.characters) {
                    if (card.characterBook?.id === id) card.characterBook = null;
                    if (card.embeddedLorebook?.id === id) card.embeddedLorebook = null;
                }
            }
            const chats = Object.values(next.records).filter(record => record.id.startsWith('chat:') && record.value !== null).map(record => record.value as ArchivedChat);
            let active = chats.find(chat => chat.id === workspace.activeChatId);
            restore = resumeStory && !!active && changed.has(`chat:${active.id}`);
            missing = resumeStory && (!active || !workspace.characters.some(card => card.id === workspace.activeCharacterId));
            if (missing) active = chats.find(chat => workspace.characters.some(card => card.id === chat.characterId));
            if (active && restore && !missing && !authorResourcesChanged) {
                const local = before.workspace;
                const rendered: ArchivedChat = { id: local.activeChatId, characterId: local.activeCharacterId, importedFrom: local.storyImportFingerprint, messages: local.messages,
                    activeLeafId: local.activeLeafId, deletedMessageIds: local.deletedMessageIds, timedStates: local.timedStates,
                    worldbookName: local.chatWorldbookBindings[local.activeChatId] ?? null, templateInjections: local.templateInjections,
                    templateActivations: local.templateActivations, continuation: captureChatContinuation(local, before.variables, before.settings) };
                if (sameAuthorStory(rendered, active)) {
                    pluginOnly = true;
                    restore = false;
                    const route = active.continuation?.nativePluginRoute;
                    Object.assign(workspace, { storyChatTitle: active.title, messages: carryNativePluginState(local.messages, active.messages),
                        ...(canonical(local.nativePluginRoute) !== canonical(route) && { nativePluginRoute: route }) });
                }
            }
            if (active && (restore || missing)) {
                active = structuredClone(active);
                Object.assign(workspace, { activeChatId: active.id, storyChatTitle: active.title, activeCharacterId: active.characterId, messages: active.messages, deletedMessageIds: active.deletedMessageIds ?? [],
                    activeLeafId: active.activeLeafId, branchEpoch: (before.workspace.branchEpoch ?? 0) + 1, timedStates: active.timedStates, templateInjections: active.templateInjections ?? [],
                    chatMetadata: active.continuation?.chatMetadata,
                    nativePluginRoute: active.continuation?.nativePluginRoute,
                    templateActivations: active.templateActivations ?? [], lastAssembledPrompt: null,
                    storyWorldbooks: active.continuation?.worldbooks, storyCharacterBinding: active.continuation?.characterBinding,
                    storyCharacter: active.continuation?.character, storyPersona: active.continuation?.persona,
                    storyImportFingerprint: active.importedFrom, portableStory: active.continuation?.portable });
                workspace.chatWorldbookBindings[active.id] = active.worldbookName ?? null;
                if (active.continuation) {
                    const c = active.continuation;
                    if (!c.portable) variables.global = removeStarterGlobals(c.variables.global);
                    for (const scope of ['character', 'preset', 'chat', 'message'] as const) Object.assign(variables[scope], c.variables[scope] ?? {});
                    restoreChatExtensions(variables.extension, c, active.id, workspace.branchExtensionKeys);
                    workspace.branchExtensionKeys = c.extensionKeys ?? []; Object.assign(settings, c.settings);
                    Object.assign(workspace, { activePresetId: c.activePresetId, inUsePreset: c.inUsePreset,
                        activeLorebookIds: c.activeLorebookIds, userName: c.userName, activePersonaId: c.activePersonaId });
                }
            } else if (missing) {
                Object.assign(workspace, emptyStory());
            }
            for (const id of changed) if (id.startsWith('extension:') && !id.includes('~')) {
                const key = id.slice(10), value = next.records[id].value;
                if (active && (restore || missing) && active.continuation) {
                    if (key !== 'tavern_helper') continue;
                    if (Array.isArray(value?.scripts)) (variables.extension[key] ??= {}).scripts = structuredClone(value.scripts);
                    else if (variables.extension[key]) delete variables.extension[key].scripts;
                } else if (value === null) delete variables.extension[key];
                else variables.extension[key] = structuredClone(value);
            }
        });
        if (pluginOnly) preserveAuthorMessageRevision(before.workspace.messages, after.workspace.messages);
        const snapshots: Record<string, any> = { [SYNC_KEY]: next };
        if ([...changed].some(id => id.startsWith('chat:'))) {
            const index = new Map((cache.chat_archive_index ?? []).map(item => [item.id, item]));
            for (const id of changed) if (id.startsWith('chat:')) {
                const chat = next.records[id].value as ArchivedChat | null;
                if (chat) index.set(chat.id, summarizeChat(chat)); else index.delete(id.slice(5));
                snapshots[`chat_archive:${id.slice(5)}`] = chat;
            }
            snapshots.chat_archive_index = [...index.values()];
        }
        const pending = Object.values(next.records).some(record => shared(record.id) && next.remoteHeads[record.id] !== record.version);
        if (!pending && !next.inbox.length && !Object.keys(next.worldbookReviews ?? {}).length) next.lastSync = Date.now();
        let published = false;
        try {
            await persistStateTransaction(() => {
                if (busy() || !syncRuntimeReady() || syncAssetsEditing() || !canApply() || state !== mergeBase || workspaceStore.getState() !== before.workspace
                    || scopedVariableStore.getState() !== before.variables || schemaRegistryStore.getState().values !== before.settings
                    || appearanceStore.getState() !== before.appearance) throw new SyncApplyDeferred();
                applying = true; published = true;
                // One synchronous publication: text, branches and variables change together.
                // Input remains live throughout the subsequent disk write.
                batchReactiveUpdates(() => {
                    if (after.workspace !== before.workspace) publishSyncedWorkspace(after.workspace);
                    if (after.variables !== before.variables) scopedVariableStore.setState(after.variables);
                    if (after.settings !== before.settings) schemaRegistryStore.setState({ values: after.settings });
                    if (remoteAppearance !== before.appearance) appearanceStore.setState(remoteAppearance);
                });
                if (restore || missing) { resetCompatibilityBranch(); void tavernEventBus.emit('chat_changed', after.workspace.activeChatId); }
                if (restore || missing || [...changed].some(id => /^(characters|lorebooks|binding|presets):/.test(id))) worldbooksChanged();
            }, () => {
                if (published) batchReactiveUpdates(() => {
                    if (after.workspace !== before.workspace) rollbackWorkspacePublication(before.workspace, after.workspace, pluginOnly);
                    if (after.variables !== before.variables) scopedVariableStore.setState(rollbackStateChanges(scopedVariableStore.getState(), before.variables, after.variables));
                    if (after.settings !== before.settings) schemaRegistryStore.setState({ values: rollbackStateChanges(schemaRegistryStore.getState().values, before.settings, after.settings) });
                    if (remoteAppearance !== before.appearance) appearanceStore.setState(rollbackStateChanges(appearanceStore.getState(), before.appearance, remoteAppearance));
                });
                applying = false; dirty = true;
                if (published && (restore || missing)) void tavernEventBus.emit('chat_changed', workspaceStore.getState().activeChatId);
            }, { snapshots, committed(saved) {
                state = next; cache = { ...cache, ...saved }; references = { ...references, ...saved };
                captureBaseline = cache; referenceBaseline = references;
                applying = false; dirty = false;
                if (reviewsChanged) lanSyncStore.setState({ reviewPrompt: true });
                if (snapshots.chat_archive_index) lanSyncStore.setState(view => { view.archiveRevision++; });
            } });
        } catch (error) { if (!(error instanceof SyncApplyDeferred)) throw error; }
        finally { applying = false; }
    });
    publishView(state.inbox?.length ? '资源已处理，远端剧情已暂存；换回本端或点击“立即同步”时接续' : '已接收完整剧情状态');
}

async function openListener() {
    state.hostingSecret ??= newSecret();
    host = await lanControl('start', { deviceId: state.deviceId, name: state.deviceName, secret: state.hostingSecret, token: await authToken(state.hostingSecret) });
    publishedIv = undefined;
    await saveState(); publishView('正在发现附近设备');
}
export function initializeLanSync(): Promise<void> {
    return started ??= (async () => {
        await waitForSyncQuiet(() => manualSyncRequested);
        state = await platformStorage.loadSnapshot<SyncState>(SYNC_KEY, { protocol: 2, deviceId: crypto.randomUUID(),
            deviceName: /Android/i.test(navigator.userAgent) ? '我的手机' : '我的电脑', records: {}, remoteHeads: {},
            options: { automatic: true, appearance: false, galleries: false }, conflicts: [], enabled: false, inbox: [] });
        state.protocol = 2;
        state.enabled ??= !!(state.hostingSecret || state.peer);
        state.options.imageReferences = true;
        retireBuiltinWorldbooks(state);
        retireStarterContent(state);
        if (state.peer) state.hostingSecret = state.peer.secret;
        const archiveIndex = await listChatArchives();
        // Hydration already restored these stores. Sample after the last read so edits
        // made while sync initializes are included instead of rereading stale snapshots.
        const snapshots = registeredSnapshots();
        cache = { ...snapshots, chat_archive_index: archiveIndex };
        references = snapshots;
        for (const record of Object.values(state.records)) {
            if (!record.id.includes('~')) continue;
            const value = materializeValue(record);
            if (canonical(value) !== canonical(record.value)) revise(state, record.id, value);
            else if (record.id.includes('~') && !state['copyMigration'] && !record.version.startsWith('copy-')) {
                record.ancestors = [...record.ancestors, record.version]; record.version = crypto.randomUUID();
            }
        }
        state['copyMigration'] = true;
        registerSnapshotCommitHook(async (snapshots, sourceReferences) => {
            const shareable = (values: Record<string, unknown> = {}) => Object.fromEntries(Object.entries(values).filter(([key]) => !key.startsWith('native_plugin') && !isAppearanceLibrarySnapshot(key)));
            const sources = { ...cache, ...shareable(snapshots) };
            const nextReferences = { ...references, ...shareable(sourceReferences) };
            // Local saves finish without preparing a sync revision on every write.
            // capturePending coalesces the latest durable sources at a quiet moment.
            return { values: {}, committed() {
                cache = sources;
                references = nextReferences;
                dirty = true;
                if (state.enabled) { lanSyncStore.setState({ localChangesPending: true, message: '本机已保存，空闲后同步' }); scheduleChangedSync(); }
            } };
        });
        let wasBusy = busy();
        workspaceStore.subscribe(() => {
            const nowBusy = busy();
            if (wasBusy && !nowBusy) scheduleChangedSync();
            wasBusy = nowBusy;
        });
        dirty = true; await capturePending(); await saveState();
        historyLoading = (async () => {
            // Yield between groups; normal startup does not wait for old conversation bodies.
            const archives = cache.chat_archive_index ?? [];
            for (let offset = 0; offset < archives.length; offset += 4) {
                await waitForSyncQuiet(() => manualSyncRequested);
                await new Promise(resolve => setTimeout(resolve, 0));
                await Promise.all(archives.slice(offset, offset + 4).map(async item => {
                    if (state.records[`chat:${item.id}`] || Object.hasOwn(cache, `chat_archive:${item.id}`)) return;
                    const chat = await loadChatArchive(item.id);
                    if (chat && (cache.chat_archive_index ?? []).some(summary => summary.id === item.id)) cache = { ...cache, [`chat_archive:${item.id}`]: chat };
                }));
            }
            dirty = true; await capturePending(); historyReady = true;
            await applyInbox(true); scheduleChangedSync();
        })().catch(error => { lanSyncStore.setState({ error: String(error) }); throw error; });
        void historyLoading.catch(() => {});
        if (state.enabled) try { await openListener(); } catch (error) { lanSyncStore.setState({ error: String(error) }); }
        const tick = () => { if (state.enabled && syncIsQuiet()) void cycle(false); };
        setInterval(tick, 15000);
        document.addEventListener('visibilitychange', () => { nextConnection = 0; tick(); });
        window.addEventListener('online', () => { nextConnection = 0; tick(); });
        window.addEventListener('tipsy-sync-runtime-ready', tick);
        window.addEventListener('tipsy-sync-edits-finished', scheduleChangedSync);
        window.addEventListener('tipsy-gallery-changed', () => { if (!applying && state.options.galleries) scheduleChangedSync(); });
        tick();
        void import('../story-gallery').then(module => module.drainGalleryCleanup()).catch(error => console.error('图库清理等待重试', error));
        publishView();
    })().catch(error => { started = undefined; lanSyncStore.setState({ error: String(error) }); throw error; });
}
async function waitCycle() { if (running) await running; }
export async function refreshDevices() {
    await waitCycle();
    if (!state.enabled) await startHosting();
    host = await lanControl('scan'); publishView();
}
export async function updateSyncOptions(options: Partial<SyncOptions>, name?: string) {
    await waitCycle();
    const next = copySyncState(state); Object.assign(next.options, options);
    if (name?.trim()) next.deviceName = name.trim();
    await saveState(next); dirty = true;
    if (state.enabled) await openListener();
    scheduleChangedSync();
}
export async function startHosting() {
    await initializeLanSync(); await waitCycle();
    state.enabled = true; await openListener(); nextConnection = 0;
    void cycle(false);
}
export async function stopHosting() {
    await waitCycle(); host = await lanControl('stop'); state.enabled = false;
    await saveState(); lanSyncStore.setState({ online: false }); publishView('已暂停互通，配对关系保留');
}
export async function pairDevice(address: string, secret: string, expectedId?: string) {
    await waitCycle();
    const normalized = new URL(address.includes('://') ? address.trim() : `http://${address.trim()}`);
    if (!normalized.port) normalized.port = '5192';
    const peer = { address: normalized.origin, secret: secret.replace(/\s/g, '') };
    const info = await requestPeer<{ deviceId: string; name: string; protocol: number }>(peer, 'hello');
    if (info.protocol !== 2) throw new Error('两端的故事分支版本不一致，请更新另一台设备后再同步');
    if (info.deviceId === state.deviceId || expectedId && expectedId !== info.deviceId) throw new Error('设备身份不匹配，请重新发现设备');
    state.peer = { ...peer, id: info.deviceId, name: info.name }; state.remoteHeads = {}; state.remoteOptions = undefined;
    state.hostingSecret = peer.secret; state.enabled = true;
    await saveState(); await openListener(); await syncNow();
}
export async function forgetPeer() {
    await waitCycle();
    delete state.peer; delete state.remoteOptions; state.remoteHeads = {}; state.inbox = []; state.lastSync = undefined;
    state.hostingSecret = newSecret();
    sentIv = undefined; receivedIv = undefined; publishedIv = undefined; peerWasNearby = false;
    await lanControl('revoke', { secret: state.hostingSecret, token: await authToken(state.hostingSecret) });
    await saveState(); lanSyncStore.setState({ online: false }); publishView('已忘记设备，下次连接需要重新配对');
}
export async function dismissConflict(id: string) { await waitCycle(); state.conflicts = state.conflicts.filter(item => item.id !== id); await saveState(); }
export async function useConflict(id: string) {
    await waitCycle(); const record = state.records[id], baseId = id.split('~')[0];
    const next = copySyncState(state), value = structuredClone(record.value);
    if (value && /^(characters|presets|lorebooks):/.test(baseId)) { value.id = baseId.slice(baseId.indexOf(':') + 1); value.name = state.records[baseId]?.value?.name ?? value.name; }
    if (value && baseId.startsWith('personas:')) value.avatar_id = baseId.slice(9);
    revise(next, baseId, value);
    const change = next.records[baseId];
    (state.inbox ??= []).push({ protocol: 3, deviceId: state.peer?.id ?? 'conflict', deviceName: record.device,
        heads: state.remoteHeads, options: state.remoteOptions ?? state.options, changes: [change] });
    await saveState(); await applyInbox(false, undefined, true); await dismissConflict(id);
}

function cycle(force: boolean): Promise<void> {
    return running ??= (async () => {
        try {
            if (!syncRuntimeReady() || busy() || syncAssetsEditing() || !force && !syncIsQuiet()) return;
            if (!historyReady) { if (force) await historyLoading; else return; }
            if (!syncRuntimeReady() || busy() || syncAssetsEditing() || !force && !syncIsQuiet()) return;
            if (!state.enabled) { publishView('请先开启局域网互通'); return; }
            if (!force && !state.options.automatic) return;
            if (!host?.enabled) await openListener();
            host = await lanControl('status');
            if (busy() || !syncRuntimeReady() || syncAssetsEditing() || !force && !syncIsQuiet()) return;
            const nearby = host.nearby?.find(item => item.deviceId === state.peer?.id);
            if (nearby && !peerWasNearby) nextConnection = 0;
            peerWasNearby = !!nearby;
            if (nearby && state.peer && state.peer.address !== nearby.address) { state.peer.address = nearby.address; await saveState(); }
            if (!nearby && state.peer) lanSyncStore.setState({ online: false });
            for (const item of [...(host.queue ?? []), ...(host.incoming ? [host.incoming] : [])]) {
                if (busy() || !syncRuntimeReady() || syncAssetsEditing() || !force && !syncIsQuiet()) return;
                const remote = await unsealPacket(item.packet, state.hostingSecret!);
                await receive(remote); await lanControl('ack', { id: item.id });
            }
            if (!busy()) { await capturePending(); await applyInbox(false, undefined, force); }
            if (busy() || !syncRuntimeReady() || syncAssetsEditing() || !force && !syncIsQuiet()) return;
            await publishPacket();
            if (!state.peer?.address || !force && (!state.options.automatic || Date.now() < nextConnection)) { publishView(); return; }
            nextConnection = Date.now() + IDLE_SYNC_MS;
            lanSyncStore.setState({ busy: true, error: '', message: '正在连接已配对设备…' });
            if (!busy() && state.options.galleries) {
                const baseline = copySyncState(state), next = copySyncState(state);
                await captureGalleries(next, workspaceStore.getState().characters.map(card => card.id), message => lanSyncStore.setState({ message }));
                if (canonical(heads(next)) !== canonical(heads(baseline))) await saveState(next, baseline);
            }
            const outgoing = await publishPacket();
            if (!force && sentIv === outgoing.iv) {
                const info = await requestPeer<{ deviceId: string; packetId?: string | null }>(state.peer, 'hello');
                if (info.deviceId !== state.peer.id) throw new Error('发现的地址不属于已配对设备');
                lanSyncStore.setState({ online: true, error: '' });
                if (info.packetId !== undefined && (!info.packetId || info.packetId === receivedIv)) {
                    publishView(state.inbox?.length ? '远端剧情已暂存；换回本端或点击“立即同步”时接续' : '连接正常，暂无新内容'); return;
                }
            }
            const result = await requestPeer<{ packet: SealedPacket | null }>(state.peer, 'exchange', outgoing);
            sentIv = outgoing.iv;
            lanSyncStore.setState({ online: true, error: '' });
            if (result.packet) {
                if (result.packet.iv !== receivedIv) {
                    const remote = await unsealPacket(result.packet, state.peer.secret);
                    if (remote.deviceId !== state.peer.id) throw new Error('发现的地址不属于已配对设备');
                    await receive(remote); receivedIv = result.packet.iv;
                }
                await applyInbox(false, undefined, force);
            }
            await publishPacket();
            publishView(state.inbox?.length ? '远端更新已暂存；换回本端或点击“立即同步”时接续' : '已连接，同步进度已更新');
        } catch (error) {
            lanSyncStore.setState({ online: false, error: error instanceof Error ? error.message : String(error), message: '同步失败，内容保留在本机，重新发现设备后会重试' });
        } finally { publishView(); lanSyncStore.setState({ busy: false }); }
    })().finally(() => { running = undefined; });
}
export async function syncNow() {
    await waitCycle();
    if (!syncRuntimeReady() || busy() || syncAssetsEditing()) { publishView('请等待角色初始化、生成或编辑完成后再同步'); return; }
    manualSyncRequested = true;
    try { await cycle(true); } finally { manualSyncRequested = false; }
}

export function beginWorldbookEditing() {
    finishWorldbookEdit ??= beginSyncAssetEdit();
    lanSyncStore.setState({ editingWorldbooks: true });
}
export async function finishWorldbookEditing() {
    finishWorldbookEdit?.(); finishWorldbookEdit = undefined;
    lanSyncStore.setState({ editingWorldbooks: false, reviewPrompt: true });
    await initializeLanSync();
    dirty = true;
    scheduleChangedSync();
}
export async function resolveWorldbookReview(id: string, choice: 'local' | 'remote', localVersion: string, remoteVersion: string) {
    await waitCycle();
    if (busy() || syncAssetsEditing()) throw new Error('请先结束剧情生成或资源编辑，再选择版本');
    await capturePending(); await applyInbox();
    const review = state.worldbookReviews?.[id];
    if (!review) return;
    const current = state.records[id];
    if (current.version !== localVersion || review.remote.version !== remoteVersion) throw new Error('世界书有新的修改，请查看更新后的差异再选择');
    const selected = choice === 'local' ? current : review.remote;
    const resolution: SyncRevision = { ...structuredClone(selected), version: crypto.randomUUID(), device: state.deviceName, modified: Date.now(),
        ancestors: [...new Set([...current.ancestors, current.version, ...review.remote.ancestors, review.remote.version])] };
    await applyInbox(false, resolution, true);
    if (state.enabled) await syncNow();
}

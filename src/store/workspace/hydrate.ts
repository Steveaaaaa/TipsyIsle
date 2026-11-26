import { saveChatArchive } from '../chat-archives';
import { removeRetiredBuiltinWorldbooks } from '../../core/builtin-worldbook';
import { emptyStory } from '../../core/empty-workspace';
import { isRetiredGuide, isRetiredPreset } from '../../core/retired-starter-content';
import { platformStorage } from '../../core/platform-bridge';
import { scopedVariableStore, replaceExtensionVariables } from '../scoped-variable-store';
import { normalizeTemplateFeatures, legacyTemplateFeatures } from '../../pipeline/template-features';
import { compactCharacterCard, compactLorebook } from '../../pipeline/normalizer';
import { workspaceStore, type WorkspaceState } from './state';
import { refreshPromptInspectorPreview } from './prompt';
import { persistWorkspace } from './storage';
import { normalizeMessageVariableSnapshots, ensureInitialVariables } from './story-initialization';
import { captureChatContinuation } from './sessions';
import { restoreMessageSnapshot } from './branches';
import { syncCharacterScriptsFromLibrary, syncPresetScriptsFromLibrary } from './scripts';

export async function hydrateWorkspaceFromPlatform(preview = true): Promise<void> {
    const chat = await platformStorage.loadSnapshot<(Partial<WorkspaceState> & { snapshotVersion?: number }) | null>('workspace_snapshot', null);
    const assets = await platformStorage.loadSnapshot<Pick<WorkspaceState, 'characters' | 'lorebooks' | 'presets'> | null>('workspace_assets', null);
    const loaded = chat || assets ? { ...chat, ...assets } : null;
    const saved = loaded ? removeRetiredBuiltinWorldbooks(loaded) : null;
    let compacted = false;
    if (saved && typeof saved === 'object') {
        if (Array.isArray(saved.characters)) {
            saved.characters = saved.characters.map(card => {
                const next = compactCharacterCard(card);
                if (next.changed) compacted = true;
                return next.value;
            });
        }
        if (Array.isArray(saved.lorebooks)) {
            saved.lorebooks = saved.lorebooks.map(book => {
                const next = compactLorebook(book);
                if (next.changed) compacted = true;
                return next.value;
            });
        }
        if (saved.storyCharacter) {
            const next = compactCharacterCard(saved.storyCharacter);
            if (next.changed) { compacted = true; saved.storyCharacter = next.value; }
        }
        if (Array.isArray(saved.storyWorldbooks)) {
            saved.storyWorldbooks = saved.storyWorldbooks.map(book => {
                const next = compactLorebook(book);
                if (next.changed) compacted = true;
                return next.value;
            });
        }
    }
    const retiredGuides = (saved?.characters ?? []).filter(isRetiredGuide);
    // Preserve actual conversations with the old guide as recoverable archives.
    if (saved?.messages?.length && retiredGuides.some(card => card.id === saved.activeCharacterId)
        && (saved.messages.length > 1 || saved.messages[0].role !== 'assistant' || saved.messages[0].content !== retiredGuides.find(card => card.id === saved.activeCharacterId)?.firstMessage)) {
        await saveChatArchive({ id: saved.activeChatId!, characterId: saved.activeCharacterId!, messages: saved.messages,
            activeLeafId: saved.activeLeafId ?? null, timedStates: saved.timedStates ?? {},
            templateInjections: saved.templateInjections, templateActivations: saved.templateActivations, syncLabel: '原向导会话',
            continuation: captureChatContinuation({ ...workspaceStore.getState(), ...saved } as WorkspaceState) });
    }
    const messages = Array.isArray(saved?.messages) ? normalizeMessageVariableSnapshots(saved.messages) : undefined;
    if (saved && typeof saved === 'object') {
        workspaceStore.setState((draft) => {
            draft.branchEpoch = saved.branchEpoch ?? 0;
            draft.sessionKind = saved.sessionKind ?? 'character';
            draft.freeChat = saved.freeChat;
            draft.storyChatTitle = saved.storyChatTitle;
            draft.storyImportFingerprint = saved.storyImportFingerprint;
            draft.portableStory = saved.portableStory;
            draft.chatMetadata = saved.chatMetadata;
            draft.nativePluginRoute = saved.nativePluginRoute;
            draft.branchExtensionKeys = saved.branchExtensionKeys ?? [];
            draft.deletedMessageIds = saved.deletedMessageIds ?? [];
            draft.storyWorldbooks = saved.storyWorldbooks ?? undefined;
            draft.storyCharacterBinding = saved.storyCharacterBinding ?? undefined;
            draft.storyCharacter = saved.storyCharacter ?? undefined;
            draft.storyPersona = saved.storyPersona ?? undefined;
            if (saved.userName) draft.userName = !saved.activePersonaId && saved.userName === '玩家' ? '用户' : saved.userName;
            draft.streamDisplayModes = saved.streamDisplayModes ?? {};
            if (saved.personas) draft.personas = saved.personas;
            draft.activePersonaId = saved.activePersonaId ?? null;
            if (Array.isArray(saved.characters)) draft.characters = saved.characters;
            draft.activeCharacterId = saved.activeCharacterId ?? '';
            if (Array.isArray(saved.lorebooks)) draft.lorebooks = saved.lorebooks;
            if (Array.isArray(saved.activeLorebookIds)) draft.activeLorebookIds = saved.activeLorebookIds;
            if (saved.characterWorldbookBindings) draft.characterWorldbookBindings = saved.characterWorldbookBindings;
            if (saved.characterPresetBindings) draft.characterPresetBindings = saved.characterPresetBindings;
            if (saved.chatWorldbookBindings) draft.chatWorldbookBindings = saved.chatWorldbookBindings;
            if (Array.isArray(saved.presets)) draft.presets = saved.presets;
            if (saved.activePresetId) draft.activePresetId = saved.activePresetId;
            draft.inUsePreset = saved.inUsePreset ?? draft.presets.find(item => item.id === draft.activePresetId);
            draft.storyCharacter = syncCharacterScriptsFromLibrary(draft.storyCharacter, draft.characters, draft.portableStory);
            draft.inUsePreset = syncPresetScriptsFromLibrary(draft.inUsePreset, draft.presets, draft.portableStory);
            if (saved.activeChatId) draft.activeChatId = saved.activeChatId;
            if (messages) draft.messages = messages;
            draft.activeLeafId = saved.activeLeafId === null && (saved.snapshotVersion ?? 1) >= 2 ? null : saved.activeLeafId ?? draft.messages.at(-1)?.id ?? null;
            if (saved.timedStates) draft.timedStates = saved.timedStates;
            if (Array.isArray(saved.templateInjections)) draft.templateInjections = saved.templateInjections;
            if (Array.isArray(saved.templateActivations)) draft.templateActivations = saved.templateActivations;
        });
    }
    let retired = false;
    workspaceStore.setState(draft => {
        const guides = draft.characters.filter(isRetiredGuide), presets = draft.presets.filter(isRetiredPreset);
        retired = !!guides.length || !!presets.length || !!draft.inUsePreset && isRetiredPreset(draft.inUsePreset);
        draft.characters = draft.characters.filter(card => !isRetiredGuide(card));
        draft.presets = draft.presets.filter(preset => !isRetiredPreset(preset));
        if (draft.inUsePreset && isRetiredPreset(draft.inUsePreset)) { draft.activePresetId = ''; draft.inUsePreset = undefined; }
        else if (!draft.inUsePreset && presets.some(preset => preset.id === draft.activePresetId)) draft.activePresetId = '';
        for (const guide of guides) { delete draft.characterWorldbookBindings[guide.id]; delete draft.characterPresetBindings[guide.id]; delete draft.streamDisplayModes[guide.id]; }
        const retiredPresetIds = new Set(presets.map(preset => preset.id));
        for (const [charId, presetId] of Object.entries(draft.characterPresetBindings)) {
            if (presetId && retiredPresetIds.has(presetId)) delete draft.characterPresetBindings[charId];
        }
        if (draft.sessionKind !== 'free' && (guides.some(card => card.id === draft.activeCharacterId) || !draft.activeCharacterId)) Object.assign(draft, emptyStory());
    });
    if (!saved?.storyWorldbooks) ensureInitialVariables();
    const leaf = workspaceStore.getState().activeLeafId;
    if (!saved?.storyWorldbooks && leaf && workspaceStore.getState().messages.find(message => message.id === leaf)?.extra?.swipeVariables) {
        const node = workspaceStore.getState().messages.find(message => message.id === leaf)!;
        const legacyTemplateState = !node.extra?.swipeTemplateStates && saved
            ? { templateInjections: saved.templateInjections ?? [], templateActivations: saved.templateActivations ?? [] } : undefined;
        restoreMessageSnapshot(leaf);
        if (legacyTemplateState) workspaceStore.setState(legacyTemplateState);
    }
    if (!Object.hasOwn(scopedVariableStore.getState().extension, 'EjsTemplate')) {
        replaceExtensionVariables('EjsTemplate', saved ? { ...legacyTemplateFeatures, tipsy_migrated_legacy_features: true } : { ...normalizeTemplateFeatures() });
    }
    if (retired || compacted || saved !== loaded || messages && messages !== saved?.messages) persistWorkspace();
    if (preview && workspaceStore.getState().sessionKind !== 'free') await refreshPromptInspectorPreview();
}

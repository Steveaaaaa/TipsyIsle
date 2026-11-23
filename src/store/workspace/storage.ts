import { persistRegisteredSnapshots, persistStateTransaction, registerSnapshotSource } from '../persistence';
import { setStatusBanner } from './notice';
import { batchReactiveUpdates } from '../reactive-store';
import { rollbackStateChanges } from '../state-rollback';
import { scopedVariableStore } from '../scoped-variable-store';
import { workspaceStore, type WorkspaceState } from './state';
import { preserveAuthorMessageRevision } from './queries';

export async function persistWorkspaceNow(): Promise<void> { await persistRegisteredSnapshots(); }

export function persistWorkspace(): void { void persistWorkspaceNow().catch(error => setStatusBanner(`保存失败：${error instanceof Error ? error.message : String(error)}`)); }

// Sync calls these inside its existing multi-store publication and rollback batches.
export function publishSyncedWorkspace(snapshot: WorkspaceState): void {
    workspaceStore.setState(snapshot);
}

export function rollbackWorkspacePublication(before: WorkspaceState, after: WorkspaceState, nativeOnly = false): void {
    const current = workspaceStore.getState(), restored = rollbackStateChanges(current, before, after);
    if (nativeOnly) preserveAuthorMessageRevision(current.messages, restored.messages);
    workspaceStore.setState(restored);
}

/** Roll back only this publication if durable storage rejects it. Immutable store
 * snapshots make later edits distinguishable from the writes being undone. */
export async function commitWorkspaceMutation(publish: () => void, localExtras?: Record<string, unknown>, nativeOnly = false): Promise<void> {
    let beforeWorkspace = workspaceStore.getState(); let beforeVariables = scopedVariableStore.getState();
    let afterWorkspace = beforeWorkspace; let afterVariables = beforeVariables;
    let published = false;
    const rollback = () => batchReactiveUpdates(() => {
        if (!published) return;
        rollbackWorkspacePublication(beforeWorkspace, afterWorkspace, nativeOnly);
        scopedVariableStore.setState(rollbackStateChanges(scopedVariableStore.getState(), beforeVariables, afterVariables));
    });
    await persistStateTransaction(() => batchReactiveUpdates(() => {
        beforeWorkspace = workspaceStore.getState(); beforeVariables = scopedVariableStore.getState(); published = true;
        try { publish(); }
        catch (error) {
            afterWorkspace = workspaceStore.getState(); afterVariables = scopedVariableStore.getState();
            rollback(); published = false; throw error;
        }
        afterWorkspace = workspaceStore.getState(); afterVariables = scopedVariableStore.getState();
    }), rollback, undefined, localExtras);
}

export function registerWorkspaceSnapshots() {
    registerSnapshotSource('workspace_assets', () => {
        const s = workspaceStore.getState();
        return { characters: s.characters, lorebooks: s.lorebooks, presets: s.presets };
    });
    registerSnapshotSource('workspace_snapshot', () => {
        const s = workspaceStore.getState();
        return {
            snapshotVersion: 2,
            branchEpoch: s.branchEpoch,
            nativeStoryPending: s.isGenerating || s.helperGenerationCount > 0 || s.mvuExtraAnalysisActive,
            nativeStoryReply: s.sessionKind === 'free' ? undefined : s.nativeStoryReply,
            chatMetadata: s.chatMetadata,
            nativePluginRoute: s.nativePluginRoute,
            branchExtensionKeys: s.branchExtensionKeys,
            deletedMessageIds: s.deletedMessageIds,
            storyWorldbooks: s.storyWorldbooks ?? null,
            storyCharacterBinding: s.storyCharacterBinding ?? null,
            storyCharacter: s.storyCharacter ?? null,
            storyPersona: s.storyPersona ?? null,
            streamDisplayModes: s.streamDisplayModes,
            userName: s.userName,
            personas: s.personas,
            activePersonaId: s.activePersonaId,
            activeCharacterId: s.activeCharacterId,
            activeLorebookIds: s.activeLorebookIds,
            characterWorldbookBindings: s.characterWorldbookBindings,
            characterPresetBindings: s.characterPresetBindings,
            chatWorldbookBindings: s.chatWorldbookBindings,
            activePresetId: s.activePresetId,
            inUsePreset: s.inUsePreset,
            activeChatId: s.activeChatId,
            storyChatTitle: s.storyChatTitle,
            sessionKind: s.sessionKind,
            freeChat: s.freeChat,
            storyImportFingerprint: s.storyImportFingerprint,
            portableStory: s.portableStory,
            messages: s.messages,
            activeLeafId: s.activeLeafId,
            timedStates: s.timedStates,
            templateInjections: s.templateInjections,
            templateActivations: s.templateActivations,
        };
    });
}

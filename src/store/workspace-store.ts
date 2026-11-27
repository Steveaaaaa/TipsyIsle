// Stable entry for the shell, compatibility adapters, sync, and plugins.
import { connectTemplateCommit } from './workspace/prompt';
import { connectSessionBranches } from './workspace/sessions';
import { restoreMessageSnapshot, captureMessageSnapshot } from './workspace/branches';
import { installWorkspaceStoryRuntime, installWorkspaceAssetVariables } from './workspace/runtime';
import { commitPromptTask } from './workspace/prompt-commit';
import { registerWorkspaceSnapshots } from './workspace/storage';

export { saveSettingsEdits } from './workspace/settings';
export { commitNativeWorkspace, commitNativeAssetEdit, applyNativeChatEdit, openNativePluginRoute } from './workspace/runtime';
export { worldbooksChanged, selectPersona, savePlayerPersona, clearCharacterPersona, setGlobalWorldbookEnabled, setCharacterWorldbookBinding, updateLorebookEntry, updateCharacterDocument, replaceActiveWorldbookEntries, selectPreset, applyPresetSettings, updatePresetPrompt, removeWorldbookFromWorkspace, deleteWorkspaceWorldbook, getCharacterDeletionBooks, deleteWorkspaceCharacter, deleteWorkspaceCharacters, deleteWorkspacePreset, clearImportedWorkspace, importStoryCharacter, importAssetFile, exportCharacterAsPng, saveWorkspaceRegexRules } from './workspace/library-actions';
export {
    setHelperCharacterAvatar, addHelperCharacter, importHelperCharacter, replaceHelperCharacterRegexes,
    writeHelperPreset, removeHelperPreset, renameHelperPreset, replaceHelperPresetRegexes,
    saveHelperPersona, removeHelperPersona,
    writeHelperWorldbook, importHelperWorldbook, replaceHelperGlobalWorldbookBindings, bindHelperCharacterWorldbooks,
    bindHelperChatWorldbook, removeLibraryWorldbook,
} from './workspace/library-actions';
export { hydrateWorkspaceFromPlatform } from './workspace/hydrate';
export { saveLegacyChat, editHelperChatMessage, setHelperChatMessages, createHelperChatMessages, deleteHelperChatMessages, rotateHelperChatMessages, editChatMessage, editMessageInPlace, attachReplyIllustration, deleteChatMessage, swipeChatMessage } from './workspace/message-edits';

export { stopActiveGeneration, regenerateLastAssistantMessage, reprocessLastMvuMessage, type MvuRepairPreview, prepareMvuRepair, applyMvuRepair, canUndoMvuRepair, undoMvuRepair, repairLastMvuMessage, sendUserMessageAndGenerate } from './workspace/generation';
export { appendChatMessage } from './workspace/messages';
export { getWorkspaceScriptTrees, getWorkspaceScripts, replaceWorkspaceScriptTrees, syncCharacterScriptsFromLibrary, syncPresetScriptsFromLibrary } from './workspace/scripts';
export { validateHelperVariableWrite, saveHelperVariables, commitMvuInitialization, commitMvuMessage } from './workspace/story-variables';
export { commitPromptVariableChanges, commitPromptTask } from './workspace/prompt-commit';

export { captureMessageSnapshot, updateWorldbookTimedEffects, sealBranchPoint, trackBranchExtension, retryStoryFrom, selectChatBranch, deleteStoryBranch } from './workspace/branches';

export { readNativeChat, listArchivedChats, readHelperChatArchives, importHelperChat, storySaveDuplicate, importStorySave, readStoryForExport, restoreArchivedChat, SYNC_EXTENSIONS, restoreChatExtensions, captureChatContinuation, applyArchivedChat, createChat, selectCharacter, startNewChat, startFreeChat, getFreeChatConnection, updateFreeChat, renameStoryChat, deleteWorkspaceChats } from './workspace/sessions';

export { authorMessageRevision, preserveAuthorMessageRevision, getEffectiveMvuSettings, getActiveChatMessages, getChatBranchOptions } from './workspace/queries';
export { persistWorkspaceNow, publishSyncedWorkspace, rollbackWorkspacePublication } from './workspace/storage';
export { updateHelperGenerationCount, setMvuExtraAnalysisActive } from './workspace/activity';
export { setStatusBanner } from './workspace/notice';
export { observePromptInspector, refreshPromptInspectorPreview, createPromptAssemblyInput, invalidateTemplateEnvironment, templateLifecycleKey, ensureTemplatePreload, refreshMessageTemplates, refreshTemplateLifecycle } from './workspace/prompt';
export { getMessageComponentTargets, getMessageStreamPreview, formatMessageForDisplay, isMessageTemplatePending } from './workspace/message-display';

export { type WorkspaceState, workspaceStore } from './workspace/state';
export { getActiveCharacter, getActivePreset, getAvailableWorldbooks, getActivePersona, getCharacterWorldbooks, getActiveLorebooks } from './workspace/library';
export { embedCharacterCardIntoPng } from '../core/png-chunk-codec';

installWorkspaceStoryRuntime();
registerWorkspaceSnapshots();
installWorkspaceAssetVariables();

connectTemplateCommit(commitPromptTask);
connectSessionBranches({ capture: captureMessageSnapshot, restore: restoreMessageSnapshot });

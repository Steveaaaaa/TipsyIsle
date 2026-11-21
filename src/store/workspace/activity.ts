import { syncRuntimeReady } from '../../core/sync/activity';
import { pendingBranchOperations } from '../branch-runtime';
import { workspaceStore } from './state';

let nativeStorySaving = false;

export function setNativeStorySaving(value: boolean) { nativeStorySaving = value; }

export function isNativeStorySaving() { return nativeStorySaving; }

export function updateHelperGenerationCount(count: () => number): void {
    workspaceStore.setState(draft => { draft.helperGenerationCount = count(); });
}

export function setMvuExtraAnalysisActive(active: boolean | (() => boolean)): void {
    workspaceStore.setState(draft => { draft.mvuExtraAnalysisActive = typeof active === 'function' ? active() : active; });
}

export function branchBusy(internal = false) { const s = workspaceStore.getState(); return nativeStorySaving || !syncRuntimeReady() || s.isGenerating || s.helperGenerationCount > 0 || s.mvuExtraAnalysisActive || pendingBranchOperations() > (internal ? 1 : 0); }

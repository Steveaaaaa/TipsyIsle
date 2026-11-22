import { scopedVariableStore, replaceExtensionVariables } from '../scoped-variable-store';
import { normalizeScriptTrees, scriptsFromTrees, type ScriptScope, type ScriptTrees } from '../../compatibility/script-trees';
import { workspaceStore, type WorkspaceState } from './state';
import { getActivePreset, getActiveCharacter } from './library';

const emptyScriptTrees: any[] = [];

let cachedScriptTrees: ScriptTrees | undefined;

let cachedScripts: ReturnType<typeof scriptsFromTrees> = [];

export function getWorkspaceScriptTrees(state: WorkspaceState = workspaceStore.getState()): ScriptTrees {
    const card = getActiveCharacter(state); const preset = getActivePreset(state);
    const extension = (card.extensions?.tavern_helper ?? card.extensions?.TavernHelper) as any;
    const trees = { global: (scopedVariableStore.getState().extension.tavern_helper?.scripts as any[]) ?? emptyScriptTrees,
        preset: (preset.rawData?.extensions as any)?.tavern_helper?.scripts ?? emptyScriptTrees, character: extension?.scripts ?? emptyScriptTrees };
    if (cachedScriptTrees && (Object.keys(trees) as ScriptScope[]).every(type => trees[type] === cachedScriptTrees![type])) return cachedScriptTrees;
    cachedScriptTrees = trees;
    cachedScripts = [...new Map([...scriptsFromTrees(trees.global), ...scriptsFromTrees(trees.preset), ...scriptsFromTrees(trees.character)].map(script => [script.id, script])).values()];
    return trees;
}

export function getWorkspaceScripts(state: WorkspaceState = workspaceStore.getState()) { getWorkspaceScriptTrees(state); return cachedScripts; }

export function replaceWorkspaceScriptTrees(values: any[], type: ScriptScope, normalize = true): void {
    const trees = normalize ? normalizeScriptTrees(values) : values;
    if (type === 'global') replaceExtensionVariables('tavern_helper', { ...scopedVariableStore.getState().extension.tavern_helper, scripts: trees });
    else if (type === 'character') workspaceStore.setState(draft => {
        draft.storyCharacter ??= structuredClone(getActiveCharacter());
        const card = draft.storyCharacter;
        const helper = (card.extensions?.tavern_helper ?? card.extensions?.TavernHelper ?? {}) as object;
        card.extensions = { ...card.extensions, tavern_helper: { ...helper, scripts: trees } };
        const libraryCard = draft.characters.find(item => item.id === card.id);
        if (libraryCard) {
            const libHelper = (libraryCard.extensions?.tavern_helper ?? libraryCard.extensions?.TavernHelper ?? {}) as object;
            libraryCard.extensions = { ...libraryCard.extensions, tavern_helper: { ...libHelper, scripts: trees } };
        }
    });
    else if (type === 'preset') {
        const current = getActivePreset();
        workspaceStore.setState(draft => {
            if (!draft.inUsePreset) draft.inUsePreset = structuredClone(current);
            const preset = draft.inUsePreset;
            const extensions = preset.rawData?.extensions as any ?? {};
            preset.rawData = { ...preset.rawData, extensions: { ...extensions, tavern_helper: { ...extensions.tavern_helper, scripts: trees } } };
            const listPreset = draft.presets.find(item => item.id === preset.id);
            if (listPreset) {
                const listExt = listPreset.rawData?.extensions as any ?? {};
                listPreset.rawData = { ...listPreset.rawData, extensions: { ...listExt, tavern_helper: { ...listExt.tavern_helper, scripts: trees } } };
            }
        });
    } else throw new Error(`未知脚本作用域：${type}`);
}

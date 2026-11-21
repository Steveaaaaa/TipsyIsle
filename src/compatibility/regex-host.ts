import { getActiveCharacter, getActivePreset, workspaceStore, persistWorkspaceNow, replaceHelperCharacterRegexes, replaceHelperPresetRegexes } from '../store/workspace-store';
import { replaceExtensionVariables } from '../store/scoped-variable-store';
import { workspaceGlobalRegexes } from '../store/global-regex-store';
import { fromTavernRegexes } from './regex-codec';
import { characterAvatarId } from './asset-identity';
export function regexCatalog() {
    const state = workspaceStore.getState();
    return { global: workspaceGlobalRegexes(), characters: state.characters.map(card => ({ id: card.id, name: card.name, avatar: characterAvatarId(card), rules: card.regexScripts })),
        presets: state.presets.map(preset => ({ id: preset.id, name: preset.name, rules: preset.regexScripts ?? [] })), presetId: state.activePresetId, inUse: getActivePreset().regexScripts ?? [] };
}
export async function replaceHostRegexes(values: any[], option: any = {}): Promise<void> {
    const state = workspaceStore.getState();
    const write = (type: string, input: any[], name?: string) => {
        if (type === 'global') { replaceExtensionVariables('tipsy_regex', { rules: fromTavernRegexes(input, workspaceGlobalRegexes()) }); return; }
        if (type === 'character') {
            const card = !name || name === 'current' ? getActiveCharacter() : state.characters.find(card => [card.id, card.name, characterAvatarId(card)].includes(name));
            if (!card) throw new Error(`找不到角色：${name}`);
            const rules = fromTavernRegexes(input, card.regexScripts);
            replaceHelperCharacterRegexes(card.id, rules);
        } else if (type === 'preset') {
            const preset = !name || name === 'in_use' ? getActivePreset() : state.presets.find(preset => preset.name === name || preset.id === name);
            if (!preset) throw new Error(`找不到预设：${name}`);
            const rules = fromTavernRegexes(input, preset.regexScripts);
            replaceHelperPresetRegexes(preset, rules, !name || name === 'in_use');
        } else throw new Error(`未知正则类型：${type}`);
    };
    if (option.type) write(option.type, values, option.name);
    else {
        const scope = option.scope ?? 'all';
        if (!['all', 'global', 'character'].includes(scope)) throw new Error(`未知正则 scope：${scope}`);
        if (scope !== 'character') write('global', values.filter(rule => rule.scope === 'global'));
        if (scope !== 'global') write('character', values.filter(rule => rule.scope !== 'global'));
    }
    await persistWorkspaceNow();
}
export type ReturnRegexCatalog = ReturnType<typeof regexCatalog>;

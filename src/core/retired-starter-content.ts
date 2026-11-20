import { normalizeCharacterCard, normalizePreset } from '../pipeline/normalizer';
import { canonical } from './sync/protocol';
import type { NormalizedCharacterCard, NormalizedPreset } from '../types';

// Kept only to recognize unchanged content from installations before onboarding.
export const RETIRED_GUIDE = normalizeCharacterCard({
    id: 'char_tipsy_guide', spec: 'chara_card_v3', spec_version: '3.0',
    data: { id: 'char_tipsy_guide', name: '微醺屿向导', creator: 'TipsyIsle', character_version: '3.0.0', avatar: '',
        description: '{{char}}是微醺屿的内置示例角色，帮助{{user}}了解角色导入与对话功能。',
        personality: '友善、简洁，提供清楚的使用指引。', scenario: '用户首次进入微醺屿，准备导入角色卡并开始故事。',
        first_mes: '欢迎来到微醺屿。先在「设置个人资料」中填写称呼、头像与人设，再导入角色卡并连接模型，即可开始故事。你也可以随时点击对话顶部的头像修改资料。',
        alternate_greetings: [], mes_example: '', system_prompt: '作为应用向导，简洁回答用户的使用问题，不虚构功能或执行结果。',
        post_history_instructions: '', tags: ['内置示例', '使用指引'], regex_scripts: [] },
});
const retiredPreset = normalizePreset({ name: '微醺屿·细腻文学叙事预设' });
const withoutIdentity = (value: NormalizedCharacterCard | NormalizedPreset) => {
    const { id: _id, rawData, ...copy } = value;
    const { id: _rawId, ...raw } = rawData ?? {};
    return canonical({ ...copy, rawData: raw });
};
const presetDefinition = (preset: NormalizedPreset) => canonical({ name: preset.name, rawData: preset.rawData,
    prompts: preset.promptSlots ?? preset.prompts, regexScripts: preset.regexScripts });
const guideContent = withoutIdentity(RETIRED_GUIDE), presetContent = presetDefinition(retiredPreset);
export const isRetiredGuide = (card: NormalizedCharacterCard) => card.name === RETIRED_GUIDE.name && withoutIdentity(card) === guideContent;
export const isRetiredPreset = (preset: NormalizedPreset) => preset.name === retiredPreset.name && presetDefinition(preset) === presetContent;

export function removeStarterGlobals<T extends Record<string, unknown>>(variables: T): T {
    const defaults = { affection: 92, mood: '甜滋滋又有点害羞', location: '微醺屿·海风书房' };
    const remove = Object.keys(defaults).filter(key => variables[key] === defaults[key]);
    if (!remove.length) return variables;
    const next = { ...variables }; for (const key of remove) delete next[key];
    return next;
}
export function removeStarterContinuation<T extends { activePresetId: string; inUsePreset: any; variables: { global: Record<string, unknown> } }>(value: T): T {
    const global = removeStarterGlobals(value.variables.global);
    const removePreset = value.inUsePreset && isRetiredPreset(value.inUsePreset);
    if (global === value.variables.global && !removePreset) return value;
    return { ...value, variables: global === value.variables.global ? value.variables : { ...value.variables, global },
        ...(removePreset ? { activePresetId: '', inUsePreset: undefined } : {}) };
}

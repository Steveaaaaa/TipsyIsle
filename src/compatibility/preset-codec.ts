import type { NormalizedPreset } from '../types';
import { normalizePreset } from '../pipeline/normalizer';
import { serializeRegexRule } from '../pipeline/asset-serializer';
import { fromTavernRegexes, toTavernRegex } from './regex-codec';
import { DEFAULT_CONTEXT_TOKENS, DEFAULT_RESPONSE_TOKENS } from '../core/generation-defaults';

export const systemPromptIds = ['main', 'nsfw', 'jailbreak', 'enhanceDefinitions'];
export const placeholderPromptIds = ['worldInfoBefore', 'personaDescription', 'charDescription', 'charPersonality', 'scenario', 'worldInfoAfter', 'dialogueExamples', 'chatHistory'];
export const defaultPresetSettings = {
    max_context: DEFAULT_CONTEXT_TOKENS, max_completion_tokens: DEFAULT_RESPONSE_TOKENS, reply_count: 1, should_stream: false,
    temperature: 1, frequency_penalty: 0, presence_penalty: 0, repetition_penalty: 1, top_p: 1, min_p: 0, top_k: 0, top_a: 0, seed: -1,
    squash_system_messages: false, reasoning_effort: 'auto', request_thoughts: false, request_images: false,
    enable_function_calling: false, enable_web_search: false, allow_sending_images: 'disabled', allow_sending_videos: false,
    character_name_prefix: 'none', wrap_user_messages_in_quotes: false,
};
export interface HelperPreset { settings: Record<string, any>; prompts: any[]; prompts_unused: any[]; extensions: Record<string, any> }
export const defaultHelperPreset: HelperPreset = {
    settings: defaultPresetSettings,
    prompts: placeholderPromptIds.map(id => ({ id, name: id, enabled: true, position: { type: 'relative' }, role: 'system' })),
    prompts_unused: [], extensions: { tavern_helper: { scripts: [], variables: {} } },
};
const settingFields: Record<string, string> = {
    max_context: 'openai_max_context', max_completion_tokens: 'openai_max_tokens', reply_count: 'n', should_stream: 'stream_openai',
    request_thoughts: 'show_thoughts', enable_function_calling: 'function_calling', allow_sending_videos: 'video_inlining', wrap_user_messages_in_quotes: 'wrap_in_quotes',
};
const normalizedFields: Record<string, keyof NormalizedPreset> = {
    max_context: 'maxContextTokens', max_completion_tokens: 'maxResponseTokens', temperature: 'temperature', top_p: 'topP', top_k: 'topK', min_p: 'minP',
    repetition_penalty: 'repetitionPenalty', frequency_penalty: 'frequencyPenalty', presence_penalty: 'presencePenalty',
};
export function toHelperPreset(preset: NormalizedPreset): HelperPreset {
    const raw = preset.rawData as Record<string, any> ?? {};
    const settings: Record<string, any> = { ...defaultPresetSettings };
    for (const key of Object.keys(settings)) settings[key] = preset[normalizedFields[key]] ?? raw[settingFields[key] ?? key] ?? settings[key];
    settings.allow_sending_images = raw.image_inlining ? raw.inline_image_quality ?? 'auto' : 'disabled';
    settings.character_name_prefix = ({ '-1': 'none', '0': 'default', '1': 'completion', '2': 'content' } as Record<string, string>)[raw.names_behavior] ?? 'none';
    const group = raw.prompt_order?.find?.((item: any) => item.character_id === 100001) ?? raw.prompt_order?.[0];
    const order: any[] | undefined = Array.isArray(group?.order) ? group.order : Array.isArray(raw.prompt_order) ? raw.prompt_order : undefined;
    const used = order ? new Set(order.map(item => item.identifier)) : undefined;
    const prompts: any[] = []; const prompts_unused: any[] = [];
    for (const slot of preset.promptSlots ?? preset.prompts ?? []) {
        const original = raw.prompts?.find?.((item: any) => item.identifier === slot.identifier) ?? {};
        const placeholder = placeholderPromptIds.includes(slot.identifier);
        const value = { id: slot.identifier, name: slot.name, enabled: used && !used.has(slot.identifier) ? original.enabled !== false : slot.enabled, role: slot.role,
            ...(!systemPromptIds.includes(slot.identifier) ? { position: slot.injectionPosition === 'in_chat' ? { type: 'in_chat', depth: slot.injectionDepth ?? 4, order: slot.depthOrder ?? original.injection_order ?? 100 } : { type: 'relative' } } : {}),
            ...(!placeholder ? { content: slot.content } : {}), ...(original.extra ? { extra: structuredClone(original.extra) } : {}) };
        (used && !used.has(slot.identifier) ? prompts_unused : prompts).push(value);
    }
    return { settings, prompts, prompts_unused, extensions: { ...structuredClone(raw.extensions ?? {}), tavern_helper: { scripts: [], variables: {}, ...structuredClone(raw.extensions?.tavern_helper ?? {}) }, regex_scripts: (preset.regexScripts ?? []).map(toTavernRegex) } };
}
export function fromHelperPreset(value: HelperPreset, name: string, previous?: NormalizedPreset): NormalizedPreset {
    const raw: Record<string, any> = { ...structuredClone(previous?.rawData ?? {}), name };
    // Canonical fields take precedence over aliases in the normalizer.
    delete raw.promptSlots; delete raw.regexScripts;
    const settings = { ...defaultPresetSettings, ...value.settings } as Record<string, any>;
    for (const [key, item] of Object.entries(settings)) {
        raw[settingFields[key] ?? key] = item;
        if (normalizedFields[key]) raw[normalizedFields[key]] = item;
    }
    raw.image_inlining = settings.allow_sending_images !== 'disabled'; raw.inline_image_quality = settings.allow_sending_images;
    raw.names_behavior = ({ none: -1, default: 0, completion: 1, content: 2 } as Record<string, number>)[settings.character_name_prefix];
    const seen = new Set<string>();
    const convert = (prompt: any) => {
        let id = prompt.id || crypto.randomUUID();
        if (seen.has(id)) {
            if (systemPromptIds.includes(id) || placeholderPromptIds.includes(id)) throw new Error(`预设存在重复系统或占位提示词：${id}`);
            id = crypto.randomUUID();
        }
        seen.add(id);
        const original = (raw.prompts as any[] | undefined)?.find(item => item.identifier === prompt.id) ?? {};
        return { ...original, identifier: id, name: prompt.name, enabled: prompt.enabled !== false, role: prompt.role ?? 'system', content: prompt.content ?? '',
            injection_position: prompt.position?.type === 'in_chat' ? 1 : 0, injection_depth: prompt.position?.depth ?? 4, injection_order: prompt.position?.order ?? 100,
            system_prompt: systemPromptIds.includes(id) || placeholderPromptIds.includes(id), marker: placeholderPromptIds.includes(id), extra: prompt.extra };
    };
    const used = (value.prompts ?? []).map(convert);
    raw.prompts = [...used, ...(value.prompts_unused ?? []).map(convert)];
    raw.prompt_order = [{ character_id: 100001, order: used.map(prompt => ({ identifier: prompt.identifier, enabled: prompt.enabled })) }];
    raw.extensions = structuredClone(value.extensions ?? {});
    raw.extensions.regex_scripts = fromTavernRegexes(raw.extensions.regex_scripts ?? [], previous?.regexScripts, true).map(serializeRegexRule);
    const next = normalizePreset(raw, name);
    // An explicitly empty list must stay empty rather than receiving starter prompts.
    if (!raw.prompts.length) next.promptSlots = [];
    next.id = previous?.id ?? `preset_${crypto.randomUUID()}`;
    return next;
}

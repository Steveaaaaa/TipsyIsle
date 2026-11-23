import type { AssembledPromptMessage, NormalizedPreset } from '../types';
import { DEFAULT_RESPONSE_TOKENS } from './generation-defaults';

export function presetSchemaValues(preset: NormalizedPreset): Record<string, unknown> {
    const values: Record<string, unknown> = {
        temperature: preset.temperature, top_p: preset.topP, top_k: preset.topK,
        min_p: preset.minP, frequency_penalty: preset.frequencyPenalty,
        presence_penalty: preset.presencePenalty, max_tokens: preset.maxResponseTokens,
        context_max_tokens: preset.maxContextTokens,
    };
    const settings = Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined).map(([key, value]) => [`sampler.${key}`, value]));
    if (preset.rawData?.stream_openai !== undefined) settings['api.stream'] = preset.rawData.stream_openai;
    if (preset.rawData?.reasoning_effort !== undefined) settings['sampler.reasoning_effort'] = preset.rawData.reasoning_effort;
    return settings;
}

/** Shared by ordinary chat generation and Helper's return-only requests. */
export function presetSamplingParameters(preset: NormalizedPreset, live?: Record<string, unknown>): Record<string, unknown> {
    const raw = preset.rawData ?? {};
    const value = (key: string, fallback: unknown) => live?.[`sampler.${key}`] ?? fallback;
    const output: Record<string, unknown> = {
        temperature: value('temperature', preset.temperature ?? 1), max_tokens: value('max_tokens', preset.maxResponseTokens ?? DEFAULT_RESPONSE_TOKENS),
        top_p: value('top_p', preset.topP ?? 1), frequency_penalty: value('frequency_penalty', preset.frequencyPenalty ?? 0),
        presence_penalty: value('presence_penalty', preset.presencePenalty ?? 0),
    };
    for (const [key, item] of Object.entries({ top_k: value('top_k', preset.topK), min_p: value('min_p', preset.minP), top_a: raw.top_a,
        repetition_penalty: preset.repetitionPenalty })) {
        if (typeof item === 'number' && item > 0 && !(key === 'repetition_penalty' && item === 1)) output[key] = item;
    }
    const seed = value('seed', raw.seed);
    if (typeof seed === 'number' && seed >= 0) output.seed = seed;
    const reasoning = value('reasoning_effort', raw.reasoning_effort);
    if (reasoning && reasoning !== 'auto') output.reasoning_effort = reasoning;
    if (Number(raw.n) > 1) output.n = Math.floor(Number(raw.n));
    return output;
}

export function formatPresetMessages(messages: AssembledPromptMessage[], preset: NormalizedPreset,
    speakers: ReadonlyMap<string, string>, userName: string, characterName: string): AssembledPromptMessage[] {
    const raw = preset.rawData ?? {};
    const nameMode = Number(raw.names_behavior ?? -1);
    const formatted = messages.map(message => {
        let content = message.content;
        const speaker = speakers.get(message.sourceId) ?? (message.sourceId === 'helper_user_input' ? userName : undefined);
        let name: string | undefined;
        if (speaker && message.role !== 'system') {
            if (nameMode === 2 || nameMode === 0 && speaker !== (message.role === 'user' ? userName : characterName)) content = `${speaker}: ${content}`;
            else if (nameMode === 1) name = speaker.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 64) || (message.role === 'user' ? 'User' : 'Assistant');
        }
        if (raw.wrap_in_quotes && message.role === 'user') content = `"${content}"`;
        return { ...message, content, ...(name ? { name } : {}) };
    });
    if (!raw.squash_system_messages) return formatted;
    const result: AssembledPromptMessage[] = [];
    for (const message of formatted) {
        const previous = result.at(-1);
        if (message.role === 'system' && previous?.role === 'system') {
            previous.content += `\n\n${message.content}`;
            previous.tokens += message.tokens;
            if (message.images?.length) previous.images = [...previous.images ?? [], ...message.images];
        } else result.push(message);
    }
    return result;
}

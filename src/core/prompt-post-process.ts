import type { AssembledChatMessage, NormalizedPreset } from '../types';

export type PromptPostProcessingMode =
    | ''
    | 'merge'
    | 'merge_tools'
    | 'semi'
    | 'semi_tools'
    | 'strict'
    | 'strict_tools'
    | 'single';

export const PROMPT_PLACEHOLDER = "Let's get started.";

export const GEMINI_SAFETY_SETTINGS = [
    { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'OFF' },
    { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'OFF' },
    { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'OFF' },
    { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'OFF' },
    { category: 'HARM_CATEGORY_CIVIC_INTEGRITY', threshold: 'OFF' },
] as const;

export const VERTEX_SAFETY_SETTINGS = [
    { category: 'HARM_CATEGORY_IMAGE_HATE', threshold: 'OFF' },
    { category: 'HARM_CATEGORY_IMAGE_DANGEROUS_CONTENT', threshold: 'OFF' },
    { category: 'HARM_CATEGORY_IMAGE_HARASSMENT', threshold: 'OFF' },
    { category: 'HARM_CATEGORY_IMAGE_SEXUALLY_EXPLICIT', threshold: 'OFF' },
    { category: 'HARM_CATEGORY_JAILBREAK', threshold: 'OFF' },
] as const;

const VALID_MODES = new Set<PromptPostProcessingMode>([
    '', 'merge', 'merge_tools', 'semi', 'semi_tools', 'strict', 'strict_tools', 'single',
]);

export function normalizePromptPostProcessingMode(value: unknown): PromptPostProcessingMode {
    if (typeof value !== 'string') return '';
    const trimmed = value.trim().toLowerCase();
    if (!trimmed || trimmed === 'none') return '';
    if (trimmed === 'claude') return 'merge';
    return VALID_MODES.has(trimmed as PromptPostProcessingMode) ? trimmed as PromptPostProcessingMode : '';
}

export function resolvePromptPostProcessing(preset: NormalizedPreset, live?: Record<string, unknown>): PromptPostProcessingMode {
    const setting = live?.['sampler.prompt_post_processing'];
    if (typeof setting === 'string' && setting && setting !== 'auto') {
        return normalizePromptPostProcessingMode(setting);
    }
    return normalizePromptPostProcessingMode(preset.rawData?.custom_prompt_post_processing);
}

export function resolveUseSystemPrompt(preset: NormalizedPreset, live?: Record<string, unknown>): boolean {
    const setting = live?.['sampler.use_sysprompt'];
    if (setting === 'on' || setting === true) return true;
    if (setting === 'off' || setting === false) return false;
    return preset.rawData?.use_sysprompt !== false;
}

interface MergeOptions {
    strict?: boolean;
    placeholders?: boolean;
    single?: boolean;
    tools?: boolean;
}

function prefixContent(content: string, prefix: string | undefined): string {
    if (!prefix) return content;
    return content.startsWith(`${prefix}: `) ? content : `${prefix}: ${content}`;
}

function placeholderMessage(): AssembledChatMessage {
    return {
        role: 'user',
        content: PROMPT_PLACEHOLDER,
        sourceId: 'post_process_placeholder',
        sourceLabel: '后处理占位',
        tokens: 0,
        estimatedTokens: 0,
    };
}

function mergePass(
    input: AssembledChatMessage[],
    names: { charName?: string; userName?: string },
    options: MergeOptions,
): AssembledChatMessage[] {
    const { strict = false, placeholders = false, single = false, tools = false } = options;
    const prepared: AssembledChatMessage[] = input.map(item => {
        const message: AssembledChatMessage = {
            ...item,
            content: item.content ?? '',
            ...(item.images?.length ? { images: [...item.images] } : {}),
        };
        if (message.role === 'system' && message.name === 'example_assistant') {
            message.content = prefixContent(message.content, names.charName);
        } else if (message.role === 'system' && message.name === 'example_user') {
            message.content = prefixContent(message.content, names.userName);
        } else if (message.name && message.role !== 'system') {
            message.content = prefixContent(message.content, message.name);
        }
        if (single) {
            if (message.role === 'assistant') message.content = prefixContent(message.content, names.charName);
            else if (message.role === 'user') message.content = prefixContent(message.content, names.userName);
            message.role = 'user';
        }
        delete message.name;
        return message;
    });

    const merged: AssembledChatMessage[] = [];
    for (const message of prepared) {
        const previous = merged.at(-1);
        const canMerge = !!previous && previous.role === message.role && (Boolean(message.content) || Boolean(message.images?.length));
        if (canMerge) {
            if (message.content) {
                previous.content = previous.content ? `${previous.content}\n\n${message.content}` : message.content;
            }
            if (message.images?.length) {
                previous.images = [...(previous.images ?? []), ...message.images];
            }
            previous.tokens += message.tokens;
            previous.estimatedTokens = (previous.estimatedTokens ?? 0) + (message.estimatedTokens ?? message.tokens);
        } else {
            merged.push(message);
        }
    }

    if (merged.length === 0) {
        merged.push(placeholderMessage());
    }

    if (strict) {
        for (let i = 1; i < merged.length; i++) {
            if (merged[i].role === 'system') {
                merged[i].role = 'user';
            }
        }
        if (placeholders) {
            if (merged[0].role === 'system' && (merged.length === 1 || merged[1].role !== 'user')) {
                merged.splice(1, 0, placeholderMessage());
            } else if (merged[0].role !== 'system' && merged[0].role !== 'user') {
                merged.unshift(placeholderMessage());
            }
        }
        return mergePass(merged, names, { strict: false, placeholders, single: false, tools });
    }

    return merged;
}

/**
 * SillyTavern-compatible Prompt Post-Processing (`src/prompt-converters.js`).
 */
export function postProcessPromptMessages(
    messages: AssembledChatMessage[],
    mode: PromptPostProcessingMode,
    names: { charName?: string; userName?: string } = {},
): AssembledChatMessage[] {
    switch (mode) {
        case 'merge':
            return mergePass(messages, names, { strict: false, placeholders: false, single: false, tools: false });
        case 'merge_tools':
            return mergePass(messages, names, { strict: false, placeholders: false, single: false, tools: true });
        case 'semi':
            return mergePass(messages, names, { strict: true, placeholders: false, single: false, tools: false });
        case 'semi_tools':
            return mergePass(messages, names, { strict: true, placeholders: false, single: false, tools: true });
        case 'strict':
            return mergePass(messages, names, { strict: true, placeholders: true, single: false, tools: false });
        case 'strict_tools':
            return mergePass(messages, names, { strict: true, placeholders: true, single: false, tools: true });
        case 'single':
            return mergePass(messages, names, { strict: true, placeholders: false, single: true, tools: false });
        default:
            return messages;
    }
}

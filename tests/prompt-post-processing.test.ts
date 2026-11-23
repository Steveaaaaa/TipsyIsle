import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    GEMINI_SAFETY_SETTINGS,
    PROMPT_PLACEHOLDER,
    normalizePromptPostProcessingMode,
    postProcessPromptMessages,
    resolvePromptPostProcessing,
    resolveUseSystemPrompt,
} from '../src/core/prompt-post-process';
import { requestGeminiCompletion } from '../src/core/gemini-completion';
import { assemblePromptPipeline } from '../src/pipeline/prompt-assembler';
import {
    GEMINI_SAFETY_SETTINGS as SERVER_GEMINI_SAFETY,
    VERTEX_SAFETY_SETTINGS as SERVER_VERTEX_SAFETY,
    defaultGoogleSafetySettings,
    prepareNativeMessages,
} from '../server/llm-providers.mjs';
import type { AssembledChatMessage, NormalizedCharacterCard, NormalizedPreset } from '../src/types';

function msg(role: AssembledChatMessage['role'], content: string, extra: Partial<AssembledChatMessage> = {}): AssembledChatMessage {
    return { role, content, sourceId: extra.sourceId ?? `m_${role}`, sourceLabel: role, tokens: 1, estimatedTokens: 1, ...extra };
}

function minimalCard(): NormalizedCharacterCard {
    return {
        id: 'char_test',
        name: 'Alice',
        description: 'A brave knight.',
        personality: '',
        scenario: '',
        firstMes: 'Greetings.',
        mesExample: '',
        creatorNotes: '',
        systemPrompt: '',
        postHistoryInstructions: '',
        alternateGreetings: [],
        tags: [],
        creator: '',
        characterVersion: '1.0',
        extensions: {},
    };
}

function minimalPreset(rawData: Record<string, unknown> = {}): NormalizedPreset {
    return {
        id: 'preset_test',
        name: 'Test Preset',
        rawData,
        promptSlots: [
            { identifier: 'main', name: 'Main', role: 'system', content: 'Main system rule.', enabled: true },
            { identifier: 'chatHistory', name: 'Chat History', role: 'system', content: '', enabled: true, marker: true },
            {
                identifier: 'jb_depth0',
                name: 'JB Depth 0',
                role: 'system',
                content: 'Post-history jailbreak directive.',
                enabled: true,
                injectionPosition: 'in_chat',
                injectionDepth: 0,
                depthOrder: 100,
            },
        ],
    };
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('prompt post-processing (SillyTavern parity)', () => {
    it('normalizes legacy and explicit modes and resolves auto from preset', () => {
        expect(normalizePromptPostProcessingMode('claude')).toBe('merge');
        expect(normalizePromptPostProcessingMode('none')).toBe('');
        expect(normalizePromptPostProcessingMode('SEMI')).toBe('semi');

        const preset = minimalPreset({ custom_prompt_post_processing: 'semi', use_sysprompt: false });
        expect(resolvePromptPostProcessing(preset, { 'sampler.prompt_post_processing': 'auto' })).toBe('semi');
        expect(resolvePromptPostProcessing(preset, { 'sampler.prompt_post_processing': 'strict' })).toBe('strict');
        expect(resolvePromptPostProcessing(preset, { 'sampler.prompt_post_processing': 'none' })).toBe('');

        expect(resolveUseSystemPrompt(preset, { 'sampler.use_sysprompt': 'auto' })).toBe(false);
        expect(resolveUseSystemPrompt(preset, { 'sampler.use_sysprompt': 'on' })).toBe(true);
        expect(resolveUseSystemPrompt(minimalPreset(), { 'sampler.use_sysprompt': 'auto' })).toBe(true);
        expect(resolveUseSystemPrompt(minimalPreset(), { 'sampler.use_sysprompt': 'off' })).toBe(false);
    });

    it('semi mode preserves leading system block and converts post-history system to user in-place', () => {
        const input = [
            msg('system', 'Sys 1'),
            msg('system', 'Sys 2'),
            msg('user', 'Hello', { images: ['data:image/png;base64,AAA'] }),
            msg('assistant', 'Hi there'),
            msg('user', 'Next action'),
            msg('system', 'Depth 0 JB'),
        ];
        const out = postProcessPromptMessages(input, 'semi', { charName: 'Alice', userName: 'Bob' });
        expect(out.map(m => [m.role, m.content])).toEqual([
            ['system', 'Sys 1\n\nSys 2'],
            ['user', 'Hello'],
            ['assistant', 'Hi there'],
            ['user', 'Next action\n\nDepth 0 JB'],
        ]);
        expect(out[1].images).toEqual(['data:image/png;base64,AAA']);
    });

    it('strict mode inserts placeholder user turn when first non-system message is assistant', () => {
        const input = [
            msg('system', 'Sys'),
            msg('assistant', 'Opening narration'),
            msg('system', 'Depth 0 JB'),
        ];
        const out = postProcessPromptMessages(input, 'strict');
        expect(out.map(m => [m.role, m.content])).toEqual([
            ['system', 'Sys'],
            ['user', PROMPT_PLACEHOLDER],
            ['assistant', 'Opening narration'],
            ['user', 'Depth 0 JB'],
        ]);
    });

    it('single mode squashes entire prompt into one user message with speaker prefixes', () => {
        const input = [
            msg('system', 'Rules'),
            msg('user', 'Hi'),
            msg('assistant', 'Hello'),
        ];
        const out = postProcessPromptMessages(input, 'single', { charName: 'Alice', userName: 'Bob' });
        expect(out).toHaveLength(1);
        expect(out[0].role).toBe('user');
        expect(out[0].content).toBe('Rules\n\nBob: Hi\n\nAlice: Hello');
    });

    it('applies preset custom_prompt_post_processing during prompt assembly but skips mvuExtraAnalysis', async () => {
        const baseInput = {
            character: minimalCard(),
            preset: minimalPreset({ custom_prompt_post_processing: 'semi' }),
            lorebooks: [],
            messages: [
                {
                    id: 'u1',
                    parentId: null,
                    floor: 0,
                    role: 'user' as const,
                    speakerName: 'Bob',
                    content: 'Draw your sword.',
                    swipes: ['Draw your sword.'],
                    activeSwipeIndex: 0,
                },
            ],
            userName: 'Bob',
        };

        const normal = await assemblePromptPipeline(baseInput);
        expect(normal.messages.map(m => [m.role, m.content])).toEqual([
            ['system', 'Main system rule.'],
            ['user', 'Draw your sword.\n\nPost-history jailbreak directive.'],
        ]);

        const mvu = await assemblePromptPipeline({ ...baseInput, mvuExtraAnalysis: true });
        expect(mvu.messages.map(m => m.role)).toEqual(['system', 'user', 'system']);
    });
});

describe('Gemini native direct adapter (src/core/gemini-completion.ts)', () => {
    it('sends default OFF safetySettings and keeps @depth 0 system in-place as user', async () => {
        let sentBody: Record<string, any> | undefined;
        vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
            sentBody = JSON.parse(String(init?.body ?? '{}'));
            return Response.json({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] });
        }));

        await requestGeminiCompletion({
            source: 'makersuite',
            baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
            apiKey: 'test-key',
            model: 'gemini-2.5-pro',
            messages: [
                msg('system', 'Top system'),
                msg('user', 'Hello'),
                msg('assistant', 'Reply'),
                msg('system', 'Depth 0 jailbreak'),
            ],
            parameters: { temperature: 1, max_tokens: 1024 },
            stream: false,
            onToken: () => {},
        });

        expect(sentBody?.safetySettings).toEqual(GEMINI_SAFETY_SETTINGS);
        expect(sentBody?.systemInstruction).toEqual({ parts: [{ text: 'Top system' }] });
        expect(sentBody?.contents).toEqual([
            { role: 'user', parts: [{ text: 'Hello' }] },
            { role: 'model', parts: [{ text: 'Reply' }] },
            { role: 'user', parts: [{ text: 'Depth 0 jailbreak' }] },
        ]);
    });

    it('respects useSystemPrompt: false, includeBody.safetySettings override, and no-prefill Gemini models', async () => {
        let sentBody: Record<string, any> | undefined;
        vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
            sentBody = JSON.parse(String(init?.body ?? '{}'));
            return Response.json({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] });
        }));

        const customSafety = [{ category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' }];
        await requestGeminiCompletion({
            source: 'makersuite',
            baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
            apiKey: 'test-key',
            model: 'gemini-3.6-flash',
            useSystemPrompt: false,
            includeBody: { safetySettings: customSafety },
            messages: [
                msg('system', 'Top system'),
                msg('user', 'Hello'),
                msg('assistant', 'Prefill'),
            ],
            parameters: {},
            stream: false,
            onToken: () => {},
        });

        expect(sentBody?.systemInstruction).toBeUndefined();
        expect(sentBody?.safetySettings).toEqual(customSafety);
        expect(sentBody?.contents).toEqual([
            { role: 'user', parts: [{ text: 'Top system' }, { text: 'Hello' }, { text: 'Prefill' }] },
        ]);
    });
});

describe('Gateway native provider adapter (server/llm-providers.mjs)', () => {
    it('builds default Gemini and Vertex safetySettings matching SillyTavern', () => {
        expect(defaultGoogleSafetySettings('google-generative-ai')).toEqual(SERVER_GEMINI_SAFETY);
        expect(defaultGoogleSafetySettings('google-vertex')).toEqual([...SERVER_GEMINI_SAFETY, ...SERVER_VERTEX_SAFETY]);
    });

    it('keeps @depth 0 system in-place as user for Claude and Gemini without hoisting to top system', () => {
        const raw = [
            { role: 'system', content: 'Leading 1' },
            { role: 'system', content: 'Leading 2' },
            { role: 'assistant', content: 'Greeting' },
            { role: 'system', content: 'Depth 0 JB' },
        ];

        const claude = prepareNativeMessages(raw, { api: 'anthropic-messages', id: 'claude-3-7-sonnet' }, true);
        expect(claude).toEqual([
            { role: 'system', content: 'Leading 1\n\nLeading 2' },
            { role: 'user', content: PROMPT_PLACEHOLDER },
            { role: 'assistant', content: 'Greeting' },
            { role: 'user', content: 'Depth 0 JB' },
        ]);

        const claudeNoSys = prepareNativeMessages(raw, { api: 'anthropic-messages', id: 'claude-3-7-sonnet' }, false);
        expect(claudeNoSys).toEqual([
            { role: 'user', content: 'Leading 1\n\nLeading 2' },
            { role: 'assistant', content: 'Greeting' },
            { role: 'user', content: 'Depth 0 JB' },
        ]);

        const gemini = prepareNativeMessages(raw, { api: 'google-generative-ai', id: 'gemini-2.5-pro' }, true);
        expect(gemini).toEqual([
            { role: 'system', content: 'Leading 1\n\nLeading 2' },
            { role: 'assistant', content: 'Greeting' },
            { role: 'user', content: 'Depth 0 JB' },
        ]);
    });

    it('leaves OpenAI-compatible protocol messages untouched', () => {
        const raw = [
            { role: 'system', content: 'Sys' },
            { role: 'user', content: 'Hi' },
            { role: 'system', content: 'Mid system' },
        ];
        expect(prepareNativeMessages(raw, { api: 'openai-completions', id: 'gpt-4o' }, true)).toBe(raw);
    });
});

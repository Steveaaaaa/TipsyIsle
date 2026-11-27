import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { build } from 'esbuild';
import { prepareNativeMessages } from '../server/llm-providers.mjs';

const bundle = await build({
    stdin: {
        contents: `
            export * from './src/compatibility/spreset-config';
            export * from './src/compatibility/spreset-runtime';
            export * from './src/core/spreset-output-stream';
            export * from './src/pipeline/normalizer';
            export * from './src/core/platform-bridge';
            export * from './src/core/gemini-completion';
            export * from './src/core/claude-completion';
            export * from './examples/plugins/lumina-director/tension-gate';
        `,
        resolveDir: process.cwd(),
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false,
    banner: {
        js: `import { createRequire as __cr } from 'node:module'; const require = __cr(${JSON.stringify(process.cwd() + '/package.json')});`,
    },
});

const {
    readSPresetConfig,
    hasActiveSPreset,
    extractSPresetRegexScripts,
    isRemoteSPresetInjectorScript,
    runSPresetFinalRequestInRealm,
    createSPresetOutputProcessor,
    hasActiveSPresetOutput,
    normalizePreset,
    streamLlmCompletion,
    requestGeminiCompletion,
    requestClaudeCompletion,
    narrative,
    shots,
} = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);

const realMeowssiahPath =
    'C:/Users/东南风也好喝/.gemini/antigravity/brain/3e4e0338-49f2-4ddf-b32f-c4627f01b3e0/.user_uploaded/media_1795801153356_59c936c3.json';

function withMockFetch(handler, fn) {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = handler;
    return Promise.resolve()
        .then(fn)
        .finally(() => {
            globalThis.fetch = originalFetch;
        });
}

test('SPreset config parsing strips LogUpload, falls back to SPresetSettings prompt, and blocks remote inject.js scripts', () => {
    const legacyPreset = {
        name: 'legacy-spreset',
        prompts: [
            {
                identifier: 'SPresetSettings',
                enabled: false,
                content: JSON.stringify({
                    LogUpload: { enabled: true, url: 'https://evil.example/upload' },
                    RegexBinding: { enabled: true, regexes: [{ id: 'r1', scriptName: 'Rule 1', findRegex: '/a/g', replaceString: 'b', placement: [2] }] },
                    OutputPreprocessing: { enabled: true, consumeToolCalls: true, script: '({ buffer }) => ({ output: buffer, hold: "", state: {} })' },
                }),
            },
        ],
        extensions: {
            regex_scripts: [
                { id: 'r1', scriptName: 'Rule 1', findRegex: '/a/g', replaceString: 'b', placement: [2] },
            ],
        },
    };

    const config = readSPresetConfig(legacyPreset);
    assert.ok(config);
    assert.equal('logUpload' in config, false);
    assert.equal('LogUpload' in config, false);
    assert.equal(hasActiveSPreset(legacyPreset), true);
    assert.equal(extractSPresetRegexScripts(legacyPreset).length, 1);

    const normalized = normalizePreset(legacyPreset, 'legacy-spreset');
    assert.equal(normalized.regexScripts.length, 1, 'duplicate regex in RegexBinding and regex_scripts must be deduped');

    assert.equal(
        isRemoteSPresetInjectorScript({
            name: 'SPreset',
            content: "const s = document.createElement('script'); s.src = 'https://jnai2d9kgnbs6xzx5c.com/regex_bind/inject.js';",
        }),
        true,
    );
    assert.equal(
        isRemoteSPresetInjectorScript({
            name: '菜单',
            content: "const s = doc.createElement('script'); s.textContent = 'window.CatGodOracle = {};';",
        }),
        false,
    );
});

test('runSPresetFinalRequestInRealm executes ChatSquash, ToolBindings, and FinalRequestProcessing', async () => {
    const rawPreset = {
        name: 'spreset-test',
        prompt_order: [
            {
                character_id: 100001,
                order: [{ identifier: 'tool_reply', enabled: true }],
            },
        ],
        extensions: {
            SPreset: {
                ChatSquash: { enabled: true, separate: '\n---\n', role: 'user', preserveSystem: true },
                ToolBindings: {
                    tool_reply: {
                        enabled: true,
                        code: `return {
                            name: "cat_reply",
                            description: "Structured reply tool",
                            parameters: {
                                type: "object",
                                propertyOrdering: ["think_nya", "game_content"],
                                properties: {
                                    think_nya: { type: "string" },
                                    game_content: { type: "string" }
                                },
                                required: ["think_nya", "game_content"]
                            }
                        };`,
                    },
                },
                FinalRequestProcessing: {
                    enabled: true,
                    script: `async ({ request }) => {
                        delete request.reasoning_effort;
                        request.tool_choice = { type: "function", function: { name: "cat_reply" } };
                        request.toolConfig = { functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["cat_reply"] } };
                        request.messages.push({
                            role: "assistant",
                            content: "<think>ready</think>",
                            thoughtSignature: "skip_thought_signature_validator"
                        });
                        return request;
                    }`,
                },
            },
        },
    };

    const result = await runSPresetFinalRequestInRealm({
        rawPreset,
        request: {
            model: 'gemini-3-pro',
            reasoning_effort: 'high',
            messages: [
                { role: 'system', content: 'Sys' },
                { role: 'user', content: 'Hello' },
                { role: 'assistant', content: 'Hi' },
            ],
        },
    });

    assert.equal(result.applied, true);
    assert.equal(result.deletedReasoningEffort, true);
    assert.equal('reasoning_effort' in result.request, false);
    assert.equal(result.request.tools.length, 1);
    assert.equal(result.request.tools[0].function.name, 'cat_reply');
    assert.deepEqual(result.request.messages, [
        { role: 'system', content: 'Sys' },
        { role: 'user', content: 'Hello\n---\nHi' },
        { role: 'assistant', content: '<think>ready</think>', thoughtSignature: 'skip_thought_signature_validator' },
    ]);
});

test('createSPresetOutputProcessor handles streaming partial tool JSON, OutputPreprocessing, and MVU external passthrough', () => {
    const config = {
        enabled: true,
        consumeToolCalls: true,
        script: `({ buffer, final, state = {} }) => {
            let out = String(buffer ?? '');
            if (out.includes('<think_nya') || final) {
                out = out.replace(/<think>[\\s\\S]*?(?:<\\/think>|(?=<think_nya>))\\s*/gi, '');
            }
            return { output: out, hold: '', state: { ...state, accepted: true } };
        }`,
        toolCallFormatter: {
            enabled: true,
            script: `({ calls, defaultText }) => {
                if (!calls?.length) return defaultText ?? '';
                if (calls.every(c => /^mvu_/i.test(c.name))) throw new Error('External tool call passthrough');
                const call = calls[0];
                let obj = {};
                try { obj = JSON.parse(call.arguments); } catch {
                    const m1 = /"think_nya"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)/.exec(call.arguments);
                    const m2 = /"game_content"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)/.exec(call.arguments);
                    if (m1) obj.think_nya = m1[1];
                    if (m2) obj.game_content = m2[1];
                }
                return [
                    obj.think_nya ? '<think_nya>\\n' + obj.think_nya + '\\n</think_nya>' : '',
                    obj.game_content ? '<game>\\n' + obj.game_content + '\\n</game>' : '',
                ].filter(Boolean).join('\\n');
            }`,
        },
    };

    assert.equal(hasActiveSPresetOutput(config), true);
    const proc = createSPresetOutputProcessor(config);
    // Model emits stray <think> text before calling tool
    assert.equal(proc.onTextDelta('<think>stray</think>'), '<think>stray</think>');
    // Incremental tool call chunk strips stray <think> and renders partial JSON args
    const stream1 = proc.onToolCallsDelta([
        { id: 'c1', type: 'function', function: { name: 'soliumbra_reply', arguments: '{"think_nya":"planning","game_content":"First line' } },
    ]);
    assert.ok(stream1?.includes('<think_nya>\nplanning\n</think_nya>'));
    assert.ok(stream1?.includes('<game>\nFirst line\n</game>'));
    assert.equal(stream1?.includes('stray'), false);

    const finalized = proc.finalize('<think>stray</think>', [
        { id: 'c1', type: 'function', function: { name: 'soliumbra_reply', arguments: '{"think_nya":"planning","game_content":"Full story"}' } },
    ]);
    assert.equal(finalized.consumed, true);
    assert.equal(finalized.toolCalls, undefined);
    assert.equal(finalized.content, '<think_nya>\nplanning\n</think_nya>\n<game>\nFull story\n</game>');

    // External tool call (e.g. MVU) triggers throw -> must NOT consume toolCalls
    const passthroughProc = createSPresetOutputProcessor(config);
    const externalCalls = [{ id: 'mvu_1', type: 'function', function: { name: 'mvu_VariableUpdate_test', arguments: '{}' } }];
    assert.equal(passthroughProc.onToolCallsDelta(externalCalls), null);
    const passthroughFinal = passthroughProc.finalize('', externalCalls);
    assert.equal(passthroughFinal.consumed, false);
    assert.deepEqual(passthroughFinal.toolCalls, externalCalls);
});

test('OpenAI, Gemini, and gateway protocols preserve tool names, thoughtSignature, propertyOrdering, toolConfig, and streaming tool deltas', async () => {
    let openaiBody;
    const sse = [
        'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"soliumbra_reply","arguments":"{\\"think_nya\\":\\"hi\\""}}]}}]}\n\n',
        'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":",\\"game_content\\":\\"body\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n',
        'data: [DONE]\n\n',
    ].join('');

    const deltaSnapshots = [];
    const openaiRes = await withMockFetch(async (_url, init) => {
        openaiBody = JSON.parse(String(init?.body ?? '{}'));
        return new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    }, () => streamLlmCompletion({
        source: 'openai',
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'sk-test',
        model: 'gpt-4o',
        messages: [
            { role: 'system', content: 'Sys' },
            { role: 'assistant', content: '<think>t</think>', thoughtSignature: 'skip_thought_signature_validator' },
            { role: 'assistant', thoughtSignature: 'sig1', tool_calls: [{ id: 'c0', type: 'function', signature: 'sig1', extra_content: { google: { thoughtSignature: 'sig1' } }, function: { name: 'context', arguments: '{}' } }] },
            { role: 'tool', tool_call_id: 'c0', name: 'context', content: '{"ok":true}' },
        ],
        parameters: { tools: [{ type: 'function', function: { name: 'soliumbra_reply', parameters: { type: 'object', properties: {} } } }], tool_choice: 'required' },
        requireReplyText: false,
        onToken: () => {},
        onToolCallsDelta: calls => deltaSnapshots.push(calls.map(c => c.function.arguments)),
    }));

    assert.equal(openaiBody.messages[3].name, 'context', 'direct OpenAI endpoint must keep tool.name');
    assert.equal(openaiBody.messages[2].tool_calls[0].signature, 'sig1');
    assert.equal(openaiRes.tool_calls?.[0]?.function.arguments, '{"think_nya":"hi","game_content":"body"}');
    assert.equal(deltaSnapshots.length, 2);

    let geminiBody;
    await withMockFetch(async (_url, init) => {
        geminiBody = JSON.parse(String(init?.body ?? '{}'));
        return Response.json({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] });
    }, () => requestGeminiCompletion({
        source: 'makersuite',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        apiKey: 'gk-test',
        model: 'gemini-3.6-flash',
        messages: [
            { role: 'system', content: 'Sys' },
            { role: 'assistant', content: '<think>inner think</think>', thoughtSignature: 'skip_thought_signature_validator' },
            { role: 'assistant', thoughtSignature: 'sig_call', tool_calls: [{ id: 'tc1', type: 'function', signature: 'sig_call', function: { name: 'context', arguments: '{"q":"1"}' } }] },
            { role: 'tool', tool_call_id: 'tc1', name: 'context', content: '{"data":1}' },
        ],
        parameters: {
            tools: [{
                type: 'function',
                function: {
                    name: 'soliumbra_reply',
                    description: 'reply',
                    parameters: { type: 'object', propertyOrdering: ['think_nya', 'game_content'], properties: { think_nya: { type: 'string' }, game_content: { type: 'string' } } },
                },
            }],
            toolConfig: { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['soliumbra_reply'] } },
        },
        stream: false,
        onToken: () => {},
    }));

    assert.equal(geminiBody.contents[0].role, 'model');
    assert.deepEqual(geminiBody.contents[0].parts[0], { text: 'inner think', thought: true, thoughtSignature: 'skip_thought_signature_validator' });
    assert.deepEqual(geminiBody.contents[0].parts[1], { functionCall: { name: 'context', args: { q: '1' }, id: 'tc1' }, thoughtSignature: 'sig_call' });
    assert.ok(geminiBody.tools[0].functionDeclarations[0].parameters?.propertyOrdering);
    assert.deepEqual(geminiBody.toolConfig, { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['soliumbra_reply'] } });

    let claudeBody;
    await withMockFetch(async (_url, init) => {
        claudeBody = JSON.parse(String(init?.body ?? '{}'));
        return Response.json({ content: [{ type: 'text', text: 'ok' }] });
    }, () => requestClaudeCompletion({
        source: 'claude',
        baseUrl: 'https://api.anthropic.com',
        apiKey: 'ck-test',
        model: 'claude-3-7-sonnet',
        messages: [{ role: 'user', content: 'hi' }],
        parameters: {
            tools: [{ type: 'function', function: { name: 'soliumbra_reply', description: 'reply', parameters: { type: 'object', properties: {} } } }],
            tool_choice: { type: 'function', function: { name: 'soliumbra_reply' } },
        },
        stream: false,
        onToken: () => {},
    }));
    assert.deepEqual(claudeBody.tool_choice, { type: 'tool', name: 'soliumbra_reply' });

    const gatewayMsgs = prepareNativeMessages(
        [
            { role: 'user', content: 'hi' },
            { role: 'assistant', content: '<think>pre</think>', thoughtSignature: 'sig_gw' },
        ],
        { api: 'google-generative-ai', id: 'gemini-3.6-flash' },
        true,
    );
    assert.equal(gatewayMsgs.at(-1).role, 'assistant', 'noPrefillModel must not flatten thoughtSignature assistant message to user');
});

test('Lumina tension-gate strips CatGod meta tags and extracts prose from <game>', () => {
    const sample = `<think_nya>secret planning</think_nya><!--</think>-->
<game>
雨滴顺着神社屋檐滑落，少女回过头望向走廊尽头。
</game>
<options>A. 上前\nB. 观望</options>
<report_nya>state ok</report_nya>`;
    const clean = narrative(sample);
    assert.equal(clean.includes('secret planning'), false);
    assert.equal(clean.includes('state ok'), false);
    assert.equal(clean.includes('观望'), false);
    assert.ok(clean.includes('雨滴顺着神社屋檐滑落'));
    const extracted = shots(sample);
    assert.ok(extracted.length >= 1);
    assert.ok(extracted[0].part.includes('雨滴顺着神社屋檐滑落'));
});

if (fs.existsSync(realMeowssiahPath)) {
    test('Real Meowssiah-2.1.7.json (小猫之神 3.7 Full) parses, dedups regexes, blocks inject.js, and runs real OutputPreprocessing', () => {
        const raw = JSON.parse(fs.readFileSync(realMeowssiahPath, 'utf8'));
        const config = readSPresetConfig(raw);
        assert.ok(config?.finalRequestProcessing?.enabled);
        assert.ok(config?.outputPreprocessing?.enabled);
        assert.ok(config?.outputPreprocessing?.consumeToolCalls);
        assert.equal(hasActiveSPreset(raw), true);

        const normalized = normalizePreset(raw, raw.name);
        const dupCount = raw.extensions.regex_scripts.length;
        assert.equal(normalized.regexScripts.length, dupCount, 'real preset RegexBinding duplicates must not double regex count');

        const scripts = raw.extensions.tavern_helper.scripts;
        assert.equal(scripts.filter(s => !isRemoteSPresetInjectorScript(s)).map(s => s.name).includes('菜单'), true);
        assert.equal(scripts.filter(s => isRemoteSPresetInjectorScript(s)).map(s => s.name).includes('SPreset'), true);

        const proc = createSPresetOutputProcessor(config.outputPreprocessing);
        proc.onTextDelta('<think>bad</think>');
        const partial = proc.onToolCallsDelta([
            { id: 'c1', type: 'function', function: { name: 'soliumbra_reply', arguments: '{"think_nya":"喵~","game_content":"她轻轻推开木门' } },
        ]);
        assert.ok(partial?.includes('<think_nya>'));
        assert.ok(partial?.includes('<game>\n她轻轻推开木门\n</game>'));
        assert.equal(partial?.includes('bad'), false);
    });

    test('Real Meowssiah-2.1.7.json FinalRequestProcessing.script runs cleanly against compat SillyTavern context', async () => {
        const raw = JSON.parse(fs.readFileSync(realMeowssiahPath, 'utf8'));
        const prevWindow = globalThis.window;
        const ls = new Map();
        const eventsFired = [];
        const listeners = new Map();
        const chatMetadata = { variables: {} };
        const chat = [
            { name: 'User', is_user: true, is_system: false, mes: '你好小猫之神', extra: {} },
        ];
        const fakeWin = {
            parent: null,
            top: null,
            localStorage: {
                getItem: k => ls.get(String(k)) ?? null,
                setItem: (k, v) => ls.set(String(k), String(v)),
                removeItem: k => ls.delete(String(k)),
            },
            CustomEvent: class extends Event {
                constructor(type, init = {}) {
                    super(type);
                    this.detail = init.detail;
                }
            },
            dispatchEvent(ev) {
                eventsFired.push(ev);
                return true;
            },
            SillyTavern: {
                getContext: () => ({
                    chat,
                    chatMetadata,
                    chatId: 'chat_test_1',
                    getCurrentChatId: () => 'chat_test_1',
                    characterId: '0',
                    mainApi: 'openai',
                    chatCompletionSettings: {
                        ...raw,
                        preset_settings_openai: raw.name,
                        openai_max_context: 65536,
                    },
                    powerUserSettings: { persona_description: '测试旅人' },
                    extensionPrompts: {},
                    extensionSettings: {},
                    getTokenCountAsync: async text => String(text ?? '').length,
                    getTokenizerModel: () => 'gemini-3-pro',
                    substituteParams: text => String(text ?? ''),
                    saveMetadataDebounced: () => {},
                    saveSettingsDebounced: () => {},
                    eventTypes: {
                        GENERATION_STARTED: 'generation_started',
                        WORLD_INFO_ACTIVATED: 'world_info_activated',
                    },
                    eventSource: {
                        on: (ev, fn) => {
                            if (!listeners.has(ev)) listeners.set(ev, []);
                            listeners.get(ev).push(fn);
                        },
                    },
                }),
            },
        };
        fakeWin.parent = fakeWin;
        fakeWin.top = fakeWin;
        globalThis.window = fakeWin;

        try {
            const result = await runSPresetFinalRequestInRealm({
                rawPreset: raw,
                request: {
                    model: 'gemini-3-pro',
                    reasoning_effort: 'high',
                    messages: [
                        { role: 'system', content: 'System Setup' },
                        { role: 'user', content: '你好小猫之神\n<run_tool_replacement>' },
                    ],
                },
            });

            assert.equal(result.applied, true);
            assert.equal(result.deletedReasoningEffort, true);
            assert.equal('reasoning_effort' in result.request, false);
            assert.ok(Array.isArray(result.request.tools));
            assert.equal(result.request.tools[0]?.function?.name, 'soliumbra_reply');
            assert.ok(Array.isArray(result.request.tools[0]?.function?.parameters?.propertyOrdering));
            assert.ok(result.request.messages.some(m => m.role === 'tool' && m.name === 'context'));
            assert.ok(result.request.messages.some(m => m.role === 'assistant' && m.thoughtSignature));
            assert.ok(eventsFired.some(ev => ev.type === 'catgod-oracle:final-request'));
            assert.ok(chatMetadata.catgod_oracle && typeof chatMetadata.catgod_oracle === 'object');
        } finally {
            if (prevWindow === undefined) delete globalThis.window;
            else globalThis.window = prevWindow;
        }
    });
}

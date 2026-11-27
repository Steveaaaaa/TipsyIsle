import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';

const bundle = await build({
    stdin: {
        contents: `
            export * from './src/core/openai-responses-completion';
            export * from './src/core/gemini-completion';
            export * from './src/core/platform-bridge';
            export * from './src/core/model-profiles';
            export * from './src/shell/workspace-page';
            export * from './src/pipeline/streaming-message';
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
    requestOpenAiResponsesCompletion,
    openAiResponsesReplyAdapter,
    requestGeminiCompletion,
    geminiReplyAdapter,
    streamLlmCompletion,
    profileFromSettings,
    serializeConnectionProfiles,
    parseConnectionProfiles,
    findMatchingConnectionProfile,
    syncActiveProfileInSettingsPatch,
    readWorkspacePage,
    rememberWorkspacePage,
    createStreamPlan,
    StreamProjector,
} = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`);

test('requestOpenAiResponsesCompletion normalizes URLs, leading instructions, tools, and headers', async () => {
    const calls = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
        calls.push({ url: String(url), init });
        return new Response(JSON.stringify({ status: 'completed', output: [] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        });
    };
    try {
        await requestOpenAiResponsesCompletion({
            source: 'openai-responses',
            baseUrl: 'https://api.openai.com/v1',
            apiKey: 'sk-test-1',
            model: 'gpt-5',
            messages: [
                { role: 'system', content: 'Sys 1' },
                { role: 'user', content: 'Hi' },
                { role: 'system', content: 'Depth note' },
            ],
            parameters: { max_tokens: 1024, temperature: 0.7, reasoning_effort: 'medium' },
            onToken() {},
        });
        await requestOpenAiResponsesCompletion({
            source: 'openai-responses',
            baseUrl: 'https://relay.example.com',
            apiKey: 'sk-test-2',
            model: 'gpt-5',
            messages: [{ role: 'user', content: 'Ping' }],
            parameters: {},
            onToken() {},
        });
        await requestOpenAiResponsesCompletion({
            source: 'openai-responses',
            baseUrl: 'https://relay.example.com/openai/v1',
            apiKey: 'sk-test-3',
            model: 'gpt-5',
            messages: [{ role: 'user', content: 'Ping' }],
            parameters: {},
            onToken() {},
        });
    } finally {
        globalThis.fetch = originalFetch;
    }

    assert.equal(calls[0].url, 'https://api.openai.com/v1/responses');
    assert.equal(calls[1].url, 'https://relay.example.com/v1/responses');
    assert.equal(calls[2].url, 'https://relay.example.com/openai/v1/responses');

    const body0 = JSON.parse(String(calls[0].init.body));
    assert.equal(body0.instructions, 'Sys 1');
    assert.deepEqual(body0.input, [
        { role: 'user', content: 'Hi' },
        { role: 'system', content: 'Depth note' },
    ]);
    assert.equal(body0.max_output_tokens, 1024);
    assert.deepEqual(body0.reasoning, { effort: 'medium', summary: 'auto' });
});

test('openAiResponsesReplyAdapter converts streaming events and non-streaming outputs', () => {
    const streamAdapt = openAiResponsesReplyAdapter();
    assert.deepEqual(streamAdapt({ type: 'response.created' }, true), { choices: [] });
    assert.equal(
        streamAdapt({ type: 'response.reasoning_summary_text.delta', delta: '思考中' }, true).choices[0].delta.reasoning_content,
        '思考中',
    );
    assert.equal(
        streamAdapt({ type: 'response.output_text.delta', delta: '你好' }, true).choices[0].delta.content,
        '你好',
    );
    const added = streamAdapt({
        type: 'response.output_item.added',
        output_index: 1,
        item: { id: 'fc_1', call_id: 'call_1', type: 'function_call', name: 'roll', arguments: '' },
    }, true);
    assert.equal(added.choices[0].delta.tool_calls[0].index, 0);
    assert.equal(added.choices[0].delta.tool_calls[0].id, 'call_1');
    const argDelta = streamAdapt({
        type: 'response.function_call_arguments.delta',
        item_id: 'fc_1',
        output_index: 1,
        delta: '{"d":6}',
    }, true);
    assert.equal(argDelta.choices[0].delta.tool_calls[0].index, 0);
    assert.equal(argDelta.choices[0].delta.tool_calls[0].function.arguments, '{"d":6}');
    assert.equal(streamAdapt({ type: 'response.completed' }, true).choices[0].finish_reason, 'stop');

    const nonStreamAdapt = openAiResponsesReplyAdapter();
    const full = nonStreamAdapt({
        status: 'completed',
        output: [
            { type: 'reasoning', summary: [{ type: 'summary_text', text: 'Plan' }], content: [] },
            { type: 'message', content: [{ type: 'output_text', text: 'Answer' }] },
            { type: 'function_call', call_id: 'c1', name: 'search', arguments: '{"q":"test"}' },
        ],
    }, false);
    assert.equal(full.choices[0].message.reasoning_content, 'Plan');
    assert.equal(full.choices[0].message.content, 'Answer');
    assert.deepEqual(full.choices[0].message.tool_calls, [
        { id: 'c1', type: 'function', function: { name: 'search', arguments: '{"q":"test"}' } },
    ]);
});

test('model-profiles matches existing channels and syncs active channel on save', () => {
    const ch1 = profileFromSettings('主力中转', {
        'api.chat_completion_source': 'openai-responses',
        'api.custom_url': 'https://relay.example.com/v1',
        'api.key': 'sk-111',
        'api.model': 'gpt-5',
        'sampler.reasoning_effort': 'high',
        'sampler.prompt_post_processing': 'semi',
        'sampler.use_sysprompt': 'on',
    }, 'conn_1');
    const profiles = [ch1];

    const matched = findMatchingConnectionProfile(profiles, {
        'api.chat_completion_source': 'openai-responses',
        'api.custom_url': ' https://relay.example.com/v1 ',
        'api.key': 'sk-111',
        'api.model': 'gpt-5',
    });
    assert.equal(matched?.id, 'conn_1');

    const syncedPatch = syncActiveProfileInSettingsPatch(
        {
            'api.active_profile': 'conn_1',
            'api.connection_profiles': serializeConnectionProfiles(profiles),
            'api.chat_completion_source': 'openai-responses',
            'api.custom_url': 'https://relay.example.com/v1',
            'api.key': 'sk-111',
            'api.model': 'gpt-5',
            'sampler.reasoning_effort': 'high',
            'sampler.prompt_post_processing': 'semi',
            'sampler.use_sysprompt': 'on',
        },
        {
            'api.model': 'gpt-5-mini',
            'sampler.reasoning_effort': 'low',
        },
    );
    const updatedProfiles = parseConnectionProfiles(syncedPatch['api.connection_profiles']);
    assert.equal(updatedProfiles[0].model, 'gpt-5-mini');
    assert.equal(updatedProfiles[0].reasoningEffort, 'low');

    const manualPatch = syncActiveProfileInSettingsPatch(
        {
            'api.active_profile': '',
            'api.connection_profiles': serializeConnectionProfiles(profiles),
        },
        { 'api.model': 'manual-only' },
    );
    assert.equal('api.connection_profiles' in manualPatch, false);
});

test('workspace-page persists and restores inline theme tab', () => {
    const store = new Map();
    const originalStorage = globalThis.localStorage;
    globalThis.localStorage = {
        getItem: key => store.get(key) ?? null,
        setItem: (key, value) => store.set(key, String(value)),
    };
    try {
        rememberWorkspacePage({ tab: 'theme', chatId: 'chat_1', appearance: 'packages', nightShelf: false });
        assert.deepEqual(readWorkspacePage('chat_1'), {
            tab: 'theme',
            chatId: 'chat_1',
            appearance: 'packages',
            nightShelf: false,
        });
    } finally {
        globalThis.localStorage = originalStorage;
    }
});

test('requestGeminiCompletion enables includeThoughts on auto reasoning for thinking-capable Gemini models and skips legacy models', async () => {
    const calls = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
        calls.push({ url: String(url), init });
        return new Response(JSON.stringify({ candidates: [] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        });
    };
    try {
        for (const [model, reasoning_effort] of [
            ['gemini-2.5-pro', undefined],
            ['gemini-3-flash-preview', 'auto'],
            ['gemini-pro-latest', undefined],
            ['gemini-2.0-flash', undefined],
            ['gemini-2.5-flash', 'off'],
        ]) {
            await requestGeminiCompletion({
                source: 'makersuite',
                baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
                apiKey: 'gm-key',
                model,
                messages: [{ role: 'user', content: 'Hi' }],
                parameters: reasoning_effort ? { reasoning_effort } : {},
                onToken() {},
            });
        }
    } finally {
        globalThis.fetch = originalFetch;
    }

    assert.equal(new Headers(calls[0].init.headers).get('accept'), 'text/event-stream');
    assert.deepEqual(JSON.parse(String(calls[0].init.body)).generationConfig.thinkingConfig, { includeThoughts: true });
    assert.deepEqual(JSON.parse(String(calls[1].init.body)).generationConfig.thinkingConfig, { includeThoughts: true });
    assert.deepEqual(JSON.parse(String(calls[2].init.body)).generationConfig.thinkingConfig, { includeThoughts: true });
    assert.equal(JSON.parse(String(calls[3].init.body)).generationConfig.thinkingConfig, undefined);
    assert.deepEqual(JSON.parse(String(calls[4].init.body)).generationConfig.thinkingConfig, { includeThoughts: false, thinkingBudget: 0 });
});

test('geminiReplyAdapter preserves reasoning, prose, thoughtSignature, and finishReason on terminal chunks', () => {
    const adapt = geminiReplyAdapter();
    const thoughtChunk = adapt({
        candidates: [{
            index: 0,
            content: { parts: [{ text: '先梳理人物动机', thought: true, thoughtSignature: 'sig-1' }] },
        }],
    }, true);
    assert.equal(thoughtChunk.choices[0].delta.reasoning_content, '先梳理人物动机');
    assert.equal(thoughtChunk.choices[0].delta.reasoning_signature, 'sig-1');

    const proseChunk = adapt({
        candidates: [{
            index: 0,
            content: { parts: [{ text: '她推开了木门。', thoughtSignature: 'sig-2' }] },
        }],
    }, true);
    assert.equal(proseChunk.choices[0].delta.content, '她推开了木门。');
    assert.equal(proseChunk.choices[0].delta.reasoning_signature, 'sig-2');

    const terminalChunk = adapt({
        candidates: [{ index: 0, finishReason: 'MAX_TOKENS', content: { parts: [] } }],
    }, true);
    assert.equal(terminalChunk.choices[0].finish_reason, 'length');
});

test('streamLlmCompletion incrementally streams JSON arrays, NDJSON, and mislabeled SSE streams', async () => {
    const encoder = new TextEncoder();
    const originalFetch = globalThis.fetch;

    const runChunkedStream = async (chunks, contentType) => {
        const received = [];
        globalThis.fetch = async (url) => {
            if (url === '/api/tipsy-isle/health') return new Response('{}', { status: 404 });
            return new Response(new ReadableStream({
                start(controller) {
                    for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
                    controller.close();
                },
            }), { headers: { 'Content-Type': contentType } });
        };
        const result = await streamLlmCompletion({
            source: 'openai',
            baseUrl: 'https://relay.invalid/v1',
            apiKey: '',
            model: 'gemini-3-pro',
            messages: [{ role: 'user', content: 'hi' }],
            parameters: {},
            onToken: (content, reasoning) => received.push([content, reasoning]),
        });
        return { result, received };
    };

    try {
        // 1. JSON array with braces inside strings and Content-Type: application/json
        const arrayRes = await runChunkedStream([
            '[\n{"choices":[{"delta":{"reasoning_content":"构思{第1段}"}}]}',
            ',\n{"choices":[{"delta":{"content":"她轻轻一笑。"}}]}\n]',
        ], 'application/json');
        assert.deepEqual(arrayRes.received, [
            ['', '构思{第1段}'],
            ['她轻轻一笑。', ''],
        ]);
        assert.equal(arrayRes.result.reasoning, '构思{第1段}');
        assert.equal(arrayRes.result.content, '她轻轻一笑。');

        // 2. NDJSON chunks arriving separately
        const ndjsonRes = await runChunkedStream([
            '{"choices":[{"delta":{"reasoning_content":"思考"}}]}\n',
            '{"choices":[{"delta":{"content":"正文"}}]}\n',
        ], 'application/json');
        assert.deepEqual(ndjsonRes.received, [
            ['', '思考'],
            ['正文', ''],
        ]);

        // 3. Mislabeled Content-Type: application/json carrying SSE data lines
        const sseRes = await runChunkedStream([
            'data: {"choices":[{"delta":{"reasoning_content":"step1"}}]}\n\n',
            'data: {"choices":[{"delta":{"content":"hello"}}]}\n\ndata: [DONE]\n\n',
        ], 'application/json');
        assert.deepEqual(sseRes.received, [
            ['', 'step1'],
            ['hello', ''],
        ]);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('StreamProjector retains thinking phase across whitespace-only content and switches to writing on prose', () => {
    const plan = createStreamPlan([], 'scope', '你', '角色', 'auto');
    const projector = new StreamProjector(plan);
    const thinkingPreview = projector.update('\n  ', false, !'\n  '.trim() && true);
    assert.equal(thinkingPreview.phase, 'thinking');
    const writingPreview = projector.update('真正落下的第一行。', false, !'真正落下的第一行。'.trim() && true);
    assert.equal(writingPreview.phase, 'writing');
});

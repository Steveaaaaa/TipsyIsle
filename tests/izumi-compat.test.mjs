import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { extensionModule } from '../server/extension-modules.mjs';

function installMemoryLocalStorage() {
    const store = new Map();
    Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        value: {
            getItem: key => store.get(String(key)) ?? null,
            setItem: (key, value) => { store.set(String(key), String(value)); },
            removeItem: key => { store.delete(String(key)); },
            clear: () => { store.clear(); },
            key: index => [...store.keys()][index] ?? null,
            get length() { return store.size; },
        },
    });
}

function createFakeHostWindow() {
    class FakeXMLHttpRequest extends EventTarget {
        readyState = 0;
        status = 0;
        statusText = '';
        responseText = '';
        response = '';
        responseURL = '';
        responseType = '';
        open() { this.readyState = 1; }
        setRequestHeader() {}
        getResponseHeader() { return null; }
        getAllResponseHeaders() { return ''; }
        abort() { this.readyState = 4; }
        send() { this.readyState = 4; this.status = 405; }
    }
    return {
        document: { baseURI: 'http://127.0.0.1/' },
        location: { href: 'http://127.0.0.1/' },
        fetch: () => Promise.reject(new Error('unexpected fallback fetch')),
        XMLHttpRequest: FakeXMLHttpRequest,
        Headers,
        Request,
        Response,
        Event,
    };
}

async function loadTestBundle() {
    const cacheDir = path.resolve('node_modules/.cache');
    await fs.mkdir(cacheDir, { recursive: true });
    const bundleFile = path.join(cacheDir, `izumi-compat-${crypto.randomUUID()}.mjs`);
    const result = await build({
        stdin: {
            contents: [
                'export { toNativePreset, fromNativePreset } from "./src/compatibility/preset-codec.ts";',
                'export { workspaceStore } from "./src/store/workspace/state.ts";',
                'export { selectPreset, updatePresetPrompt } from "./src/store/workspace/library-actions.ts";',
                'export { requestNativeResource } from "./src/compatibility/native-resource-host.ts";',
                'export { setHelperChatMessages, saveLegacyChat } from "./src/store/workspace/message-edits.ts";',
                'export { sendUserMessageAndGenerate, isGenerationPreparing } from "./src/store/workspace/generation.ts";',
                'export { setStoryRuntimeLoading } from "./src/core/sync/activity.ts";',
                'export { schemaRegistryStore } from "./src/registry/schema-registry.ts";',
                'export { tavernEventBus } from "./src/sandbox/event-bus.ts";',
                'export { assetCatalog, requestAsset } from "./src/compatibility/asset-host.ts";',
                'export { installHostFetch } from "./src/compatibility/host-fetch.ts";',
                'export { authorDocument } from "./src/compatibility/author-document.ts";',
                'export { commitPromptVariableChanges } from "./src/store/workspace/prompt-commit.ts";',
                'export { createPromptAssemblyInput, TemplateInputChangedError } from "./src/store/workspace/prompt.ts";',
                'export { assemblePromptPipeline } from "./src/pipeline/prompt-assembler.ts";',
                'export { TemplateRuntime } from "./src/pipeline/template-runtime.ts";',
            ].join('\n'),
            resolveDir: process.cwd(),
            loader: 'ts',
        },
        bundle: true,
        write: false,
        format: 'esm',
        platform: 'node',
        packages: 'external',
        plugins: [
            {
                name: 'stub-raw-imports',
                setup(pluginBuild) {
                    pluginBuild.onResolve({ filter: /\?raw$/ }, args => ({ path: args.path, namespace: 'stub-raw' }));
                    pluginBuild.onLoad({ filter: /.*/, namespace: 'stub-raw' }, () => ({ contents: 'export default "";', loader: 'js' }));
                },
            },
        ],
    });
    await fs.writeFile(bundleFile, result.outputFiles[0].text, 'utf8');
    try {
        const mod = await import(pathToFileURL(bundleFile).href);
        return {
            mod,
            cleanup: () => fs.rm(bundleFile, { force: true }),
        };
    } catch (error) {
        await fs.rm(bundleFile, { force: true });
        throw error;
    }
}

test('extensionModule provides all Izumi-required adapters and vite bundles all script modules', async () => {
    const expectedModules = [
        {
            pathname: '/script.js',
            symbols: [
                'isGenerating', 'streamingProcessor', 'isStreamingEnabled', 'main_api',
                'setExtensionPrompt', 'extension_prompts', 'saveChat', 'saveChatDebounced',
                'saveSettings', 'saveSettingsDebounced', 'getMaxPromptTokens',
            ],
        },
        {
            pathname: '/scripts/world-info.js',
            symbols: [
                'worldInfoCache', 'selected_world_info', 'world_info',
                'updateWorldInfoList', 'getWorldInfoSettings',
            ],
        },
        {
            pathname: '/scripts/openai.js',
            symbols: ['oai_settings', 'getChatCompletionModel', 'promptManager'],
        },
        {
            pathname: '/scripts/extensions/regex/engine.js',
            symbols: ['SCRIPT_TYPES', 'getScriptsByType'],
        },
        {
            pathname: '/scripts/preset-manager.js',
            symbols: ['getPresetManager'],
        },
        {
            pathname: '/scripts/showdown-underscore.js',
            symbols: ['markdownUnderscoreExt'],
        },
        {
            pathname: '/scripts/showdown-exclusion.js',
            symbols: ['markdownExclusionExt'],
        },
        {
            pathname: '/scripts/power-user.js',
            symbols: ['fixMarkdown', 'power_user'],
        },
    ];

    for (const entry of expectedModules) {
        const source = extensionModule(entry.pathname);
        assert.ok(source && source.length > 0, `${entry.pathname} should be returned`);
        for (const sym of entry.symbols) {
            assert.match(source, new RegExp(`\\b${sym}\\b`), `${entry.pathname} must export ${sym}`);
        }
    }

    const viteConfig = await fs.readFile(new URL('../vite.config.ts', import.meta.url), 'utf8');
    for (const bundledPath of [
        'scripts/extensions/regex/engine.js',
        'scripts/preset-manager.js',
        'scripts/showdown-underscore.js',
        'scripts/showdown-exclusion.js',
        'scripts/power-user.js',
    ]) {
        assert.ok(viteConfig.includes(bundledPath), `vite.config.ts must bundle ${bundledPath}`);
    }
});

test('native preset codec, settings/presets HTTP APIs, and chat swipe_info/topLevel round-trip cleanly', async () => {
    installMemoryLocalStorage();
    const { mod, cleanup } = await loadTestBundle();
    try {
        const {
            toNativePreset,
            fromNativePreset,
            workspaceStore,
            selectPreset,
            updatePresetPrompt,
            requestNativeResource,
            saveLegacyChat,
            assetCatalog,
            requestAsset,
            installHostFetch,
        } = mod;

        const rawNative = {
            temperature: 0.9,
            custom_prompt_post_processing: 'strict_tools',
            prompts: [
                { identifier: 'main', name: 'Main', role: 'system', content: 'Hello Izumi', system_prompt: true, marker: false, injection_position: 0, injection_depth: 4, injection_order: 100 },
                { identifier: 'charDescription', name: 'Char Desc', role: 'system', content: '', system_prompt: true, marker: true, injection_position: 0, injection_depth: 4, injection_order: 100 },
            ],
            prompt_order: [
                {
                    character_id: 100001,
                    order: [
                        { identifier: 'main', enabled: true },
                        { identifier: 'charDescription', enabled: true },
                    ],
                },
            ],
            extensions: {
                regex_scripts: [
                    { id: 'rx-1', scriptName: 'IzumiThinking', findRegex: '/a/g', replaceString: 'b', trimStrings: [], placement: [2], disabled: false, markdownOnly: true, promptOnly: false, runOnEdit: false, substituteRegex: 0, minDepth: null, maxDepth: null },
                ],
            },
        };

        // 1. Preset round-trip preserves exact JSON equality for readPresetProof
        const storedPreset = fromNativePreset(rawNative, 'IzumiPreset');
        assert.equal(JSON.stringify(toNativePreset(storedPreset)), JSON.stringify(rawNative));

        // 2. HTTP /api/presets/save & /api/settings/get round-trip (syncs both presets and inUsePreset)
        workspaceStore.setState({
            presets: [storedPreset],
            inUsePreset: structuredClone(storedPreset),
            activePresetId: storedPreset.id,
        });
        selectPreset(storedPreset.id);

        const updatedNative = structuredClone(rawNative);
        updatedNative.prompts[0].content = 'Updated Main Prompt';
        updatedNative.custom_prompt_post_processing = 'none';

        const saveResponse = await requestNativeResource('/api/presets/save', {
            apiId: 'openai',
            name: 'IzumiPreset',
            preset: updatedNative,
        });
        assert.deepEqual(saveResponse, { name: 'IzumiPreset' });

        const settingsResponse = await requestNativeResource('/api/settings/get', {});
        const parsedSettings = JSON.parse(settingsResponse.settings);
        assert.ok(settingsResponse.openai_setting_names.includes('IzumiPreset'));
        assert.equal(parsedSettings.oai_settings.custom_prompt_post_processing, 'none');
        assert.equal(JSON.stringify(parsedSettings.oai_settings), JSON.stringify(updatedNative));
        const idx = settingsResponse.openai_setting_names.indexOf('IzumiPreset');
        assert.equal(JSON.stringify(settingsResponse.openai_settings[idx]), JSON.stringify(updatedNative));

        // 3. updatePresetPrompt keeps rawData synchronized
        updatePresetPrompt(storedPreset.id, 'main', { enabled: false, content: 'UI Edited' });
        const afterUiEdit = toNativePreset(workspaceStore.getState().presets.find(p => p.id === storedPreset.id));
        assert.equal(afterUiEdit.prompts[0].content, 'UI Edited');
        assert.equal(afterUiEdit.prompt_order[0].order[0].enabled, false);

        // 4. AssetHost exposes native preset & saves via asset.preset.saveNative / saveWorkingNative
        await requestAsset('asset.preset.saveNative', { name: 'IzumiPreset', preset: updatedNative });
        const catalog = assetCatalog();
        assert.equal(catalog.loadedPresetName, 'IzumiPreset');
        assert.ok(catalog.inUseNativePreset);
        assert.ok(catalog.presets[0].native);
        assert.equal(catalog.inUseNativePreset.prompts[0].content, 'Updated Main Prompt');

        // 5. Chat persistence + /api/chats/get preserves swipe_info[i].extra and top-level markers
        const charId = 'char_izumi';
        const chatId = 'chat_izumi_1';
        workspaceStore.setState({
            activeCharacterId: charId,
            activeChatId: chatId,
            activeLeafId: 'msg-0',
            characters: [{
                id: charId,
                name: 'Izumi',
                avatar: 'izumi.png',
                systemPrompt: '',
                firstMessage: 'Hi',
                alternateGreetings: [],
                regexScripts: [],
                cardScripts: [],
                extensions: {},
            }],
            userName: 'Konata',
            messages: [
                {
                    id: 'msg-0',
                    chatId,
                    parentId: null,
                    floor: 0,
                    role: 'assistant',
                    speakerName: 'Izumi',
                    content: 'Swipe 0 text',
                    swipes: ['Swipe 0 text', 'Swipe 1 text'],
                    swipeIds: ['s0', 's1'],
                    activeSwipeIndex: 0,
                    reasoning: '',
                    createdAt: 1000,
                    updatedAt: 1000,
                    extra: {},
                },
            ],
            chatMetadata: { note: 'v1' },
        });

        const saved = saveLegacyChat([
            {
                id: 'msg-0',
                swipe: 0,
                content: 'Swipe 0 text',
                swipeInfo: {
                    0: { izumiWorld: { turn: 1 } },
                    1: { izumiWorld: { turn: 2 } },
                },
                topLevel: { izumiWorldHideTargetV1: true },
            },
        ]);
        assert.equal(saved, true);

        const chatRows = await requestNativeResource('/api/chats/get', {
            avatar_url: 'izumi.png',
            file_name: chatId,
        });
        assert.equal(chatRows.length, 2);
        assert.equal(chatRows[0].chat_metadata.note, 'v1');
        assert.equal(chatRows[1].izumiWorldHideTargetV1, true);
        assert.deepEqual(chatRows[1].swipe_info[0].extra.izumiWorld, { turn: 1 });
        assert.deepEqual(chatRows[1].swipe_info[1].extra.izumiWorld, { turn: 2 });

        // 6. installHostFetch routes /api/chats/get and /api/presets/save without throwing
        const fakeWindow = createFakeHostWindow();
        installHostFetch(fakeWindow, async (method, params) => {
            if (method === 'host.http') return requestNativeResource(params.path, params.body);
            throw new Error(`Unexpected host request: ${method}`);
        });
        const fetchChatsRes = await fakeWindow.fetch('/api/chats/get', { method: 'POST', body: JSON.stringify({ avatar_url: 'izumi.png', file_name: chatId }) });
        assert.equal(fetchChatsRes.ok, true);
        const fetchPresetRes = await fakeWindow.fetch('/api/presets/save', { method: 'POST', body: JSON.stringify({ apiId: 'openai', name: 'IzumiPreset', preset: updatedNative }) });
        assert.equal(fetchPresetRes.ok, true);

        // 7. authorDocument leaves module script strings containing '<head>' / '<body' untouched
        const scriptHtml = `<script type="module">\nconst check = t => t.includes('<head>') || t.includes('<body');\n</script>`;
        const builtScriptDoc = mod.authorDocument(scriptHtml, '<script>parent.__compatInstall(window);<\\/script>', '');
        assert.equal((builtScriptDoc.match(/<head\b/gi) ?? []).length, 2);
        assert.ok(builtScriptDoc.startsWith('<!doctype html><html><head><script>parent.__compatInstall(window);<\\/script></head><body><script type="module">'));
        assert.ok(builtScriptDoc.includes(`t.includes('<head>') || t.includes('<body')`));

        // 8. frame-entry unifies repaintMessageBlock with populateMessageBody/disposeRowBody and supports SillyTavern addHook(fn, opts)
        const frameEntrySource = await fs.readFile(new URL('../src/compatibility/frame-entry.ts', import.meta.url), 'utf8');
        assert.match(frameEntrySource, /function repaintMessageBlock[\s\S]*?disposeRowBody\(rowEl\)[\s\S]*?populateMessageBody\(rowEl,/);
        assert.doesNotMatch(frameEntrySource, /function repaintMessageBlock[\s\S]*?rowEl\.innerHTML\s*=/);
        assert.match(frameEntrySource, /stageOrFn:\s*FormatterStage\s*\|\s*FormatterHookFn/);
    } finally {
        await cleanup();
    }
});

test('setHelperChatMessages allows Izumi advice transfer during generation preparation while blocking structural or streaming-phase mutations', async () => {
    installMemoryLocalStorage();
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((fn, delay, ...args) => {
        const timer = realSetTimeout(fn, delay, ...args);
        if (typeof delay === 'number' && delay >= 60_000) timer?.unref?.();
        return timer;
    });
    const prevWindow = globalThis.window;
    const { mod, cleanup } = await loadTestBundle();
    try {
        const {
            workspaceStore,
            setStoryRuntimeLoading,
            setHelperChatMessages,
            sendUserMessageAndGenerate,
            isGenerationPreparing,
            tavernEventBus,
            schemaRegistryStore,
        } = mod;
        Object.defineProperty(globalThis, 'window', {
            configurable: true,
            value: { dispatchEvent() {}, addEventListener() {}, removeEventListener() {} },
        });
        setStoryRuntimeLoading(false);
        await new Promise(resolve => realSetTimeout(resolve, 0));
        delete globalThis.window;
        const prevCustomUrl = schemaRegistryStore.getState().values['api.custom_url'];
        schemaRegistryStore.setState(draft => { draft.values['api.custom_url'] = ''; });
        const charId = 'char_izumi_prep';
        const chatId = 'chat_izumi_prep';
        workspaceStore.setState({
            activeCharacterId: charId,
            activeChatId: chatId,
            activeLeafId: 'msg-0',
            isGenerating: false,
            sessionKind: 'character',
            characters: [{
                id: charId,
                name: 'Izumi',
                avatar: 'izumi.png',
                characterVersion: '',
                description: '',
                personality: '',
                scenario: '',
                systemPrompt: '',
                firstMessage: 'Swipe 0 text',
                alternateGreetings: [],
                mesExample: '',
                postHistoryInstructions: '',
                creatorNotes: '',
                tags: [],
                regexScripts: [],
                cardScripts: [],
                extensions: {},
            }],
            userName: 'Konata',
            messages: [
                {
                    id: 'msg-0',
                    chatId,
                    parentId: null,
                    floor: 0,
                    role: 'assistant',
                    speakerName: 'Izumi',
                    content: 'Swipe 0 text',
                    swipes: ['Swipe 0 text', 'Swipe 1 text'],
                    swipeIds: ['s0', 's1'],
                    activeSwipeIndex: 0,
                    reasoning: '',
                    createdAt: 1000,
                    updatedAt: 1000,
                    extra: {},
                },
            ],
            chatMetadata: {},
        });

        let sawPreparing = false;
        let sawStreamingError = false;
        const offStart = tavernEventBus.on('generation_started', async () => {
            sawPreparing = isGenerationPreparing();
            assert.equal(sawPreparing, true);
            await setHelperChatMessages([
                {
                    message_id: 0,
                    message: 'Swipe 0 text\n<advice>moved</advice>',
                    swipes: ['Swipe 0 text\n<advice>moved</advice>', 'Swipe 1 text'],
                },
                {
                    message_id: 1,
                    message: '就按照最新的advice说的来吧',
                    extra: { izumi_advice: { sourceFloor: 0 } },
                    swipes: ['就按照最新的advice说的来吧'],
                },
            ], { refresh: 'none' });

            await assert.rejects(
                setHelperChatMessages([{ message_id: 0, swipe_id: 1 }], { refresh: 'none' }),
                /生成期间不能修改其他消息或改变分支结构/,
            );
            await assert.rejects(
                setHelperChatMessages([
                    { message_id: 0, message: 'x', swipes: ['x', 'Mutated inactive swipe'] },
                ], { refresh: 'none' }),
                /生成期间不能修改其他消息或改变分支结构/,
            );
            await assert.rejects(
                setHelperChatMessages([{ message_id: 1, role: 'system' }], { refresh: 'none' }),
                /生成期间不能修改其他消息或改变分支结构/,
            );
            await assert.rejects(
                setHelperChatMessages([{ message_id: 1, is_hidden: true }], { refresh: 'none' }),
                /生成期间不能修改其他消息或改变分支结构/,
            );
        });
        let checkedStreaming = false;
        const offToken = tavernEventBus.on('generation_stream_token', async () => {
            if (checkedStreaming) return;
            checkedStreaming = true;
            if (typeof globalThis.window === 'undefined') {
                Object.defineProperty(globalThis, 'window', {
                    configurable: true,
                    value: { dispatchEvent() {}, addEventListener() {}, removeEventListener() {} },
                });
            }
            assert.equal(isGenerationPreparing(), false);
            try {
                await setHelperChatMessages([{ message_id: 0, message: 'mutated during stream' }], { refresh: 'none' });
            } catch (error) {
                if (/生成期间不能修改其他消息或改变分支结构/.test(String(error))) sawStreamingError = true;
            }
        });

        try {
            await sendUserMessageAndGenerate('在背后悄悄看着她俩');
            await new Promise(resolve => setTimeout(resolve, 20));
        } finally {
            offStart();
            offToken();
        }

        assert.equal(sawPreparing, true);
        assert.equal(checkedStreaming, true);
        assert.equal(sawStreamingError, true);
        const path = workspaceStore.getState().messages;
        assert.equal(path[0].content, 'Swipe 0 text\n<advice>moved</advice>');
        assert.equal(path[0].swipes[1], 'Swipe 1 text');
        assert.equal(path[1].content, '就按照最新的advice说的来吧');
        assert.deepEqual(path[1].extra?.helperSwipeInfo?.[0]?.izumi_advice, { sourceFloor: 0 });
        schemaRegistryStore.setState(draft => { draft.values['api.custom_url'] = prevCustomUrl; });
    } finally {
        globalThis.setTimeout = realSetTimeout;
        if (prevWindow === undefined) delete globalThis.window;
        else Object.defineProperty(globalThis, 'window', { configurable: true, value: prevWindow });
        await cleanup();
    }
});

test('commitPromptVariableChanges allows non-structural in-place edits only while preparing non-template generation prompts', async () => {
    installMemoryLocalStorage();
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((fn, ms, ...args) => {
        const timer = realSetTimeout(fn, ms, ...args);
        if (typeof ms === 'number' && ms >= 60_000) timer.unref?.();
        return timer;
    });
    const prevWindow = globalThis.window;
    const { mod, cleanup } = await loadTestBundle();
    try {
        const {
            workspaceStore,
            setStoryRuntimeLoading,
            setHelperChatMessages,
            sendUserMessageAndGenerate,
            isGenerationPreparing,
            commitPromptVariableChanges,
            createPromptAssemblyInput,
            TemplateInputChangedError,
            tavernEventBus,
            schemaRegistryStore,
        } = mod;
        Object.defineProperty(globalThis, 'window', {
            configurable: true,
            value: { dispatchEvent() {}, addEventListener() {}, removeEventListener() {} },
        });
        setStoryRuntimeLoading(false);
        await new Promise(resolve => realSetTimeout(resolve, 0));
        delete globalThis.window;
        const prevCustomUrl = schemaRegistryStore.getState().values['api.custom_url'];
        schemaRegistryStore.setState(draft => { draft.values['api.custom_url'] = ''; });
        const charId = 'char_izumi_commit';
        const chatId = 'chat_izumi_commit';
        const presetId = 'preset_izumi_commit';
        workspaceStore.setState({
            activeCharacterId: charId,
            activeChatId: chatId,
            activePresetId: presetId,
            presets: [{
                id: presetId,
                name: 'Izumi',
                promptSlots: [],
                regexScripts: [],
                rawData: {},
            }],
            activeLeafId: 'msg-0',
            isGenerating: false,
            sessionKind: 'character',
            characters: [{
                id: charId,
                name: 'Izumi',
                avatar: 'izumi.png',
                characterVersion: '',
                description: '',
                personality: '',
                scenario: '',
                systemPrompt: '',
                firstMessage: 'Opening text',
                alternateGreetings: [],
                mesExample: '',
                postHistoryInstructions: '',
                creatorNotes: '',
                tags: [],
                regexScripts: [],
                cardScripts: [],
                extensions: {},
            }],
            userName: 'Konata',
            messages: [
                {
                    id: 'msg-0',
                    chatId,
                    parentId: null,
                    floor: 0,
                    role: 'assistant',
                    speakerName: 'Izumi',
                    content: 'Opening text',
                    swipes: ['Opening text', 'Alt opening'],
                    swipeIds: ['s0', 's1'],
                    activeSwipeIndex: 0,
                    reasoning: '',
                    createdAt: 1000,
                    updatedAt: 1000,
                    extra: {},
                },
            ],
            chatMetadata: {},
        });

        const baseAssembled = {
            messages: [],
            activatedLorebookEntries: [],
            nextTimedStates: {},
            variableChanges: { izumi_checked: true },
            globalVariableChanges: {},
            tokenUsage: { system: 0, lorebook: 0, history: 0, total: 0, budgetRemaining: 1000 },
            droppedHistoryCount: 0,
        };

        let verifiedInPrep = false;
        const offStart = tavernEventBus.on('generation_started', async () => {
            assert.equal(isGenerationPreparing(), true);
            const expectedBeforeTransfer = createPromptAssemblyInput();
            await setHelperChatMessages([
                {
                    message_id: 0,
                    message: 'Opening text\n<advice>继续</advice>',
                    swipes: ['Opening text\n<advice>继续</advice>', 'Alt opening'],
                },
                {
                    message_id: 1,
                    message: '就按照最新的advice说的来吧',
                    extra: { izumi_advice: { sourceFloor: 0 } },
                    swipes: ['就按照最新的advice说的来吧'],
                },
            ], { refresh: 'none' });

            // Non-template generation commit succeeds despite in-place content mutation.
            commitPromptVariableChanges(baseAssembled, expectedBeforeTransfer);

            // Render tasks must still fail when message content changed under them.
            assert.throws(
                () => commitPromptVariableChanges(baseAssembled, {
                    ...expectedBeforeTransfer,
                    templateTask: { type: 'render', messageId: 'msg-0', source: 'Opening text' },
                }),
                TemplateInputChangedError,
            );

            // Structural/metadata changes must still fail even during generation preparation.
            const wrongSwipe = structuredClone(expectedBeforeTransfer);
            wrongSwipe.messages[0].activeSwipeIndex = 1;
            assert.throws(() => commitPromptVariableChanges(baseAssembled, wrongSwipe), TemplateInputChangedError);

            const wrongRole = structuredClone(expectedBeforeTransfer);
            wrongRole.messages[1].role = 'system';
            assert.throws(() => commitPromptVariableChanges(baseAssembled, wrongRole), TemplateInputChangedError);

            const wrongLength = structuredClone(expectedBeforeTransfer);
            wrongLength.messages.pop();
            assert.throws(() => commitPromptVariableChanges(baseAssembled, wrongLength), TemplateInputChangedError);

            verifiedInPrep = true;
        });

        try {
            await sendUserMessageAndGenerate('继续');
            await new Promise(resolve => realSetTimeout(resolve, 20));
        } finally {
            offStart();
        }
        assert.equal(verifiedInPrep, true);

        // Outside generation preparation, any content mismatch must still fail commit.
        assert.equal(isGenerationPreparing(), false);
        const expectedOutside = createPromptAssemblyInput();
        await setHelperChatMessages([{ message_id: 0, message: 'Modified outside prep' }], { refresh: 'none' });
        assert.throws(() => commitPromptVariableChanges(baseAssembled, expectedOutside), TemplateInputChangedError);

        schemaRegistryStore.setState(draft => { draft.values['api.custom_url'] = prevCustomUrl; });
    } finally {
        globalThis.setTimeout = realSetTimeout;
        if (prevWindow === undefined) delete globalThis.window;
        else Object.defineProperty(globalThis, 'window', { configurable: true, value: prevWindow });
        await cleanup();
    }
});

test('assemblePromptPipeline syncs in-place advice transfer after WORLD_INFO_ACTIVATED while preserving pre-transfer scan hits', async () => {
    installMemoryLocalStorage();
    const { mod, cleanup } = await loadTestBundle();
    try {
        const { assemblePromptPipeline, TemplateRuntime } = mod;
        const messages = [
            {
                id: 'msg-0',
                chatId: 'chat-sync',
                parentId: null,
                floor: 0,
                role: 'assistant',
                speakerName: 'Izumi',
                content: 'Opening text',
                swipes: ['Opening text'],
                swipeIds: ['s0'],
                activeSwipeIndex: 0,
                reasoning: '',
                createdAt: 1000,
                updatedAt: 1000,
                extra: {},
            },
            {
                id: 'msg-1',
                chatId: 'chat-sync',
                parentId: 'msg-0',
                floor: 1,
                role: 'user',
                speakerName: 'Konata',
                content: '继续',
                swipes: ['继续'],
                swipeIds: ['s1'],
                activeSwipeIndex: 0,
                reasoning: '',
                createdAt: 2000,
                updatedAt: 2000,
                extra: {},
            },
        ];
        const liveMessages = structuredClone(messages);
        const input = {
            character: {
                id: 'char-sync',
                name: 'Izumi',
                avatar: '',
                characterVersion: '',
                description: '',
                personality: '',
                scenario: '',
                systemPrompt: '',
                firstMessage: 'Opening text',
                alternateGreetings: [],
                mesExample: '',
                postHistoryInstructions: '',
                creatorNotes: '',
                tags: [],
                regexScripts: [],
                cardScripts: [],
                extensions: {},
            },
            userName: 'Konata',
            chatId: 'chat-sync',
            maxContextTokens: 8192,
            maxResponseTokens: 1024,
            preset: {
                id: 'preset-sync',
                name: 'Izumi',
                promptSlots: [
                    { identifier: 'worldInfoAfter', name: 'WI', role: 'system', enabled: true, injectionOrder: 1 },
                    { identifier: 'chatHistory', name: 'History', role: 'system', enabled: true, injectionOrder: 2 },
                ],
                regexScripts: [],
                rawData: {},
            },
            lorebooks: [
                {
                    id: 'book-sync',
                    name: 'izumi-book',
                    entries: [
                        {
                            uid: 1,
                            keys: ['继续'],
                            secondaryKeys: [],
                            content: 'Worldbook hint triggered before advice transfer',
                            comment: 'continue-rule',
                            world: 'izumi-book',
                            position: 'after_char',
                            enabled: true,
                            disabled: false,
                            constant: false,
                            selective: false,
                            selectiveLogic: 'AND_ANY',
                            order: 100,
                            depth: 4,
                            role: 'system',
                            extensions: {},
                        },
                    ],
                },
            ],
            messages,
            globalRegexScripts: [],
        };

        const runtime = new TemplateRuntime(input, {
            hasEvent: name => name === 'world_info_activated',
            liveMessages: () => liveMessages,
            event: async name => {
                if (name !== 'world_info_activated') return;
                liveMessages[0].content = 'Opening text\n<advice>继续</advice>';
                liveMessages[0].swipes[0] = 'Opening text\n<advice>继续</advice>';
                liveMessages[1].content = '就按照最新的advice说的来吧';
                liveMessages[1].swipes[0] = '就按照最新的advice说的来吧';
            },
        });

        const assembled = await assemblePromptPipeline(input, runtime);
        assert.equal(assembled.activatedLorebookEntries.some(entry => entry.comment === 'continue-rule'), true);
        const contents = assembled.messages.map(m => m.content);
        assert.equal(contents.some(text => text.includes('<advice>继续</advice>')), true);
        assert.equal(contents.some(text => text === '就按照最新的advice说的来吧'), true);
        assert.equal(contents.some(text => text === '继续'), false);

        // Structural changes in liveMessages must not be synced in-place.
        liveMessages[0].activeSwipeIndex = 1;
        liveMessages[0].content = 'Should be ignored';
        assert.equal(runtime.syncInPlaceMessageContent(), false);
        assert.equal(input.messages[0].content, 'Opening text\n<advice>继续</advice>');
    } finally {
        await cleanup();
    }
});

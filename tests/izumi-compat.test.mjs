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
                'export { saveLegacyChat } from "./src/store/workspace/message-edits.ts";',
                'export { assetCatalog, requestAsset } from "./src/compatibility/asset-host.ts";',
                'export { installHostFetch } from "./src/compatibility/host-fetch.ts";',
                'export { authorDocument } from "./src/compatibility/author-document.ts";',
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

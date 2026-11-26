import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

function installMemoryEnv() {
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
    if (typeof globalThis.document === 'undefined') {
        Object.defineProperty(globalThis, 'document', {
            configurable: true,
            value: { hidden: false, addEventListener() {}, removeEventListener() {} },
        });
    }
    if (typeof globalThis.window === 'undefined') {
        Object.defineProperty(globalThis, 'window', {
            configurable: true,
            value: { dispatchEvent() {}, addEventListener() {}, removeEventListener() {} },
        });
    }
}

async function loadBundle() {
    const cacheDir = path.resolve('node_modules/.cache');
    await fs.mkdir(cacheDir, { recursive: true });
    const bundleFile = path.join(cacheDir, `script-delete-persistence-${crypto.randomUUID()}.mjs`);
    const result = await build({
        stdin: {
            contents: [
                'export { setStoryRuntimeLoading } from "./src/core/sync/activity.ts";',
                'export { workspaceStore } from "./src/store/workspace/state.ts";',
                'export { scopedVariableStore } from "./src/store/scoped-variable-store.ts";',
                'export { persistWorkspaceNow } from "./src/store/workspace/storage.ts";',
                'export { getWorkspaceScriptTrees, replaceWorkspaceScriptTrees, syncCharacterScriptsFromLibrary, syncPresetScriptsFromLibrary } from "./src/store/workspace/scripts.ts";',
                'export { applyArchivedChatState, restoreChatExtensions } from "./src/store/workspace/sessions.ts";',
                'export { applyBranchState } from "./src/store/workspace/branches.ts";',
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
        return { mod, cleanup: () => fs.rm(bundleFile, { force: true }) };
    } catch (error) {
        await fs.rm(bundleFile, { force: true });
        throw error;
    }
}

function makeScript(id, name) {
    return { type: 'script', id, name, enabled: true, content: `console.log(${JSON.stringify(name)});`, info: '', button: { enabled: true, buttons: [] }, data: {} };
}

test('deleted character, preset, and global TavernHelper scripts stay deleted across character switches and route restores', async () => {
    installMemoryEnv();
    const { mod, cleanup } = await loadBundle();
    try {
        const {
            setStoryRuntimeLoading,
            workspaceStore,
            scopedVariableStore,
            persistWorkspaceNow,
            getWorkspaceScriptTrees,
            replaceWorkspaceScriptTrees,
            applyArchivedChatState,
            restoreChatExtensions,
            applyBranchState,
        } = mod;

        setStoryRuntimeLoading(false);

        const charA = {
            id: 'char_a',
            name: 'CharA',
            avatar: 'a.png',
            systemPrompt: '',
            firstMessage: 'Hi A',
            alternateGreetings: [],
            regexScripts: [],
            extensions: {
                tavern_helper: { scripts: [makeScript('sc-a', 'CharA Script')] },
                TavernHelper: { scripts: [makeScript('sc-a', 'CharA Script')] },
            },
        };
        const charB = {
            id: 'char_b',
            name: 'CharB',
            avatar: 'b.png',
            systemPrompt: '',
            firstMessage: 'Hi B',
            alternateGreetings: [],
            regexScripts: [],
            extensions: { tavern_helper: { scripts: [] } },
        };
        const preset1 = {
            id: 'preset_1',
            name: 'Preset1',
            rawData: { extensions: { tavern_helper: { scripts: [makeScript('sc-p', 'Preset Script')] } } },
            promptSlots: [],
        };

        workspaceStore.setState({
            characters: [structuredClone(charA), structuredClone(charB)],
            presets: [structuredClone(preset1)],
            activeCharacterId: 'char_a',
            activePresetId: 'preset_1',
            inUsePreset: structuredClone(preset1),
            activeChatId: 'chat_a',
            sessionKind: 'character',
            storyCharacter: structuredClone(charA),
        });
        replaceWorkspaceScriptTrees([makeScript('sc-g', 'Global Script')], 'global', false);

        // Build stale continuation snapshots before deletion (simulating previously saved chat archives / branches)
        const staleCharAArchive = {
            id: 'chat_a',
            characterId: 'char_a',
            messages: [
                { id: 'msg-a', chatId: 'chat_a', parentId: null, floor: 0, role: 'assistant', speakerName: 'CharA', content: 'Hi A', swipes: ['Hi A'], activeSwipeIndex: 0, createdAt: 1, updatedAt: 1 },
            ],
            activeLeafId: 'msg-a',
            timedStates: {},
            continuation: {
                portable: false,
                variables: { global: {}, character: {}, preset: {}, chat: {}, message: {} },
                extensions: { tavern_helper: { someSetting: true, scripts: [makeScript('sc-g', 'Global Script')] } },
                activePresetId: 'preset_1',
                inUsePreset: structuredClone(preset1),
                activeLorebookIds: [],
                userName: 'User',
                activePersonaId: null,
                settings: {},
                worldbooks: [],
                characterBinding: { primary: null, additional: [] },
                character: structuredClone(charA),
            },
        };

        const staleCharBArchive = {
            id: 'chat_b',
            characterId: 'char_b',
            messages: [
                { id: 'msg-b', chatId: 'chat_b', parentId: null, floor: 0, role: 'assistant', speakerName: 'CharB', content: 'Hi B', swipes: ['Hi B'], activeSwipeIndex: 0, createdAt: 1, updatedAt: 1 },
            ],
            activeLeafId: 'msg-b',
            timedStates: {},
            continuation: {
                portable: false,
                variables: { global: {}, character: {}, preset: {}, chat: {}, message: {} },
                extensions: {},
                activePresetId: 'preset_1',
                inUsePreset: structuredClone(preset1),
                activeLorebookIds: [],
                userName: 'User',
                activePersonaId: null,
                settings: {},
                worldbooks: [],
                characterBinding: { primary: null, additional: [] },
                character: structuredClone(charB),
            },
        };

        // 1. Delete global, preset, and character A scripts
        replaceWorkspaceScriptTrees([], 'global', false);
        replaceWorkspaceScriptTrees([], 'preset', false);
        replaceWorkspaceScriptTrees([], 'character', false);

        let trees = getWorkspaceScriptTrees();
        assert.equal(trees.global.length, 0);
        assert.equal(trees.preset.length, 0);
        assert.equal(trees.character.length, 0);
        assert.equal(workspaceStore.getState().storyCharacter.extensions.TavernHelper, undefined);

        // 2. Switch to Character B whose archive has stale continuation.inUsePreset (used to resurrect Preset Script)
        applyArchivedChatState(staleCharBArchive);
        trees = getWorkspaceScriptTrees();
        assert.equal(trees.preset.length, 0, 'preset script must stay deleted after switching character');
        assert.equal(trees.global.length, 0, 'global script must stay deleted after switching character');

        // 3. Switch back to Character A whose stale archive still contains CharA Script + TavernHelper alias
        applyArchivedChatState(staleCharAArchive);
        trees = getWorkspaceScriptTrees();
        assert.equal(trees.character.length, 0, 'character script must stay deleted when switching back to character A');
        assert.equal(trees.preset.length, 0, 'preset script must stay deleted when switching back to character A');
        assert.equal(trees.global.length, 0, 'global script must stay deleted even when stale continuation.extensions.tavern_helper had scripts');
        assert.equal(workspaceStore.getState().storyCharacter.extensions.TavernHelper, undefined);

        // 4. Branch restore with stale continuation.character must also keep deleted character script deleted
        applyBranchState({
            continuation: staleCharAArchive.continuation,
            messageVariablePages: [],
            reply: { content: 'Hi A', swipe: 'Hi A' },
            worldbookName: null,
            timedStates: {},
            templateInjections: [],
            templateActivations: [],
        });
        assert.equal(getWorkspaceScriptTrees().character.length, 0, 'applyBranchState must not resurrect deleted character script');

        // 5. Portable story keeps its own bundled scripts intact
        const portableArchive = {
            ...staleCharAArchive,
            id: 'chat_portable',
            continuation: { ...staleCharAArchive.continuation, portable: true },
        };
        applyArchivedChatState(portableArchive);
        assert.equal(getWorkspaceScriptTrees().character.length, 1, 'portable story must retain its embedded scripts');

        // 6. restoreChatExtensions directly preserves current global scripts
        const extTarget = { tavern_helper: { scripts: [] } };
        restoreChatExtensions(extTarget, staleCharAArchive.continuation, 'chat_a', []);
        assert.deepEqual(extTarget.tavern_helper.scripts, []);
        assert.equal(extTarget.tavern_helper.someSetting, true);

        await persistWorkspaceNow();
    } finally {
        await cleanup();
    }
});

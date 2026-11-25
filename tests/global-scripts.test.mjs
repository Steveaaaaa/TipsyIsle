import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'vite';

test('switching characters cannot restore deleted global scripts from a legacy archive', async () => {
    const server = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom', optimizeDeps: { noDiscovery: true } });
    const globals = new Map(['localStorage', 'window'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    try {
        const { workspaceStore, selectCharacter, getWorkspaceScriptTrees, replaceWorkspaceScriptTrees, persistWorkspaceNow, captureChatContinuation } =
            await server.ssrLoadModule('/src/store/workspace-store.ts');
        const { readBranchState, applyBranchState } = await server.ssrLoadModule('/src/store/workspace/branches.ts');
        const { normalizeCharacterCard } = await server.ssrLoadModule('/src/pipeline/normalizer.ts');
        const { setStoryRuntimeLoading } = await server.ssrLoadModule('/src/core/sync/activity.ts');
        const { loadChatArchive, saveChatArchive } = await server.ssrLoadModule('/src/store/chat-archives.ts');
        const { platformStorage } = await server.ssrLoadModule('/src/core/platform-bridge.ts');

        const storage = new Map();
        Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
            getItem: key => storage.get(key) ?? null,
            setItem: (key, value) => storage.set(key, value),
        } });
        Object.defineProperty(globalThis, 'window', { configurable: true, value: new EventTarget() });
        setStoryRuntimeLoading(false);
        workspaceStore.setState({ characters: ['first', 'second'].map(id => normalizeCharacterCard({ id, name: id, first_mes: 'Hello' })) });

        await selectCharacter('first');
        const firstChat = workspaceStore.getState().activeChatId;
        const script = { id: 'imported', name: 'Imported script', type: 'script', enabled: true, content: '' };
        replaceWorkspaceScriptTrees([script], 'global', false);
        await persistWorkspaceNow();
        await selectCharacter('second');
        const secondChat = workspaceStore.getState().activeChatId;
        assert.deepEqual(getWorkspaceScriptTrees().global, [script]);

        const archive = await loadChatArchive(firstChat);
        const legacyBucket = { scripts: [script], otherSetting: 'saved' };
        await saveChatArchive({ ...archive, continuation: { ...archive.continuation,
            extensions: { ...archive.continuation.extensions, tavern_helper: legacyBucket },
        } }, true);
        assert.deepEqual((await loadChatArchive(firstChat)).continuation.extensions.tavern_helper, legacyBucket);
        replaceWorkspaceScriptTrees([], 'global');
        await persistWorkspaceNow();
        await selectCharacter('first');

        assert.equal(workspaceStore.getState().activeChatId, firstChat);
        assert.deepEqual(getWorkspaceScriptTrees().global, []);
        assert.deepEqual((await platformStorage.loadSnapshot('scoped_variables', null)).extension.tavern_helper, { scripts: [], otherSetting: 'saved' });
        assert.deepEqual(captureChatContinuation().extensions.tavern_helper, { otherSetting: 'saved' });

        const state = workspaceStore.getState();
        const checkpoint = readBranchState(state, state.messages[0]);
        assert.deepEqual(checkpoint.continuation.extensions.tavern_helper, { otherSetting: 'saved' });
        checkpoint.continuation.extensions.tavern_helper = { scripts: [script] };
        applyBranchState(checkpoint);
        assert.deepEqual(getWorkspaceScriptTrees().global, []);

        const replacement = { ...script, id: 'replacement' };
        replaceWorkspaceScriptTrees([replacement], 'global', false);
        await persistWorkspaceNow();
        await selectCharacter('second');
        assert.equal(workspaceStore.getState().activeChatId, secondChat);
        assert.deepEqual(getWorkspaceScriptTrees().global, [replacement]);
    } finally {
        await server.close();
        for (const [key, descriptor] of globals) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else delete globalThis[key];
        }
    }
});

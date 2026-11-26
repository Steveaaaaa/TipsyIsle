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
    const bundleFile = path.join(cacheDir, `message-edit-copy-${crypto.randomUUID()}.mjs`);
    const result = await build({
        stdin: {
            contents: [
                'export { setStoryRuntimeLoading } from "./src/core/sync/activity.ts";',
                'export { workspaceStore } from "./src/store/workspace/state.ts";',
                'export { persistWorkspaceNow } from "./src/store/workspace/storage.ts";',
                'export { editMessageInPlace } from "./src/store/workspace/message-edits.ts";',
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

test('editMessageInPlace edits both user and assistant messages in place without truncating later floors', async () => {
    installMemoryEnv();
    const { mod, cleanup } = await loadBundle();
    try {
        const { setStoryRuntimeLoading, workspaceStore, persistWorkspaceNow, editMessageInPlace } = mod;
        setStoryRuntimeLoading(false);
        const chatId = 'chat_edit_1';
        workspaceStore.setState({
            activeCharacterId: 'char_1',
            activeChatId: chatId,
            activeLeafId: 'msg-2',
            isGenerating: false,
            sessionKind: 'free',
            characters: [{
                id: 'char_1',
                name: 'Assistant',
                avatar: 'a.png',
                systemPrompt: '',
                firstMessage: 'Hi',
                alternateGreetings: [],
                regexScripts: [],
                cardScripts: [],
                extensions: {},
            }],
            userName: 'User',
            messages: [
                {
                    id: 'msg-0',
                    chatId,
                    parentId: null,
                    floor: 0,
                    role: 'assistant',
                    speakerName: 'Assistant',
                    content: 'Opening',
                    swipes: ['Opening'],
                    swipeIds: ['s0'],
                    activeSwipeIndex: 0,
                    reasoning: '',
                    createdAt: 1000,
                    updatedAt: 1000,
                    extra: {},
                },
                {
                    id: 'msg-1',
                    chatId,
                    parentId: 'msg-0',
                    floor: 1,
                    role: 'user',
                    speakerName: 'User',
                    content: 'Original user input',
                    swipes: ['Original user input'],
                    swipeIds: ['s1'],
                    activeSwipeIndex: 0,
                    reasoning: '',
                    createdAt: 2000,
                    updatedAt: 2000,
                    extra: {},
                },
                {
                    id: 'msg-2',
                    chatId,
                    parentId: 'msg-1',
                    floor: 2,
                    role: 'assistant',
                    speakerName: 'Assistant',
                    content: 'Later reply',
                    swipes: ['Later reply'],
                    swipeIds: ['s2'],
                    activeSwipeIndex: 0,
                    reasoning: '',
                    createdAt: 3000,
                    updatedAt: 3000,
                    extra: {},
                    branchBases: {
                        s2: {
                            reply: {
                                content: 'Later reply',
                                swipe: 'Later reply',
                                variables: {},
                            },
                            chatVariables: {},
                            timedStates: {},
                        },
                    },
                },
            ],
        });

        const userEdited = await editMessageInPlace('msg-1', 'Edited user input');
        assert.equal(userEdited, true);
        let state = workspaceStore.getState();
        assert.equal(state.activeLeafId, 'msg-2');
        assert.equal(state.messages.length, 3);
        assert.equal(state.messages[1].content, 'Edited user input');
        assert.equal(state.messages[1].swipes[0], 'Edited user input');

        const assistantEdited = await editMessageInPlace('msg-2', 'Edited assistant reply');
        assert.equal(assistantEdited, true);
        state = workspaceStore.getState();
        assert.equal(state.messages[2].content, 'Edited assistant reply');
        assert.equal(state.messages[2].swipes[0], 'Edited assistant reply');
        assert.equal(state.messages[2].branchBases.s2.reply.content, 'Edited assistant reply');
        assert.equal(state.messages[2].branchBases.s2.reply.swipe, 'Edited assistant reply');

        workspaceStore.setState({ isGenerating: true });
        await assert.rejects(() => editMessageInPlace('msg-2', 'Blocked'), /生成或保存期间不能修改消息/);
        await mod.persistWorkspaceNow();
    } finally {
        await cleanup();
    }
});

test('compatibility view enables mobile text selection, clipboard permission, and copy/edit actions', async () => {
    const [frameEntry, readingHostCss, compatChat, virtualStream] = await Promise.all([
        fs.readFile(new URL('../src/compatibility/frame-entry.ts', import.meta.url), 'utf8'),
        fs.readFile(new URL('../src/compatibility/reading-host.css', import.meta.url), 'utf8'),
        fs.readFile(new URL('../src/compatibility/CompatibilityChat.tsx', import.meta.url), 'utf8'),
        fs.readFile(new URL('../src/shell/VirtualChatStream.tsx', import.meta.url), 'utf8'),
    ]);

    assert.ok(frameEntry.includes("matchMedia('(any-pointer: coarse)').matches"));
    assert.ok(frameEntry.includes("button('复制'"));
    assert.ok(frameEntry.includes("button('修改'"));
    assert.ok(readingHostCss.includes('-webkit-user-select: text'));
    assert.ok(readingHostCss.includes('-webkit-touch-callout: default'));
    assert.ok(compatChat.includes('clipboard-write'));
    assert.ok(virtualStream.includes('复制内容'));
    assert.ok(virtualStream.includes('修改内容'));
});

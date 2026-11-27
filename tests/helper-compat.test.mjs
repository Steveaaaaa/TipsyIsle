import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

async function loadModule(entryPoint) {
    const cacheDir = path.resolve('node_modules/.cache');
    await fs.mkdir(cacheDir, { recursive: true });
    const bundleFile = path.join(cacheDir, `helper-compat-${crypto.randomUUID()}.mjs`);
    const bundle = await build({
        entryPoints: [entryPoint],
        bundle: true,
        write: false,
        format: 'esm',
        platform: 'node',
        packages: 'external',
    });
    await fs.writeFile(bundleFile, bundle.outputFiles[0].text, 'utf8');
    try {
        return await import(pathToFileURL(bundleFile).href);
    } finally {
        await fs.rm(bundleFile, { force: true });
    }
}

const {
    AUXILIARY_CONNECTION_PROXY_PRESET,
    CURRENT_CONNECTION_PROXY_PRESET,
    resolveProxyPresets,
    findProxyPreset,
} = await loadModule('src/compatibility/proxy-presets.ts');

const {
    resolveExtensionMenuActionTarget,
    collectExtensionActionTargets,
} = await loadModule('src/compatibility/extension-menu.ts');

const {
    shouldEmitMainGenerationAfterCommands,
    helperGenerationCommandType,
    shouldCollectGlobalInjections,
    shouldEmitGlobalGenerationStopped,
    shouldRemoveOnceInjectionsOnIframeGenerationEnded,
} = await loadModule('src/compatibility/helper-generation-policy.ts');

const { readMvuPatchBlocks } = await loadModule('src/pipeline/mvu-patch.ts');
const { readMvuCommands, settleMvuWithoutScripts } = await loadModule('src/pipeline/mvu-commands.ts');

test('resolveProxyPresets returns empty list when no proxy or connection url is configured', () => {
    assert.deepEqual(resolveProxyPresets({}), []);
    assert.deepEqual(resolveProxyPresets({ 'api.custom_url': 'ftp://invalid.local' }), []);
});

test('resolveProxyPresets exposes active connection when custom_url is configured without saved profiles', () => {
    const presets = resolveProxyPresets({
        'api.custom_url': 'https://api.example.com/v1',
        'api.key': 'sk-live',
        'api.chat_completion_source': 'openai',
        'api.model': 'gpt-4o',
    });
    assert.deepEqual(presets.map(item => item.name), [CURRENT_CONNECTION_PROXY_PRESET]);
    assert.deepEqual(findProxyPreset({
        'api.custom_url': 'https://api.example.com/v1',
        'api.key': 'sk-live',
        'api.chat_completion_source': 'openai',
        'api.model': 'gpt-4o',
    }, CURRENT_CONNECTION_PROXY_PRESET), {
        name: CURRENT_CONNECTION_PROXY_PRESET,
        url: 'https://api.example.com/v1',
        password: 'sk-live',
        source: 'openai',
        model: 'gpt-4o',
    });
});

test('resolveProxyPresets merges explicit proxy_presets, saved connection_profiles, and active connection with deduplication', () => {
    const profiles = JSON.stringify([
        { id: 'p1', name: 'DeepSeek通道', source: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-ds', model: 'deepseek-chat' },
        { id: 'p2', name: '无效通道', source: 'openai', baseUrl: 'not-a-url', apiKey: 'sk-bad', model: 'gpt-4o' },
        { id: 'p3', name: 'DeepSeek通道', source: 'openai', baseUrl: 'https://override.example/v1', apiKey: 'sk-dup', model: 'gpt-4o' },
        { id: 'p4', name: 'Claude通道', source: 'claude', baseUrl: 'https://api.anthropic.com', apiKey: 'sk-cl', model: 'claude-sonnet-4-20250514' },
    ]);
    const settings = {
        'api.proxy_presets': [
            { name: 'DeepSeek通道', url: 'https://explicit-proxy.example/v1', password: 'pw-explicit', source: 'custom', model: 'explicit-model' },
        ],
        'api.connection_profiles': profiles,
        'api.custom_url': 'https://active.example/v1',
        'api.key': 'sk-active',
        'api.chat_completion_source': 'openrouter',
        'api.model': 'openai/gpt-4o',
    };

    const resolved = resolveProxyPresets(settings);
    assert.deepEqual(resolved.map(item => item.name), ['DeepSeek通道', 'Claude通道', CURRENT_CONNECTION_PROXY_PRESET]);
    assert.equal(findProxyPreset(settings, 'DeepSeek通道')?.url, 'https://explicit-proxy.example/v1');
    assert.equal(findProxyPreset(settings, 'DeepSeek通道')?.password, 'pw-explicit');
    assert.equal(findProxyPreset(settings, ' Claude通道 ')?.url, 'https://api.anthropic.com');
    assert.equal(findProxyPreset(settings, 'Claude通道')?.password, 'sk-cl');
    assert.equal(findProxyPreset(settings, CURRENT_CONNECTION_PROXY_PRESET)?.source, 'openrouter');
});

test('resolveProxyPresets resolves blank baseUrl defaults, mvu profiles, independent mvu connection, and chat plugin connections', () => {
    const settings = {
        'api.connection_profiles': JSON.stringify([
            { id: 'ds', name: 'DeepSeek默认', source: 'deepseek', baseUrl: '', apiKey: 'sk-ds', model: 'deepseek-chat' },
        ]),
        'mvu.profiles': JSON.stringify([
            { 名称: 'MVU专用', backend: 'custom', api地址: 'https://mvu.example/v1', 密钥: 'sk-mvu', 模型名称: 'mvu-model', request: { protocol: 'openai' } },
            { 名称: 'PiOAuth通道', backend: 'pi', api地址: '', 密钥: '', 模型名称: 'pi-model', pi: { provider: 'openai' } },
        ]),
        'mvu.source': '自定义',
        'mvu.protocol': 'claude',
        'mvu.url': '',
        'mvu.key': 'sk-mvu-live',
        'mvu.model': 'claude-sonnet-4-20250514',
        'api.chat_completion_source': 'claude',
        'api.custom_url': '',
        'api.key': 'sk-main-claude',
        'api.model': 'claude-opus-4',
    };
    const extraConnections = [
        { name: '插件聊天渠道', baseUrl: 'https://plugin-chat.example/v1', apiKey: 'sk-plug', source: 'openai', model: 'gpt-4.1', kinds: ['chat'] },
        { name: '仅向量渠道', baseUrl: 'https://embed.example/v1', apiKey: 'sk-emb', source: 'openai', model: 'text-embedding-3', kinds: ['embedding'] },
    ];

    const resolved = resolveProxyPresets(settings, extraConnections);
    assert.deepEqual(resolved.map(item => item.name), [
        'DeepSeek默认',
        'MVU专用',
        AUXILIARY_CONNECTION_PROXY_PRESET,
        '插件聊天渠道',
        CURRENT_CONNECTION_PROXY_PRESET,
    ]);
    assert.equal(findProxyPreset(settings, 'DeepSeek默认', extraConnections)?.url, 'https://api.deepseek.com/v1');
    assert.equal(findProxyPreset(settings, 'MVU专用', extraConnections)?.password, 'sk-mvu');
    assert.equal(findProxyPreset(settings, AUXILIARY_CONNECTION_PROXY_PRESET, extraConnections)?.url, 'https://api.anthropic.com');
    assert.equal(findProxyPreset(settings, '插件聊天渠道', extraConnections)?.model, 'gpt-4.1');
    assert.equal(findProxyPreset(settings, CURRENT_CONNECTION_PROXY_PRESET, extraConnections)?.url, 'https://api.anthropic.com');
});

function mockElement({ id, classes = [], role, tagName = 'DIV', children = [] }) {
    const tokens = new Set(classes);
    const hasInteractiveSelector = (el, selector) => selector.split(',').map(part => part.trim()).some(token => {
        if (token === '.list-group-item') return el._classes.has('list-group-item');
        if (token === '[role="button"]') return el._role === 'button';
        if (token === 'button') return el.tagName === 'BUTTON';
        if (token === 'a') return el.tagName === 'A';
        if (token === '.drawer-toggle') return el._classes.has('drawer-toggle');
        if (token === '.qr--button') return el._classes.has('qr--button');
        return false;
    });
    const el = {
        id,
        tagName,
        _classes: tokens,
        _role: role,
        children,
        matches(selector) {
            return hasInteractiveSelector(el, selector);
        },
        querySelector(selector) {
            for (const child of el.children) {
                if (hasInteractiveSelector(child, selector)) return child;
                const nested = child.querySelector(selector);
                if (nested) return nested;
            }
            return null;
        },
        querySelectorAll(selector) {
            const out = [];
            for (const child of el.children) {
                if (hasInteractiveSelector(child, selector)) out.push(child);
                out.push(...child.querySelectorAll(selector));
            }
            return out;
        },
    };
    return el;
}

test('extension menu target resolution targets inner interactive items inside extension_container', () => {
    const innerItem = mockElement({ id: 'avs-v4-api-menu-item', classes: ['list-group-item'], role: 'button' });
    const container = mockElement({ id: 'avs-v4-api-menu-container', classes: ['extension_container'], children: [innerItem] });
    const directItem = mockElement({ id: 'direct-item', classes: ['list-group-item'] });
    const directButton = mockElement({ id: 'direct-btn', tagName: 'BUTTON' });
    const plainDiv = mockElement({ id: 'plain-div' });

    assert.equal(resolveExtensionMenuActionTarget(container), innerItem);
    assert.equal(resolveExtensionMenuActionTarget(directItem), directItem);
    assert.equal(resolveExtensionMenuActionTarget(directButton), directButton);
    assert.equal(resolveExtensionMenuActionTarget(plainDiv), plainDiv);

    const drawerToggle = mockElement({ id: 'drawer', classes: ['drawer-toggle'] });
    const qrBtn = mockElement({ id: 'qr', classes: ['qr--button'] });
    const targets = collectExtensionActionTargets(
        mockElement({ children: [container, directItem, plainDiv] }),
        mockElement({ children: [drawerToggle] }),
        mockElement({ children: [qrBtn] }),
    );
    assert.deepEqual(targets, [innerItem, directItem, plainDiv, drawerToggle, qrBtn]);
});

test('helper generation policy isolates generateRaw and silent background tasks from main chat lifecycle', () => {
    assert.equal(shouldEmitMainGenerationAfterCommands(true), false);
    assert.equal(shouldEmitMainGenerationAfterCommands(false), true);

    assert.equal(helperGenerationCommandType({ should_silence: true }), 'quiet');
    assert.equal(helperGenerationCommandType({ should_silence: false }), 'normal');
    assert.equal(helperGenerationCommandType({}), 'normal');

    assert.equal(shouldCollectGlobalInjections({ ordered_prompts: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'ping' }] }, true), false);
    assert.equal(shouldCollectGlobalInjections({ ordered_prompts: ['chat_history', { role: 'user', content: 'ping' }] }, true), true);
    assert.equal(shouldCollectGlobalInjections({}, true), true);
    assert.equal(shouldCollectGlobalInjections({ ordered_prompts: [{ role: 'user', content: 'ping' }] }, false), true);

    assert.equal(shouldEmitGlobalGenerationStopped(true), false);
    assert.equal(shouldEmitGlobalGenerationStopped(false), true);
    assert.equal(shouldRemoveOnceInjectionsOnIframeGenerationEnded(true), false);
    assert.equal(shouldRemoveOnceInjectionsOnIframeGenerationEnded(false), true);
});

test('MVU JSONPatch parser tolerates empty/comment/object blocks and skips non-MVU invalid blocks cleanly', async () => {
    for (const emptyBody of ['', '\n  \n', '```json\n```', '// 无需更新', '/* no changes */', '# comment', 'null', '{}']) {
        const blocks = readMvuPatchBlocks(`<UpdateVariable><JSONPatch>${emptyBody}</JSONPatch></UpdateVariable>`);
        assert.equal(blocks.length, 1);
        assert.deepEqual(blocks[0].patches, []);
    }

    const single = readMvuCommands('<UpdateVariable><JSONPatch>{"op":"replace","path":"/a","value":2}</JSONPatch></UpdateVariable>');
    assert.equal(single.commands.length, 1);
    assert.equal(single.commands[0].type, 'set');

    const wrapped = readMvuCommands('<UpdateVariable><JSONPatch>{"json_patch":[{"op":"replace","path":"/a","value":3}]}</JSONPatch></UpdateVariable>');
    assert.equal(wrapped.commands.length, 1);
    assert.equal(wrapped.commands[0].args[1], '3');

    const nonMvu = await settleMvuWithoutScripts({}, '正文内容<UpdateVariable><JSONPatch>无变化</JSONPatch></UpdateVariable>', () => {});
    assert.deepEqual(nonMvu, {});

    await assert.rejects(
        settleMvuWithoutScripts({ stat_data: { a: 1 } }, '<UpdateVariable><JSONPatch>"not an array"</JSONPatch></UpdateVariable>', () => {}),
        /JSONPatch 必须是操作数组（最多 4096 项）/,
    );
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';

const { outputFiles } = await build({ entryPoints: ['src/compatibility/avs-proxy-panel.ts'], write: false, format: 'esm' });
const { bindAvsProxyPanel, adaptAvsProxyPanel } = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`);

function fixture(lookup, saved = '') {
    const shown = [], warnings = [], calls = [];
    const field = value => Object.assign(new EventTarget(), { value });
    const panel = { mode: field('proxy'), preset: field('profile A'), model: field(saved),
        show: models => shown.push(models), warn: reason => warnings.push(reason),
        direct: async () => { calls.push('direct'); return { ok: true, models: ['direct model'] }; } };
    const bound = bindAvsProxyPanel(panel, name => ({ 'profile A': 'model/a', 'profile B': 'model/b' })[name],
        name => { calls.push(name); return lookup(name); });
    bound.restore();
    return { ...bound, panel, shown, warnings, calls };
}

test('restores configured model offline and preserves a saved override', async () => {
    const first = fixture(async () => ['model/a', 'other']);
    assert.deepEqual(first.calls, []);
    assert.equal(first.panel.model.value, 'model/a');
    assert.deepEqual(first.shown.at(-1), ['model/a']);
    await first.refresh();
    assert.deepEqual(first.calls, ['profile A']);
    assert.deepEqual(first.shown.at(-1), ['model/a', 'other']);
    assert.equal(fixture(async () => [], 'manual model').panel.model.value, 'manual model');
});

test('ignores stale catalog results and keeps direct lookup separate', async () => {
    let finish;
    const current = fixture(() => new Promise(resolve => { finish = resolve; }));
    const fetching = current.refresh();
    current.panel.preset.value = 'profile B';
    current.panel.preset.dispatchEvent(new Event('change'));
    finish(['old catalog']);
    await fetching;
    assert.equal(current.panel.model.value, 'model/b');
    assert.deepEqual(current.shown.at(-1), ['model/b']);
    current.panel.mode.value = 'direct';
    current.panel.mode.dispatchEvent(new Event('change'));
    await current.refresh();
    assert.deepEqual(current.calls, ['profile A', 'direct']);
    assert.deepEqual(current.shown.at(-1), ['direct model']);
});

test('catalog error leaves configured model usable; blank preset makes no request', async () => {
    const current = fixture(async () => { throw new Error('catalog unavailable'); });
    await current.refresh();
    assert.deepEqual(current.warnings, ['catalog unavailable']);
    assert.deepEqual(current.shown.at(-1), ['model/a']);
    current.panel.preset.value = '';
    current.panel.preset.dispatchEvent(new Event('change'));
    await current.refresh();
    assert.deepEqual(current.calls, ['profile A']);
    assert.equal(current.warnings.at(-1), '请先选择代理预设');
});

test('leaves unrecognized AVS panel revisions untouched', () => {
    const revised = "const avs={build: '20261108-v410-history-deepen1'}; openNewPanel();";
    assert.equal(adaptAvsProxyPanel(revised), revised);
});

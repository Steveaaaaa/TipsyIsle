import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'vite';

test('switching presets retains saved entries and leaves the reading stream preference alone', async () => {
    const server = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom', optimizeDeps: { noDiscovery: true } });
    try {
        const { workspaceStore } = await server.ssrLoadModule('/src/store/workspace/state.ts');
        const { selectPreset, updatePresetPrompt } = await server.ssrLoadModule('/src/store/workspace/library-actions.ts');
        const { getSchemaValues, setSchemaValues } = await server.ssrLoadModule('/src/registry/schema-registry.ts');
        const makePreset = (id, stream) => ({ id, name: id, rawData: { stream_openai: stream },
            promptSlots: [{ identifier: 'main', content: id, enabled: false }] });
        workspaceStore.setState({ presets: [makePreset('first', true), makePreset('second', false)] });
        setSchemaValues({ 'api.stream': false }, false);
        selectPreset('first');
        assert.equal(getSchemaValues()['api.stream'], false);
        updatePresetPrompt('first', 'main', { content: 'saved text' });
        updatePresetPrompt('first', 'main', { enabled: true });
        selectPreset('second');
        assert.deepEqual(workspaceStore.getState().inUsePreset.promptSlots[0], { identifier: 'main', content: 'second', enabled: false });
        selectPreset('');
        selectPreset('first');
        assert.deepEqual(workspaceStore.getState().inUsePreset.promptSlots[0], { identifier: 'main', content: 'saved text', enabled: true });
        assert.equal(getSchemaValues()['api.stream'], false);
        setSchemaValues({ 'api.stream': true }, false);
        selectPreset('second');
        assert.equal(getSchemaValues()['api.stream'], true);
    } finally { await server.close(); }
});

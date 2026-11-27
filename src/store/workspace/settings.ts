import { batchReactiveUpdates } from '../reactive-store';
import type { StreamDisplayMode } from '../../pipeline/streaming-message';
import { syncActiveProfileInSettingsPatch } from '../../core/model-profiles';
import { setSchemaValues, schemaRegistryStore } from '../../registry/schema-registry';
import { scopedVariableStore } from '../scoped-variable-store';
import { enqueuePersistentOperation, persistStateTransaction, waitForReplicaCommit } from '../persistence';
import { workspaceStore } from './state';
import { getActivePreset } from './library';
import { schedulePreview } from './prompt';
import { clearStreamProjectors } from './message-display';

export async function saveSettingsEdits(values: Record<string, unknown>, streamModes: Record<string, StreamDisplayMode>, extensions: Record<string, boolean>): Promise<void> {
    await enqueuePersistentOperation(async () => {
        await waitForReplicaCommit();
        const oldSettings = schemaRegistryStore.getState(), oldWorkspace = workspaceStore.getState(), oldVariables = scopedVariableStore.getState();
        const effectiveValues = syncActiveProfileInSettingsPatch(oldSettings.values, values);
        await persistStateTransaction(() => batchReactiveUpdates(() => {
            setSchemaValues(effectiveValues, false);
            workspaceStore.setState(draft => {
                Object.assign(draft.streamDisplayModes, streamModes);
                if (draft.sessionKind === 'free' || !draft.activePresetId) return;
                const preset = draft.inUsePreset ?? structuredClone(getActivePreset());
                const mapping = { context_max_tokens: 'maxContextTokens', max_tokens: 'maxResponseTokens', temperature: 'temperature',
                    top_p: 'topP', top_k: 'topK', min_p: 'minP', frequency_penalty: 'frequencyPenalty', presence_penalty: 'presencePenalty' } as const;
                for (const [key, field] of Object.entries(mapping)) if (`sampler.${key}` in effectiveValues) {
                    preset[field] = Number(schemaRegistryStore.getState().values[`sampler.${key}`]);
                }
                draft.inUsePreset = preset;
            });
            if (Object.keys(extensions).length) scopedVariableStore.setState(draft => {
                const settings = (draft.extension.tipsy_extensions ?? {}) as { disabled?: string[] };
                const disabled = new Set(settings.disabled ?? []);
                for (const [id, enabled] of Object.entries(extensions)) { if (enabled) disabled.delete(id); else disabled.add(id); }
                draft.extension.tipsy_extensions = { ...settings, disabled: [...disabled] };
            });
        }), () => batchReactiveUpdates(() => {
            schemaRegistryStore.setState(oldSettings); workspaceStore.setState(oldWorkspace); scopedVariableStore.setState(oldVariables);
        }));
        try { globalThis.localStorage?.setItem('tt:modern:schema_values', JSON.stringify(schemaRegistryStore.getState().values)); } catch { /* Platform snapshots are authoritative. */ }
        clearStreamProjectors(); schedulePreview();
    });
}

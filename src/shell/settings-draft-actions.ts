import { updateSyncOptions } from '../core/sync/engine';
import { schemaRegistryStore } from '../registry/schema-registry';
import { discardSettingsDraft, settingsDraftStore } from '../registry/settings-draft';
import { saveSettingsEdits, setStatusBanner } from '../store/workspace-store';

export async function commitSettingsDraft(): Promise<void> {
    const draft = settingsDraftStore.getState();
    if (draft.saving) return;
    const fields = schemaRegistryStore.getState().fields;
    settingsDraftStore.setState({ saving: true, saveError: '' });
    try {
        for (const [id, value] of Object.entries(draft.values)) {
            if (fields[id]?.type === 'number' && (value === '' || !Number.isFinite(Number(value)))) {
                throw new Error(`请填写「${fields[id].title}」的数值。`);
            }
        }
        if (draft.deviceName !== undefined && !draft.deviceName.trim()) {
            throw new Error('请填写设备名称。');
        }
        await saveSettingsEdits(draft.values, draft.streamModes, draft.extensions);
        settingsDraftStore.setState({ values: {}, streamModes: {}, extensions: {} });
        const latest = settingsDraftStore.getState();
        if (Object.keys(latest.syncOptions).length || latest.deviceName !== undefined) {
            await updateSyncOptions(latest.syncOptions, latest.deviceName);
        }
        discardSettingsDraft();
        setStatusBanner('设置已保存。');
    } catch (error) {
        settingsDraftStore.setState({ saveError: error instanceof Error ? error.message : String(error) });
    } finally {
        settingsDraftStore.setState({ saving: false });
    }
}

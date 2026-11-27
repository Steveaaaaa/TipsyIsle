import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { createReactiveStore } from '../store/reactive-store';
import { schemaRegistryStore, setSchemaValues } from './schema-registry';
import type { StreamDisplayMode } from '../pipeline/streaming-message';
import type { SyncOptions } from '../core/sync/protocol';

// Kept outside the mounted panel so closing it or changing tabs retains edits.
export const settingsDraftStore = createReactiveStore(() => ({
    values: {} as Record<string, unknown>,
    streamModes: {} as Record<string, StreamDisplayMode>,
    syncOptions: {} as Partial<SyncOptions>,
    deviceName: undefined as string | undefined,
    extensions: {} as Record<string, boolean>,
    saving: false,
    saveError: '',
}));
export type SettingsDraftSnapshot = ReturnType<typeof settingsDraftStore.getState>;
export function countPendingSettingsChanges(draft: SettingsDraftSnapshot): number {
    return Object.keys(draft.values).length
        + Object.keys(draft.streamModes).length
        + Object.keys(draft.syncOptions).length
        + Object.keys(draft.extensions).length
        + Number(draft.deviceName !== undefined);
}
if (typeof window !== 'undefined') window.addEventListener('beforeunload', event => {
    if (countPendingSettingsChanges(settingsDraftStore.getState()) > 0) {
        event.preventDefault(); event.returnValue = '';
    }
});
export function discardSettingsDraft() {
    settingsDraftStore.setState({ values: {}, streamModes: {}, syncOptions: {}, deviceName: undefined, extensions: {}, saveError: '' });
}
function editValues(patch: Record<string, unknown>) {
    settingsDraftStore.setState(draft => {
        const live = schemaRegistryStore.getState().values;
        for (const [key, value] of Object.entries(patch)) {
            if (Object.is(value, live[key])) delete draft.values[key]; else draft.values[key] = value;
        }
    });
}
const SettingsDraftContext = createContext(false);
export function SettingsDraftProvider({ children }: { children: ReactNode }) {
    return <SettingsDraftContext.Provider value={true}>{children}</SettingsDraftContext.Provider>;
}
export function useSettingsEditor() {
    const editing = useContext(SettingsDraftContext);
    const registry = schemaRegistryStore.useStore();
    const draft = settingsDraftStore.useStore();
    const values = useMemo(() => editing ? { ...registry.values, ...draft.values } : registry.values, [editing, registry.values, draft.values]);
    const setValues = editing ? editValues : setSchemaValues;
    return { ...registry, values, editing, setValues, setValue: (id: string, value: unknown) => setValues({ [id]: value }) };
}

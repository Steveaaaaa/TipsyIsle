import { createReactiveStore } from './reactive-store';
import { platformStorage } from '../core/platform-bridge';
import { tavernEventBus } from '../sandbox/event-bus';
import { normalizeMvuVariables, normalizeMvuVariableMap } from '../pipeline/mvu-data';
import type { VariableScopeContext, VariableScopeLevel } from '../types';
import { writeExtensionVariables } from '../compatibility/extension-variables';
import { registerSnapshotSource, persistRegisteredSnapshots } from './persistence';
import { removeStarterGlobals } from '../core/retired-starter-content';

export type ScopedBucketMap = Record<string, Record<string, unknown>>;

export interface ScopedVariableState {
    global: Record<string, unknown>;
    preset: ScopedBucketMap;
    character: ScopedBucketMap;
    chat: ScopedBucketMap;
    message: ScopedBucketMap;
    extension: ScopedBucketMap;
}

const SCOPE_SET = new Set<string>(['global', 'preset', 'character', 'chat', 'message']);
let assetVariables: { read(scope: 'character' | 'preset', id: string): Record<string, unknown> | undefined; write(scope: 'character' | 'preset', id: string, value: Record<string, unknown>): void } | undefined;
export function registerAssetVariableAccess(access: NonNullable<typeof assetVariables>): void { assetVariables = access; }

function isScopeLevel(val: unknown): val is VariableScopeLevel {
    return typeof val === 'string' && SCOPE_SET.has(val);
}

export const scopedVariableStore = createReactiveStore<ScopedVariableState>(() => ({
    global: {},
    preset: {},
    character: {},
    chat: {},
    message: {},
    extension: {},
}));

function resolveBucketKey(scope: VariableScopeLevel, ctx: VariableScopeContext = {}): string {
    switch (scope) {
        case 'global':
            return 'global';
        case 'preset':
            return ctx.presetId || 'default_preset';
        case 'character':
            return ctx.characterId || 'default_character';
        case 'chat':
            return ctx.chatId || 'default_chat';
        case 'message':
            return ctx.messageId || (ctx.floor !== undefined ? `floor_${ctx.floor}` : 'default_message');
    }
}

function persistVariables(): void {
    void persistRegisteredSnapshots().catch(error => {
        console.error('变量保存失败', error);
        globalThis.dispatchEvent?.(new CustomEvent('tipsy-storage-error', { detail: '变量保存失败，请检查本地网关或浏览器存储空间。' }));
    });
}
registerSnapshotSource('scoped_variables', () => scopedVariableStore.getState());

export async function hydrateScopedVariables(): Promise<void> {
    const saved = await platformStorage.loadSnapshot<Partial<ScopedVariableState> | null>('scoped_variables', null);
    if (!saved || typeof saved !== 'object') return;
    const chat = normalizeMvuVariableMap(saved.chat ?? {});
    const message = normalizeMvuVariableMap(saved.message ?? {});
    const global = removeStarterGlobals(saved.global ?? {});
    scopedVariableStore.setState((draft) => {
        draft.global = global;
        if (saved.preset && typeof saved.preset === 'object') draft.preset = saved.preset;
        if (saved.character && typeof saved.character === 'object') draft.character = saved.character;
        if (saved.chat && typeof saved.chat === 'object') draft.chat = chat.variables;
        if (saved.message && typeof saved.message === 'object') draft.message = message.variables;
        if (saved.extension && typeof saved.extension === 'object' && !Array.isArray(saved.extension)) draft.extension = saved.extension;
    });
    if (chat.changed || message.changed || global !== saved.global) persistVariables();
}

export const hydrateVariablesFromPlatform = hydrateScopedVariables;

export function getExtensionVariableBuckets(): ScopedBucketMap {
    return structuredClone(scopedVariableStore.getState().extension);
}

export function replaceExtensionVariables(id: string, value: Record<string, unknown>): void {
    scopedVariableStore.setState(draft => { writeExtensionVariables(draft.extension, id, value); });
    persistVariables();
    void tavernEventBus.emit('variables_changed', { scope: 'extension', extension_id: id, snapshot: value });
}

export function getScopedVariables(
    scope: VariableScopeLevel = 'chat',
    ctx: VariableScopeContext = {},
): Record<string, unknown> {
    return structuredClone(readScopedVariables(scope, ctx));
}
const emptyVariables: Record<string, unknown> = Object.freeze({});
/** Internal immutable store view for change detection; author APIs still clone. */
export function readScopedVariables(scope: VariableScopeLevel = 'chat', ctx: VariableScopeContext = {}): Record<string, unknown> {
    const state = scopedVariableStore.getState();
    if (scope === 'global') {
        return state.global;
    }
    const bucketKey = resolveBucketKey(scope, ctx);
    if ((scope === 'character' || scope === 'preset') && assetVariables) return assetVariables.read(scope, bucketKey) ?? emptyVariables;
    const map: ScopedBucketMap = state[scope];
    return map[bucketKey] ?? emptyVariables;
}

export function resolveMergedVariables(ctx: VariableScopeContext = {}): Record<string, unknown> {
    const state = scopedVariableStore.getState();
    return structuredClone({
        ...state.global,
        ...readScopedVariables('preset', ctx),
        ...readScopedVariables('character', ctx),
        ...(state.chat[resolveBucketKey('chat', ctx)] || {}),
        ...(state.message[resolveBucketKey('message', ctx)] || {}),
    });
}

export function resolveScopedVariable(key: string, ctx: VariableScopeContext = {}): unknown {
    const merged = resolveMergedVariables(ctx);
    return merged[key];
}

export function insertOrAssignScopedVariables(
    first: Record<string, unknown> | VariableScopeLevel,
    second: VariableScopeLevel | Record<string, unknown> = 'chat',
    ctx: VariableScopeContext = {},
): Record<string, unknown> {
    const scope: VariableScopeLevel = isScopeLevel(first)
        ? first
        : isScopeLevel(second)
          ? second
          : 'chat';
    const patch: Record<string, unknown> = isScopeLevel(first)
        ? ((second as Record<string, unknown>) || {})
        : ((first as Record<string, unknown>) || {});

    const merged = { ...getScopedVariables(scope, ctx), ...structuredClone(patch) };
    const nextSnapshot = scope === 'chat' || scope === 'message' ? normalizeMvuVariables(merged).variables : merged;
    if ((scope === 'character' || scope === 'preset') && assetVariables) {
        assetVariables.write(scope, resolveBucketKey(scope, ctx), nextSnapshot); persistVariables();
        return structuredClone(nextSnapshot);
    }
    scopedVariableStore.setState((draft) => {
        if (scope === 'global') {
            draft.global = nextSnapshot;
        } else {
            const bucketKey = resolveBucketKey(scope, ctx);
            const map: ScopedBucketMap = draft[scope];
            draft[scope] = { ...map, [bucketKey]: nextSnapshot };
        }
    });
    persistVariables();
    void tavernEventBus.emit('variables_changed', { scope, patch, snapshot: nextSnapshot });
    return structuredClone(nextSnapshot);
}

export function replaceScopedVariables(
    first: Record<string, unknown> | VariableScopeLevel,
    second: VariableScopeLevel | Record<string, unknown> = 'chat',
    ctx: VariableScopeContext = {},
): Record<string, unknown> {
    const scope: VariableScopeLevel = isScopeLevel(first)
        ? first
        : isScopeLevel(second)
          ? second
          : 'chat';
    const value: Record<string, unknown> = isScopeLevel(first)
        ? ((second as Record<string, unknown>) || {})
        : ((first as Record<string, unknown>) || {});
    const nextVars = structuredClone(scope === 'chat' || scope === 'message' ? normalizeMvuVariables(value).variables : value);
    if ((scope === 'character' || scope === 'preset') && assetVariables) {
        assetVariables.write(scope, resolveBucketKey(scope, ctx), nextVars); persistVariables();
        return structuredClone(nextVars);
    }

    scopedVariableStore.setState((draft) => {
        if (scope === 'global') {
            draft.global = { ...nextVars };
        } else {
            const bucketKey = resolveBucketKey(scope, ctx);
            const map: ScopedBucketMap = draft[scope];
            draft[scope] = { ...map, [bucketKey]: { ...nextVars } };
        }
    });
    persistVariables();
    void tavernEventBus.emit('variables_changed', { scope, snapshot: nextVars });
    return structuredClone(nextVars);
}

export function deleteScopedVariableKey(
    key: string,
    scope: VariableScopeLevel = 'chat',
    ctx: VariableScopeContext = {},
): boolean {
    if ((scope === 'character' || scope === 'preset') && assetVariables) {
        const value = getScopedVariables(scope, ctx); const exists = Object.hasOwn(value, key);
        if (exists) { delete value[key]; assetVariables.write(scope, resolveBucketKey(scope, ctx), value); persistVariables(); }
        return exists;
    }
    let existed = false;
    scopedVariableStore.setState((draft) => {
        if (scope === 'global') {
            if (key in draft.global) {
                delete draft.global[key];
                existed = true;
            }
        } else {
            const bucketKey = resolveBucketKey(scope, ctx);
            const map: ScopedBucketMap = draft[scope];
            const bucket = map[bucketKey];
            if (bucket && key in bucket) {
                delete bucket[key];
                existed = true;
            }
        }
    });
    if (existed) {
        persistVariables();
        void tavernEventBus.emit('variables_changed', { scope, deletedKey: key });
    }
    return existed;
}

export function deleteScopedVariable(
    first: VariableScopeLevel | string,
    second: VariableScopeLevel | string = 'chat',
    ctx: VariableScopeContext = {},
): boolean {
    if (isScopeLevel(first) && !isScopeLevel(second)) {
        return deleteScopedVariableKey(second, first, ctx);
    }
    return deleteScopedVariableKey(first, isScopeLevel(second) ? second : 'chat', ctx);
}

export const insertOrAssignVariables = insertOrAssignScopedVariables;
export const deleteVariable = deleteScopedVariable;
export const getVariablesByScope = getScopedVariables;

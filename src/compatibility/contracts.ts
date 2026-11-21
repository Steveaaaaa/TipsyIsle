import type { AssembledPromptResult, ChatMessageNode, NormalizedCharacterCard, NormalizedLorebook, VariableScopeLevel } from '../types';

export interface CardScript { id: string; name: string; version?: string; info: string; content: string; enabled: boolean; data: Record<string, unknown>; buttons: Array<{ name: string; visible?: boolean }> }
export interface CompatibilityLoadReport {
    type: 'extension' | 'script'; id: string; name: string; version?: string;
    state: 'ready' | 'failed' | 'removed'; stage: 'load' | 'runtime';
    code?: 'DEPENDENCY_MISSING' | 'UNSUPPORTED_MODULE' | 'CATALOG_ERROR' | 'LOAD_ERROR' | 'TIMEOUT' | 'RUNTIME_ERROR';
}
export interface CompatibilityScriptButton { id: string; name: string }
export interface HelperVariableOption { type?: string; message_id?: number | 'latest'; script_id?: string; extension_id?: string }
export interface WorldbookBindingsSnapshot { names: string[]; global: string[]; chat: string | null; characters: Array<{ id: string; name: string; avatar: string; books: { primary: string | null; additional: string[] } }> }
export interface CompatSnapshot {
    branchEpoch?: number;
    routeId: string;
    routeReplacing: boolean;
    chatMetadata?: Record<string, unknown>;
    session: string;
    revision: number;
    character: Pick<NormalizedCharacterCard, 'id' | 'name'>;
    userName: string;
    generating: boolean;
    nativeMessageMenu?: Array<{ role?: ChatMessageNode['role']; latestOnly?: boolean }>;
    modelSettings: { source: string; model: string; stream: boolean; maxContext: number; maxResponse: number };
    mvuExtraAnalysisActive: boolean;
    helperRenderDepth: number;
    mvuSettings: { updateChat: boolean; sendasAssistant: boolean; notifyLoading: boolean; notifyInitialized: boolean; notifyError: boolean };
    extensions: import('./extensions').ExtensionCatalog;
    assembledMessages: import('../types').AssembledChatMessage[];
    messages: Array<ChatMessageNode & { routeCount?: number; formatted: string; templatePending?: boolean; streamStatus?: string; streamPreview?: import('../pipeline/streaming-message').MessageStreamPreview; componentTargets?: Array<{ key: string; selector: string }>; variables: Record<string, unknown> }>;
    scopes: Record<VariableScopeLevel, Record<string, unknown>>;
    worldbooks: NormalizedLorebook[];
    worldbookBindings: WorldbookBindingsSnapshot;
    worldinfoSettings: import('./worldbook-host').ReturnWorldinfoSettings;
    scriptVariables: Record<string, Record<string, unknown>>;
    extensionVariables: Record<string, Record<string, unknown>>;
    regexCatalog: import('./regex-host').ReturnRegexCatalog;
    assetCatalog: import('./asset-host').AssetCatalog;
    scriptTrees: import('./script-trees').ScriptTrees;
    personas: import('../types').UserPersona[];
    activePersonaId: string | null;
    proxyPresetNames: string[];
}
export interface CompatSnapshotDelta {
    branchEpoch?: number;
    routeId: string;
    routeReplacing: boolean;
    chatMetadata?: Record<string, unknown> | null;
    session: string;
    revision: number;
    character: CompatSnapshot['character'];
    userName: string;
    generating: boolean;
    nativeMessageMenu?: CompatSnapshot['nativeMessageMenu'];
    modelSettings: CompatSnapshot['modelSettings'];
    mvuExtraAnalysisActive: boolean;
    helperRenderDepth: number;
    mvuSettings: CompatSnapshot['mvuSettings'];
    extensions?: CompatSnapshot['extensions'];
    assembledMessages?: CompatSnapshot['assembledMessages'];
    order: string[];
    messages: CompatSnapshot['messages'];
    scopes?: Partial<CompatSnapshot['scopes']>;
    worldbooks?: CompatSnapshot['worldbooks'];
    worldbookBindings?: WorldbookBindingsSnapshot;
    worldinfoSettings?: CompatSnapshot['worldinfoSettings'];
    scriptVariables?: CompatSnapshot['scriptVariables'];
    extensionVariables?: CompatSnapshot['extensionVariables'];
    regexCatalog?: CompatSnapshot['regexCatalog'];
    assetCatalog?: Partial<CompatSnapshot['assetCatalog']>;
    scriptTrees?: CompatSnapshot['scriptTrees'];
    personas?: CompatSnapshot['personas'];
    activePersonaId: string | null;
    proxyPresetNames: string[];
}
export interface RuntimeDiagnostic { scriptId: string; name: string; message: string; level: 'error' | 'warning' }
export interface PromptInjection { id: string; role: 'system' | 'user' | 'assistant'; content: string; position?: 'in_chat' | 'none' | 'in_prompt' | 'before_prompt'; depth?: number; should_scan?: boolean }
export const placeholderPromptDefaultOrder = ['world_info_before', 'persona_description', 'char_description', 'char_personality', 'scenario', 'world_info_after', 'dialogue_examples', 'chat_history', 'user_input'] as const;
export type HelperPlaceholder = typeof placeholderPromptDefaultOrder[number];
export type HelperImage = Blob | string | Array<Blob | string>;
export interface HelperRolePrompt { role: 'system' | 'user' | 'assistant'; content: string; image?: HelperImage }
export interface HelperGenerationConfig {
    generation_id?: string;
    preset_name?: string;
    user_input?: string;
    image?: HelperImage;
    tools?: Array<{ type: 'function'; function: { name: string; description?: string; parameters?: Record<string, unknown> } }>;
    tool_choice?: 'auto' | 'required' | 'none' | 'any' | { type: 'function'; function: { name: string } };
    should_stream?: boolean;
    should_silence?: boolean;
    should_return_reasoning?: boolean;
    max_chat_history?: number | 'all';
    overrides?: Partial<Record<Exclude<HelperPlaceholder, 'chat_history' | 'user_input'>, string>> & {
        chat_history?: { prompts?: HelperRolePrompt[]; with_depth_entries?: boolean; author_note?: string };
    };
    injects?: Array<Omit<PromptInjection, 'id'> & { filter?: () => boolean | Promise<boolean> }>;
    ordered_prompts?: Array<HelperPlaceholder | HelperRolePrompt>;
    custom_api?: { apiurl?: string; key?: string; model?: string; source?: string; proxy_preset?: string;
        max_tokens?: number | 'same_as_preset' | 'unset'; temperature?: number | 'same_as_preset' | 'unset';
        frequency_penalty?: number | 'same_as_preset' | 'unset'; presence_penalty?: number | 'same_as_preset' | 'unset';
        top_p?: number | 'same_as_preset' | 'unset'; top_k?: number | 'same_as_preset' | 'unset';
        custom_include_body?: Record<string, unknown>; custom_exclude_body?: string[]; custom_include_headers?: Record<string, string> };
    json_schema?: { name: string; value: Record<string, unknown>; description?: string; strict?: boolean };
}
export interface VariableWrite { variables: Record<string, unknown>; option: HelperVariableOption }
export interface InterceptedHistoryMessage { messageId?: string; role: ChatMessageNode['role']; content: string; speakerName: string }
export interface RuntimeResult { pipe?: string; variables?: Record<string, unknown>; messageContent?: string; writes?: VariableWrite[]; injections?: PromptInjection[]; generationAborted?: boolean; interceptedHistory?: InterceptedHistoryMessage[]; illustrationPath?: string; diagnostics?: RuntimeDiagnostic[]; assembled?: AssembledPromptResult;
    generationConfig?: HelperGenerationConfig; generationResult?: string | Partial<import('../core/platform-bridge').CompletionResult> & { content: string } }
export interface CompatibilityHost {
    session(): string;
    snapshot(): CompatSnapshot;
    scripts(): CardScript[];
    request(method: string, params: Record<string, any>): unknown | Promise<unknown>;
    diagnostic(diagnostic: RuntimeDiagnostic): void;
}

/** Script folders and the two historical helper extension spellings are accepted. */
export function readCardScripts(card: NormalizedCharacterCard): CardScript[] {
    const extension = (card.extensions?.tavern_helper ?? card.extensions?.TavernHelper) as Record<string, unknown> | undefined;
    const result: CardScript[] = [];
    const visit = (items: unknown, parentEnabled = true) => {
        if (!Array.isArray(items)) return;
        for (const item of items) {
            if (!item || typeof item !== 'object') continue;
            const enabled = parentEnabled && item.enabled !== false;
            if (Array.isArray(item.scripts)) visit(item.scripts, enabled);
            else if (typeof item.content === 'string') result.push({ id: String(item.id ?? result.length), name: String(item.name ?? '未命名脚本'), info: String(item.info ?? ''), content: item.content, enabled,
                data: item.data && typeof item.data === 'object' && !Array.isArray(item.data) ? structuredClone(item.data) : {},
                buttons: item.button?.enabled !== false && Array.isArray(item.button?.buttons) ? item.button.buttons : [] });
        }
    };
    visit(extension?.scripts);
    return result;
}

export type LayoutMode = 'tipsy-bubble' | 'novel-reader' | 'adv-galgame' | 'im-messenger';

export type PortraitPlacement =
    | 'left'
    | 'right'
    | 'backdrop'
    | 'hidden'
    | 'left-bubble'
    | 'right-standing'
    | 'stage-backdrop';

export type VariableScopeLevel = 'global' | 'preset' | 'character' | 'chat' | 'message';

export interface VariableScopeContext {
    type?: VariableScopeLevel | string;
    presetId?: string;
    characterId?: string;
    chatId?: string;
    messageId?: string;
    floor?: number;
}

export type ScopedVariableQuery = VariableScopeContext;

export interface ThemeDesignTokens {
    accentColor: string;
    bgPrimary: string;
    bgSurface: string;
    bgElevated?: string;
    bgGlass?: string;
    textPrimary: string;
    textMuted: string;
    textSecondary?: string;
    borderColor?: string;
    userBubbleBg?: string;
    assistantBubbleBg?: string;
    wallpaperUrl: string;
    backdropBlurPx: number;
    cardOpacity: number;
    borderRadiusPx: number;
    bubbleRadiusPx?: number;
    fontFamilyBody: string;
    fontFamilySerif?: string;
    fontFamilyMono: string;
    fontSizePx: number;
    fontSizeBasePx?: number;
    lineHeight: number;
    lineHeightBase?: number;
    chatMaxWidthPx: number;
    stageMaxWidthPx?: number;
    portraitPlacement: PortraitPlacement;
}

export interface ThemePresetPackage {
    id: string;
    name: string;
    author: string;
    description: string;
    layoutMode: LayoutMode;
    portraitPlacement?: PortraitPlacement;
    tokens: ThemeDesignTokens;
    scopedCustomCss: string;
    customCss?: string;
    customBubbleHtmlTemplate?: string;
}

export type RegexPlacementStage =
    | 'input'
    | 'output'
    | 'prompt'
    | 'render'
    | 'user_input'
    | 'ai_output'
    | 'slash_command'
    | 'world_info'
    | 'reasoning';

export interface RegexScriptRule {
    rawData?: Record<string, unknown>;
    id: string;
    scriptName: string;
    findRegex: string;
    replaceString: string;
    placement: RegexPlacementStage[];
    disabled?: boolean;
    markdownOnly?: boolean;
    promptOnly?: boolean;
    minDepth?: number | null;
    maxDepth?: number | null;
    trimStrings?: string[];
    runOnEdit?: boolean;
    substituteRegex?: boolean | number;
}

export type NormalizedRegexScript = RegexScriptRule;

export type SelectiveLogicMode = 'AND_ANY' | 'AND_ALL' | 'NOT_ANY' | 'NOT_ALL' | number;

export type LorebookInsertPosition =
    | 'before_char'
    | 'after_char'
    | 'an_top'
    | 'an_bottom'
    | 'at_depth'
    | 'before_example'
    | 'after_example'
    | 'before_an'
    | 'after_an'
    | 'outlet';

export interface LorebookEntry {
    hash?: number;
    rawData?: Record<string, unknown>;
    entry?: LorebookEntry;
    reason?: string;
    matchedKeys?: string[];
    estimatedTokens?: number;
    uid: string | number;
    world?: string;
    comment: string;
    key?: string[];
    keys: string[];
    keysecondary?: string[];
    secondaryKeys: string[];
    selectiveLogic: SelectiveLogicMode;
    selective?: boolean;
    scanDepth?: number;
    ignoreBudget?: boolean;
    automationId?: string;
    vectorized?: boolean;
    triggers?: string[];
    characterFilter?: { isExclude: boolean; names: string[]; tags: string[] };
    matchPersonaDescription?: boolean;
    matchCharacterDescription?: boolean;
    matchCharacterPersonality?: boolean;
    matchCharacterDepthPrompt?: boolean;
    matchScenario?: boolean;
    matchCreatorNotes?: boolean;
    content: string;
    constant: boolean;
    enabled?: boolean;
    disabled?: boolean;
    caseSensitive?: boolean;
    matchWholeWords?: boolean;
    position: LorebookInsertPosition;
    outletName?: string;
    role?: 'system' | 'user' | 'assistant';
    depth: number;
    order: number;
    sticky: number;
    cooldown: number;
    delay: number;
    probability?: number;
    useProbability?: boolean;
    group?: string;
    groupOverride?: boolean;
    groupWeight?: number;
    useGroupScoring?: boolean;
    excludeRecursion?: boolean;
    preventRecursion?: boolean;
    delayUntilRecursion?: number;
}

export type NormalizedLorebookEntry = LorebookEntry;

export interface LorebookActivationHit {
    world?: string;
    uid: string | number;
    comment: string;
    matchedKeys: string[];
    recursionLevel: number;
    reason: 'constant' | 'sticky' | 'primary' | 'recursive' | 'keyword' | 'recursion';
}

export interface NormalizedLorebook {
    rawData?: Record<string, unknown>;
    id: string;
    name: string;
    scanDepth?: number;
    tokenBudget?: number;
    recursiveScanning?: boolean;
    maxRecursionSteps?: number;
    entries: NormalizedLorebookEntry[];
}

export interface LorebookTimedState {
    stickyUntilFloor: number;
    cooldownUntilFloor: number;
    effects?: Partial<Record<'sticky' | 'cooldown' | 'delay', { start: number; end: number; protected: boolean; hash: number }>>;
}

export interface NormalizedCharacterCard {
    specVersion?: string;
    id: string;
    name: string;
    creator?: string;
    characterVersion: string;
    avatar: string;
    description: string;
    personality: string;
    scenario: string;
    firstMessage: string;
    alternateGreetings: string[];
    mesExample: string;
    systemPrompt: string;
    postHistoryInstructions: string;
    creatorNotes: string;
    tags: string[];
    characterBook?: NormalizedLorebook | null;
    embeddedLorebook?: NormalizedLorebook | null;
    primaryWorldbook?: NormalizedLorebook | string | null;
    additionalWorldbooks?: string[];
    regexScripts: RegexScriptRule[];
    extensions?: Record<string, unknown>;
    rawData?: Record<string, unknown>;
    depthPrompt?: { prompt: string; depth: number; role: 'system' | 'user' | 'assistant' };
}

export interface PresetPromptSlot {
    identifier: string;
    name: string;
    role: 'system' | 'user' | 'assistant';
    content: string;
    enabled: boolean;
    marker?: boolean;
    systemPrompt?: boolean;
    forbidOverrides?: boolean;
    injectionPosition?: 'relative' | 'in_chat' | number;
    injectionDepth?: number;
    injectionOrder?: number;
    depthOrder?: number;
}

export type NormalizedPresetPromptSlot = PresetPromptSlot;

export interface UserPersona {
    avatar_id: string; avatar: string; image: string; name: string; title: string; description: string;
    /** Profiles saved in personal settings supplement the story's established protagonist. */
    description_mode?: 'supplement';
    position: number; depth: number; role: number; lorebook: string;
    connections: Array<{ type: 'character' | 'group'; id: string }>; is_default: boolean;
}

export interface NormalizedPreset {
    rawData?: Record<string, unknown>;
    id: string;
    name: string;
    apiId?: string;
    temperature?: number;
    topP?: number;
    topK?: number;
    minP?: number;
    repetitionPenalty?: number;
    frequencyPenalty?: number;
    presencePenalty?: number;
    maxContextTokens?: number;
    maxResponseTokens?: number;
    parameters?: Record<string, unknown>;
    prompts?: PresetPromptSlot[];
    promptSlots?: PresetPromptSlot[];
    regexScripts?: RegexScriptRule[];
}

export interface ChatSwipeItem {
    id?: number;
    content: string;
    reasoning?: string;
    sendDate?: string;
    extra?: Record<string, unknown>;
}

export interface ChatMessageNode {
    id: string;
    messageId?: string;
    parentId: string | null;
    /** The exact parent reply this continuation follows. */
    parentSwipeId?: string;
    swipeIds?: string[];
    branchOrigin?: string;
    branchLabel?: string;
    storySummaries?: Record<string, import('./pipeline/story-summary').StorySummary>;
    branchBases?: Record<string, import('./store/branch-state').BranchState>;
    branchStates?: Record<string, import('./store/branch-state').BranchState>;
    nativePluginReplies?: import('./plugins/native/storage').SwipePluginBuckets;
    nativePluginOpeningRoutes?: import('./plugins/native/storage').SwipePluginBuckets;
    /** Stable IDs preserved when a route root is replaced or a historical edit forks. */
    nativeRouteAnchors?: Record<string, string>;
    floor: number;
    role: 'system' | 'user' | 'assistant';
    speakerName: string;
    isHidden?: boolean;
    content: string;
    swipes: Array<string | ChatSwipeItem>;
    activeSwipeIndex: number;
    createdAt?: number;
    updatedAt?: number;
    sendDate?: string;
    tokenCount?: number;
    reasoning?: string;
    extra?: Record<string, unknown>;
}

export interface AssembledChatMessage {
    name?: string;
    images?: string[];
    estimatedTokens?: number;
    role: 'system' | 'user' | 'assistant';
    content: string;
    sourceId: string;
    sourceLabel: string;
    tokens: number;
}

export type AssembledPromptMessage = AssembledChatMessage;

export interface AssembledPromptResult {
    generationSettings?: { model: string; stream: boolean; parameters: Record<string, unknown> };
    /** Opaque resident-author-state lease; never persisted with a chat. */
    templateTransactionId?: string;
    messages: AssembledChatMessage[];
    templateContent?: string;
    templateMessageContent?: string;
    templateInjections?: import('./pipeline/template-injections').TemplatePromptInjection[];
    templateActivations?: Array<{ world: string; uid: string | number; force: boolean }>;
    compatibilityWarnings?: string[];
    activatedLorebookEntries: LorebookEntry[];
    nextTimedStates: Record<string, LorebookTimedState>;
    finalVariables: Record<string, unknown>;
    variableChanges: Record<string, unknown>;
    globalVariableChanges: Record<string, unknown>;
    messageVariableChanges?: Record<string, Record<string, unknown>>;
    messageSwipeVariableChanges?: Record<string, Record<string, Record<string, unknown>>>;
    messageVariableInitializationChanges?: Record<string, number[]>;
    tokenUsage: {
        system: number;
        lorebook: number;
        history: number;
        total: number;
        budgetRemaining: number;
        budget?: number;
        character?: number;
    };
    droppedHistoryCount: number;
}

export interface SandboxRpcRequest {
    jsonrpc: '2.0';
    id: string;
    frameId?: string;
    method: string;
    params?: Record<string, unknown>;
}

export interface SandboxRpcResponse {
    jsonrpc: '2.0';
    id: string;
    frameId?: string;
    result?: unknown;
    error?: {
        code: number;
        message: string;
    };
}

export type PipelineHookName =
    | 'beforeUserSend'
    | 'beforePromptAssemble'
    | 'afterPromptAssemble'
    | 'afterMessageReceive'
    | 'beforeMessageRender';

export type UiSlotName =
    | 'topbar.actions'
    | 'sidebar.footer'
    | 'shell.sidebar.footer'
    | 'composer.toolbar'
    | 'chat.header.actions'
    | 'chat.input.toolbar'
    | 'inspector.extra'
    | 'inspector.tab'
    | 'message.footer'
    | 'message.actions';

export type TavernEventName =
    | 'message_sent'
    | 'message_received'
    | 'message_edited'
    | 'message_deleted'
    | 'message_swiped'
    | 'character_changed'
    | 'chat_changed'
    | 'variables_changed'
    | 'generation_started'
    | 'generation_stream_token'
    | 'generation_ended';

export interface SchemaValidationRule {
    min?: number;
    max?: number;
    step?: number;
    pattern?: string;
    required?: boolean;
}

export interface SchemaFieldDescriptor<T = any> {
    id: string;
    key?: string;
    title: string;
    label?: string;
    section?: string;
    group: string;
    type: 'string' | 'secret' | 'text' | 'password' | 'number' | 'slider' | 'boolean' | 'select' | 'textarea';
    defaultValue: T;
    description?: string;
    placeholder?: string;
    mobileWeight?: 'essential' | 'standard' | 'primary' | 'secondary' | 'advanced' | number;
    min?: number;
    max?: number;
    step?: number;
    validation?: SchemaValidationRule;
    options?: Array<{ label: string; value: string }>;
}





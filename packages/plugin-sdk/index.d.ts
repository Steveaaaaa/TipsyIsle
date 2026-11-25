import type { CharacterVisualEntry, ImageProviderKind, ImageCapability, ImageModelRequest, JobContext, JobScheduleInput, ReplyCheckpoint, MediaAction, StoryParticipant } from './director.js';
export * from './director.js';
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonMap = Record<string, Json>;
export type Immutable<T, Depth extends 0[] = []> = Depth['length'] extends 6 ? T
    : T extends object ? { readonly [K in keyof T]: Immutable<T[K], [...Depth, 0]> } : T;
export type Permission = 'story.read' | 'story.events' | 'storage.device' | 'storage.route' | 'storage.reply'
    | 'ui.panel' | 'composer.draft' | 'generation.contribute' | 'resources.read'
    | 'story.history' | 'story.variables' | 'story.edit' | 'story.navigate' | 'assets.read' | 'assets.write'
    | 'generation.pipeline' | 'generation.tools' | 'models.use' | 'network.request' | 'media.manage'
    | 'index.manage' | 'services.provide' | 'services.call' | 'ui.surface' | 'ui.stage' | 'ui.export' | 'jobs.run';
export type StoryEvent = 'story.replySaved' | 'story.routeChanged' | 'story.changed' | 'story.replyCheckpoint';
export type PluginErrorCode = 'PERMISSION_DENIED' | 'STALE_ROUTE' | 'STALE_REPLY' | 'STORY_BUSY' | 'PLUGIN_INACTIVE'
    | 'STORAGE_CONFLICT' | 'INVALID_ARGUMENT' | 'QUOTA_EXCEEDED' | 'HOST_ERROR' | 'NOT_FOUND' | 'VERSION_CONFLICT'
    | 'UNAVAILABLE' | 'CANCELLED' | 'TIMEOUT' | 'NETWORK_ERROR' | 'SERVICE_VERSION' | 'EXPIRED';
export interface PluginApiError extends Error { readonly name: 'PluginApiError'; readonly code: PluginErrorCode }
export type StorageScope = 'device' | 'route' | 'reply';
export type MessageRole = 'assistant' | 'user' | 'system';
export type SettingValue = string | number | boolean;
export type Settings = Record<string, SettingValue>;
export interface SettingField {
    id: string; label: string; description?: string; type: 'text' | 'number' | 'boolean' | 'select'; default: SettingValue;
    min?: number; max?: number; options?: { value: string; label: string }[];
}
export interface CommandDeclaration {
    id: string; label: string; location: 'composer' | 'message' | 'workspace'; role?: MessageRole; latestOnly?: boolean;
    surface?: 'dialog' | 'sidebar' | 'fullscreen';
}
export interface PluginManifest {
    $schema?: string;
    manifestVersion: 1; id: string; name: string; publisher: string; description?: string;
    version: string; hostApi: string; storageVersion: number; permissions: Permission[];
    entrypoints: { main: string; migrate?: string }; resources?: string[];
    commands?: CommandDeclaration[]; events?: StoryEvent[]; generation?: boolean; settings?: SettingField[];
    pipeline?: ('beforeScan' | 'afterScan')[];
    macros?: string[];
    tools?: ToolDeclaration[];
    provides?: ServiceDeclaration[];
    consumes?: { id: string; range: string }[];
    /** Exact HTTP(S) origins. The user approves destinations independently of model connections. */
    origins?: string[];
}

/** An opaque reference to a version of a candidate in this chat. */
export interface MessageRef { messageId: string; swipeId: string; revision: string }
/** Legacy open-view reference. Use api.context.route for a persistent address. */
export interface StoryRef { chatId: string; routeId: string; revision: string; head: MessageRef | null }
export interface StoryMessage {
    ref: MessageRef; floor: number; role: MessageRole; speaker: string; text: string; truncated: boolean;
    summary?: string; createdAt: number; hidden: boolean; settled: boolean;
}
export interface StoryPage { messages: StoryMessage[]; nextBefore: number | null }
export interface StorageView { values: JsonMap; version: number }
export interface StoragePatch {
    set?: JsonMap; remove?: string[];
    /** Reuse an ID to retry a recent patch safely. Otherwise the host supplies one for this invocation. */
    operationId?: string;
}
export interface StoryStorageTarget { route: RouteAddress; reply?: MessageRef }

export type PanelBlock = { type: 'text'; text: string } | { type: 'list'; items: string[] };
export type SurfaceBlock = PanelBlock | { type: 'table'; columns: string[]; rows: string[][] }
    | { type: 'media'; id: string; label: string };
export type PanelField = {
    id: string; label: string; type: 'text' | 'textarea' | 'checkbox' | 'select';
    initial?: string | boolean; required?: boolean; options?: { value: string; label: string }[];
};
export interface Panel {
    title: string; blocks?: SurfaceBlock[]; fields?: PanelField[];
    actions?: { id: string; label: string; kind?: 'primary' | 'secondary' }[];
    /** Passed back on the next action in this panel, never persisted by the host. */
    state?: Json;
    /** HTML and CSS from the signed package. Interact through forms and data-action buttons. */
    layout?: { html: string; css?: string };
    task?: { id: string; onFinished?: string };
}
export interface CommandInput {
    id: string; target?: MessageRef; action?: { id: string; values: Record<string, string | boolean>; state?: Json };
}
/** Emitted for the active candidate after a successful local turn is saved. */
export interface ReplySaved { id: string; reply: MessageRef; kind: 'normal' | 'regenerate' }
/** Emitted on an active route change after startup, including opening a saved chat. This is read-only. */
export interface RouteChanged { id: string; previous: StoryRef | null; current: StoryRef }
export interface GenerationInput { id: string; kind: 'normal' | 'regenerate'; maxTokens: number }
export interface PromptContribution { text: string }

export interface RouteAddress { chatId: string; routeId: string }
export interface RouteInfo extends RouteAddress {
    head: MessageRef; depth: number; label: string; active: boolean; checkpoint: boolean;
}
export interface RouteVersion extends RouteInfo { revision: string }
export interface ChatInfo { id: string; characterId: string; messageCount: number; label?: string }
export interface StoryTreeRow { reply: MessageRef; parent: MessageRef | null; floor: number; role: MessageRole; label: string; routes: string[] }
export interface Page<T> { items: T[]; next: string | null }
export interface RouteQuery { route: RouteAddress; revision?: string; cursor?: string; limit?: number }
export interface StoryStateQuery extends Pick<RouteQuery, 'route' | 'revision'> {
    at?: MessageRef; scope: 'chat' | 'message' | 'runtime'; path?: (string | number)[];
}
export interface StoryStateValue { version: RouteVersion; at: MessageRef; value: Json }
export interface StoryChange {
    id: string; at: number; origin: 'local' | 'sync'; kind: 'story.changed' | 'story.replySaved' | 'assets.changed';
    chatId?: string; route?: RouteAddress; reply?: MessageRef; generation?: 'normal' | 'regenerate'; deleted?: boolean;
}
export interface ChangePage { items: StoryChange[]; cursor: string; more: boolean; reset: boolean }
export interface JsonEdit { op: 'set' | 'remove'; path: (string | number)[]; value?: Json }
export type StoryEdit = { type: 'fork'; at: MessageRef; label?: string }
    | { type: 'message'; target: MessageRef; text: string }
    | { type: 'variables'; scope: 'chat' | 'message' | 'mvu'; edits: JsonEdit[]; target?: MessageRef }
    | { type: 'append'; role: MessageRole; text: string };
export interface StoryEditRequest { route: RouteAddress; expectedRevision: string; operationId: string; edits: StoryEdit[] }
export interface AssetRef { kind: 'character' | 'worldbook' | 'preset'; id: string; revision: string }
export interface AssetInfo extends AssetRef { name: string }
export interface AssetDocument extends AssetInfo { document: Json }
export interface WorldbookEntryRecord { uid: string | number; label: string; enabled: boolean; content: string; keys: string[]; document: JsonMap | null }
export type AssetEdit = { type: 'patch'; asset: AssetRef; edits: JsonEdit[] }
    | { type: 'entry.put'; asset: AssetRef; uid: string | number; document: JsonMap }
    | { type: 'entry.remove'; asset: AssetRef; uid: string | number };
export interface AssetEditRequest { operationId: string; edits: AssetEdit[] }
export interface EditPreview { token: string; changes: { target: string; before: string; after: string }[]; forks?: boolean }
export interface EditReceipt { operationId: string; undo: string; route?: RouteVersion; assets?: AssetInfo[] }

export interface PromptInjection {
    text: string; role?: MessageRole; position?: 'beforePrompt' | 'afterHistory' | 'atDepth' | 'scanOnly'; depth?: number; scan?: boolean;
}
export interface WorldActivation { book: string; uid: string | number; label: string; reason?: string; matchedKeys: string[] }
export type HistoryEdit = { type: 'omit'; from: MessageRef; through?: MessageRef }
    | { type: 'replace'; from: MessageRef; through?: MessageRef; text: string; role?: MessageRole };
export interface PromptStageInput extends GenerationInput {
    stage: 'beforeScan' | 'afterScan'; route: RouteAddress; history: { first: MessageRef | null; last: MessageRef | null; count: number };
    activations?: WorldActivation[]; activationCount?: number;
}
export interface BeforeScanResult { injections?: PromptInjection[]; macros?: Record<string, string> }
export interface AfterScanResult { history?: HistoryEdit[]; injections?: Omit<PromptInjection, 'scan'>[] }
export interface ToolDeclaration { id: string; description: string; parameters: JsonMap }
export interface ToolInput { id: string; args: JsonMap; generationId: string }
export interface ServiceDeclaration { id: string; version: string; methods: string[] }
export interface ServiceInfo extends ServiceDeclaration { plugin: string }
export interface ServiceInput { id: string; method: string; args: Json; caller: string }
/** Share only the outputs this caller should be able to read (and cancel, for tasks). */
export interface ServiceOutput { value: Json; tasks?: string[]; media?: string[] }

export type ModelKind = 'chat' | 'image' | 'speech' | 'embedding';
export interface ModelConnection { id: string; label: string; model: string; kinds: ModelKind[]; providerKind?: ImageProviderKind | 'chat' | 'embedding' | 'speech'; imageCapabilities?: ImageCapability[]; workflowProfiles?: { id: string; label: string; slots: string[] }[] }
export type ModelRequest = { connection: string } & (
    { kind: 'chat'; messages: { role: MessageRole; content: string }[]; maxTokens?: number; temperature?: number; stream?: boolean; schema?: JsonMap; cacheKey?: string }
    | ImageModelRequest
    | { kind: 'speech'; text: string; voice: string }
    | { kind: 'embedding'; texts: string[] });
export interface MediaHandle { id: string; mime: string; size: number; name: string }
export type TaskResult = { kind: 'chat'; text: string; reasoning: string } | { kind: 'image' | 'speech' | 'download'; media: MediaHandle; seed?: number }
    | { kind: 'embedding'; count: number; dimensions: number; vectors?: number[][] };
export interface TaskView { id: string; state: 'queued' | 'running' | 'done' | 'cancelled' | 'failed'; cursor: number; delta: string; reasoning: string;
    progress?: number; result?: TaskResult; error?: { code: PluginErrorCode; message: string } }
export interface IndexDocument { id: string; text: string; value?: Json; vector?: number[] }
export interface IndexHit { id: string; excerpt: string; score: number; value?: Json }
export interface OutboundRequest { url: string; method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; headers?: Record<string, string>; body?: Json }
export interface OutboundResponse { status: number; contentType: string; text: string }
export interface HostCapabilities {
    api: string; platform: 'web' | 'android' | 'desktop'; transport: 'browser' | 'gateway' | 'native';
    permissions: Permission[]; features: string[];
}

export interface PluginApi {
    readonly hostApi: string;
    readonly context: Immutable<{ story: StoryRef | null; target?: MessageRef; route: RouteAddress | null }>;
    readonly settings: Immutable<Settings>;
    readonly story: {
        participants(): Promise<Immutable<StoryParticipant[]>>;
        visualSources(): Promise<Immutable<{ characterId: string; layoutMode: 'tipsy-bubble' | 'novel-reader' | 'adv-galgame' | 'im-messenger'; people: string[]; profiles: Record<string, string>; gallery: string[]; characters?: CharacterVisualEntry[] }>>;
        /** Newest page by default, ordered oldest first within a page. Use nextBefore on this snapshot to page further. */
        readMessages(options?: { before?: number; limit?: number }): Promise<Immutable<StoryPage>>;
        getMessage(ref: MessageRef): Promise<Immutable<StoryMessage> | null>;
        listChats(options?: { characterId?: string; cursor?: string; limit?: number }): Promise<Immutable<Page<ChatInfo>>>;
        listRoutes(options: { chatId: string; cursor?: string; limit?: number }): Promise<Immutable<Page<RouteInfo>>>;
        tree(options: { chatId: string; cursor?: string; limit?: number }): Promise<Immutable<Page<StoryTreeRow>>>;
        version(route: RouteAddress): Promise<Immutable<RouteVersion>>;
        readPage(options: RouteQuery): Promise<Immutable<Page<StoryMessage> & { version: RouteVersion }>>;
        readText(options: { route: RouteAddress; target: MessageRef; offset?: number; length?: number }): Promise<Immutable<{ text: string; next: number | null }>>;
        search(options: RouteQuery & { query: string }): Promise<Immutable<Page<StoryMessage> & { version: RouteVersion }>>;
        state(options: StoryStateQuery): Promise<Immutable<StoryStateValue>>;
        /** Device-local cursor. reset means rebuild from snapshots; sync never emits replySaved. */
        changes(options?: { cursor?: string; limit?: number }): Promise<Immutable<ChangePage>>;
        preview(request: StoryEditRequest): Promise<Immutable<EditPreview>>;
        /** Commit and undo require the exact previously seen version. Idempotency is scoped to the plugin. */
        commit(token: string): Promise<Immutable<EditReceipt>>;
        undo(token: string): Promise<Immutable<EditReceipt>>;
        open(route: RouteAddress): Promise<void>;
    };
    readonly storage: {
        read(scope: StorageScope): Promise<Immutable<StorageView>>;
        /** Route writes refer to the active head. Reply writes refer to the target candidate.
         * Writes are staged and become durable together after the handler succeeds. */
        patch(scope: StorageScope, patch: StoragePatch): Promise<void>;
        readAt(target: StoryStorageTarget): Promise<Immutable<StorageView>>;
        patchAt(input: StoryStorageTarget & { expectedVersion: number; patch: StoragePatch }): Promise<Immutable<StorageView>>;
    };
    readonly ui: {
        export(input: { title: string; pages: { text: string; mediaId?: string }[] } | {title:string;route:RouteAddress}): Promise<void>;
        /** Replaces the input draft; never sends it. Available from a user command. */
        replaceDraft(text: string): Promise<void>;
    };
    readonly resources: { readText(path: string): Promise<string> };
    readonly assets: {
        list(options: { kind: AssetRef['kind']; cursor?: string; limit?: number }): Promise<Immutable<Page<AssetInfo>>>;
        get(options: { kind: AssetRef['kind']; id: string; path?: (string | number)[] }): Promise<Immutable<AssetDocument>>;
        entries(options: { id: string; revision?: string; cursor?: string; limit?: number }): Promise<Immutable<Page<WorldbookEntryRecord>>>;
        entry(options: { id: string; uid: string | number; revision?: string; path?: (string | number)[] }): Promise<Immutable<Json>>;
        preview(request: AssetEditRequest): Promise<Immutable<EditPreview>>;
        commit(token: string): Promise<Immutable<EditReceipt>>;
        undo(token: string): Promise<Immutable<EditReceipt>>;
    };
    readonly host: { capabilities(): Promise<Immutable<HostCapabilities>> };
    readonly models: { connections(): Promise<Immutable<ModelConnection[]>>; start(input: ModelRequest): Promise<string> };
    readonly tasks: {
        await(id: string): Promise<Immutable<TaskView>>;
        read(options: { id: string; after?: number; waitMs?: number }): Promise<Immutable<TaskView>>;
        /** Read a finished embedding task in input order, including when vectors do not fit in TaskView. */
        embeddings(options: { id: string; offset?: number; limit?: number }): Promise<Immutable<{ vectors: number[][]; next: number | null }>>;
        cancel(id: string): Promise<void>;
    };
    readonly network: { request(input: OutboundRequest): Promise<Immutable<OutboundResponse>>; download(input: OutboundRequest & { name?: string }): Promise<string> };
    readonly media: {
        reclaim(): Promise<Immutable<{removed:number}>>;
        stats(): Promise<Immutable<{ bytes: number; items: number; totalLimit: number; maxItems: number }>>;
        list(options?: { cursor?: string; limit?: number }): Promise<Immutable<Page<MediaHandle>>>;
        put(input: { mime: string; name: string; base64: string }): Promise<Immutable<MediaHandle>>;
        remove(id: string): Promise<void>;
        read(input: { id: string; offset?: number; length?: number }): Promise<Immutable<{ base64: string; next: number | null }>>;
    };
    readonly index: {
        put(input: { collection: string; documents: IndexDocument[] }): Promise<void>;
        remove(input: { collection: string; ids: string[] }): Promise<void>;
        search(input: { collection: string; text?: string; vector?: number[]; limit?: number }): Promise<Immutable<IndexHit[]>>;
    };
    readonly services: {
        list(): Promise<Immutable<ServiceInfo[]>>;
        call(input: { id: string; method: string; args: Json }): Promise<Immutable<Json>>;
    };
    readonly log: (message: string) => Promise<void>;
    readonly jobs: { schedule(input: JobScheduleInput): Promise<string>; awaitReply(): Promise<Immutable<ReplySaved>> };
    readonly replyMedia: { developing(item: Pick<import('./director.js').ReplyMediaItem, 'slotId' | 'label' | 'aspectRatio' | 'anchor' | 'palette' | 'presentation'> & Partial<Pick<import('./director.js').ReplyMediaItem, 'status' | 'takes' | 'activeTake'>>): Promise<void> };
}
export type ReadonlyPluginApi = Pick<PluginApi, 'host' | 'hostApi' | 'context' | 'settings' | 'resources' | 'log'> & {
    readonly storage: Pick<PluginApi['storage'], 'read' | 'readAt'>;
    readonly story: Omit<PluginApi['story'], 'preview' | 'commit' | 'undo' | 'open'>;
    readonly assets: Pick<PluginApi['assets'], 'list' | 'get' | 'entries' | 'entry'>;
    readonly index: Pick<PluginApi['index'], 'search'>;
};
type Awaitable<T> = T | Promise<T>;
type EventPluginApi = Omit<PluginApi, 'ui' | 'story'> & { readonly story: Omit<PluginApi['story'], 'open'> };
export interface PluginDefinition {
    onJob?: (api: EventPluginApi, job: Immutable<JobContext>) => Awaitable<void>;
    onMediaAction?: (api: EventPluginApi, event: Immutable<MediaAction>) => Awaitable<void>;
    onReplyCheckpoint?: (api: EventPluginApi, event: Immutable<ReplyCheckpoint>) => Awaitable<void>;
    commands?: Record<string, (api: PluginApi, input: Immutable<CommandInput>) => Awaitable<Panel | void>>;
    onReplySaved?: (api: EventPluginApi, event: Immutable<ReplySaved>) => Awaitable<void>;
    onRouteChanged?: (api: ReadonlyPluginApi, event: Immutable<RouteChanged>) => Awaitable<void>;
    contribute?: (api: ReadonlyPluginApi, input: Immutable<GenerationInput>) => Awaitable<PromptContribution | void>;
    beforeScan?: (api: ReadonlyPluginApi, input: Immutable<PromptStageInput>) => Awaitable<BeforeScanResult | void>;
    afterScan?: (api: ReadonlyPluginApi, input: Immutable<PromptStageInput>) => Awaitable<AfterScanResult | void>;
    /** Notification only. Call story.changes with your stored cursor to catch up. */
    onStoryChange?: (api: EventPluginApi, input: Immutable<{ cursor: string }>) => Awaitable<void>;
    tools?: Record<string, (api: ReadonlyPluginApi, input: Immutable<ToolInput>) => Awaitable<Json>>;
    services?: Record<string, Record<string, (api: Omit<EventPluginApi, 'services'>, input: Immutable<ServiceInput>) => Awaitable<ServiceOutput>>>;
}
export interface MigrationInput {
    scope: StorageScope; fromVersion: number; toVersion: number; values: JsonMap;
    /** Present for a device migration. Obsolete fields can be renamed here. */
    settings?: Settings;
}
export interface MigrationResult { values: JsonMap; settings?: Settings }
export function definePlugin<T extends PluginDefinition>(definition: T): T;
export function defineMigration(migrate: (input: Immutable<MigrationInput>) => Awaitable<MigrationResult>): typeof migrate;
export function isPluginApiError(error: unknown): error is PluginApiError;

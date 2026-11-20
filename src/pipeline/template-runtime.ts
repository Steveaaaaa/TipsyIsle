import { filterMvuWorldbooks } from './mvu-worldbooks';
import { worldinfoHash } from './worldinfo-hash';
import ejs from 'ejs';
import _ from 'lodash';
import { parse as parseYaml } from 'yaml';
import { evaluateMacros, applyRegexScripts, orderedRegexScripts } from './macro-regex-engine';
import { parseWorldInfoDecorators, isInitialWorldInfo, isSpecialWorldInfo } from './worldinfo-decorators';
import { queryTemplateWorldInfo, sortTemplateWorldInfo, type TemplateWorldInfo, type WorldInfoQueryCondition } from './worldinfo-query';
import { toHelperWorldbook } from '../compatibility/worldbook-codec';
import { TemplateInjections } from './template-injections';
import * as z from 'zod';
import { estimateTokenCount, type AssemblePromptInput } from './prompt-assembler';
import type { ChatMessageNode, NormalizedCharacterCard, NormalizedLorebook, LorebookEntry, RegexPlacementStage } from '../types';
import { messageExtra } from '../compatibility/chat-message-codec';
import { mergeTemplateSchemas, templateObjectSchema } from './template-schema';
import { parseTemplateJSON, patchTemplateJSON } from './template-json';
import { annotateTemplateVariables } from './template-yaml';
import { normalizeTemplateFeatures, templateEntryEnabled, type TemplateFeatures } from './template-features';
import { formatTemplateMarkdown, protectTemplateBlocks, renderTemplateFrame } from './template-formatting';
import { TemplateRegexRegistry, type TemplateRegexSelection } from './template-regex';
import { compileAuthorTemplate } from './template-compiler';
import { TemplateSandbox } from './template-sandbox';
import { executeSlashPipeline } from '../sandbox/slash-core';
import { loadTemplateFaker } from './template-faker';
import { findExecutableQuickReply } from '../sandbox/quick-reply';
import type { SlashExecutionHost, SlashExecutionOptions } from '../sandbox/slash-core';
import { normalizeLorebook } from './normalizer';
import type { AssembledChatMessage } from '../types';
import type { LorebookScanEvent, LorebookScanOptions } from './lorebook-scanner';

export const hasTemplate = (text: string) => /<%[\s\S]*?%>/.test(text);
type CompiledTemplate = (this: unknown, data: Record<string, any>, sandbox?: TemplateSandbox) => string | Promise<string>;
const cache = new Map<string, CompiledTemplate>();
const safePath = (key: string) => !_.toPath(key).some((part: string) => ['__proto__', 'prototype', 'constructor'].includes(part));
const initialEntry = isInitialWorldInfo;
const rawOutput = (value: unknown) => value == null ? '' : String(value);
const markdownOutput = (value: unknown) => formatTemplateMarkdown(rawOutput(value));

interface TemplateInvocation {
    readonly ancestry: readonly string[];
    readonly conditions: readonly string[];
    readonly data: Record<string, any>;
    readonly environment: Record<string, any>;
    readonly worldInfo?: LorebookEntry;
}
export interface TemplateRuntimeHooks {
    prepare?(context: Record<string, any>): Promise<void>;
    execute?(command: string): Promise<string>;
    slashCommand?: SlashExecutionHost['command'];
    hasSlashCommand?: SlashExecutionHost['hasCommand'];
    hostMacros?(text: string): string;
    macroLikes?(text: string, context: { message_id?: number; role?: 'user' | 'assistant' | 'system' }): string;
    event?(name: string, ...args: any[]): Promise<void>;
    hasEvent?(name: string): boolean;
    takeWorldInfoActivations?(): any[];
    echo?(text: string): void;
    globals?: Record<string, any>;
    contextGlobals?(runtime: TemplateRuntime): Record<string, any>;
    defines?: Record<string, any>;
    initialVariables?: Record<string, any>;
    assertWritable?(): void;
    mutated?(): void;
    idle?(): void;
    fault?(error: Error): void;
}
function replaceObject(target: Record<string, any>, source: Record<string, any> = {}): void {
    for (const key of Object.keys(target)) delete target[key];
    Object.assign(target, source);
}

/** Transaction data plus resident author definitions. Previews construct a disposable instance. */
export class TemplateRuntime {
    countTokens = estimateTokenCount;
    readonly variables: Record<string, any> = {};
    readonly globals: Record<string, any> = {};
    readonly messageVariables: Record<string, Record<string, any>> = {};
    readonly variableChanges: Record<string, unknown> = {};
    readonly globalChanges: Record<string, unknown> = {};
    readonly messageChanges: Record<string, Record<string, unknown>> = {};
    readonly messageSwipeChanges: Record<string, Record<string, Record<string, unknown>>> = {};
    readonly localVariables: Record<string, any> = {};
    readonly initialVariables: Record<string, any>;
    readonly forced = new Map<string, LorebookEntry>();
    readonly suppressed = new Set<string>();
    readonly forceActivationKeys = new Set<string>();
    readonly preprocessed = new Set<string>();
    readonly warnings = new Set<string>();
    readonly injections: TemplateInjections;
    features: TemplateFeatures;
    readonly regex = new TemplateRegexRegistry();
    activationClosed = false;
    activationSnapshot() {
        // Upstream clears activations after final generation formatting. Requests
        // from preload/render survive until the next scan; late generate requests do not.
        if (!this.input.templateTask && !this.input.templateApi) return [];
        const requested = this.forced;
        const selected = new Map((this.input.templateActivations ?? []).map(entry => [`${entry.world}::${entry.uid}`, entry]));
        for (const [key, entry] of requested) selected.set(key, { world: entry.world!, uid: entry.uid, force: this.forceActivationKeys.has(key) });
        return [...selected.values()];
    }
    private swipeVariables: Record<string, Record<string, Record<string, any>>> = {};
    private initializedSwipes: Record<string, Record<string, boolean>> = {};
    private currentMessageId: string | undefined;
    private currentSwipeIndex: number | undefined;
    private currentWorldInfo: LorebookEntry | undefined;
    private eventLorebooks?: NormalizedLorebook[];
    private sandbox?: TemplateSandbox;
    private getSandbox(): TemplateSandbox | undefined {
        if (!this.features.sandbox || typeof document === 'undefined') return undefined;
        return this.sandbox ??= new TemplateSandbox();
    }
    disposeExecution(): void { this.sandbox?.destroy(); this.sandbox = undefined; }
    private get workingLorebooks(): NormalizedLorebook[] { return this.eventLorebooks ?? this.input.lorebooks; }
    private environment: Record<string, any> = { runType: 'generate', isDryRun: false, generateType: 'normal', generateBuffer: '' };
    readonly defines: Record<string, any>;
    private prepareDepth = 0;
    private nextRunId = 0;
    private preparedStage?: { context: Record<string, any>; defaults: Record<string, any> };
    private synchronizedSources?: { scopes: { global: Record<string, any>; chat: Record<string, any> }; messages: Array<ChatMessageNode & { variables: Record<string, any> }> };
    private readonly authorContexts = new WeakSet<object>();
    ownsContext(value: unknown): boolean { return !!value && typeof value === 'object' && this.authorContexts.has(value); }
    /** Only the outer pipeline changes stage/message context, sequentially. Nested
     * author calls carry their own ancestry and locals across every await. */
    private invocation(): TemplateInvocation {
        return { ancestry: [], conditions: [], data: {}, environment: { ...this.environment }, worldInfo: this.currentWorldInfo };
    }
    private variableSchema?: z.ZodType<any>;
    /** Present only while assembling a native plugin's main generation. */
    nativeMacroMask?: (text: string) => string;
    setVariableSchema = (value: unknown): void => {
        this.hooks.assertWritable?.();
        this.variableSchema = mergeTemplateSchemas(this.variableSchema ?? z.looseObject({}), templateObjectSchema(value));
    };
    /** Functions retain identity in the author realm and bind to each invocation's locals. */
    private boundDefines(context: Record<string, any>, values: Record<string, any> = this.defines): Record<string, any> {
        const result: Record<string, any> = Array.isArray(values) ? [] : {};
        for (const [key, value] of Object.entries(values)) result[key] = typeof value === 'function' ? value.bind(context)
            : Array.isArray(value) || _.isPlainObject(value) ? this.boundDefines(context, value) : value;
        return result;
    }
    private macroContext() {
        return { userName: this.input.userName, charName: this.input.character.name, variables: this.variables, globalVariables: this.globals,
            modelName: this.input.modelName, chatId: this.input.chatId, generationType: this.input.generationType,
            maxContextTokens: this.input.maxContextTokens ?? this.input.preset.maxContextTokens, maxResponseTokens: this.input.maxResponseTokens ?? this.input.preset.maxResponseTokens,
            messageCount: this.input.messages.length, currentSwipe: this.input.messages.at(-1)?.activeSwipeIndex, swipeCount: this.input.messages.at(-1)?.swipes.length,
            firstIncludedMessage: this.input.firstIncludedMessage, lastMessageTime: this.input.messages.at(-1)?.createdAt,
            input: this.input.helperGeneration?.config.user_input, characterDescription: this.input.character.description, characterPersonality: this.input.character.personality,
            scenario: this.input.character.scenario, personaDescription: this.input.persona?.description, characterPrompt: this.input.character.systemPrompt,
            characterJailbreak: this.input.character.postHistoryInstructions, examples: this.input.character.mesExample,
            lastMessageId: this.input.messages.length - 1,
            lastMessage: this.input.messages.at(-1)?.content,
            lastUserMessage: this.input.macroLastUserMessage ?? [...this.input.messages].reverse().find(message => message.role === 'user')?.content,
            lastCharMessage: [...this.input.messages].reverse().find(message => message.role === 'assistant')?.content,
            variableScopes: this.macroScopes(),
            onSetVariable: this.environment.isDryRun ? undefined : this.recordLocalChange,
            onSetGlobalVariable: this.environment.isDryRun ? undefined : (key: string, value: unknown) => { this.globalChanges[key] = value; },
        };
    }
    prepare(raw: string, depth = 0, role: 'system' | 'user' | 'assistant' = 'system', stage: RegexPlacementStage = 'prompt', importedRegexApplied = false): string {
        const macro = this.macroContext();
        // Macro writes in preparation are confined to scratch objects as well as omitted from returned changes.
        const values = this.environment.isDryRun ? { ...macro, variables: structuredClone(this.variables), globalVariables: structuredClone(this.globals) } : macro;
        let substituted = raw.split(/(<%[\s\S]*?%>)/g).map(part => part.startsWith('<%') ? part : evaluateMacros(this.hooks.hostMacros?.(this.nativeMacroMask?.(part) ?? part) ?? this.nativeMacroMask?.(part) ?? part, values)).join('');
        substituted = this.hooks.macroLikes?.(substituted, { message_id: this.message(this.currentMessageId)?.floor, role }) ?? substituted;
        let regexed = importedRegexApplied ? substituted : applyRegexScripts(substituted, orderedRegexScripts(this.input.globalRegexScripts, this.input.preset.regexScripts, this.input.character.regexScripts),
            { stage, isPrompt: stage !== 'render', isMarkdown: stage === 'render', depth, role, macroContext: values });
        regexed = this.regex.applyBasic(regexed, { stage, isPrompt: stage !== 'render', isMarkdown: stage === 'render', depth, role, macroContext: values,
            onError: (_rule, error) => { throw error; } });
        if (this.features.enabled && this.features.filter_message_enabled && stage === 'prompt' && role !== 'system') regexed = regexed.replace(/<%(?!%)[\s\S]*?(?<!%)%>/g, '');
        return regexed;
    }
    async expand(raw: string, depth = 0, role: 'system' | 'user' | 'assistant' = 'system', stage: RegexPlacementStage = 'prompt', sourceId = `${stage}:root`, invocation = this.invocation()): Promise<string> {
        return this.finish(await this.render(this.prepare(raw, depth, role, stage), sourceId, {}, invocation,
            stage === 'world_info' || stage === 'render' ? { generate: stage === 'world_info', message: stage === 'render', worldinfo: true, html: true } : undefined));
    }
    finish(text: string): string {
        return text.split(/(<%[\s\S]*?%>)/g).map(part => part.startsWith('<%') ? part : evaluateMacros(this.hooks.hostMacros?.(this.nativeMacroMask?.(part) ?? part) ?? this.nativeMacroMask?.(part) ?? part, {
            ...this.macroContext(),
            variables: this.environment.isDryRun ? structuredClone(this.variables) : this.variables,
            globalVariables: this.environment.isDryRun ? structuredClone(this.globals) : this.globals,
            onSetVariable: this.environment.isDryRun ? undefined : this.recordLocalChange,
            onSetGlobalVariable: this.environment.isDryRun ? undefined : (key: string, value: unknown) => { this.globalChanges[key] = value; },
        })).join('');
    }
    private macroScopes() {
        const node = this.message(this.currentMessageId);
        const preset = this.input.preset.rawData as any;
        return { global: this.globals, chat: this.localVariables,
            message: node ? this.swipeVariables[node.id]?.[this.currentSwipeIndex ?? node.activeSwipeIndex] ?? {} : {},
            character: (this.input.character.extensions?.tavern_helper as any)?.variables ?? {},
            preset: preset?.extensions?.tavern_helper?.variables ?? {} };
    }
    hostEvent(name: string, ...args: any[]): Promise<void> {
        return this.input.templatePreview ? Promise.resolve() : this.hooks.event?.(name, ...args) ?? Promise.resolve();
    }
    async prepareWorldInfoEvents(): Promise<void> {
        for (const warning of this.input.mvuWarnings ?? []) this.warnings.add(warning);
        if (this.input.mvuWorldbookFilter) this.eventLorebooks = filterMvuWorldbooks(this.workingLorebooks, this.input.mvuWorldbookFilter, this.input.mvuExtraAnalysis === true, message => this.warnings.add(message));
        if (this.input.templatePreview || !this.hooks.hasEvent?.('worldinfo_entries_loaded')) return;
        const groups = this.input.worldbookGroups;
        const names = { globalLore: groups?.global ?? [], characterLore: [...(groups?.character ?? []), ...(groups?.additional ?? [])],
            chatLore: groups?.chat ?? [], personaLore: groups?.persona ?? [] };
        const data: Record<string, any[]> = { globalLore: [], characterLore: [], chatLore: [], personaLore: [] };
        for (const book of this.eventLorebooks ?? this.workingLorebooks) {
            const group = Object.entries(names).find(([, selected]) => selected.includes(book.name))?.[0] ?? 'characterLore';
            data[group].push(...book.entries.map(entry => ({ ...this.legacyEntry(entry), content: entry.content, world: book.name })));
        }
        await this.hostEvent('worldinfo_entries_loaded', data);
        const byBook = new Map<string, any[]>();
        for (const items of Object.values(data)) for (const entry of items) {
            const list = byBook.get(entry.world) ?? []; list.push(entry); byBook.set(entry.world, list);
        }
        // Event modifications are local to this assembly, never persisted as edits.
        const books = [...this.workingLorebooks];
        for (const name of byBook.keys()) if (!books.some(book => book.name === name)) books.push({ id: `event:${name}`, name, entries: [] });
        this.eventLorebooks = books.map(book => ({ ...book,
            entries: normalizeLorebook({ name: book.name, entries: (byBook.get(book.name) ?? []).map(({ rawData: _rawData, ...entry }) => ({ ...entry,
                extensions: { ...entry.extensions, position: entry.position } })) }, book.name).entries }));
    }
    async emitWorldInfoActivated(entries: LorebookEntry[]): Promise<void> {
        if (this.hooks.hasEvent?.('world_info_activated')) await this.hostEvent('world_info_activated', entries.map(entry => this.legacyEntry(entry)));
    }
    async prepareExternalWorldInfo(): Promise<void> {
        const selected = new Set(this.input.vectorActivations ?? []);
        if (selected.size) await this.hostEvent('worldinfo_force_activate', this.workingLorebooks.flatMap(book => book.entries
            .filter(entry => selected.has(`${book.name}::${entry.uid}`)).map(entry => this.legacyEntry({ ...entry, world: book.name }))));
        const external = this.hooks.takeWorldInfoActivations?.() ?? [];
        if (!external.length) return;
        const books = new Map(this.workingLorebooks.map(book => [book.name, { ...book, entries: [...book.entries] }]));
        for (const value of external) {
            if (typeof value.world !== 'string' || value.uid == null) continue;
            const book: NormalizedLorebook = books.get(value.world) ?? { id: `external:${value.world}`, name: value.world, entries: [] };
            const entry = normalizeLorebook({ name: value.world, entries: [{ ...value, extensions: { ...value.extensions, position: value.position } }] }, value.world).entries[0];
            const index = book.entries.findIndex(entry => String(entry.uid) === String(value.uid));
            if (index >= 0) book.entries[index] = entry; else book.entries.push(entry);
            books.set(book.name, book); selected.add(`${book.name}::${entry.uid}`);
        }
        this.eventLorebooks = [...books.values()]; this.input.vectorActivations = [...selected];
    }
    worldInfoScanListener(): LorebookScanOptions['onScanDone'] {
        if (this.input.templatePreview || !this.hooks.hasEvent?.('worldinfo_scan_done')) return undefined;
        // Keep entry identity across the arrays and Map passed to each listener.
        const outward = new WeakMap<LorebookEntry, any>();
        const inward = new WeakMap<object, LorebookEntry>();
        const sortedEntries: any[] = [];
        const expose = (entry: LorebookEntry, supplied?: any): any => {
            if (outward.has(entry)) return outward.get(entry);
            const value = supplied ?? this.legacyEntry(entry);
            const aliases: Record<string, keyof LorebookEntry> = { key: 'keys', keysecondary: 'secondaryKeys', disable: 'disabled' };
            const enums: Record<string, Array<string>> = { position: ['before_char', 'after_char', 'an_top', 'an_bottom', 'at_depth', 'before_example', 'after_example', 'outlet'],
                role: ['system', 'user', 'assistant'], selectiveLogic: ['AND_ANY', 'NOT_ALL', 'NOT_ANY', 'AND_ALL'] };
            for (const key of new Set([...Object.keys(entry), ...Object.keys(aliases)])) {
                if (key === 'rawData') continue;
                const field = aliases[key] ?? key as keyof LorebookEntry;
                Object.defineProperty(value, key, { enumerable: true, configurable: true,
                    get: () => enums[key] ? enums[key].indexOf(String(key === 'role' ? entry.role ?? 'system' : key === 'position' && entry.position === 'before_an' ? 'an_top' : key === 'position' && entry.position === 'after_an' ? 'an_bottom' : entry[field])) : entry[field],
                    set: next => { (entry as any)[field] = enums[key] && typeof next === 'number' ? enums[key][next] : next; } });
            }
            outward.set(entry, value); inward.set(value, entry);
            return value;
        };
        const consume = (value: any): LorebookEntry => {
            const existing = inward.get(value);
            if (existing) return existing;
            const { rawData: _raw, ...data } = value;
            const entry = normalizeLorebook({ name: value.world, entries: [{ ...data, extensions: { ...data.extensions, position: data.position } }] }, value.world).entries[0];
            expose(entry, value);
            return entry;
        };
        return async (event: LorebookScanEvent) => {
            const entries = new Map([...event.activated.entries].map(([key, entry]) => [key, expose(entry)]));
            sortedEntries.splice(0, sortedEntries.length, ...event.sortedEntries.map(entry => expose(entry)));
            const payload = { ...event, activated: { ...event.activated, entries }, sortedEntries,
                new: { all: event.new.all.map(entry => expose(entry)), successful: event.new.successful.map(entry => expose(entry)) },
                timedEffects: {
                    isEffectActive: (type: string, entry: any) => event.timedEffects.isEffectActive(type, consume(entry)),
                    isValidEffectType: (type: string) => event.timedEffects.isValidEffectType(type),
                    getEffectMetadata: (type: string, entry: any) => event.timedEffects.getEffectMetadata(type, consume(entry)),
                    setTimedEffect: (type: string, entry: any, enabled: boolean) => event.timedEffects.setTimedEffect(type, consume(entry), enabled),
                    setTimedEffects: (entries: any[]) => event.timedEffects.setTimedEffects(entries.map(consume)),
                    checkTimedEffects: () => event.timedEffects.checkTimedEffects(),
                    cleanUp: () => event.timedEffects.cleanUp(),
                } };
            await this.hostEvent('worldinfo_scan_done', payload);
            event.state.next = payload.state.next;
            event.activated.text = payload.activated.text;
            event.budget.current = payload.budget.current; event.budget.overflowed = payload.budget.overflowed;
            event.recursionDelay.currentLevel = payload.recursionDelay.currentLevel;
            event.activated.entries.clear();
            for (const [key, entry] of entries) event.activated.entries.set(key, consume(entry));
            event.sortedEntries.splice(0, event.sortedEntries.length, ...sortedEntries.map(consume));
        };
    }
    private sendingMessages(value: any[], fallback: AssembledChatMessage[]): AssembledChatMessage[] {
        if (!Array.isArray(value)) throw new Error('生成事件必须保留消息数组');
        const originalById = new Map(fallback.map(message => [message.sourceId, message]));
        return value.map((message, index) => {
            if (!message || !['system', 'user', 'assistant'].includes(message.role)) throw new Error('生成事件返回了无效消息角色');
            const content = typeof message.content === 'string' ? message.content : Array.isArray(message.content)
                ? message.content.filter((part: any) => part.type === 'text').map((part: any) => part.text).join('\n') : undefined;
            if (content === undefined) throw new Error('生成事件返回了无效消息内容');
            const images = Array.isArray(message.content) ? message.content.filter((part: any) => part.type === 'image_url').map((part: any) => part.image_url.url) : message.images ?? [];
            const original = originalById.get(message.sourceId);
            const tokens = this.countTokens(content);
            return Object.assign(original ?? {}, message, { role: message.role, content, images,
                sourceId: message.sourceId ?? original?.sourceId ?? `author_event_${index}`, sourceLabel: message.sourceLabel ?? original?.sourceLabel ?? '作者事件',
                tokens, estimatedTokens: tokens }) as AssembledChatMessage;
        });
    }
    private eventMessages(messages: AssembledChatMessage[]) {
        return messages.map(({ images, ...message }) => ({ ...message, content: images?.length
            ? [{ type: 'text', text: message.content }, ...images.map(url => ({ type: 'image_url', image_url: { url } }))] : message.content }));
    }
    async promptReady(messages: AssembledChatMessage[]): Promise<AssembledChatMessage[]> {
        if (!this.hooks.hasEvent?.('chat_completion_prompt_ready') || this.input.templatePreview) return messages;
        const event = { chat: this.eventMessages(messages), dryRun: false };
        await this.hostEvent('chat_completion_prompt_ready', event);
        return this.sendingMessages(event.chat, messages);
    }
    async requestReady(messages: AssembledChatMessage[]) {
        const settings = this.input.generationSettings;
        if (!settings) return { messages };
        const generationSettings = { model: settings.model, stream: settings.stream, parameters: { ...settings.parameters } };
        if (!this.hooks.hasEvent?.('chat_completion_settings_ready') || this.input.templatePreview) return { messages, generationSettings };
        const data: Record<string, any> = { ...settings.parameters, model: settings.model, stream: settings.stream, messages: this.eventMessages(messages),
            type: this.input.generationType ?? 'normal', chat_completion_source: settings.source,
            user_name: this.input.userName, char_name: this.input.character.name, group_names: [] };
        await this.hostEvent('chat_completion_settings_ready', data);
        generationSettings.model = String(data.model); generationSettings.stream = !!data.stream;
        const parameterNames = new Set([...Object.keys(settings.parameters), 'temperature', 'max_tokens', 'max_completion_tokens', 'top_p', 'top_k',
            'frequency_penalty', 'presence_penalty', 'min_p', 'top_a', 'repetition_penalty', 'seed', 'reasoning_effort', 'response_format', 'tools', 'tool_choice', 'stop', 'logit_bias', 'n']);
        for (const key of parameterNames) {
            if (data[key] === undefined) delete generationSettings.parameters[key]; else generationSettings.parameters[key] = data[key];
        }
        return { messages: this.sendingMessages(data.messages, messages), generationSettings };
    }
    async generationDataReady(messages: AssembledChatMessage[]): Promise<AssembledChatMessage[]> {
        if (!this.hooks.hasEvent?.('generate_after_data') || this.input.templatePreview) return messages;
        const data = { prompt: this.eventMessages(messages) };
        await this.hostEvent('generate_after_data', data, false);
        return this.sendingMessages(data.prompt, messages);
    }
    constructor(public input: AssemblePromptInput, readonly hooks: TemplateRuntimeHooks = {}) {
        this.defines = hooks.defines ?? {};
        this.initialVariables = hooks.initialVariables ?? {};
        this.features = normalizeTemplateFeatures(input.templateFeatures);
        this.injections = new TemplateInjections(input.templateInjections);
        this.begin(input);
    }
    /** Reset transaction data in place; author closures can keep references to these objects. */
    begin(input: AssemblePromptInput): void {
        this.disposeExecution();
        this.synchronizedSources = undefined;
        this.input = input;
        this.eventLorebooks = undefined;
        this.features = normalizeTemplateFeatures(input.templateFeatures);
        this.injections.restore(input.templateInjections ?? []);
        this.injections.forceOutlet = false;
        this.environment = { runType: input.templateTask?.type === 'render' ? 'render' : input.templateTask?.type === 'preload' ? 'preparation' : 'generate', isDryRun: false, generateType: 'normal', generateBuffer: '' };
        this.environment.generateType = input.generationType ?? 'normal';
        replaceObject(this.variables, structuredClone(input.initialVariables ?? {}));
        replaceObject(this.globals, structuredClone(input.initialGlobalVariables ?? {}));
        replaceObject(this.messageVariables, structuredClone(input.initialMessageVariables ?? {}));
        replaceObject(this.localVariables, structuredClone(input.initialLocalVariables ?? input.initialVariables ?? {}));
        for (const changes of [this.variableChanges, this.globalChanges, this.messageChanges, this.messageSwipeChanges]) replaceObject(changes);
        this.forced.clear(); this.suppressed.clear(); this.forceActivationKeys.clear(); this.preprocessed.clear(); this.warnings.clear(); this.conditions.clear();
        this.activationClosed = false; this.currentWorldInfo = undefined;
        this.preparedStage = undefined;
        replaceObject(this.swipeVariables); replaceObject(this.initializedSwipes);
        this.currentMessageId = input.messages.at(-1)?.id;
        this.currentSwipeIndex = input.messages.at(-1)?.activeSwipeIndex;
        for (const node of input.messages) {
            this.initializedSwipes[node.id] = { ...(node.extra?.tipsy_template_variables_initialized as Record<string, boolean> ?? {}) };
            this.swipeVariables[node.id] = structuredClone(node.extra?.swipeVariables ?? {}) as Record<string, Record<string, any>>;
            if (Object.hasOwn(this.messageVariables, node.id)) this.swipeVariables[node.id][node.activeSwipeIndex] = this.messageVariables[node.id];
        }
        this.recache();
    }
    checkpoint() {
        return { input: this.input, eventLorebooks: this.eventLorebooks, defines: _.cloneDeep(this.defines), initialVariables: _.cloneDeep(this.initialVariables), schema: this.variableSchema,
            preparedStage: this.preparedStage,
            regex: this.regex.checkpoint(), injections: this.injections.snapshot(), forceOutlet: this.injections.forceOutlet,
            data: _.cloneDeep({ variables: this.variables, globals: this.globals, localVariables: this.localVariables, messageVariables: this.messageVariables,
                swipeVariables: this.swipeVariables, initializedSwipes: this.initializedSwipes, variableChanges: this.variableChanges, globalChanges: this.globalChanges,
                messageChanges: this.messageChanges, messageSwipeChanges: this.messageSwipeChanges, environment: this.environment,
                currentMessageId: this.currentMessageId, currentSwipeIndex: this.currentSwipeIndex, currentWorldInfo: this.currentWorldInfo, activationClosed: this.activationClosed,
                forced: this.forced, suppressed: this.suppressed, forceActivationKeys: this.forceActivationKeys,
                preprocessed: this.preprocessed, warnings: this.warnings, conditions: this.conditions }) };
    }
    restore(checkpoint: ReturnType<TemplateRuntime['checkpoint']>): void {
        this.disposeExecution();
        this.synchronizedSources = undefined;
        this.input = checkpoint.input; this.features = normalizeTemplateFeatures(this.input.templateFeatures);
        this.eventLorebooks = checkpoint.eventLorebooks;
        replaceObject(this.defines, checkpoint.defines); replaceObject(this.initialVariables, checkpoint.initialVariables);
        this.variableSchema = checkpoint.schema; this.regex.restore(checkpoint.regex);
        this.preparedStage = checkpoint.preparedStage;
        this.injections.restore(checkpoint.injections); this.injections.forceOutlet = checkpoint.forceOutlet;
        const saved = checkpoint.data;
        for (const key of ['variables', 'globals', 'localVariables', 'messageVariables', 'swipeVariables', 'initializedSwipes', 'variableChanges', 'globalChanges', 'messageChanges', 'messageSwipeChanges'] as const) replaceObject(this[key], saved[key]);
        this.environment = saved.environment; this.currentMessageId = saved.currentMessageId; this.currentWorldInfo = saved.currentWorldInfo;
        this.currentSwipeIndex = saved.currentSwipeIndex;
        this.activationClosed = saved.activationClosed;
        for (const key of ['forced', 'conditions'] as const) { this[key].clear(); for (const [name, value] of saved[key]) (this[key] as Map<string, any>).set(name, value); }
        for (const key of ['suppressed', 'forceActivationKeys', 'preprocessed', 'warnings'] as const) { this[key].clear(); for (const name of saved[key]) this[key].add(name); }
    }
    /** Snapshot data can refresh outside a task without dropping resident author functions. */
    synchronizeScopes(scopes: { global: Record<string, any>; chat: Record<string, any> }, messages: Array<ChatMessageNode & { variables: Record<string, any> }>): void {
        const previous = this.synchronizedSources;
        if (previous?.messages === messages && previous.scopes.global === scopes.global && previous.scopes.chat === scopes.chat) return;
        this.synchronizedSources = { scopes, messages };
        const current = this.currentMessageId;
        const oldInputs = this.input.messages;
        const values: Record<string, Record<string, any>> = {};
        const globals = previous?.scopes.global === scopes.global ? this.input.initialGlobalVariables : structuredClone(scopes.global);
        const local = previous?.scopes.chat === scopes.chat ? this.input.initialLocalVariables : structuredClone(scopes.chat);
        if (previous?.scopes.global !== scopes.global) replaceObject(this.globals, structuredClone(scopes.global));
        if (previous?.scopes.chat !== scopes.chat) replaceObject(this.localVariables, structuredClone(scopes.chat));
        const oldValues = this.input.initialMessageVariables;
        const nextInputs = messages.map((node, index) => {
            const old = previous?.messages[index];
            if (old === node) {
                values[node.id] = oldValues![node.id];
                return oldInputs[index];
            }
            values[node.id] = structuredClone(node.variables);
            this.messageVariables[node.id] = structuredClone(node.variables);
            this.initializedSwipes[node.id] = { ...(node.extra?.tipsy_template_variables_initialized as Record<string, boolean> ?? {}) };
            this.swipeVariables[node.id] = structuredClone(node.extra?.swipeVariables ?? {}) as Record<string, Record<string, any>>;
            this.swipeVariables[node.id][node.activeSwipeIndex] = structuredClone(node.variables);
            return structuredClone(node);
        });
        for (const id of Object.keys(this.swipeVariables)) if (!Object.hasOwn(values, id)) {
            delete this.swipeVariables[id]; delete this.initializedSwipes[id]; delete this.messageVariables[id];
        }
        this.input = { ...this.input, messages: nextInputs, initialGlobalVariables: globals, initialLocalVariables: local, initialMessageVariables: values };
        this.currentMessageId = messages.some(node => node.id === current) ? current : messages.at(-1)?.id;
        this.currentSwipeIndex = messages.find(node => node.id === this.currentMessageId)?.activeSwipeIndex;
        for (const changes of [this.variableChanges, this.globalChanges, this.messageChanges, this.messageSwipeChanges]) replaceObject(changes);
        this.recache();
    }
    /** InitialVariables entries are data providers, separate from normal lorebook activation. */
    async initialize(expand: (text: string, entry: LorebookEntry) => Promise<string>): Promise<void> {
        for (const entry of this.input.lorebooks.flatMap(book => book.entries).filter(initialEntry)) {
            const parsed = parseWorldInfoDecorators(entry.content);
            if (!templateEntryEnabled(entry, this.features)) continue;
            if (!await this.entryCondition(entry)) continue;
            const rendered = await this.withWorldInfo(entry, () => expand(parsed.content, entry));
            const value = parseYaml(rendered, { maxAliasCount: 100 });
            if (!_.isPlainObject(value)) throw new Error(`初始变量「${entry.world}/${entry.comment}」必须为 JSON 或 YAML 对象`);
            _.mergeWith(this.initialVariables, value, (_a: any, b: any) => Array.isArray(b) ? b : undefined);
            this.recache();
        }
    }
    isInitialEntry = initialEntry;
    private conditions = new Map<string, boolean>();
    async prepareLorebooks(expand: (text: string, entry: LorebookEntry) => Promise<string>): Promise<NormalizedLorebook[]> {
        const hashedBooks = this.workingLorebooks.map(book => ({ ...book, entries: book.entries.map(entry => ({ ...entry, hash: worldinfoHash(entry) })) }));
        if (!this.features.enabled) return hashedBooks;
        const books: NormalizedLorebook[] = [];
        for (const book of hashedBooks) {
            const entries: LorebookEntry[] = [];
            for (const entry of book.entries) {
                const parsed = parseWorldInfoDecorators(entry.content);
                // Dedicated loaders do not occupy normal world-info prompt slots.
                if (initialEntry(entry)) continue;
                if (isSpecialWorldInfo(entry)) {
                    continue;
                }
                if (entry.disabled && !parsed.has('always_enabled')) { entries.push({ ...entry, content: parsed.content }); continue; }
                const key = `${entry.world}::${entry.uid}`;
                if (!await this.entryCondition(entry)) { this.suppressed.add(key); continue; }
                let content = parsed.content;
                let keys = entry.keys;
                let secondaryKeys = entry.secondaryKeys;
                if (parsed.has('preprocessing') || entry.comment.includes('[Preprocessing]')) {
                    content = await this.withWorldInfo(entry, () => expand(content, entry));
                    const renderedKeys: string[] = []; const renderedSecondary: string[] = [];
                    for (const text of keys) renderedKeys.push(await this.withWorldInfo(entry, () => expand(text, entry)));
                    for (const text of secondaryKeys) renderedSecondary.push(await this.withWorldInfo(entry, () => expand(text, entry)));
                    keys = renderedKeys; secondaryKeys = renderedSecondary;
                    this.preprocessed.add(key);
                }
                let next = { ...entry, content, keys, secondaryKeys, disabled: false };
                if (parsed.has('dont_activate')) { this.suppressed.add(key); continue; }
                if (parsed.has('activate')) {
                    next = { ...next, constant: true, vectorized: false, useProbability: false, delay: 0, cooldown: 0, delayUntilRecursion: 0, group: '', ignoreBudget: true };
                    this.forceActivationKeys.add(key);
                }
                entries.push(next);
            }
            books.push({ ...book, entries });
        }
        return books;
    }
    async withWorldInfo<T>(entry: LorebookEntry, run: () => Promise<T>): Promise<T> {
        const previous = this.currentWorldInfo; this.currentWorldInfo = entry;
        try { return await run(); } finally { this.currentWorldInfo = previous; }
    }
    async entryCondition(entry: LorebookEntry, invocation = this.invocation()): Promise<boolean> {
        const key = `${invocation.environment.runType}:${invocation.environment.loaderPhase ?? ''}:${this.currentMessageId}:${entry.world}::${entry.uid}`;
        const condition = parseWorldInfoDecorators(entry.content).decorators.find(item => item.name === 'if');
        if (!condition) return true;
        if (!condition.argument.trim()) throw new Error(`世界书「${entry.world}/${entry.comment}」的 @@if 缺少表达式`);
        if (invocation.conditions.includes(key)) throw new Error(`世界书条件递归引用：${entry.world}/${entry.comment}`);
        // Explicit nested locals can change an expression's result. Only cache the
        // outer scan's context, never another concurrent reader's condition result.
        const cacheable = invocation.ancestry.length === 0 && Object.keys(invocation.data).length === 0;
        if (cacheable && this.conditions.has(key)) return this.conditions.get(key)!;
        const allowed = (await this.render(`<%- !!(${condition.argument}) %>`, `condition:${entry.world}:${entry.uid}`, {},
            { ...invocation, worldInfo: entry, conditions: [...invocation.conditions, key] })).trim() !== 'false';
        if (cacheable) this.conditions.set(key, allowed);
        return allowed;
    }
    async withEnvironment<T>(values: Record<string, unknown>, run: () => Promise<T>): Promise<T> {
        const previous = this.environment; this.environment = { ...previous, ...values };
        try { return await run(); } finally { this.environment = previous; }
    }
    /** A host lifecycle phase prepares one mutable author context even when its
     * first entry contains no EJS. Nested reads reuse the phase without re-emitting. */
    async beginStage(): Promise<void> {
        this.disposeExecution();
        this.preparedStage = undefined;
        if (!this.features.enabled) return;
        if (this.inheritMessageVariables()) this.recache();
        this.environment = { ...this.environment, runID: this.nextRunId++ };
        await this.render('<% %>', 'stage:prepare', {}, this.invocation(), undefined, undefined, () => {});
    }
    private enabledEntries() { return this.sortedWorldInfo(this.workingLorebooks.flatMap(book => book.entries)).filter(entry => templateEntryEnabled(entry, this.features)); }
    /** Called once per explicit preparation lifecycle by a resident host. */
    async preload(expand: (text: string, entry: LorebookEntry) => Promise<string>, recordWrites = false): Promise<void> {
        if (!this.features.enabled) return;
        this.variableSchema = undefined;
        this.regex.deactivate({ basic: true, message: true, generate: true }, Number.MAX_SAFE_INTEGER);
        const previousInjections = this.injections.snapshot();
        if (recordWrites) this.injections.restore([]);
        this.forced.clear(); this.forceActivationKeys.clear();
        if (!this.features.preload_worldinfo_enabled && !this.input.templateForcePreload) return;
        replaceObject(this.initialVariables);
        await this.withEnvironment({ runType: 'preparation', isDryRun: true, generateType: '', message_id: undefined, swipe_id: undefined }, async () => {
            await this.beginStage();
            await this.initialize(expand);
            let buffer = await this.loader('generate_before', undefined, '', '', expand);
            for (const entry of this.enabledEntries()) {
                const parsed = parseWorldInfoDecorators(entry.content);
                if (parsed.has('dont_preload') || !(parsed.has('preload') || parsed.has('only_preload') || !this.features.preload_only && !isSpecialWorldInfo(entry))) continue;
                if (!await this.entryCondition(entry)) continue;
                buffer += await this.withWorldInfo(entry, () => expand(parsed.content, entry));
            }
            for (const text of [this.input.character.description, this.input.character.scenario]) if (text) buffer += await this.render(text, 'preload:character');
            await this.loader('generate_after', undefined, buffer, buffer, expand);
        });
        if (!recordWrites) {
            this.injections.restore(previousInjections);
            this.forced.clear(); this.forceActivationKeys.clear(); this.suppressed.clear(); this.preprocessed.clear();
            for (const key of Object.keys(this.globals)) delete this.globals[key];
            Object.assign(this.globals, structuredClone(this.input.initialGlobalVariables ?? {}));
            for (const key of Object.keys(this.localVariables)) delete this.localVariables[key];
            Object.assign(this.localVariables, structuredClone(this.input.initialLocalVariables ?? this.input.initialVariables ?? {}));
            for (const node of this.input.messages) {
                this.swipeVariables[node.id] = structuredClone(node.extra?.swipeVariables ?? {}) as Record<string, Record<string, any>>;
                if (Object.hasOwn(this.input.initialMessageVariables ?? {}, node.id)) this.swipeVariables[node.id][node.activeSwipeIndex] = structuredClone(this.input.initialMessageVariables![node.id]);
            }
            for (const changes of [this.variableChanges, this.globalChanges, this.messageChanges, this.messageSwipeChanges]) for (const key of Object.keys(changes)) delete changes[key];
            this.recache();
        }
    }
    async loader(stage: 'generate_before' | 'generate_after' | 'render_before' | 'render_after', index: number | undefined, trigger: string, buffer: string, expand: (text: string, entry: LorebookEntry) => Promise<string>): Promise<string> {
        const [kind, when] = stage.split('_');
        if (!this.features.enabled || (kind === 'generate' ? !this.features.generate_loader_enabled || this.environment.runType !== 'preparation' && !this.features.generate_enabled : !this.features.render_loader_enabled || !this.features.render_enabled)) return '';
        const prefix = `[${kind.toUpperCase()}:${index === undefined ? '' : `${index}:`}${when.toUpperCase()}]`;
        const candidates = this.enabledEntries().filter(entry => {
            if (initialEntry(entry) || entry.comment.includes('@INJECT') || parseWorldInfoDecorators(entry.content).has('only_preload')) return false;
            const decorator = parseWorldInfoDecorators(entry.content).decorators.find(item => item.name === stage && item.argument.trim() === (index === undefined ? '' : String(index)));
            return !!decorator || entry.comment.startsWith(prefix);
        });
        const selected = this.selectActivatedEntries(candidates.map(entry => this.legacyEntry(entry)), trigger, { vectorized: false });
        let output = '';
        for (const selectedEntry of selected) {
            const entry = candidates.find(item => item.world === selectedEntry.world && Number(item.uid) === selectedEntry.uid)!;
            const parsed = parseWorldInfoDecorators(entry.content);
            let rendered = await this.withEnvironment({ generateBuffer: buffer, loaderPhase: `${stage}:${index ?? 'all'}` }, async () => {
                if (!await this.entryCondition(entry)) return '';
                return this.withWorldInfo(entry, () => expand(parsed.content, entry));
            });
            if (kind === 'render' && rendered.trim()) {
                if (parsed.has('message_formatting')) rendered = formatTemplateMarkdown(rendered);
                const iframe = parsed.decorators.find(item => item.name === 'iframe');
                if (iframe) rendered = renderTemplateFrame(rendered, iframe.argument, `template-wi-${crypto.randomUUID()}`,
                    { 'data-worldinfo': entry.world ?? '', 'data-comment': entry.comment, 'data-uid': String(entry.uid) });
            }
            output += rendered;
        }
        return output;
    }
    private recache(): void {
        const node = this.message(this.currentMessageId);
        const values = structuredClone({ ...this.globals, ...(this.input.initialBaseVariables ?? this.input.initialVariables),
            ...this.initialVariables, ...this.localVariables, ...(node ? this.swipeVariables[node.id]?.[this.currentSwipeIndex ?? node.activeSwipeIndex] : {}) });
        for (const key of Object.keys(this.variables)) delete this.variables[key];
        Object.assign(this.variables, values, { _trace_id: this.traceId++, _modify_id: 0 });
    }
    private traceId = 0;
    /** One inheritance per response candidate, retaining the candidate's own keys.
     * The marker is separate from its values so deleting a key does not resurrect it. */
    private inheritMessageVariables(): boolean {
        if (!this.features.enabled || this.environment.runType === 'preparation') return false;
        const index = this.input.messages.findIndex(node => node.id === this.currentMessageId);
        if (index <= 0) return false;
        const node = this.input.messages[index], swipe = this.currentSwipeIndex ?? node.activeSwipeIndex;
        const initialized = this.initializedSwipes[node.id] ??= {};
        if (initialized[swipe]) return false;
        let previous = this.initialVariables;
        for (let i = index - 1; i >= 0; i--) {
            const candidate = this.input.messages[i];
            const values = this.swipeVariables[candidate.id]?.[candidate.activeSwipeIndex];
            if (values != null) { previous = values; break; }
        }
        const table = this.swipeVariables[node.id] ??= {};
        table[swipe] = structuredClone({ ...previous, ...table[swipe] });
        if (swipe === node.activeSwipeIndex) this.messageVariables[node.id] = table[swipe];
        initialized[swipe] = true;
        return true;
    }
    async withMessageContext<T>(id: string, run: () => Promise<T>): Promise<T> {
        const previous = this.currentMessageId;
        const previousSwipe = this.currentSwipeIndex;
        const cached = structuredClone(this.variables);
        this.currentMessageId = id;
        this.currentSwipeIndex = this.message(id)?.activeSwipeIndex;
        this.inheritMessageVariables();
        this.recache();
        try { return await run(); }
        finally {
            this.currentMessageId = previous;
            this.currentSwipeIndex = previousSwipe;
            if (id !== previous) {
                for (const key of Object.keys(this.variables)) delete this.variables[key];
                Object.assign(this.variables, cached);
            }
        }
    }
    recordLocalChange = (key: string, value: unknown) => {
        this.hooks.assertWritable?.();
        this.localVariables[key] = value;
        this.variableChanges[key] = value;
        this.hooks.mutated?.();
    };
    private options(value: any): Record<string, any> {
        if (typeof value === 'string') {
            if (['global', 'local', 'message', 'cache', 'initial'].includes(value)) return { scope: value, inscope: value, outscope: value };
            if (['old', 'new', 'fullcache'].includes(value)) return { results: value };
            return { flags: value };
        }
        return typeof value === 'boolean' ? { dryRun: value } : value ?? {};
    }
    private messageTarget(options: Record<string, any>) {
        const filter = options.withMsg ?? {};
        const node = filter.role && filter.id === undefined
            ? [...this.input.messages].reverse().find(m => filter.role === 'any' || m.role === filter.role)
            : this.message(filter.id ?? options.message_id ?? this.currentMessageId);
        if (!node) throw new Error('模板变量指定了不存在的消息楼层');
        const rawSwipe = filter.swipe_id ?? (node.id === this.currentMessageId ? this.currentSwipeIndex : undefined) ?? node.activeSwipeIndex;
        const swipe = rawSwipe < 0 ? node.swipes.length + rawSwipe : rawSwipe;
        if (!Number.isInteger(swipe) || swipe < 0 || swipe >= node.swipes.length) throw new Error('模板变量指定了不存在的消息分支');
        return { node, swipe };
    }
    private message(id: unknown): ChatMessageNode | undefined {
        const messages = this.input.messages;
        if (id === undefined || id === 'latest') return messages.at(-1);
        const n = Number(id);
        return messages.find(m => m.id === id) ?? (Number.isInteger(n) ? messages.at(n) : undefined);
    }
    private bucket(options: Record<string, any> = {}): Record<string, any> {
        const scope = options.scope ?? options.type ?? 'cache';
        if (scope === 'global') return this.globals;
        if (scope === 'local') return this.localVariables;
        if (scope === 'initial') return this.initialVariables;
        if (scope === 'message') {
            if (!options.withMsg && options.message_id === undefined) return this.variables;
            const { node, swipe } = this.messageTarget(options);
            return this.swipeVariables[node.id][swipe] ??= {};
        }
        if (scope !== 'cache') throw new Error(`未知模板变量作用域：${scope}`);
        return this.variables;
    }
    getvar = (key: string | null, options: Record<string, any> = {}) => {
        options = this.options(options);
        if (options.noCache) this.recache();
        const bucket = this.bucket(options);
        let value = key == null ? bucket : _.get(bucket, key, options.defaults);
        if (options.index != null) {
            if (!safePath(String(options.index))) throw new Error('无效变量索引路径');
            const data = typeof value === 'string' ? JSON.parse(value || '{}') : value;
            const number = Number(options.index);
            value = _.get(data, Number.isNaN(number) ? options.index : number, options.defaults);
        }
        return options.clone && value !== undefined ? structuredClone(value) : value;
    };
    setvar = (key: string | null, value: unknown, options: Record<string, any> = {}) => {
        this.hooks.assertWritable?.();
        options = this.options(options);
        if (this.environment.isDryRun && !options.dryRun) return undefined;
        if (options.noCache) this.recache();
        if (key !== null && (typeof key !== 'string' || !safePath(key))) throw new Error('无效变量路径');
        const indexed = options.index != null;
        const number = Number(options.index);
        const index = Number.isNaN(number) ? options.index : number;
        if (indexed && !safePath(String(index))) throw new Error('无效变量索引路径');
        // Upstream index values are JSON strings, rather than ordinary nested object writes.
        const decode = (raw: any) => {
            const data = JSON.parse(raw || '{}');
            if (!data || typeof data !== 'object') throw new Error('带 index 的变量必须是 JSON 对象或数组字符串');
            return data;
        };
        if (indexed && key === null) throw new Error('index 变量操作需要指定键名');
        const cachedData = indexed ? decode(_.get(this.variables, key!, '{}')) : this.variables;
        const path = indexed ? index : key;
        const old = structuredClone(path === null ? cachedData : _.get(cachedData, path));
        const exists = path === null ? Object.keys(cachedData).length > 0 : _.has(cachedData, path);
        if (options.flags === 'nx' && exists || options.flags === 'xx' && !exists) return undefined;
        if (options.flags === 'nxs' || options.flags === 'xxs') {
            const scoped = this.getvar(key, { ...options, noCache: false });
            if (options.flags === 'nxs' && scoped !== undefined || options.flags === 'xxs' && scoped === undefined) return undefined;
        }
        if (options.merge) value = (old === undefined || Array.isArray(old)) && Array.isArray(value)
            ? [...(old ?? []), ...value] : _.mergeWith(structuredClone(old ?? {}), value, (_a: any, b: any) => Array.isArray(b) ? b : undefined);
        const scope = options.scope ?? options.type ?? 'message';
        const target = scope === 'message' ? this.messageTarget(options) : undefined;
        const bucket = target ? (this.swipeVariables[target.node.id][target.swipe] ??= {}) : this.bucket({ ...options, scope });
        const staged = new Map<Record<string, any>, Record<string, any>>();
        const before = structuredClone(bucket);
        const assign = (object: Record<string, any>, targetPath: any, next: unknown) => {
            const draft = staged.get(object) ?? structuredClone(object);
            if (targetPath === null) {
                if (next === undefined) for (const field of Object.keys(draft)) delete draft[field];
                else {
                    if (!_.isPlainObject(next) || Object.keys(next as object).some(field => !safePath(field))) throw new Error('根变量写入必须是有效对象');
                    Object.assign(draft, structuredClone(next));
                }
            } else if (next === undefined) _.unset(draft, targetPath); else _.set(draft, targetPath, structuredClone(next));
            staged.set(object, draft);
        };
        if (indexed) {
            const data = scope === 'message' && !options.withMsg ? structuredClone(cachedData) : decode(_.get(bucket, key!, '{}'));
            assign(data, index, value);
            assign(cachedData, index, value);
            assign(bucket, key, JSON.stringify(staged.get(data)));
            assign(this.variables, key, JSON.stringify(staged.get(target && target.node.id === this.currentMessageId && target.swipe === this.currentSwipeIndex ? data : cachedData)));
        } else {
            assign(bucket, key, value);
            assign(this.variables, key, value);
        }
        // Validate every destination before publishing any write in this call.
        for (const [object, draft] of staged) {
            if (this.variableSchema && (object === bucket || object === this.variables)) {
                const parsed = this.variableSchema.safeParse(draft);
                if (!parsed.success) throw new Error(`模板变量结构校验失败：${parsed.error.message}`);
                if (!_.isPlainObject(parsed.data)) throw new Error('模板变量 Schema 必须返回对象');
                Object.assign(draft, parsed.data);
            }
        }
        for (const [object, draft] of staged) {
            for (const field of Object.keys(object)) delete object[field];
            Object.assign(object, draft);
        }
        const changes = bucket === this.globals ? this.globalChanges : bucket === this.localVariables ? this.variableChanges : undefined;
        if (changes) {
            for (const field of new Set([...Object.keys(before), ...Object.keys(bucket)])) {
                if (!_.isEqual(before[field], bucket[field])) changes[field] = bucket[field];
            }
        }
        else if (bucket === this.variables || bucket === this.initialVariables) { /* generation-local write */ }
        else {
            const { node, swipe } = this.messageTarget(options);
            this.messageSwipeChanges[node.id] ??= {};
            this.messageSwipeChanges[node.id][swipe] = bucket;
            if (swipe === node.activeSwipeIndex) this.messageChanges[node.id] = bucket;
        }
        this.variables._modify_id = Number(this.variables._modify_id ?? 0) + 1;
        this.hooks.mutated?.();
        return options.results === 'old' ? old : options.results === 'fullcache' ? this.variables : value;
    };
    incvar = (key: string, value = 1, options: Record<string, any> = {}) => {
        options = this.options(options);
        const previous = this.getvar(key, { ...options, scope: options.inscope });
        const exists = _.has(this.variables, key);
        if (options.flags === 'nx' && exists || options.flags === 'xx' && !exists || options.flags === 'nxs' && previous !== undefined || options.flags === 'xxs' && previous === undefined) return undefined;
        let next = (previous ?? options.defaults ?? 0) + value;
        if (options.min != null) next = Math.max(next, options.min);
        if (options.max != null) next = Math.min(next, options.max);
        return this.setvar(key, next, { ...options, scope: options.outscope, flags: 'n' });
    };
    delvar = (key: string, index: unknown = undefined, options: Record<string, any> = {}) => {
        options = this.options(options);
        if (index == null) return this.setvar(key, undefined, options);
        const value = structuredClone(this.getvar(key, options));
        if (Array.isArray(value)) {
            const found = value.indexOf(index); if (found < 0) return undefined;
            value.splice(found, 1);
        } else if (_.isPlainObject(value)) {
            if (['__proto__', 'prototype', 'constructor'].includes(String(index))) throw new Error('无效变量删除键');
            delete value[String(index)];
        } else if (typeof value === 'string' && typeof index === 'string') {
            const found = value.indexOf(index); if (found < 0) return undefined;
            return this.setvar(key, value.slice(0, found) + value.slice(found + index.length), options);
        } else return undefined;
        return this.setvar(key, value, options);
    };
    insvar = (key: string, value: unknown, index?: number | string, options: Record<string, any> = {}) => {
        options = this.options(options);
        let current = structuredClone(this.getvar(key, options));
        if (Array.isArray(current)) {
            const position = index == null ? current.length : Number(index) < 0 ? current.length + Number(index) : Number(index);
            if (!Number.isFinite(position)) throw new Error('数组插入位置必须是数字');
            current.splice(position, 0, value);
        } else if (_.isPlainObject(current) && index != null) {
            if (['__proto__', 'prototype', 'constructor'].includes(String(index))) throw new Error('无效变量插入键');
            if (options.flags?.includes('nx') && Object.hasOwn(current, index) || options.flags?.includes('xx') && !Object.hasOwn(current, index)) return undefined;
            current[String(index)] = value;
        } else if (typeof current === 'string') {
            const position = index == null ? current.length : typeof index === 'string' ? current.indexOf(index) : index < 0 ? current.length + index : index;
            if (position < 0) return undefined;
            const added = String(value);
            current = current.slice(0, position) + added + current.slice(position + (typeof index === 'string' ? added.length : 0));
        } else return undefined;
        return this.setvar(key, current, options);
    };
    private selectBooks(name?: string | null): NormalizedLorebook[] {
        return name == null ? this.workingLorebooks : (this.input.lorebookCatalog ?? this.workingLorebooks).map(book => this.eventLorebooks?.find(changed => changed.id === book.id) ?? book).filter(book => book.name === name || book.id === name);
    }
    getWorldbook = async (name: string) => {
        if (typeof name !== 'string' || !name) throw new Error('世界书名称必须是非空字符串');
        const books = this.selectBooks(name); if (!books.length) throw new Error(`未能找到世界书「${name}」`);
        if (books.length > 1) throw new Error(`存在同名世界书「${name}」，无法确定读取目标`);
        return toHelperWorldbook(books[0]);
    };
    private legacyEntry(entry: LorebookEntry) {
        const parsed = parseWorldInfoDecorators(entry.content);
        const raw = entry.rawData ?? {};
        const ext = raw.extensions as Record<string, unknown> | undefined;
        const inheritedBoolean = (key: 'caseSensitive' | 'matchWholeWords' | 'useGroupScoring', alias: string) =>
            Object.hasOwn(raw, key) ? raw[key] : ext && Object.hasOwn(ext, alias) ? ext[alias] : entry[key] ?? null;
        return structuredClone({ ...entry.rawData, ...entry, content: parsed.content, decorators: parsed.decorators.map(item => item.source), key: [...entry.keys], keysecondary: [...entry.secondaryKeys], disable: !!entry.disabled,
            uid: Number(entry.uid), vectorized: !!entry.vectorized, scanDepth: entry.scanDepth ?? null,
            caseSensitive: inheritedBoolean('caseSensitive', 'case_sensitive'), matchWholeWords: inheritedBoolean('matchWholeWords', 'match_whole_words'), useGroupScoring: inheritedBoolean('useGroupScoring', 'use_group_scoring'),
            position: ({ before_char: 0, after_char: 1, before_an: 2, an_top: 2, after_an: 3, an_bottom: 3, at_depth: 4, before_example: 5, after_example: 6, outlet: 7 })[entry.position],
            role: ({ system: 0, user: 1, assistant: 2 })[entry.role ?? 'system'],
            selectiveLogic: ({ AND_ANY: 0, NOT_ALL: 1, NOT_ANY: 2, AND_ALL: 3 } as Record<string, number>)[String(entry.selectiveLogic)] ?? entry.selectiveLogic });
    }
    private defaultWorldbookName() { return this.input.primaryWorldbookName || this.input.worldbookGroups?.persona[0] || this.input.worldbookGroups?.chat[0]; }
    private sortedWorldInfo(entries: LorebookEntry[]) {
        const positions: Record<string, number> = { before_char: 0, after_char: 1, before_an: 2, an_top: 2, after_an: 3, an_bottom: 3, at_depth: 4, before_example: 5, after_example: 6, outlet: 7 };
        return sortTemplateWorldInfo(entries, entry => ({ position: positions[entry.position] ?? 4, depth: entry.depth ?? 4,
            order: entry.order, uid: Number(entry.uid) }));
    }
    selectActivatedEntries = <T extends TemplateWorldInfo>(entries: T[], keywords: string | string[], condition: WorldInfoQueryCondition = {}) => queryTemplateWorldInfo(entries, keywords, condition,
        text => evaluateMacros(text, { userName: this.input.userName, charName: this.input.character.name, variables: structuredClone(this.variables), globalVariables: structuredClone(this.globals) }),
        { caseSensitive: this.input.worldinfoSettings?.case_sensitive, matchWholeWords: this.input.worldinfoSettings?.match_whole_words, useGroupScoring: this.input.worldinfoSettings?.use_group_scoring });
    async injectionEntries(): Promise<LorebookEntry[]> {
        if (!this.features.enabled || !this.features.generate_enabled || !this.features.inject_loader_enabled) return [];
        const result: LorebookEntry[] = [];
        for (const entry of this.enabledEntries().filter(entry => entry.comment.startsWith('@INJECT'))) {
            if (!await this.entryCondition(entry)) continue;
            // Dedicated @INJECT entries use probability, not ordinary keyword/group activation.
            if (this.selectActivatedEntries([{ ...this.legacyEntry(entry), constant: true, group: '' }], '').length) result.push(entry);
        }
        return result;
    }
    getWorldInfoActivatedData = async (name: string, keywords: string | string[], condition: WorldInfoQueryCondition = {}) => this.selectActivatedEntries(await this.getWorldInfoEntries(name), keywords, condition);
    activateWorldInfoByKeywords = async (keywords: string | string[], condition: WorldInfoQueryCondition = {}, invocation = this.invocation()) => {
        const selected = this.selectActivatedEntries(await this.getEnabledWorldInfoEntries(), keywords, condition);
        for (const entry of selected) await this.activewi(entry.world!, entry.uid, condition.force, invocation);
        return selected;
    };
    getWorldInfoEntries = async (name?: string) => {
        const selected = name || this.defaultWorldbookName();
        return this.sortedWorldInfo(selected ? this.selectBooks(selected).flatMap(book => book.entries) : []).map(entry => this.legacyEntry(entry));
    };
    getEnabledLoreBooks = (character = true, global = true, persona = true, additional = true, chat = true, onlyExisting = true) => {
        const groups = this.input.worldbookGroups;
        if (!groups) return this.input.lorebooks.map(book => book.name);
        const names = [...(character ? groups.character : []), ...(global ? groups.global : []), ...(persona ? groups.persona : []), ...(additional ? groups.additional : []), ...(chat ? groups.chat : [])];
        return [...new Set(names)].filter(name => !onlyExisting || this.selectBooks(name).length > 0);
    };
    getEnabledWorldInfoEntries = async (...options: Parameters<TemplateRuntime['getEnabledLoreBooks']>) => this.sortedWorldInfo(this.getEnabledLoreBooks(...options).flatMap(name => this.selectBooks(name).flatMap(book => book.entries))).map(entry => this.legacyEntry(entry));
    private findEntry(book: string | null | undefined, title: string | RegExp | number) {
        const primary = this.defaultWorldbookName();
        const books = book ? this.selectBooks(book) : [...(primary ? this.selectBooks(primary) : []), ...(typeof title === 'number' ? [] : this.getEnabledLoreBooks().filter(name => name !== primary).flatMap(name => this.selectBooks(name)))];
        return books.flatMap(b => this.sortedWorldInfo(b.entries)).find(entry => {
            if (typeof title === 'number') return Number(entry.uid) === title;
            if (entry.comment === title) return true;
            if (typeof title === 'string') { try { return new RegExp(title).test(entry.comment); } catch { return false; } }
            if (!_.isRegExp(title)) return false;
            title.lastIndex = 0; return title.test(entry.comment);
        });
    }
    getwi = async (bookOrTitle: string | RegExp | number | null, titleOrData?: string | RegExp | number | Record<string, unknown>, data: Record<string, unknown> = {}, invocation = this.invocation()) => {
        const titleOnly = titleOrData === undefined || _.isPlainObject(titleOrData);
        const entry = this.findEntry(titleOnly ? null : bookOrTitle as string, titleOnly ? bookOrTitle as string | RegExp | number : titleOrData as string | RegExp | number);
        if (!entry) return '';
        const nested = { ...invocation, worldInfo: entry, data: { ...invocation.data, ...(titleOnly ? titleOrData as Record<string, unknown> ?? {} : data) } };
        const source = parseWorldInfoDecorators(entry.content).content;
        return this.expand(source, entry.depth, entry.role ?? 'system', 'world_info', `getwi:${entry.world}:${entry.uid}`, nested);
    };
    activewi = async (bookOrTitle: string | RegExp | number, titleOrForce?: string | RegExp | number | boolean, force = false, invocation = this.invocation()) => {
        this.hooks.assertWritable?.();
        const titleOnly = titleOrForce === undefined || typeof titleOrForce === 'boolean';
        const entry = this.findEntry(titleOnly ? null : bookOrTitle as string, titleOnly ? bookOrTitle : titleOrForce as string | RegExp | number);
        const forced = typeof titleOrForce === 'boolean' ? titleOrForce : force;
        if (entry) {
            const key = `${entry.world}::${entry.uid}`;
            const parsed = parseWorldInfoDecorators(entry.content);
            if (!forced && (parsed.has('dont_activate') || !await this.entryCondition(entry, invocation))) {
                this.suppressed.add(key); return this.legacyEntry(entry);
            }
            this.preprocessed.delete(key);
            this.forced.set(key, { ...entry, content: parsed.content, disabled: false, ...(forced ? { constant: true, vectorized: false, cooldown: 0, delay: 0, delayUntilRecursion: 0, group: '', ignoreBudget: true, useProbability: false } : {}) });
            if (forced) { this.forceActivationKeys.add(key); this.suppressed.delete(key); }
            if (this.activationClosed && !this.input.templateTask) this.warnings.add('activewi 在本轮世界书扫描结束后调用，按上游生命周期在生成收尾时清除，不延迟到下一轮。');
        }
        this.hooks.mutated?.();
        return entry ? this.legacyEntry(entry) : null;
    };
    private helperChatMessages = (range: string | number = '0-{{lastMessageId}}') => {
        const messages = this.input.messages;
        const normalized = String(range).replace(/\{\{lastMessageId\}\}/gi, String(messages.length - 1));
        const bounds = /^(-?\d+)\s*-\s*(-?\d+)$/.exec(normalized);
        const index = (n: number) => n < 0 ? messages.length + n : n;
        const low = bounds ? index(Number(bounds[1])) : index(Number(normalized));
        const high = bounds ? index(Number(bounds[2])) : low;
        return messages.filter((_, i) => i >= low && i <= high).map(node => ({
            message_id: node.floor, name: node.speakerName, role: node.role, message: node.content,
            mes: node.content, is_user: node.role === 'user', is_system: !!node.isHidden,
            swipe_id: node.activeSwipeIndex, swipes: node.swipes.map(s => typeof s === 'string' ? s : s.content),
            data: this.swipeVariables[node.id]?.[node.activeSwipeIndex] ?? {}, variables: Object.assign([], this.swipeVariables[node.id]),
            variables_initialized: Object.assign([], this.initializedSwipes[node.id]), extra: messageExtra(node),
        }));
    };
    private templateMessage(node: ChatMessageNode): string { return this.prepare(node.content, this.input.messages.length - node.floor - 1, node.role, node.role === 'user' ? 'user_input' : 'ai_output'); }
    private findCharacter(name?: string | RegExp | number): NormalizedCharacterCard | undefined {
        if (name == null || name === '') return this.input.character;
        const cards = this.input.characterCatalog ?? [this.input.character];
        if (typeof name === 'number') return cards[name];
        const exact = typeof name === 'string' ? cards.find(card => card.id === name || card.name === name) : undefined;
        if (exact) return exact;
        const expression = name instanceof RegExp ? name : new RegExp(name);
        return cards.find(card => { expression.lastIndex = 0; return expression.test(card.name); });
    }
    private getCharacterData = (name?: string | RegExp | number) => {
        const card = this.findCharacter(name);
        if (!card) return null;
        return { ...card, first_mes: card.firstMessage, mes_example: card.mesExample, creatorcomment: card.creatorNotes,
            data: { ...(card.rawData?.data as Record<string, unknown> ?? {}), name: card.name, description: card.description, personality: card.personality, scenario: card.scenario,
                first_mes: card.firstMessage, mes_example: card.mesExample, creator_notes: card.creatorNotes, system_prompt: card.systemPrompt, post_history_instructions: card.postHistoryInstructions, alternate_greetings: card.alternateGreetings,
                extensions: card.extensions ?? {}, tags: card.tags, creator: card.creator, character_version: card.characterVersion } };
    };
    private characterDefine(card = this.input.character) {
        let example = card.mesExample.trim().replace(/^<START>\s*/, '').replace('<START>', '```\n```');
        if (example.includes('```')) example += '\n```';
        return { name: card.name, description: card.description, personality: card.personality, scenario: card.scenario, first_message: card.firstMessage,
            message_example: example, creator_notes: card.creatorNotes, creatorcomment: card.creatorNotes, system_prompt: card.systemPrompt,
            post_history_instructions: card.postHistoryInstructions, alternate_greetings: card.alternateGreetings, depth_prompt: card.depthPrompt?.prompt, creator: card.creator };
    }
    getchar = async (name?: string | RegExp | number, template?: string, data: Record<string, unknown> = {}, invocation = this.invocation()) => {
        const card = this.findCharacter(name); if (!card) return '';
        const define = this.characterDefine(card);
        const source = template ?? `<${card.name}>\n${card.systemPrompt ? `System: ${card.systemPrompt}\n` : ''}name: ${card.name}\n${card.personality ? `personality: ${card.personality}\n` : ''}${card.description ? `description: ${card.description}\n` : ''}${card.mesExample ? `example:\n${define.message_example}\n` : ''}${card.depthPrompt?.prompt ? `System: ${card.depthPrompt.prompt}\n` : ''}</${card.name}>`;
        return evaluateMacros(await this.render(source, `getchar:${card.id}`, {},
            { ...invocation, data: { ...invocation.data, ...data, ...define, chara_name: card.name } }),
            { userName: this.input.userName, charName: card.name, variables: this.variables, globalVariables: this.globals });
    };
    getprp = async (name: string | RegExp, data: Record<string, unknown> = {}, invocation = this.invocation()) => {
        const expression = name instanceof RegExp ? name : new RegExp(name);
        const slot = (this.input.preset.promptSlots ?? this.input.preset.prompts ?? []).find(slot => { expression.lastIndex = 0; return slot.name === name || expression.test(slot.name ?? ''); });
        return slot?.content ? this.finish(await this.render(slot.content!, `getprp:${slot.identifier}`, {},
            { ...invocation, data: { ...invocation.data, ...data, prompt_name: name } })) : '';
    };
    getQuickReplyData = (name: string | RegExp): Record<string, any> | null => {
        const matches = (text: string, pattern: string | RegExp) => {
            if (text === pattern) return true;
            const expression = typeof pattern === 'string' ? new RegExp(pattern) : pattern;
            expression.lastIndex = 0; return expression.test(text);
        };
        return this.input.quickReplyConfig?.setList?.find((link: any) => typeof link?.set?.name === 'string' && matches(link.set.name, name)) ?? null;
    };
    getqr = async (name: string | RegExp, label: string | RegExp, data: Record<string, unknown> = {}, invocation = this.invocation()): Promise<string> => {
        const link = this.getQuickReplyData(name);
        const reply = link?.set?.qrList?.find((item: any) => {
            if (item?.label === label) return true;
            if (typeof item?.label !== 'string') return false;
            const expression = typeof label === 'string' ? new RegExp(label) : label;
            expression.lastIndex = 0; return expression.test(item.label);
        });
        if (typeof reply?.message !== 'string' || !reply.message) return '';
        return this.finish(await this.render(reply.message, `getqr:${link!.set.name}:${reply.label}`, {},
            { ...invocation, data: { ...invocation.data, ...data, qr_name: name, qr_label: label } }));
    };
    getChatMessage = (index: number, role?: string) => {
        const messages = this.input.messages.filter(node => !role || node.role === role);
        const node = messages.at(index); return node ? this.templateMessage(node) : '';
    };
    getChatMessages = (start = this.input.messages.length, endOrRole?: number | string, role?: string): string[] => {
        const filteredRole = typeof endOrRole === 'string' ? endOrRole : role;
        const messages = this.input.messages.filter(node => !filteredRole || node.role === filteredRole);
        if (start === 0) return [];
        return (typeof endOrRole === 'number' ? messages.slice(start, endOrRole) : start > 0 ? messages.slice(0, start) : messages.slice(start)).map(node => this.templateMessage(node));
    };
    matchChatMessages = (pattern: string | RegExp | Array<string | RegExp>, options: { start?: number; end?: number; role?: string; and?: boolean } = {}) => {
        const patterns = Array.isArray(pattern) ? pattern : [pattern];
        const match = (text: string, item: string | RegExp) => { const regex = typeof item === 'string' ? new RegExp(item) : item; regex.lastIndex = 0; return regex.test(text); };
        return this.getChatMessages(options.start ?? -2, options.end, options.role).some(text => options.and ? patterns.every(item => match(text, item)) : patterns.some(item => match(text, item)));
    };
    findVariables = (key?: string, messageId = this.input.messages.length): Record<string, any> => {
        const node = this.input.messages.slice(0, messageId).reverse().find(message => {
            const values = this.swipeVariables[message.id]?.[message.activeSwipeIndex];
            return values != null && (key == null || _.get(values, key) != null);
        });
        return node ? this.swipeVariables[node.id][node.activeSwipeIndex] : this.initialVariables;
    };
    allVariables(end?: number, swipe?: number): Record<string, any> {
        this.hooks.assertWritable?.();
        const node = end === undefined ? this.input.messages.at(-1) : this.input.messages.at(Math.min(end, this.input.messages.length - 1));
        const selected = node && swipe !== undefined ? swipe < 0 ? node.swipes.length + swipe : swipe : node?.activeSwipeIndex;
        if (node && (!Number.isInteger(selected) || selected! < 0 || selected! >= node.swipes.length)) throw new Error('模板变量指定了不存在的消息分支');
        this.currentMessageId = node?.id; this.currentSwipeIndex = selected;
        this.inheritMessageVariables();
        this.recache();
        return this.variables;
    }
    async prepareContext(additional: Record<string, any> = {}, end = -1): Promise<Record<string, any>> {
        this.allVariables(end);
        let captured: Record<string, any> | undefined;
        const previous = this.preparedStage; this.preparedStage = undefined;
        try { await this.render('<% %>', 'prepareContext', {}, { ...this.invocation(), data: additional }, undefined, undefined, context => { captured = context; }); }
        finally { this.preparedStage = previous; }
        return captured!;
    }
    async evaluateExternal(source: string, context?: Record<string, any> | null, options: Record<string, any> = {}): Promise<string> {
        if (typeof source !== 'string' || !source.includes(`${options.openDelimiter ?? '<'}${options.delimiter ?? '%'}`)) return source;
        const data = context ?? await this.prepareContext();
        const fn = await compileAuthorTemplate(source, { options: { ...(this.features.with_context_disabled
            ? { _with: false, destructuredLocals: Object.keys(data).filter(key => /^[A-Za-z_$][\w$]*$/.test(key)) } : {}), ...options } }, data, this.features.compile_workers);
        return fn.call(data, data, this.getSandbox()) as Promise<string>;
    }
    executeCommand = (command: string, options?: SlashExecutionOptions): Promise<string> => executeSlashPipeline(command, {
        hasCommand: this.hooks.hasSlashCommand,
        expand: text => this.finish(text), echo: this.hooks.echo,
        quickReply: name => findExecutableQuickReply(this.input.quickReplyConfig, name),
        command: async (name, args, value, scope) => {
            if (name === 'ejs') {
                const data = typeof args.ctx === 'string' ? JSON.parse(args.ctx || '{}') : args.ctx ?? {};
                return this.withEnvironment({ runType: 'command', isDryRun: false }, async () => {
                    const context = await this.prepareContext({ runType: 'command', isDryRun: false, ...data });
                    return this.evaluateExternal(args.block ? `<%= ${value} %>` : String(value), context);
                });
            }
            if (name === 'ejs-refresh') throw new Error('请在当前模板任务结束后刷新世界书');
            if (this.hooks.slashCommand) return this.hooks.slashCommand(name, args, value, scope);
            throw new Error(`尚未接入 Slash 命令 /${name}`);
        },
        variables: {
            get: (key, global) => (global ? this.globals : this.localVariables)[key],
            set: (key, value, global) => { this.setvar(`[${JSON.stringify(key)}]`, value, { scope: global ? 'global' : 'local', dryRun: true }); },
            delete: (key, global) => { this.setvar(`[${JSON.stringify(key)}]`, undefined, { scope: global ? 'global' : 'local', dryRun: true }); },
        },
    }, options);
    changes() {
        // Public getters can hand author code a mutable scope object. Include those
        // writes too, even when the author did not call a setter.
        for (const [current, before, changes] of [[this.globals, this.input.initialGlobalVariables, this.globalChanges],
            [this.localVariables, this.input.initialLocalVariables ?? this.input.initialVariables, this.variableChanges]] as const) {
            replaceObject(changes);
            for (const key of new Set([...Object.keys(before ?? {}), ...Object.keys(current)])) if (!_.isEqual(before?.[key], current[key])) changes[key] = current[key];
        }
        replaceObject(this.messageChanges); replaceObject(this.messageSwipeChanges);
        for (const node of this.input.messages) {
            const before = { ...(node.extra?.swipeVariables as Record<string, Record<string, any>> ?? {}) };
            if (Object.hasOwn(this.input.initialMessageVariables ?? {}, node.id)) before[node.activeSwipeIndex] = this.input.initialMessageVariables![node.id];
            for (const [swipe, value] of Object.entries(this.swipeVariables[node.id] ?? {})) if (!_.isEqual(value, before[swipe] ?? {})) {
                (this.messageSwipeChanges[node.id] ??= {})[swipe] = value;
                if (Number(swipe) === node.activeSwipeIndex) this.messageChanges[node.id] = value;
            }
        }
        const messageVariableInitializationChanges: Record<string, number[]> = {};
        for (const node of this.input.messages) {
            const before = node.extra?.tipsy_template_variables_initialized as Record<string, boolean> | undefined;
            const added = Object.keys(this.initializedSwipes[node.id] ?? {}).filter(swipe => this.initializedSwipes[node.id][swipe] && !before?.[swipe]).map(Number);
            if (added.length) messageVariableInitializationChanges[node.id] = added;
        }
        return { finalVariables: this.variables, variableChanges: this.variableChanges, globalVariableChanges: this.globalChanges,
            messageVariableInitializationChanges,
            messageVariableChanges: this.messageChanges, messageSwipeVariableChanges: this.messageSwipeChanges,
            templateInjections: this.injections.snapshot(), templateActivations: this.activationSnapshot() };
    }
    hasChanges(): boolean {
        const changes = this.changes();
        return [changes.variableChanges, changes.globalVariableChanges, changes.messageSwipeVariableChanges, changes.messageVariableInitializationChanges].some(value => Object.keys(value).length > 0)
            || !_.isEqual(changes.templateInjections, this.input.templateInjections ?? [])
            || !_.isEqual(changes.templateActivations, this.input.templateActivations ?? []);
    }
    /** Advance the optimistic baseline only after the host accepted these values. */
    acceptChanges(): void {
        const changes = this.changes();
        this.synchronizedSources = undefined;
        this.input = { ...this.input, initialGlobalVariables: structuredClone(this.globals), initialLocalVariables: structuredClone(this.localVariables),
            initialMessageVariables: { ...this.input.initialMessageVariables, ...structuredClone(changes.messageVariableChanges) },
            templateInjections: structuredClone(changes.templateInjections), templateActivations: structuredClone(changes.templateActivations),
            messages: this.input.messages.map(node => ({ ...node, extra: { ...node.extra, swipeVariables: structuredClone(this.swipeVariables[node.id] ?? {}),
                tipsy_template_variables_initialized: { ...this.initializedSwipes[node.id] } } })) };
        for (const value of [this.variableChanges, this.globalChanges, this.messageChanges, this.messageSwipeChanges]) replaceObject(value);
    }
    finishTransaction(): void {
        this.disposeExecution();
        this.eventLorebooks = undefined;
        this.input = { ...this.input, templateTask: undefined, templateApi: true, templateForcePreload: false };
        this.environment = { runType: '', isDryRun: false, generateType: '', generateBuffer: '' };
        this.currentWorldInfo = undefined; this.activationClosed = false;
        this.preparedStage = undefined;
        this.forced.clear(); this.forceActivationKeys.clear(); this.suppressed.clear();
    }
    async render(source: string, sourceId: string, options: Record<string, any> = {}, parent = this.invocation(), regex?: TemplateRegexSelection, protectedBlocks?: 'reasoning' | 'code', capture?: (context: Record<string, any>) => void): Promise<string> {
        if (!capture && (!this.features.enabled || parent.environment.runType === 'generate' && !this.features.generate_enabled || parent.environment.runType === 'render' && !this.features.render_enabled)) return source;
        if (typeof source !== 'string') return source;
        if (regex?.message) source = this.hooks.macroLikes?.(source, { message_id: this.message(this.currentMessageId)?.floor,
            role: this.message(this.currentMessageId)?.role }) ?? source;
        if (!regex && !source.includes(`${options.openDelimiter ?? '<'}${options.delimiter ?? '%'}`)) return source;
        if (parent.ancestry.includes(sourceId) || parent.ancestry.length >= 24) throw new Error(`模板循环引用：${[...parent.ancestry, sourceId].join(' → ')}`);
        const invocation = { ...parent, ancestry: [...parent.ancestry, sourceId] };
        try {
            const context = () => ({ chat: this.helperChatMessages(), chatId: this.input.chatId,
                name1: this.input.userName, name2: this.input.character.name, chatMetadata: { variables: this.localVariables } });
            const nested = (data: Record<string, unknown> = {}): TemplateInvocation => ({ ...invocation, data: { ...locals, ...data } });
            const getwi = (book: any, title?: any, data?: Record<string, unknown>) => this.getwi(book, title, data, nested());
            const activewi = (book: any, title?: any, force?: boolean) => this.activewi(book, title, force, nested());
            const getchar = (name?: string | RegExp | number, template?: string, data?: Record<string, unknown>) => this.getchar(name, template, data, nested());
            const getprp = (name: string | RegExp, data?: Record<string, unknown>) => this.getprp(name, data, nested());
            const getqr = (name: string | RegExp, label: string | RegExp, data?: Record<string, unknown>) => this.getqr(name, label, data, nested());
            let locals: Record<string, any> = { ...this.hooks.globals, ...this.hooks.contextGlobals?.(this), ...invocation.environment, ...invocation.data, _, z,
                faker: await loadTemplateFaker(), variables: this.variables, getvar: this.getvar, setvar: this.setvar,
                userName: this.input.userName, assistantName: this.input.character.name, charName: this.input.character.name,
                chatId: this.input.chatId, model: this.input.modelName ?? '', characterId: (this.input.characterCatalog ?? [this.input.character]).findIndex(card => card.id === this.input.character.id),
                charAvatar: this.input.characterAvatar ?? this.input.character.avatar ?? '', userAvatar: this.input.persona?.image ?? '', groups: [], groupId: null,
                lastUserMessageId: [...this.input.messages].reverse().find(message => message.role === 'user')?.floor ?? -1,
                lastCharMessageId: [...this.input.messages].reverse().find(message => message.role === 'assistant' && !message.isHidden)?.floor ?? -1,
                lastMessageId: this.input.messages.length - 1, lastUserMessage: [...this.input.messages].reverse().find(message => message.role === 'user')?.content ?? '', lastCharMessage: [...this.input.messages].reverse().find(message => message.role === 'assistant')?.content ?? '',
                define: (key: string, value: any, merge = false) => {
                    this.hooks.assertWritable?.();
                    if (typeof key !== 'string' || !safePath(key)) throw new Error('无效模板 define 路径');
                    const old = _.get(this.defines, key);
                    if (merge) value = Array.isArray(value) && (old === undefined || Array.isArray(old)) ? [...(old ?? []), ...value] : _.mergeWith({}, old, value, (_a: any, b: any) => Array.isArray(b) ? b : undefined);
                    _.set(this.defines, key, value); _.set(locals, key, value); return old;
                },
                charLoreBook: this.input.primaryWorldbookName ?? undefined, userLoreBook: this.input.worldbookGroups?.persona[0], chatLoreBook: this.input.worldbookGroups?.chat[0],
                world_info: invocation.worldInfo ? this.legacyEntry(invocation.worldInfo) : undefined,
                initialVariables: this.initialVariables, message_id: this.message(this.currentMessageId)?.floor, swipe_id: this.currentSwipeIndex,
                setLocalVar: (key: string, value: unknown, options: any = {}) => this.setvar(key, value, { ...options, scope: 'local' }),
                setGlobalVar: (key: string, value: unknown, options: any = {}) => this.setvar(key, value, { ...options, scope: 'global' }),
                setMessageVar: (key: string, value: unknown, options: any = {}) => this.setvar(key, value, { ...options, scope: 'message' }),
                getLocalVar: (key: string, options: any = {}) => this.getvar(key, { ...options, scope: 'local' }),
                getGlobalVar: (key: string, options: any = {}) => this.getvar(key, { ...options, scope: 'global' }),
                getMessageVar: (key: string, options: any = {}) => this.getvar(key, { ...options, scope: 'message' }),
                incvar: this.incvar, decvar: (key: string, value = 1, options = {}) => this.incvar(key, -value, options), delvar: this.delvar, insvar: this.insvar,
                setVariableSchema: this.setVariableSchema, parseJSON: parseTemplateJSON,
                findVariables: this.findVariables,
                applyVarYamlAnnotate: (key: string | null = null, schema = '') => annotateTemplateVariables(this.getvar(key), schema),
                jsonPatch: (doc: unknown, patch: Array<Record<string, any>>) => patchTemplateJSON(doc, patch, warning => this.warnings.add(warning)),
                patchVariables: (key: string | null, patch: string | Array<Record<string, any>>, options: Record<string, any> = {}) => this.setvar(key,
                    patchTemplateJSON(this.getvar(key, options), typeof patch === 'string' ? parseTemplateJSON(patch) : patch, warning => this.warnings.add(warning)), options),
                evalTemplate: async (text: string, data: Record<string, unknown> = {}, options: Record<string, any> = {}) => this.finish(await this.render(text, `evalTemplate:${text}`, options, nested(data))),
                getwi, getWorldInfo: getwi, activewi, activateWorldInfo: activewi,
                getChatMessage: this.getChatMessage, getChatMessages: this.getChatMessages, matchChatMessages: this.matchChatMessages,
                getCurrentChatId: () => this.input.chatId, getContext: context, SillyTavern: { ...context(), getContext: context },
                getchar, getchr: getchar, getChara: getchar,
                getprp, getpreset: getprp, getPresetPrompt: getprp,
                getqr, getQuickReply: getqr, getQuickReplyData: this.getQuickReplyData,
                getCharaData: this.getCharacterData, getCharData: this.getCharacterData,
                getCharWorldbookNames: () => this.input.characterWorldbooks ?? { primary: this.input.primaryWorldbookName ?? null, additional: [] },
                getWorldbook: this.getWorldbook,
                getWorldbookNames: () => (this.input.lorebookCatalog ?? this.input.lorebooks).map(book => book.name),
                getWorldInfoEntries: this.getWorldInfoEntries,
                getWorldInfoData: this.getWorldInfoEntries,
                getEnabledLoreBooks: this.getEnabledLoreBooks,
                getWorldInfoEntry: async (book: any, title?: any) => { const entry = this.findEntry(title === undefined ? null : book, title === undefined ? book : title); return entry ? this.legacyEntry(entry) : null; },
                getWorldInfoComments: async (name?: string) => (await this.getWorldInfoEntries(name)).map(entry => entry.comment),
                getEnabledWorldInfoEntries: this.getEnabledWorldInfoEntries,
                selectActivatedEntries: this.selectActivatedEntries, getWorldInfoActivatedData: this.getWorldInfoActivatedData,
                getWorldInfoActivatedEntries: this.getWorldInfoActivatedData,
                activateWorldInfoByKeywords: (keywords: string | string[], condition?: WorldInfoQueryCondition) => this.activateWorldInfoByKeywords(keywords, condition, nested()),
                injectPrompt: (...args: Parameters<TemplateInjections['inject']>) => { this.hooks.assertWritable?.(); this.injections.inject(...args); this.hooks.mutated?.(); },
                getPromptsInjected: this.injections.get, hasPromptsInjected: this.injections.has,
                activateRegex: (...args: Parameters<TemplateRegexRegistry['activate']>) => { this.hooks.assertWritable?.(); return this.regex.activate(...args); },
                execute: this.executeCommand,
                substitute: (text: string) => evaluateMacros(text, { userName: this.input.userName, charName: this.input.character.name, variables: this.variables }),
            };
            for (const [suffix, scope] of [['Local', 'local'], ['Global', 'global'], ['Message', 'message']] as const) {
                locals[`inc${suffix}Var`] = (key: string, value = 1, options: Record<string, unknown> = {}) => this.incvar(key, value, { ...options, outscope: scope });
                locals[`dec${suffix}Var`] = (key: string, value = 1, options: Record<string, unknown> = {}) => this.incvar(key, -value, { ...options, outscope: scope });
                locals[`del${suffix}Var`] = (key: string, options: Record<string, unknown> = {}) => this.delvar(key, undefined, { ...options, scope });
                locals[`insert${suffix}Var`] = (key: string, value: unknown, index?: number | string, options: Record<string, unknown> = {}) => this.insvar(key, value, index, { ...options, scope });
            }
            // Explicit prepareContext data can override the public environment.
            // Nested readers must retain their freshly bound ancestry-aware helpers;
            // copying parent functions over them would bypass recursion detection.
            if (!parent.ancestry.length) Object.assign(locals, invocation.data);
            Object.assign(locals, this.boundDefines(locals));
            this.authorContexts.add(locals);
            if (!String(invocation.environment.runType).startsWith('render')) { locals.message_id = undefined; locals.swipe_id = undefined; }
            if (!parent.ancestry.length && this.preparedStage) {
                const defaults = { ...locals };
                const previous = this.preparedStage;
                locals = previous.context;
                // Definitions use `this` as the real invocation context. Rebind
                // after choosing that object, not to a discarded defaults object.
                Object.assign(defaults, this.boundDefines(locals));
                // Refresh framework helpers only while the author has not replaced
                // them; preserve additions, deletions and mutations from prepare.
                for (const [key, value] of Object.entries(defaults)) if (Object.hasOwn(previous.defaults, key) && locals[key] === previous.defaults[key]
                    || !Object.hasOwn(previous.defaults, key) && !Object.hasOwn(locals, key)) locals[key] = value;
                Object.assign(locals, invocation.environment, { world_info: defaults.world_info });
                this.preparedStage.defaults = defaults;
            } else if (!this.prepareDepth && !parent.ancestry.length) {
                const defaults = { ...locals };
                this.preparedStage = { context: locals, defaults };
                this.prepareDepth++;
                try { await this.hooks.prepare?.(locals); } finally { this.prepareDepth--; }
            }
            capture?.(locals);
            if (regex) source = this.regex.apply(locals, source, regex);
            const protectedSource = protectedBlocks ? protectTemplateBlocks(source, protectedBlocks === 'code') : undefined;
            if (protectedSource) source = protectedSource.source;
            if (!source.includes(`${options.openDelimiter ?? '<'}${options.delimiter ?? '%'}`)) return protectedSource?.restore(source) ?? source;
            const cacheable = !Object.keys(options).length && !this.features.with_context_disabled && this.features.cache_size > 0
                && (this.features.cache_enabled === 1 || this.features.cache_enabled === 2 && !!invocation.worldInfo);
            const sandbox = this.getSandbox();
            const cacheKey = `${this.features.compile_workers || sandbox ? 'client' : 'local'}:${this.features.debug_enabled}:${invocation.environment.runType === 'render' ? 'html' : 'text'}\0${source}`;
            let fn = cacheable ? cache.get(cacheKey) : undefined;
            if (!fn) {
                // Prompt Template deliberately leaves <%= output unescaped. The
                // compatibility origin remains the execution boundary for HTML.
                const compileOptions = { async: true, compileDebug: true, debug: this.features.debug_enabled, outputFunctionName: 'print',
                    escape: invocation.environment.runType === 'render' ? markdownOutput : rawOutput,
                    ...(this.features.with_context_disabled ? { _with: false, destructuredLocals: Object.keys(locals).filter(key => /^[A-Za-z_$][\w$]*$/.test(key)) } : {}),
                    ...options, cache: false };
                fn = this.features.compile_workers || sandbox ? await compileAuthorTemplate(source, { options: compileOptions,
                    escaper: options.escape ?? compileOptions.escape, includer: options.includer }, undefined, this.features.compile_workers) : ejs.compile(source, compileOptions);
                if (cacheable) {
                    while (cache.size >= this.features.cache_size) cache.delete(cache.keys().next().value!);
                    cache.set(cacheKey, fn);
                }
            }
            const output = await fn.call(locals, locals, sandbox); return protectedSource?.restore(output) ?? output;
        } catch (error) {
            throw new Error(`模板「${sourceId}」执行失败：${error instanceof Error ? error.message : String(error)}`);
        }
    }
}

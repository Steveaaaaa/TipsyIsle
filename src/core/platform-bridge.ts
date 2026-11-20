import { platformFetch } from './native-runtime';
import { encodeSnapshots, decodeSnapshot, usesImmutableStorySnapshot } from './snapshot-codec';
import { copySyncState, SYNC_KEY, type SyncState } from './sync/protocol';
/**
 * TipsyIsle Unified Cross-Platform Bridge (`PlatformBridge`)
 * Automatically adapts to:
 * 1. Tauri v2 Native Runtime (Desktop .exe & Mobile .apk via `__TAURI_INTERNALS__`)
 * 2. TipsyIsle Local SQLite/HTTP Gateway (`/api/tipsy/*`)
 * 3. Pure Offline IndexedDB / LocalStorage Fallback
 */

import { excludeRequestFields } from './request-fields';
import type {
    AssembledPromptMessage,
    ChatMessageNode,
    NormalizedCharacterCard,
    NormalizedLorebook,
    NormalizedPreset,
    ThemePresetPackage,
} from '../types';

declare global {
    interface Window {
        __TAURI_INTERNALS__?: {
            invoke: <T = unknown>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
        };
        __TIPSY_ISLE__?: Record<string, unknown>;
    }
}

export type RuntimeFlavor = 'tauri-native' | 'local-gateway' | 'browser-offline';

let detectedFlavor: RuntimeFlavor | null = null;

export async function detectRuntimeFlavor(): Promise<RuntimeFlavor> {
    if (detectedFlavor) return detectedFlavor;
    if (typeof window !== 'undefined' && window.__TAURI_INTERNALS__?.invoke) {
        detectedFlavor = 'tauri-native';
        return detectedFlavor;
    }
    try {
        const res = await fetch('/api/tipsy-isle/health', { method: 'GET' });
        if (res.ok) {
            detectedFlavor = 'local-gateway';
            return detectedFlavor;
        }
    } catch {
        // Offline browser mode
    }
    detectedFlavor = 'browser-offline';
    return detectedFlavor;
}

export interface StreamCompletionRequest {
    source: string;
    baseUrl: string;
    apiKey: string;
    model: string;
    messages: CompletionRequestMessage[];
    parameters: Record<string, unknown>;
    includeBody?: Record<string, unknown>;
    excludeBody?: string[];
    includeHeaders?: Record<string, string>;
    stream?: boolean;
    provider?: { provider: string; api?: string; authType?: 'api_key' | 'oauth'; thinkingLevel?: string; contextWindow?: number };
    signal?: AbortSignal;
    onToken: (deltaContent: string, deltaReasoning?: string) => void;
    onToolCall?: () => void;
}
export type CompletionRequestMessage = AssembledPromptMessage | {
    role: 'assistant'; content: string; tool_calls: CompletionToolCall[]; reasoning_content?: string; reasoning_signature?: string;
} | { role: 'tool'; content: string; tool_call_id: string; name: string; isError?: boolean };

/**
 * Universal SSE Streaming LLM Client.
 * Routes through Tauri native command or Local Gateway proxy when available to bypass mobile CORS,
 * or connects directly to CORS-enabled OpenAI/Claude/Gemini/DeepSeek endpoints.
 */
export interface CompletionToolCall { id: string; type: 'function'; function: { name: string; arguments: string }; thought_signature?: string }
export interface CompletionCandidate { content: string; reasoning: string; reasoning_signature?: string; tool_calls?: CompletionToolCall[] }
export interface CompletionResult extends CompletionCandidate { candidates?: CompletionCandidate[] }
const candidateFrom = (message: any): CompletionCandidate => ({ content: typeof message.content === 'string' ? message.content : '',
    reasoning: typeof message.reasoning_content === 'string' ? message.reasoning_content : typeof message.reasoning === 'string' ? message.reasoning : '',
    ...(message.reasoning_signature ? { reasoning_signature: message.reasoning_signature } : {}), ...(message.tool_calls?.length ? { tool_calls: message.tool_calls } : {}) });
export async function streamLlmCompletion(req: StreamCompletionRequest): Promise<CompletionResult> {
    const flavor = await detectRuntimeFlavor();
    if (flavor !== 'local-gateway' && (req.provider || ['claude', 'anthropic', 'makersuite', 'gemini', 'vertexai', 'openai-responses'].includes(req.source))) {
        throw new Error('此原厂协议需要本地网关，请使用项目启动器启动程序');
    }
    const baseUrl = req.baseUrl.replace(/\/+$/, '');
    const targetUrl =
        flavor === 'local-gateway'
            ? '/api/tipsy-isle/llm/stream'
            : baseUrl.endsWith('/chat/completions')
              ? baseUrl
              : `${baseUrl}/chat/completions`;

    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
    };
    if (req.apiKey && flavor !== 'local-gateway') {
        headers.Authorization = `Bearer ${req.apiKey}`;
    }
    if (flavor !== 'local-gateway') Object.assign(headers, req.includeHeaders);
    const messages = req.messages.map(message => 'sourceId' in message ? { role: message.role,
        content: message.images?.length ? [{ type: 'text', text: message.content }, ...message.images.map(url => ({ type: 'image_url', image_url: { url } }))] : message.content,
        ...(message.name ? { name: message.name } : {}) } : message.role === 'tool'
            ? { role: 'tool', content: message.content, tool_call_id: message.tool_call_id,
                ...(flavor === 'local-gateway' ? { name: message.name, isError: message.isError } : {}) }
            : message);
    const completionBody = structuredClone({ ...req.parameters, model: req.model, messages, stream: req.stream ?? true, ...req.includeBody });
    excludeRequestFields(completionBody, req.excludeBody);

    const bodyPayload =
        flavor === 'local-gateway'
            ? {
                  source: req.source,
                  provider: req.provider,
                  baseUrl: req.baseUrl,
                  apiKey: req.apiKey,
                  model: req.model,
                  messages,
                  parameters: req.parameters,
                  stream: req.stream ?? true,
                  includeBody: req.includeBody, excludeBody: req.excludeBody, includeHeaders: req.includeHeaders,
              }
            : completionBody;

    const response = await platformFetch(targetUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(bodyPayload),
        signal: req.signal,
    });

    if (!response.ok || !response.body) {
        const errText = await response.text().catch(() => response.statusText);
        throw new Error(`LLM 请求失败 (${response.status}): ${errText.slice(0, 240)}`);
    }

    if (response.headers.get('content-type')?.includes('application/json')) {
        const payload = await response.json();
        req.signal?.throwIfAborted();
        if (payload.error) throw new Error(`LLM 接口错误：${getCompletionError(payload.error)}`);
        const message = payload.choices?.[0]?.message;
        if (!message) throw new Error('LLM 接口未返回回复消息');
        const candidates = [...payload.choices].sort((a, b) => (a.index ?? 0) - (b.index ?? 0)).map(choice => candidateFrom(choice.message));
        const first = candidates[0];
        if (first.tool_calls?.length) req.onToolCall?.();
        req.onToken(first.content, first.reasoning);
        return { ...first, ...(candidates.length > 1 ? { candidates } : {}) };
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let fullContent = '';
    let fullReasoning = '';
    let eventData: string[] = [];
    let finished = false;
    let receivedMessage = false;
    let reasoningSignature = '';
    const toolCalls = new Map<number, CompletionToolCall>();
    const alternatives = new Map<number, CompletionCandidate & { tools: Map<number, CompletionToolCall> }>();

    const dispatch = () => {
        if (!eventData.length || finished) return;
        const dataStr = eventData.join('\n').trim();
        eventData = [];
        if (!dataStr) return;
        if (dataStr === '[DONE]') { finished = true; return; }
        let parsed: Record<string, any>;
        try { parsed = JSON.parse(dataStr); }
        catch { throw new Error('LLM 接口返回了无法解析的流式数据'); }
        if (!parsed || typeof parsed !== 'object') throw new Error('LLM 接口返回了无效的流式数据');
        if (parsed.error) throw new Error(`LLM 接口错误：${getCompletionError(parsed.error)}`);
        const choice = parsed.choices?.find((choice: any) => !choice.index);
        for (const item of parsed.choices ?? []) if (item.index > 0) {
            const value = alternatives.get(item.index) ?? { content: '', reasoning: '', tools: new Map<number, CompletionToolCall>() };
            const delta = item.delta ?? item.message ?? {};
            value.content += typeof delta.content === 'string' ? delta.content : '';
            value.reasoning += delta.reasoning_content ?? delta.reasoning ?? '';
            if (delta.reasoning_signature) value.reasoning_signature = (value.reasoning_signature ?? '') + delta.reasoning_signature;
            for (const [index, tool] of (delta.tool_calls ?? []).entries()) {
                const key = tool.index ?? index, saved = value.tools.get(key) ?? { id: '', type: 'function' as const, function: { name: '', arguments: '' } };
                if (tool.id) saved.id = tool.id;
                saved.function.name += tool.function?.name ?? ''; saved.function.arguments += tool.function?.arguments ?? '';
                if (tool.thought_signature) saved.thought_signature = tool.thought_signature;
                value.tools.set(key, saved);
            }
            alternatives.set(item.index, value);
        }
        if (choice) receivedMessage = true;
        const delta = choice?.delta ?? choice?.message ?? {};
        if (delta.reasoning_signature) reasoningSignature += delta.reasoning_signature;
        if (!toolCalls.size && delta.tool_calls?.length) req.onToolCall?.();
        for (const [index, item] of (delta.tool_calls ?? []).entries()) {
            const key = item.index ?? index;
            const call = toolCalls.get(key) ?? { id: '', type: 'function' as const, function: { name: '', arguments: '' } };
            if (item.id) call.id = item.id;
            if (item.function?.name) call.function.name += item.function.name;
            if (item.function?.arguments) call.function.arguments += item.function.arguments;
            if (item.thought_signature) call.thought_signature = item.thought_signature;
            toolCalls.set(key, call);
        }
        const contentPiece = typeof delta.content === 'string' ? delta.content : '';
        const reasoningPiece = typeof delta.reasoning_content === 'string' ? delta.reasoning_content
            : typeof delta.reasoning === 'string' ? delta.reasoning : '';
        if (contentPiece || reasoningPiece) {
            fullContent += contentPiece;
            fullReasoning += reasoningPiece;
            req.onToken(contentPiece, reasoningPiece);
        }
    };
    const acceptLine = (line: string) => {
        if (!line) { dispatch(); return; }
        if (line.startsWith('data:')) {
            eventData.push(line.slice(5).replace(/^ /, ''));
        }
    };

    try {
        while (!finished) {
            req.signal?.throwIfAborted();
            const { done, value } = await reader.read();
            req.signal?.throwIfAborted();
            buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
            // Keep a trailing CR until the next chunk so a split CRLF remains one separator.
            let separator: RegExpExecArray | null;
            while (!finished && (separator = /\r\n|\n|\r(?!$)/.exec(buffer))) {
                acceptLine(buffer.slice(0, separator.index));
                buffer = buffer.slice(separator.index + separator[0].length);
            }
            if (done) {
                if (!finished && buffer) acceptLine(buffer.replace(/\r$/, ''));
                dispatch();
                break;
            }
        }
        if (!receivedMessage) throw new Error('LLM 接口未返回回复消息');
        const first = { content: fullContent, reasoning: fullReasoning, ...(reasoningSignature ? { reasoning_signature: reasoningSignature } : {}),
            ...(toolCalls.size ? { tool_calls: [...toolCalls.entries()].sort(([a], [b]) => a - b).map(([, value]) => value) } : {}) };
        return { ...first, ...(alternatives.size ? { candidates: [first, ...[...alternatives].sort(([a], [b]) => a - b).map(([, { tools, ...value }]) => ({ ...value,
            ...(tools.size ? { tool_calls: [...tools].sort(([a], [b]) => a - b).map(([, tool]) => tool) } : {}) }))] } : {}) };
    } finally {
        try { await reader.cancel(); } catch { /* Preserve the original request error. */ }
        reader.releaseLock();
    }
}

function getCompletionError(error: unknown): string {
    if (typeof error === 'string') return error;
    if (error && typeof error === 'object' && 'message' in error) {
        return String(error.message);
    }
    return JSON.stringify(error);
}

const LS_PREFIX = 'tipsy_isle:v1:';
const SNAPSHOT_ENVELOPE = `${LS_PREFIX}snapshot_bundle`;
let storageQueue: Promise<void> = Promise.resolve();
type SnapshotHook = (snapshots: Record<string, any>, references?: Record<string, any>) => Promise<{ values: Record<string, unknown>; committed(): void }>;
let snapshotHook: SnapshotHook | undefined;
type LocalSnapshotHook = (snapshots: Record<string, unknown>, track: boolean, parkedChat?: string) => { values: Record<string, unknown>; committed(): void } | undefined;
let localSnapshotHook: LocalSnapshotHook | undefined;
export function registerSnapshotCommitHook(hook: SnapshotHook): void { snapshotHook = hook; }
export function registerLocalSnapshotHook(hook: LocalSnapshotHook): void { localSnapshotHook = hook; }
async function readGatewaySnapshot(collection: string): Promise<unknown> {
    const response = await fetch(`/api/tipsy-isle/kv/${encodeURIComponent(collection)}`);
    if (!response.ok) throw new Error(`读取 ${collection} 失败 (${response.status})`);
    return ((await response.json()) as { value: unknown }).value;
}

export const platformStorage = {
    async loadSnapshot<T>(collection: string, fallback: T): Promise<T> {
        // A previous save failure is reported to its caller. It must not prevent a
        // subsequent explicit reload/recovery from reading the last durable state.
        const task = storageQueue.catch(() => {}).then(async () => {
        const flavor = await detectRuntimeFlavor();
        const read = async (key: string): Promise<any> => {
        if (flavor === 'tauri-native' && window.__TAURI_INTERNALS__?.invoke) {
            return window.__TAURI_INTERNALS__.invoke<unknown>('tipsy_kv_get', { key });
        } else if (flavor === 'local-gateway') {
            return readGatewaySnapshot(key);
        }
        const bundled = globalThis.localStorage?.getItem(SNAPSHOT_ENVELOPE);
        if (bundled) return JSON.parse(bundled).snapshots[key];
        const raw = globalThis.localStorage?.getItem(`${LS_PREFIX}${key}`);
        return raw ? JSON.parse(raw) : null;
        };
        const value = await read(collection);
        const readMany = async (keys: string[]): Promise<Record<string, any>> => {
            if (flavor === 'tauri-native' && window.__TAURI_INTERNALS__?.invoke) {
                return window.__TAURI_INTERNALS__.invoke('tipsy_kv_get', { keys });
            }
            if (flavor === 'local-gateway') {
                const response = await fetch('/api/tipsy-isle/kv-batch', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ keys }),
                });
                if (!response.ok) throw new Error(`批量读取资源失败 (${response.status})，请重启本地网关`);
                return (await response.json()).values;
            }
            return Object.fromEntries(await Promise.all(keys.map(async key => [key, await read(key)])));
        };
        return value == null ? fallback : await decodeSnapshot(value, read, readMany, collection) as T;
        });
        storageQueue = task.then(() => {}, () => {});
        return task;
    },

    async saveSnapshot<T>(collection: string, value: T): Promise<void> {
        return platformStorage.saveSnapshots({ [collection]: value });
    },

    /** Serialize related snapshots at invocation and persist them in one transaction. */
    async saveSnapshots(snapshots: Record<string, unknown>, track = true, prepare?: SnapshotHook, parkedChat?: string): Promise<void> {
        const entries = Object.entries(snapshots);
        if (!entries.length) return;
        if (entries.some(([key, value]) => !key || ['__proto__', 'prototype', 'constructor'].includes(key) || value === undefined)) throw new Error('快照集合名称或值无效');
        const original = Object.fromEntries(entries.map(([key, value]) => [key,
            key === SYNC_KEY ? copySyncState(value as SyncState) : usesImmutableStorySnapshot(key) ? value : structuredClone(value)]));
        const task = storageQueue.catch(() => {}).then(async () => {
            const hook = prepare ? await prepare(original, snapshots) : track && snapshotHook ? await snapshotHook(original, snapshots) : undefined;
            const local = localSnapshotHook?.(snapshots, track, parkedChat);
            const encoded = await encodeSnapshots({ ...original, ...hook?.values, ...local?.values }, { ...snapshots, ...hook?.values, ...local?.values });
            const values = encoded.writes;
            const flavor = await detectRuntimeFlavor();
            if (flavor === 'tauri-native' && window.__TAURI_INTERNALS__?.invoke) {
                await window.__TAURI_INTERNALS__.invoke('tipsy_kv_set_many', { values });
            } else if (flavor === 'local-gateway') {
                const response = await fetch('/api/tipsy-isle/kv-batch', {
                    method: 'PUT', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ values }),
                });
                if (!response.ok) throw new Error(`保存快照集合失败 (${response.status})`);
            } else {
                if (!globalThis.localStorage) throw new Error('浏览器没有可用的持久存储');
                const previous = globalThis.localStorage.getItem(SNAPSHOT_ENVELOPE);
                const snapshots = previous ? JSON.parse(previous).snapshots : {};
                globalThis.localStorage.setItem(SNAPSHOT_ENVELOPE, JSON.stringify({ version: 1, snapshots: { ...snapshots, ...values } }));
            }
            encoded.committed(); hook?.committed(); local?.committed();
        });
        storageQueue = task;
        await task;
    },
};

export type {
    ChatMessageNode,
    NormalizedCharacterCard,
    NormalizedLorebook,
    NormalizedPreset,
    ThemePresetPackage,
};

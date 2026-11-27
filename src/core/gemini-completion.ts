import { geminiEndpoint, geminiHeaders } from './gemini-endpoint';
import { platformFetch } from './native-runtime';
import type { CompletionToolCall, StreamCompletionRequest } from './platform-bridge';
import { GEMINI_SAFETY_SETTINGS, PROMPT_PLACEHOLDER } from './prompt-post-process';
import { excludeRequestFields } from './request-fields';

type JsonObject = Record<string, unknown>;
type Part = { text: string; thought?: boolean; thoughtSignature?: string }
    | { inlineData: { mimeType: string; data: string } }
    | { functionCall: { name: string; args: JsonObject; id?: string }; thoughtSignature?: string }
    | { functionResponse: { name: string; response: JsonObject; id?: string } };

function object(value: unknown): JsonObject {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
}

function parseObject(text: string, fallback: JsonObject): JsonObject {
    try {
        const value: unknown = JSON.parse(text);
        if (value && typeof value === 'object' && !Array.isArray(value)) return object(value);
    } catch { return fallback; }
    return fallback;
}

async function imagePart(url: string, signal?: AbortSignal): Promise<Part> {
    const data = /^data:([^;,]+);base64,(.*)$/s.exec(url);
    if (data) return { inlineData: { mimeType: data[1], data: data[2] } };
    if (!/^https?:\/\//i.test(url)) throw new Error('Gemini 图片必须是 data URL 或 HTTP(S) 地址。');
    const response = await platformFetch(url, { signal });
    if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`读取 Gemini 提示词图片失败（${response.status}）`);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    const chunks: string[] = [];
    for (let offset = 0; offset < bytes.length; offset += 8192) chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 8192)));
    return { inlineData: { mimeType: response.headers.get('content-type')?.split(';')[0] || 'image/png', data: btoa(chunks.join('')) } };
}

function hasPropertyOrdering(schema: unknown): boolean {
    if (!schema || typeof schema !== 'object') return false;
    if (Array.isArray(schema)) return schema.some(hasPropertyOrdering);
    const obj = schema as Record<string, unknown>;
    if ('propertyOrdering' in obj) return true;
    return Object.values(obj).some(hasPropertyOrdering);
}

function contentText(content: unknown, name?: string): string {
    const raw = typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content.map(part => (typeof part === 'string' ? part : part?.type === 'text' ? String(part.text ?? '') : '')).join('\n')
          : '';
    if (!raw) return '';
    return name ? `${name}: ${raw}` : raw;
}

async function conversation(req: StreamCompletionRequest) {
    const model = req.model.trim().replace(/^models\//, '');
    const useSysPrompt = req.useSystemPrompt !== false && !/^gemma-?3/i.test(model);
    const noPrefillModel = /gemini-3\.[67]-flash|gemini-3\.5-flash-lite/i.test(model);
    const system: string[] = [];
    const contents: { role: 'user' | 'model'; parts: Part[] }[] = [];
    const addParts = (role: 'user' | 'model', parts: Part[]) => {
        if (!parts.length) return;
        const previous = contents.at(-1);
        if (previous?.role === role) previous.parts.push(...parts);
        else contents.push({ role, parts });
    };
    const toolIds = Number(/^gemini-(\d+)/i.exec(model)?.[1]) >= 3;
    let startIndex = 0;
    if (useSysPrompt) {
        while (startIndex < req.messages.length - 1 && req.messages[startIndex].role === 'system') {
            const message = req.messages[startIndex];
            const named = contentText(message.content, 'name' in message ? message.name : undefined);
            if (named) system.push(named);
            startIndex++;
        }
    }
    for (let index = startIndex; index < req.messages.length; index++) {
        const message = req.messages[index];
        req.signal?.throwIfAborted();
        if (message.role === 'tool') {
            addParts('user', [{ functionResponse: { name: message.name ?? 'tool',
                response: parseObject(message.content, { result: message.content }), ...(toolIds ? { id: message.tool_call_id } : {}) } }]);
        } else {
            const parts: Part[] = [];
            const msgSig = 'thoughtSignature' in message && typeof message.thoughtSignature === 'string' ? message.thoughtSignature : undefined;
            const reasoningSig = 'reasoning_signature' in message && typeof message.reasoning_signature === 'string' ? message.reasoning_signature : undefined;
            if (reasoningSig) {
                parts.push({ text: ('reasoning_content' in message ? message.reasoning_content : undefined) ?? '', thought: true, thoughtSignature: reasoningSig });
            }
            const namePrefix = 'name' in message ? message.name : undefined;
            if (Array.isArray(message.content)) {
                let firstText = true;
                for (const item of message.content) {
                    if (item?.type === 'text') {
                        const textVal = String(item.text ?? '');
                        if (textVal) {
                            const txt = firstText && namePrefix ? `${namePrefix}: ${textVal}` : textVal;
                            firstText = false;
                            parts.push({ text: txt });
                        }
                    } else if (item?.type === 'image_url' && typeof (item.image_url as any)?.url === 'string') {
                        parts.push(await imagePart((item.image_url as any).url, req.signal));
                    }
                }
            } else {
                const rawText = typeof message.content === 'string' ? message.content : '';
                const thinkMatch = message.role === 'assistant' && msgSig && !reasoningSig
                    ? /^\s*<think>([\s\S]*?)<\/think>\s*$/i.exec(rawText)
                    : null;
                if (thinkMatch) {
                    parts.push({ text: thinkMatch[1], thought: true, thoughtSignature: msgSig });
                } else {
                    const named = namePrefix && rawText ? `${namePrefix}: ${rawText}` : rawText;
                    if (named) {
                        parts.push(msgSig && message.role === 'assistant' && !('tool_calls' in message && message.tool_calls?.length)
                            ? { text: named, thoughtSignature: msgSig }
                            : { text: named });
                    }
                }
            }
            if ('images' in message && message.images?.length) parts.push(...await Promise.all(message.images.map(url => imagePart(url, req.signal))));
            if ('tool_calls' in message && message.tool_calls?.length) {
                for (const [callIdx, call] of message.tool_calls.entries()) {
                    const callSig = call.thought_signature
                        ?? call.signature
                        ?? call.extra_content?.google?.thoughtSignature
                        ?? (callIdx === 0 && !reasoningSig && parts.length === 0 ? msgSig : undefined);
                    parts.push({ functionCall: { name: call.function.name, args: parseObject(call.function.arguments, {}), ...(toolIds ? { id: call.id } : {}) },
                        ...(callSig ? { thoughtSignature: callSig } : {}) });
                }
            }
            const preserveModel = Boolean(
                ('tool_calls' in message && message.tool_calls?.length) || msgSig || reasoningSig,
            );
            const role = message.role === 'assistant'
                ? (noPrefillModel && index === req.messages.length - 1 && !preserveModel ? 'user' : 'model')
                : 'user';
            addParts(role, parts);
        }
    }
    if (!contents.length) contents.push({ role: 'user', parts: [{ text: PROMPT_PLACEHOLDER }] });
    return { contents, ...(system.length ? { systemInstruction: { parts: [{ text: system.join('\n\n') }] } } : {}) };
}

function thinkingConfig(model: string, level: unknown): JsonObject | undefined {
    const id = model.toLowerCase();
    const isModernThinking = /(?:^|[\s_\-\]])(?:gemini-(?:[3-9]|[1-9]\d)|gemini-(?:flash|pro)(?:-lite)?-latest|gemma-?4)/i.test(id);
    const isGemini25 = /(?:^|[\s_\-\]])gemini-2\.5-/i.test(id);
    const isExplicitThinking = /(?:^|[\s_\-\]])gemini-[\w.-]*thinking/i.test(id);
    const normalized = typeof level === 'string' ? level.trim().toLowerCase() : '';
    if (!normalized || normalized === 'auto' || normalized === 'default') {
        if (isModernThinking || isGemini25 || isExplicitThinking) return { includeThoughts: true };
        return;
    }
    if (!['off', 'none', 'minimal', 'low', 'medium', 'high', 'max', 'xhigh'].includes(normalized)) return;
    const disabled = normalized === 'off' || normalized === 'none';
    if (isModernThinking) {
        const pro = id.includes('-pro');
        const thinkingLevel = disabled || normalized === 'minimal' ? (pro ? 'LOW' : 'MINIMAL')
            : normalized === 'low' ? 'LOW' : normalized === 'medium' && !pro ? 'MEDIUM' : 'HIGH';
        return { includeThoughts: !disabled, thinkingLevel };
    }
    if (isGemini25) {
        const minimum = id.includes('-pro') ? 128 : id.includes('-lite') ? 512 : 0;
        const thinkingBudget = disabled || normalized === 'minimal' ? minimum : normalized === 'low' ? 2048 : normalized === 'medium' ? 8192 : id.includes('-pro') ? 32768 : 24576;
        return { includeThoughts: !disabled, thinkingBudget };
    }
    if (isExplicitThinking) return { includeThoughts: !disabled };
}

export async function requestGeminiCompletion(req: StreamCompletionRequest): Promise<Response> {
    const model = req.model.trim().replace(/^models\//, '');
    if (!model || /[/:]/.test(model)) throw new Error('请填写 Gemini 模型 ID。');
    const streaming = req.stream !== false;
    const endpoint = geminiEndpoint(req.baseUrl, `models/${encodeURIComponent(model)}:${streaming ? 'streamGenerateContent' : 'generateContent'}`);
    if (streaming) endpoint.searchParams.set('alt', 'sse');

    const parameters = req.parameters;
    if (Number(parameters.n) > 1) throw new Error('当前 Gemini 协议只支持单个候选，请将预设回复数量设为 1。');
    const { generationConfig: configOverrides, response_format, reasoning_effort, thinking, ...overrides } = req.includeBody ?? {};
    const generationConfig: JsonObject = {};
    for (const [key, native] of Object.entries({ temperature: 'temperature', max_tokens: 'maxOutputTokens', top_p: 'topP', top_k: 'topK',
        frequency_penalty: 'frequencyPenalty', presence_penalty: 'presencePenalty', seed: 'seed' })) {
        const value = parameters[key];
        if (typeof value === 'number' && Number.isFinite(value) && !(key === 'top_k' && value === 0)) generationConfig[native] = value;
    }
    const stop = parameters.stop ?? parameters.stop_sequences;
    if (typeof stop === 'string' && stop) generationConfig.stopSequences = [stop];
    else if (Array.isArray(stop) && stop.length) generationConfig.stopSequences = stop;
    const format = object(response_format ?? parameters.response_format);
    if (format.type === 'json_object' || format.type === 'json_schema' || format.json_schema) {
        generationConfig.responseMimeType = 'application/json';
        const schema = object(format.json_schema).schema;
        if (schema) generationConfig.responseJsonSchema = schema;
    }
    const config = thinkingConfig(model, object(thinking).type === 'disabled' ? 'off' : reasoning_effort ?? parameters.reasoning_effort);
    if (config) generationConfig.thinkingConfig = config;
    Object.assign(generationConfig, object(configOverrides));
    if (thinking && object(thinking).type !== 'disabled') generationConfig.thinkingConfig = thinking;

    const declarations = (Array.isArray(parameters.tools) ? parameters.tools : []).flatMap(tool => {
        const fn = object(object(tool).function);
        if (typeof fn.name !== 'string') return [];
        const schemaField = hasPropertyOrdering(fn.parameters)
            ? { parameters: fn.parameters }
            : { parametersJsonSchema: fn.parameters };
        return [{ name: fn.name, description: fn.description, ...schemaField }];
    });
    const explicitToolConfig = overrides.toolConfig ?? parameters.toolConfig;
    const choice = parameters.tool_choice;
    const allowedName = object(object(choice).function).name;
    const mode = typeof allowedName === 'string' || choice === 'required' ? 'ANY' : choice === 'none' ? 'NONE' : choice === 'auto' ? 'AUTO' : undefined;
    const toolConfigBlock = explicitToolConfig && typeof explicitToolConfig === 'object'
        ? { toolConfig: explicitToolConfig }
        : mode
          ? { toolConfig: { functionCallingConfig: { mode, ...(allowedName ? { allowedFunctionNames: [allowedName] } : {}) } } }
          : {};
    const body = structuredClone({ ...await conversation(req), generationConfig, safetySettings: GEMINI_SAFETY_SETTINGS,
        ...(declarations.length ? { tools: [{ functionDeclarations: declarations }] } : {}),
        ...toolConfigBlock,
        ...overrides });
    excludeRequestFields(body, req.excludeBody);
    const headers = geminiHeaders(req.apiKey, req.includeHeaders);
    if (!headers.has('content-type')) headers.set('content-type', 'application/json');
    if (streaming && !headers.has('accept')) headers.set('accept', 'text/event-stream');
    req.signal?.throwIfAborted();
    return platformFetch(endpoint.href, { method: 'POST', headers, body: JSON.stringify(body), signal: req.signal });
}

interface GeminiReply {
    error?: unknown;
    promptFeedback?: { blockReason?: string };
    candidates?: { index?: number; finishReason?: string; finishMessage?: string; content?: { parts?: {
        text?: string; thought?: boolean | string; thoughtSignature?: string; functionCall?: { id?: string; name?: string; args?: JsonObject };
    }[] } }[];
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
}

function mapGeminiFinishReason(reason?: string): string | undefined {
    if (!reason || reason === 'FINISH_REASON_UNSPECIFIED') return;
    if (reason === 'MAX_TOKENS') return 'length';
    if (reason === 'STOP') return 'stop';
    return reason.toLowerCase();
}

export function geminiReplyAdapter() {
    let toolIndex = 0;
    return (reply: GeminiReply, streaming: boolean) => {
        if (reply.error) return { error: reply.error };
        if (reply.promptFeedback?.blockReason && reply.promptFeedback.blockReason !== 'BLOCK_REASON_UNSPECIFIED') {
            return { error: `Gemini 拒绝了提示词（${reply.promptFeedback.blockReason}）` };
        }
        const choices = (reply.candidates ?? []).flatMap((candidate, index) => {
            const reason = candidate.finishReason;
            if (reason && !['FINISH_REASON_UNSPECIFIED', 'STOP', 'MAX_TOKENS'].includes(reason)) {
                throw new Error(`Gemini 已停止生成（${reason}）${candidate.finishMessage ? `：${candidate.finishMessage}` : ''}`);
            }
            const finishReason = mapGeminiFinishReason(reason);
            const parts = candidate.content?.parts ?? [];
            const message: { content: string; reasoning_content: string; reasoning_signature?: string; tool_calls: (CompletionToolCall & { index?: number })[] }
                = { content: '', reasoning_content: '', tool_calls: [] };
            for (const part of parts) {
                if (part.thought) {
                    message.reasoning_content += typeof part.text === 'string' ? part.text : (typeof part.thought === 'string' ? part.thought : '');
                } else if (typeof part.text === 'string') {
                    message.content += part.text;
                }
                if (part.thoughtSignature && !part.functionCall) {
                    message.reasoning_signature = part.thoughtSignature;
                }
                if (part.functionCall?.name) {
                    const call = part.functionCall;
                    message.tool_calls.push({ id: call.id || `gemini_${crypto.randomUUID()}`, type: 'function',
                        function: { name: part.functionCall.name, arguments: JSON.stringify(call.args ?? {}) },
                        ...(part.thoughtSignature ? { thought_signature: part.thoughtSignature } : {}), ...(streaming ? { index: toolIndex++ } : {}) });
                }
            }
            if (!message.content && !message.reasoning_content && !message.reasoning_signature && !message.tool_calls.length && !finishReason) return [];
            return [{
                index: candidate.index ?? index,
                ...(finishReason ? { finish_reason: finishReason } : {}),
                ...(streaming ? { delta: message } : { message }),
            }];
        });
        const meta = reply.usageMetadata;
        const promptTokens = typeof meta?.promptTokenCount === 'number' ? meta.promptTokenCount : undefined;
        const outputTokens = typeof meta?.candidatesTokenCount === 'number' || typeof meta?.thoughtsTokenCount === 'number'
            ? (meta?.candidatesTokenCount ?? 0) + (meta?.thoughtsTokenCount ?? 0) : undefined;
        return {
            choices,
            ...(promptTokens !== undefined || outputTokens !== undefined ? { usage: { prompt_tokens: promptTokens, completion_tokens: outputTokens } } : {}),
        };
    };
}

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
            const named = 'name' in message && message.name ? `${message.name}: ${message.content}` : message.content;
            if (named) system.push(named);
            startIndex++;
        }
    }
    for (let index = startIndex; index < req.messages.length; index++) {
        const message = req.messages[index];
        req.signal?.throwIfAborted();
        const named = 'name' in message && message.name ? `${message.name}: ${message.content}` : message.content;
        if (message.role === 'tool') {
            addParts('user', [{ functionResponse: { name: message.name,
                response: parseObject(message.content, { result: message.content }), ...(toolIds ? { id: message.tool_call_id } : {}) } }]);
        } else {
            const parts: Part[] = [];
            if ('reasoning_signature' in message && message.reasoning_signature) parts.push({ text: message.reasoning_content ?? '', thought: true,
                thoughtSignature: message.reasoning_signature });
            if (named) parts.push({ text: named });
            if ('images' in message && message.images?.length) parts.push(...await Promise.all(message.images.map(url => imagePart(url, req.signal))));
            if ('tool_calls' in message) for (const call of message.tool_calls) {
                parts.push({ functionCall: { name: call.function.name, args: parseObject(call.function.arguments, {}), ...(toolIds ? { id: call.id } : {}) },
                    ...(call.thought_signature ? { thoughtSignature: call.thought_signature } : {}) });
            }
            const role = message.role === 'assistant'
                ? (noPrefillModel && index === req.messages.length - 1 ? 'user' : 'model')
                : 'user';
            addParts(role, parts);
        }
    }
    if (!contents.length) contents.push({ role: 'user', parts: [{ text: PROMPT_PLACEHOLDER }] });
    return { contents, ...(system.length ? { systemInstruction: { parts: [{ text: system.join('\n\n') }] } } : {}) };
}

function thinkingConfig(model: string, level: unknown): JsonObject | undefined {
    if (typeof level !== 'string' || !['off', 'none', 'minimal', 'low', 'medium', 'high', 'max', 'xhigh'].includes(level)) return;
    const disabled = level === 'off' || level === 'none';
    const id = model.toLowerCase();
    if (/^(?:gemini-(?:[3-9]|[1-9]\d)|gemini-flash(?:-lite)?-latest|gemma-?4)/.test(id)) {
        const pro = id.includes('-pro');
        const thinkingLevel = disabled || level === 'minimal' ? (pro ? 'LOW' : 'MINIMAL')
            : level === 'low' ? 'LOW' : level === 'medium' && !pro ? 'MEDIUM' : 'HIGH';
        return { includeThoughts: !disabled, thinkingLevel };
    }
    if (!id.startsWith('gemini-2.5-')) return;
    const minimum = id.includes('-pro') ? 128 : id.includes('-lite') ? 512 : 0;
    const thinkingBudget = disabled || level === 'minimal' ? minimum : level === 'low' ? 2048 : level === 'medium' ? 8192 : id.includes('-pro') ? 32768 : 24576;
    return { includeThoughts: !disabled, thinkingBudget };
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
        return typeof fn.name === 'string' ? [{ name: fn.name, description: fn.description, parametersJsonSchema: fn.parameters }] : [];
    });
    const choice = parameters.tool_choice;
    const allowedName = object(object(choice).function).name;
    const mode = typeof allowedName === 'string' || choice === 'required' ? 'ANY' : choice === 'none' ? 'NONE' : choice === 'auto' ? 'AUTO' : undefined;
    const body = structuredClone({ ...await conversation(req), generationConfig, safetySettings: GEMINI_SAFETY_SETTINGS,
        ...(declarations.length ? { tools: [{ functionDeclarations: declarations }] } : {}),
        ...(mode ? { toolConfig: { functionCallingConfig: { mode, ...(allowedName ? { allowedFunctionNames: [allowedName] } : {}) } } } : {}),
        ...overrides });
    excludeRequestFields(body, req.excludeBody);
    const headers = geminiHeaders(req.apiKey, req.includeHeaders);
    if (!headers.has('content-type')) headers.set('content-type', 'application/json');
    req.signal?.throwIfAborted();
    return platformFetch(endpoint.href, { method: 'POST', headers, body: JSON.stringify(body), signal: req.signal });
}

interface GeminiReply {
    error?: unknown;
    promptFeedback?: { blockReason?: string };
    candidates?: { index?: number; finishReason?: string; finishMessage?: string; content?: { parts?: {
        text?: string; thought?: boolean; thoughtSignature?: string; functionCall?: { id?: string; name?: string; args?: JsonObject };
    }[] } }[];
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
            const parts = candidate.content?.parts ?? [];
            const message: { content: string; reasoning_content: string; reasoning_signature?: string; tool_calls: (CompletionToolCall & { index?: number })[] }
                = { content: '', reasoning_content: '', tool_calls: [] };
            for (const part of parts) {
                if (part.thought) {
                    message.reasoning_content += part.text ?? '';
                    if (part.thoughtSignature) message.reasoning_signature = part.thoughtSignature;
                } else message.content += part.text ?? '';
                if (part.functionCall?.name) {
                    const call = part.functionCall;
                    message.tool_calls.push({ id: call.id || `gemini_${crypto.randomUUID()}`, type: 'function',
                        function: { name: part.functionCall.name, arguments: JSON.stringify(call.args ?? {}) },
                        ...(part.thoughtSignature ? { thought_signature: part.thoughtSignature } : {}), ...(streaming ? { index: toolIndex++ } : {}) });
                }
            }
            if (!message.content && !message.reasoning_content && !message.reasoning_signature && !message.tool_calls.length) return [];
            return [{ index: candidate.index ?? index, ...(streaming ? { delta: message } : { message }) }];
        });
        return { choices };
    };
}

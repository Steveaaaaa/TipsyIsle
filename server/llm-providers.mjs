import { once } from 'node:events';
import { createPiNonStreamingFetch } from './pi-non-streaming.mjs';

// SDKs stay on the local host and are imported only for the selected protocol.
const adapters = {
  'anthropic-messages': () => import('@earendil-works/pi-ai/api/anthropic-messages'),
  'google-generative-ai': () => import('@earendil-works/pi-ai/api/google-generative-ai'),
  'google-vertex': () => import('@earendil-works/pi-ai/api/google-vertex'),
  'openai-completions': () => import('@earendil-works/pi-ai/api/openai-completions'),
  'openai-responses': () => import('@earendil-works/pi-ai/api/openai-responses'),
  'azure-openai-responses': () => import('@earendil-works/pi-ai/api/azure-openai-responses'),
  'openai-codex-responses': () => import('@earendil-works/pi-ai/api/openai-codex-responses'),
  'mistral-conversations': () => import('@earendil-works/pi-ai/api/mistral-conversations'),
  'bedrock-converse-stream': () => import('@earendil-works/pi-ai/api/bedrock-converse-stream'),
  'pi-messages': () => import('@earendil-works/pi-ai/api/pi-messages'),
};
const sources = {
  claude: ['anthropic', 'anthropic-messages'], anthropic: ['anthropic', 'anthropic-messages'],
  makersuite: ['google', 'google-generative-ai'], gemini: ['google', 'google-generative-ai'],
  vertexai: ['google-vertex', 'google-vertex'], 'openai-responses': ['openai', 'openai-responses'],
};
const openaiSources = new Set(['openai', 'custom', 'deepseek', 'openrouter', 'groq', 'mistral', 'xai', 'ollama', '']);
export function usesProviderAdapter(payload) {
  if (payload.provider || sources[payload.source]) return true;
  if (!openaiSources.has(payload.source ?? 'openai')) throw new Error(`未支持的模型协议：${payload.source}`);
  return false;
}

async function resolveModel(payload) {
  const { getBuiltinModel } = await import('@earendil-works/pi-ai/providers/all');
  const connection = payload.provider ?? {};
  const [provider, defaultApi] = payload.provider ? [connection.provider, 'openai-completions'] : sources[payload.source] ?? ['openai', 'openai-completions'];
  const known = getBuiltinModel(provider, payload.model);
  const api = connection.api || (payload.provider ? known?.api : defaultApi) || defaultApi;
  if (!adapters[api]) throw new Error(`Pi 未提供协议适配器：${api}`);
  let baseUrl = String(payload.baseUrl || known?.baseUrl || '').trim().replace(/\/+$/, '');
  baseUrl = baseUrl.replace(/\/(?:chat\/completions|responses|messages)$/, '');
  if (api === 'anthropic-messages') baseUrl = baseUrl.replace(/\/v1$/, '');
  if (baseUrl && !/^https?:\/\//i.test(baseUrl)) throw new Error('API 地址必须为 HTTP(S)');
  if (!baseUrl && api !== 'bedrock-converse-stream') throw new Error('请配置模型 API 地址');
  return { ...(known ?? {}), id: payload.model, name: known?.name ?? payload.model, api, provider, baseUrl,
    reasoning: known?.reasoning ?? !!connection.thinkingLevel, input: known?.input ?? ['text', 'image'],
    cost: known?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: connection.contextWindow || known?.contextWindow || 262144,
    maxTokens: known?.maxTokens || Number(payload.parameters?.max_tokens) || 16384 };
}

const PROMPT_PLACEHOLDER = "Let's get started.";
export const GEMINI_SAFETY_SETTINGS = [
  { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'OFF' },
  { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'OFF' },
  { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'OFF' },
  { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'OFF' },
  { category: 'HARM_CATEGORY_CIVIC_INTEGRITY', threshold: 'OFF' },
];
export const VERTEX_SAFETY_SETTINGS = [
  { category: 'HARM_CATEGORY_IMAGE_HATE', threshold: 'OFF' },
  { category: 'HARM_CATEGORY_IMAGE_DANGEROUS_CONTENT', threshold: 'OFF' },
  { category: 'HARM_CATEGORY_IMAGE_HARASSMENT', threshold: 'OFF' },
  { category: 'HARM_CATEGORY_IMAGE_SEXUALLY_EXPLICIT', threshold: 'OFF' },
  { category: 'HARM_CATEGORY_JAILBREAK', threshold: 'OFF' },
];

export function defaultGoogleSafetySettings(api) {
  return api === 'google-vertex'
    ? [...GEMINI_SAFETY_SETTINGS, ...VERTEX_SAFETY_SETTINGS]
    : [...GEMINI_SAFETY_SETTINGS];
}

function formatNamedMessage(message) {
  if (!message.name) return message.content ?? '';
  if (typeof message.content === 'string') {
    return message.content.startsWith(`${message.name}: `) ? message.content : `${message.name}: ${message.content}`;
  }
  if (Array.isArray(message.content)) {
    return message.content.map((part, index) => index === 0 && part?.type === 'text'
      ? { ...part, text: String(part.text ?? '').startsWith(`${message.name}: `) ? part.text : `${message.name}: ${part.text ?? ''}` }
      : part);
  }
  return message.content ?? '';
}

function contentParts(content) {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  return Array.isArray(content) ? content.map(part => ({ ...part })) : [];
}

function appendContent(target, incoming) {
  if (typeof target === 'string' && typeof incoming === 'string') {
    if (!incoming) return target;
    return target ? `${target}\n\n${incoming}` : incoming;
  }
  const merged = contentParts(target);
  for (const part of contentParts(incoming)) {
    const previous = merged.at(-1);
    if (part.type === 'text' && previous?.type === 'text') {
      previous.text = previous.text && part.text ? `${previous.text}\n\n${part.text}` : (previous.text || part.text);
    } else {
      merged.push(part);
    }
  }
  return merged;
}

/**
 * Aligns message layout with SillyTavern's `convertGooglePrompt` / `convertClaudeMessages`
 * before handing off to pi-ai (which otherwise collapses mid-chat `system` into top-level system).
 */
export function prepareNativeMessages(rawMessages, model, useSystemPrompt = true) {
  const google = model.api.startsWith('google-');
  const anthropic = model.api === 'anthropic-messages';
  if (!google && !anthropic) return rawMessages;

  const allowSysPrompt = useSystemPrompt !== false && !(google && /^gemma-?3/i.test(model.id ?? ''));
  const noPrefillModel = google && /gemini-3\.[67]-flash|gemini-3\.5-flash-lite/i.test(model.id ?? '');
  const rest = rawMessages.map(message => ({ ...message }));
  const leadingSystem = [];

  if (allowSysPrompt) {
    const minRemaining = google ? 1 : 0;
    while (rest.length > minRemaining && rest[0].role === 'system') {
      const next = rest.shift();
      const text = typeof next.content === 'string'
        ? formatNamedMessage(next)
        : contentParts(formatNamedMessage(next)).filter(part => part.type === 'text').map(part => part.text).join('\n\n');
      if (text) leadingSystem.push(text);
    }
  }

  const normalized = [];
  for (let index = 0; index < rest.length; index++) {
    const message = rest[index];
    if (message.role === 'tool') {
      normalized.push(message);
      continue;
    }
    const isPlainAssistant = message.role === 'assistant' && !message.tool_calls?.length && !message.reasoning_signature && !message.reasoning_content;
    let role = message.role;
    if (role === 'system') role = 'user';
    else if (role === 'assistant' && noPrefillModel && index === rest.length - 1 && !message.tool_calls?.length) role = 'user';

    const content = formatNamedMessage(message);
    const next = { ...message, role, content };
    delete next.name;

    const previous = normalized.at(-1);
    const previousPlainAssistant = previous?.role === 'assistant' && !previous.tool_calls?.length && !previous.reasoning_signature && !previous.reasoning_content;
    const canMergeUser = previous?.role === 'user' && role === 'user';
    const canMergeAssistant = anthropic && previousPlainAssistant && isPlainAssistant && role === 'assistant';
    if (canMergeUser || canMergeAssistant) {
      previous.content = appendContent(previous.content, next.content);
    } else {
      normalized.push(next);
    }
  }

  if (anthropic && (normalized.length === 0 || normalized[0].role !== 'user')) {
    normalized.unshift({ role: 'user', content: PROMPT_PLACEHOLDER });
  } else if (google && normalized.length === 0) {
    normalized.push({ role: 'user', content: PROMPT_PLACEHOLDER });
  }

  if (leadingSystem.length > 0) {
    normalized.unshift({ role: 'system', content: leadingSystem.join('\n\n') });
  }
  return normalized;
}

const emptyUsage = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
async function imageContent(url, signal) {
  const data = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  if (data) return { type: 'image', mimeType: data[1], data: data[2] };
  if (!/^https?:\/\//i.test(url)) throw new Error('图片必须是 data URL 或 HTTP(S) 地址');
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`读取提示词图片失败 (${response.status})`);
  return { type: 'image', mimeType: response.headers.get('content-type')?.split(';')[0] || 'image/png',
    data: Buffer.from(await response.arrayBuffer()).toString('base64') };
}
async function contextFor(payload, model, signal) {
  const { normalizeContext } = await import('@earendil-works/pi-ai/utils/transcript');
  const preparedMessages = prepareNativeMessages(payload.messages, model, payload.useSystemPrompt);
  const messages = await Promise.all(preparedMessages.map(async (message, index) => {
    const parts = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content ?? [];
    const content = await Promise.all(parts.map(part => part.type === 'image_url' ? imageContent(part.image_url.url, signal)
      : { type: 'text', text: String(part.text ?? '') }));
    if (message.name && content[0]?.type === 'text') content[0].text = `${message.name}: ${content[0].text}`;
    if (message.role === 'system') return { role: 'system', content: content.filter(part => part.type === 'text'), timestamp: index };
    if (message.role === 'tool') return { role: 'toolResult', toolCallId: message.tool_call_id,
      toolName: message.name, isError: !!message.isError, content, timestamp: index };
    if (message.role === 'assistant') {
      if (message.reasoning_content || message.reasoning_signature) content.unshift({ type: 'thinking', thinking: message.reasoning_content ?? '',
        thinkingSignature: message.reasoning_signature });
      for (const tool of message.tool_calls ?? []) {
        let args = {};
        try { const input = JSON.parse(tool.function.arguments); if (input && typeof input === 'object' && !Array.isArray(input)) args = input; } catch {}
        content.push({ type: 'toolCall', id: tool.id, name: tool.function.name, arguments: args, thoughtSignature: tool.thought_signature });
      }
      return { role: 'assistant', content: content.filter(part => part.type !== 'text' || part.text), timestamp: index, api: model.api,
        provider: model.provider, model: model.id, usage: emptyUsage(), stopReason: message.tool_calls?.length ? 'toolUse' : 'stop' };
    }
    return { role: 'user', content, timestamp: index };
  }));
  const tools = (payload.parameters?.tools ?? []).map(tool => ({ name: tool.function.name,
    description: tool.function.description ?? '', parameters: tool.function.parameters ?? { type: 'object', properties: {} } }));
  return normalizeContext({ messages, ...(tools.length ? { tools } : {}) });
}

export function removePath(object, path) {
  const parts = String(path).split('.');
  if (parts.some(key => ['__proto__', 'constructor', 'prototype'].includes(key))) return;
  let target = object;
  for (const key of parts.slice(0, -1)) { target = target?.[key]; if (!target) return; }
  if (target && typeof target === 'object') delete target[parts.at(-1)];
}
function requestOptions(payload, model, signal) {
  const parameters = payload.parameters ?? {};
  const { response_format: overrideFormat, reasoning_effort: overrideReasoning, thinking: overrideThinking, ...includeBody } = payload.includeBody ?? {};
  const format = overrideFormat ?? parameters.response_format;
  const level = overrideThinking?.type === 'disabled' ? 'off' : overrideReasoning ?? payload.provider?.thinkingLevel ?? parameters.reasoning_effort;
  const google = model.api.startsWith('google-');
  return { signal, apiKey: payload.apiKey || undefined, headers: payload.includeHeaders, maxRetries: 0, env: payload.provider?.env,
    ...(payload.stream === false && ['openai-completions', 'openai-responses', 'anthropic-messages'].includes(model.api) ? { fetch: createPiNonStreamingFetch(model.api) } : {}),
    transport: 'sse', temperature: parameters.temperature, maxTokens: parameters.max_tokens,
    ...(level && !['default', 'auto', 'none', 'off'].includes(level) ? { reasoning: level } : {}),
    onPayload(body) {
      if (google) {
        body.config ??= {};
        for (const [key, native] of Object.entries({ top_p: 'topP', top_k: 'topK', frequency_penalty: 'frequencyPenalty', presence_penalty: 'presencePenalty', seed: 'seed' })) {
          if (parameters[key] !== undefined && !(key === 'top_k' && parameters[key] === 0)) body.config[native] = parameters[key];
        }
        if (format) { body.config.responseMimeType = 'application/json'; if (format.json_schema) body.config.responseJsonSchema = format.json_schema.schema; }
        if (parameters.tool_choice) body.config.toolConfig = { functionCallingConfig: {
          mode: parameters.tool_choice === 'required' || typeof parameters.tool_choice === 'object' ? 'ANY' : parameters.tool_choice.toUpperCase(),
          ...(parameters.tool_choice?.function?.name ? { allowedFunctionNames: [parameters.tool_choice.function.name] } : {}) } };
        if (['none', 'off'].includes(level)) body.config.thinkingConfig = { thinkingBudget: 0 };
        const { generationConfig, safetySettings, ...overrides } = includeBody;
        Object.assign(body.config, generationConfig);
        body.config.safetySettings = safetySettings ?? body.config.safetySettings ?? defaultGoogleSafetySettings(model.api);
        Object.assign(body, overrides);
        if (overrideThinking && overrideThinking.type !== 'disabled') body.config.thinkingConfig = overrideThinking;
      } else if (model.api === 'anthropic-messages') {
        for (const key of ['top_p', 'top_k', 'stop_sequences']) if (parameters[key] !== undefined && parameters[key] !== 0) body[key] = parameters[key];
        if (format?.json_schema) body.output_config = { ...body.output_config, format: { type: 'json_schema', schema: format.json_schema.schema } };
        if (format?.type === 'json_object') throw new Error('Anthropic 原厂接口需要 JSON Schema，请选择“格式化输出”');
        if (parameters.tool_choice) body.tool_choice = typeof parameters.tool_choice === 'object'
          ? { type: 'tool', name: parameters.tool_choice.function.name } : { type: parameters.tool_choice === 'required' ? 'any' : parameters.tool_choice };
        if (['none', 'off'].includes(level)) body.thinking = { type: 'disabled' };
        if (overrideThinking) body.thinking = overrideThinking;
        Object.assign(body, includeBody);
      } else {
        const { max_tokens, tools, tool_choice, response_format, reasoning_effort, ...sampling } = parameters;
        Object.assign(body, sampling);
        if (model.api.includes('responses')) {
          if (format) body.text = { ...body.text, format: format.json_schema ? { type: 'json_schema', ...format.json_schema, schema: format.json_schema.schema } : format };
          if (level && level !== 'default') body.reasoning = { ...body.reasoning, effort: level === 'off' ? 'none' : level };
        } else if (format) body.response_format = format;
        if (model.api === 'openai-completions' && level && level !== 'default') body.reasoning_effort = level === 'off' ? 'none' : level;
        if (tool_choice) body.tool_choice = model.api.includes('responses') && typeof tool_choice === 'object'
          ? { type: 'function', name: tool_choice.function.name } : tool_choice;
        Object.assign(body, includeBody);
      }
      for (const key of payload.excludeBody ?? []) removePath(body, key);
      return body;
    } };
}

function resultOf(message) {
  return { content: message.content.filter(part => part.type === 'text').map(part => part.text).join(''),
    reasoning: message.content.filter(part => part.type === 'thinking').map(part => part.thinking).join(''),
    reasoning_signature: message.content.find(part => part.type === 'thinking' && part.thinkingSignature)?.thinkingSignature,
    tool_calls: message.content.filter(part => part.type === 'toolCall').map(part => ({ id: part.id, type: 'function',
      function: { name: part.name, arguments: JSON.stringify(part.arguments) }, thought_signature: part.thoughtSignature })) };
}

/** Normalize SDK events at the gateway boundary; existing callers retain one response contract. */
export async function relayProviderCompletion(payload, response, signal) {
  const model = await resolveModel(payload);
  const adapter = await adapters[model.api]();
  const context = await contextFor(payload, model, signal);
  signal.throwIfAborted();
  if (Number(payload.parameters?.n) > 1) throw new Error('当前原厂协议只支持单个候选，请将预设回复数量设为 1；OpenAI 兼容接口支持多个候选');
  const stream = adapter.streamSimple(model, context, requestOptions(payload, model, signal));
  const streaming = payload.stream !== false;
  if (streaming) response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' });
  const send = async value => { if (!response.write(`data: ${JSON.stringify(value)}\n\n`)) await once(response, 'drain', { signal }); };
  for await (const event of stream) {
    signal.throwIfAborted();
    if (event.type === 'error') throw new Error(event.error.errorMessage || '模型请求失败');
    if (streaming && (event.type === 'text_delta' || event.type === 'thinking_delta')) await send({ choices: [{ delta: {
      [event.type === 'text_delta' ? 'content' : 'reasoning_content']: event.delta } }] });
    if (event.type === 'done') {
      const result = resultOf(event.message);
      if (streaming) {
        await send({ choices: [{ delta: { tool_calls: result.tool_calls, reasoning_signature: result.reasoning_signature }, finish_reason: event.reason }] });
        response.end('data: [DONE]\n\n');
      } else {
        response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ choices: [{ message: { ...result, reasoning_content: result.reasoning } }] }));
      }
      return;
    }
  }
  throw new Error('模型连接结束但未返回完整回复');
}

export async function providerCatalog(provider) {
  const { getBuiltinProviders, getBuiltinModels } = await import('@earendil-works/pi-ai/providers/all');
  return { providers: getBuiltinProviders(), models: provider ? getBuiltinModels(provider).map(({ id, api, contextWindow, maxTokens, reasoning }) => ({ id, api, contextWindow, maxTokens, reasoning })) : [] };
}

export async function fetchModelList(payload) {
  if (payload.provider) return { data: (await providerCatalog(payload.provider.provider)).models };
  let base = String(payload.baseUrl).trim().replace(/\/+$/, '').replace(/\/(?:chat\/completions|messages|responses|embeddings|models)$/, '');
  const source = payload.source ?? 'openai';
  const headers = { ...payload.includeHeaders };
  if (['claude', 'anthropic'].includes(source)) {
    if (!base.endsWith('/v1')) base += '/v1';
    Object.assign(headers, { 'x-api-key': payload.apiKey ?? '', 'anthropic-version': '2023-06-01' });
  } else if (['makersuite', 'gemini'].includes(source)) headers['x-goog-api-key'] = payload.apiKey ?? '';
  else if (payload.apiKey) headers.Authorization = `Bearer ${payload.apiKey}`;
  Object.assign(headers, payload.includeHeaders);
  const endpoint = new URL(`${base}/models`);
  if (!['http:', 'https:'].includes(endpoint.protocol)) throw new Error('模型列表地址必须为 HTTP(S)');
  const response = await fetch(endpoint, { headers, signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`模型列表请求失败 (${response.status})`);
  const result = await response.json();
  return Array.isArray(result) ? { data: result } : { ...result, data: result.data ?? result.models ?? [] };
}

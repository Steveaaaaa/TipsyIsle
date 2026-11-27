import type { StreamCompletionRequest } from './platform-bridge';
import { platformFetch } from './native-runtime';
import { excludeRequestFields } from './request-fields';

function resolveResponsesUrl(baseUrl: string): string {
    const rawBase = (baseUrl || 'https://api.openai.com/v1').trim().replace(/\/+$/, '').replace(/\/chat\/completions$/, '');
    const parsed = new URL(rawBase);
    const cleanPath = parsed.pathname.replace(/\/+$/, '');
    return cleanPath.endsWith('/responses')
        ? rawBase
        : cleanPath === ''
          ? `${rawBase}/v1/responses`
          : `${rawBase}/responses`;
}

/** Sends a direct HTTP request to an OpenAI Responses compatible `/v1/responses` endpoint. */
export function requestOpenAiResponsesCompletion(request: StreamCompletionRequest): Promise<Response> {
    const url = resolveResponsesUrl(request.baseUrl);
    const useSystemPrompt = request.useSystemPrompt !== false;
    const rows = [...request.messages];
    const leadingSystem: string[] = [];
    if (useSystemPrompt) {
        while (rows.length > 0 && rows[0].role === 'system') {
            const next = rows.shift()!;
            if (typeof next.content === 'string' && next.content.trim()) leadingSystem.push(next.content);
        }
    }

    const input: Array<Record<string, unknown>> = [];
    for (const row of rows) {
        if (row.role === 'tool') {
            input.push({
                type: 'function_call_output',
                call_id: row.tool_call_id,
                output: row.content,
            });
            continue;
        }
        if ('tool_calls' in row && row.tool_calls?.length) {
            if (row.content) input.push({ role: 'assistant', content: row.content });
            for (const call of row.tool_calls) {
                input.push({
                    type: 'function_call',
                    call_id: call.id,
                    name: call.function.name,
                    arguments: call.function.arguments || '{}',
                });
            }
            continue;
        }
        if ('sourceId' in row && row.images?.length) {
            input.push({
                role: 'user',
                content: [
                    ...(row.content ? [{ type: 'input_text', text: row.content }] : []),
                    ...row.images.map(image_url => ({ type: 'input_image', image_url })),
                ],
            });
            continue;
        }
        const role = row.role === 'system' && !useSystemPrompt ? 'user' : row.role;
        input.push({ role, content: row.content });
    }

    const tools = Array.isArray(request.parameters.tools)
        ? request.parameters.tools.map((tool: any) => ({
              type: 'function',
              name: tool.function.name,
              description: tool.function.description,
              parameters: tool.function.parameters,
          }))
        : undefined;

    const reasoningEffort = typeof request.parameters.reasoning_effort === 'string' && request.parameters.reasoning_effort !== 'auto'
        ? request.parameters.reasoning_effort === 'max' ? 'high' : request.parameters.reasoning_effort
        : undefined;

    const body: Record<string, unknown> = {
        model: request.model,
        input,
        ...(leadingSystem.length ? { instructions: leadingSystem.join('\n\n') } : {}),
        stream: request.stream !== false,
        ...(request.parameters.max_tokens !== undefined
            ? { max_output_tokens: request.parameters.max_tokens }
            : request.parameters.max_output_tokens !== undefined
              ? { max_output_tokens: request.parameters.max_output_tokens }
              : {}),
        ...(request.parameters.temperature !== undefined ? { temperature: request.parameters.temperature } : {}),
        ...(request.parameters.top_p !== undefined ? { top_p: request.parameters.top_p } : {}),
        ...(reasoningEffort ? { reasoning: { effort: reasoningEffort, summary: 'auto' } } : {}),
        ...(tools ? { tools } : {}),
        ...request.includeBody,
    };
    excludeRequestFields(body, request.excludeBody);

    return platformFetch(url, {
        method: 'POST',
        redirect: 'error',
        credentials: 'omit',
        signal: request.signal,
        headers: {
            'Content-Type': 'application/json',
            ...(request.apiKey ? { Authorization: `Bearer ${request.apiKey}` } : {}),
            ...request.includeHeaders,
        },
        body: JSON.stringify(body),
    });
}

function extractMessageText(item: any): string {
    return (item?.content ?? [])
        .map((part: any) => (part?.type === 'output_text' || part?.type === 'text' ? part?.text : part?.refusal) ?? '')
        .join('');
}

function extractReasoningText(item: any): string {
    return [...(item?.summary ?? []), ...(item?.content ?? [])]
        .map((part: any) => part?.text ?? '')
        .join('');
}

/** Adapts OpenAI Responses SSE events and JSON responses into Chat Completions shape. */
export function openAiResponsesReplyAdapter() {
    let sawTextDelta = false;
    let sawReasoningDelta = false;
    let nextToolIndex = 0;
    const toolIndices = new Map<string, number>();

    const registerToolIndex = (item: any, outputIndex?: unknown): number => {
        const keys = [item?.id, item?.call_id, outputIndex !== undefined ? String(outputIndex) : undefined]
            .filter((value): value is string => typeof value === 'string' && value.length > 0);
        for (const key of keys) {
            const existing = toolIndices.get(key);
            if (existing !== undefined) return existing;
        }
        const index = nextToolIndex++;
        for (const key of keys) toolIndices.set(key, index);
        return index;
    };

    const lookupToolIndex = (itemId?: unknown, outputIndex?: unknown): number | undefined => {
        for (const key of [itemId, outputIndex !== undefined ? String(outputIndex) : undefined]) {
            if (typeof key === 'string' && toolIndices.has(key)) return toolIndices.get(key);
        }
        return undefined;
    };

    return (packet: any, streaming: boolean): any => {
        if (!streaming) {
            if (packet?.error || packet?.status === 'failed') {
                return { error: packet?.error ?? { message: 'Responses 请求失败' } };
            }
            const output = Array.isArray(packet?.output) ? packet.output : [];
            const content = output.filter((i: any) => i?.type === 'message').map(extractMessageText).join('')
                || (typeof packet?.output_text === 'string' ? packet.output_text : '');
            const reasoning_content = output.filter((i: any) => i?.type === 'reasoning').map(extractReasoningText).join('');
            const tool_calls = output
                .filter((i: any) => i?.type === 'function_call')
                .map((i: any) => ({
                    id: i.call_id || i.id || '',
                    type: 'function',
                    function: {
                        name: i.name ?? '',
                        arguments: typeof i.arguments === 'string' ? i.arguments : JSON.stringify(i.arguments ?? {}),
                    },
                }));
            const finish_reason = packet?.status === 'incomplete' && packet?.incomplete_details?.reason === 'max_output_tokens'
                ? 'length'
                : 'stop';
            return {
                choices: [{
                    index: 0,
                    finish_reason,
                    message: {
                        content,
                        reasoning_content,
                        ...(tool_calls.length ? { tool_calls } : {}),
                    },
                }],
            };
        }

        if (packet?.error || packet?.type === 'error' || packet?.type === 'response.failed') {
            return { error: packet?.error ?? packet?.response?.error ?? { message: 'Responses 流式请求失败' } };
        }

        switch (packet?.type) {
            case 'response.output_text.delta':
                sawTextDelta = true;
                return { choices: [{ index: 0, delta: { content: packet.delta ?? '' } }] };
            case 'response.reasoning_summary_text.delta':
            case 'response.reasoning_text.delta':
                sawReasoningDelta = true;
                return { choices: [{ index: 0, delta: { reasoning_content: packet.delta ?? '' } }] };
            case 'response.output_item.added':
                if (packet.item?.type === 'function_call') {
                    const index = registerToolIndex(packet.item, packet.output_index);
                    return {
                        choices: [{
                            index: 0,
                            delta: {
                                tool_calls: [{
                                    index,
                                    id: packet.item.call_id || packet.item.id || '',
                                    type: 'function',
                                    function: {
                                        name: packet.item.name ?? '',
                                        arguments: typeof packet.item.arguments === 'string' ? packet.item.arguments : '',
                                    },
                                }],
                            },
                        }],
                    };
                }
                return { choices: [] };
            case 'response.function_call_arguments.delta': {
                const index = lookupToolIndex(packet.item_id, packet.output_index) ?? registerToolIndex({ id: packet.item_id }, packet.output_index);
                return {
                    choices: [{
                        index: 0,
                        delta: {
                            tool_calls: [{ index, function: { arguments: packet.delta ?? '' } }],
                        },
                    }],
                };
            }
            case 'response.output_item.done': {
                const item = packet.item;
                if (item?.type === 'message' && !sawTextDelta) {
                    const content = extractMessageText(item);
                    if (content) return { choices: [{ index: 0, delta: { content } }] };
                }
                if (item?.type === 'reasoning' && !sawReasoningDelta) {
                    const reasoning_content = extractReasoningText(item);
                    if (reasoning_content) return { choices: [{ index: 0, delta: { reasoning_content } }] };
                }
                if (item?.type === 'function_call' && lookupToolIndex(item.id ?? item.call_id, packet.output_index) === undefined) {
                    const index = registerToolIndex(item, packet.output_index);
                    return {
                        choices: [{
                            index: 0,
                            delta: {
                                tool_calls: [{
                                    index,
                                    id: item.call_id || item.id || '',
                                    type: 'function',
                                    function: {
                                        name: item.name ?? '',
                                        arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments ?? {}),
                                    },
                                }],
                            },
                        }],
                    };
                }
                return { choices: [] };
            }
            case 'response.completed':
            case 'response.incomplete':
                return {
                    choices: [{
                        index: 0,
                        finish_reason: packet.type === 'response.incomplete' && packet.response?.incomplete_details?.reason === 'max_output_tokens'
                            ? 'length'
                            : 'stop',
                        delta: {},
                    }],
                };
            default:
                return { choices: [] };
        }
    };
}

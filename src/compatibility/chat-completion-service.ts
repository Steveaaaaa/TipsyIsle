type SettingsForPreset = (name: string) => Record<string, unknown> | undefined;

function completionError(error: unknown, fallback: string): Error {
    return new Error(typeof error === 'string' ? error : String((error as { message?: string } | undefined)?.message ?? fallback));
}

async function* completionEvents(body: ReadableStream<Uint8Array>) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let pending = '';
    const parseEvent = (text: string) => text.split(/\r\n|\r|\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
    try {
        for (;;) {
            const { done, value } = await reader.read();
            pending += done ? decoder.decode() : decoder.decode(value, { stream: true });
            let delimiter: RegExpExecArray | null;
            while ((delimiter = /\r?\n\r?\n/.exec(pending))) {
                const data = parseEvent(pending.slice(0, delimiter.index));
                pending = pending.slice(delimiter.index + delimiter[0].length);
                if (data.trim() === '[DONE]') return;
                if (data) yield JSON.parse(data);
            }
            if (done) {
                const data = parseEvent(pending);
                if (data && data.trim() !== '[DONE]') yield JSON.parse(data);
                return;
            }
        }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export function createChatCompletionService(preset: SettingsForPreset) {
    async function sendRequest(data: Record<string, any>, extractData = true, signal?: AbortSignal | null) {
        const response = await window.fetch('/api/backends/chat-completions/generate', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data), signal,
        });
        if (!response.ok || !data.stream || response.headers.get('Content-Type')?.includes('application/json')) {
            const result = await response.json().catch(() => null);
            if (!response.ok || result?.error || !result) throw completionError(result?.error, `HTTP ${response.status}`);
            const message = result.choices?.[0]?.message ?? {};
            if (data.stream) return async function* () {
                yield { text: message.content ?? '', swipes: [], state: { reasoning: message.reasoning_content ?? message.reasoning ?? '', image: '' } };
            };
            if (!extractData) return result;
            return { content: data.json_schema ? JSON.parse(message.content) : message.content ?? '', reasoning: message.reasoning_content ?? message.reasoning ?? '' };
        }
        if (!response.body) throw new Error('模型没有返回流式数据');
        const events = completionEvents(response.body);
        return async function* () {
            let text = '', reasoning = '';
            const swipes: string[] = [];
            for await (const event of events) {
                if (event.error) throw completionError(event.error, '模型请求失败');
                for (const choice of event.choices ?? []) {
                    const part = choice.delta ?? choice.message ?? {};
                    if (choice.index > 0) swipes[choice.index - 1] = (swipes[choice.index - 1] ?? '') + (part.content ?? '');
                    else { text += part.content ?? ''; reasoning += part.reasoning_content ?? part.reasoning ?? ''; }
                }
                yield { text, swipes: [...swipes], state: { reasoning, image: '' } };
            }
        };
    }
    return { TYPE: 'openai', sendRequest, processRequest: (data: Record<string, any>, options: { presetName?: string } = {}, extractData = true, signal?: AbortSignal | null) =>
        sendRequest({ stream: false, ...(options.presetName ? preset(options.presetName) : undefined), ...data }, extractData, signal) };
}

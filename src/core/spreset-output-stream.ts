import type { SPresetOutputPreprocessing } from '../compatibility/spreset-config';
import { compileSPresetFn } from '../compatibility/spreset-runtime';
import type { CompletionToolCall } from './platform-bridge';

export interface SPresetNormalizedToolCall {
    id: string;
    type: 'function';
    name: string;
    arguments: string;
    function: {
        name: string;
        arguments: string;
    };
}

export interface SPresetFinalizedCandidate {
    content: string;
    toolCalls?: CompletionToolCall[];
    consumed: boolean;
}

export interface SPresetOutputProcessor {
    onTextDelta(deltaContent: string): string;
    onToolCallsDelta(toolCalls: CompletionToolCall[]): string | null;
    finalize(finalContent: string, finalToolCalls?: CompletionToolCall[]): SPresetFinalizedCandidate;
}

/** Returns true when SPreset output post-processing or tool-call consumption is active. */
export function hasActiveSPresetOutput(config: SPresetOutputPreprocessing | undefined | null): boolean {
    if (!config) return false;
    return Boolean(
        (config.enabled && config.script?.trim())
        || config.consumeToolCalls
        || (config.toolCallFormatter?.enabled && config.toolCallFormatter.script?.trim()),
    );
}

/**
 * Exposes both flat `{ name, arguments }` (SPreset convention) and nested `{ function: { name, arguments } }`
 * (OpenAI convention) on every tool call passed into `toolCallFormatter.script`.
 */
export function normalizeSPresetToolCalls(calls: CompletionToolCall[]): SPresetNormalizedToolCall[] {
    return calls.map((call) => {
        const name = String(call?.function?.name ?? '');
        const args = String(call?.function?.arguments ?? '');
        return {
            id: String(call?.id ?? ''),
            type: 'function',
            name,
            arguments: args,
            function: {
                name,
                arguments: args,
            },
        };
    });
}

function defaultFormatToolCalls(calls: SPresetNormalizedToolCall[], defaultText: string): string {
    const rendered = calls
        .map((call) => {
            try {
                const parsed = JSON.parse(call.arguments);
                if (parsed && typeof parsed === 'object') {
                    return Object.values(parsed)
                        .filter((v) => typeof v === 'string' && v.trim())
                        .join('\n');
                }
            } catch {
                // Keep partial raw arguments below when JSON is not closed yet.
            }
            return call.arguments;
        })
        .filter(Boolean)
        .join('\n\n');
    return rendered || defaultText;
}

type FormatterFn = (ctx: { calls: SPresetNormalizedToolCall[]; defaultText: string }) => string;
type PreprocessFn = (ctx: {
    buffer: string;
    final: boolean;
    state?: Record<string, unknown>;
}) => string | { output?: string; hold?: string; state?: Record<string, unknown> };

/**
 * Creates a stateful SPreset streaming/non-streaming output processor handling:
 * 1) `consumeToolCalls` + `toolCallFormatter.script` (aborting consumption on thrown passthrough errors), and
 * 2) `OutputPreprocessing.script({ buffer, final, state })`.
 */
export function createSPresetOutputProcessor(
    config: SPresetOutputPreprocessing | undefined | null,
): SPresetOutputProcessor {
    const formatterEnabled = Boolean(config?.toolCallFormatter?.enabled && config?.toolCallFormatter?.script?.trim());
    const preprocessEnabled = Boolean(config?.enabled && config?.script?.trim());
    const consumeToolCalls = Boolean(config?.consumeToolCalls);

    const formatterFn = formatterEnabled
        ? compileSPresetFn<FormatterFn>(config!.toolCallFormatter!.script!, 'toolCallFormatter')
        : undefined;
    const preprocessFn = preprocessEnabled
        ? compileSPresetFn<PreprocessFn>(config!.script!, 'OutputPreprocessing')
        : undefined;

    let rawTextBuffer = '';
    let latestToolCalls: CompletionToolCall[] = [];
    let passthrough = false;
    let preprocessState: Record<string, unknown> = {};
    let lastEmittedText = '';

    const formatPayload = (text: string, calls: CompletionToolCall[]): { formatted: string; consumed: boolean } => {
        if (!consumeToolCalls || !calls.length || passthrough) {
            return { formatted: text, consumed: false };
        }
        const normalized = normalizeSPresetToolCalls(calls);
        if (formatterFn) {
            try {
                const result = formatterFn({ calls: normalized, defaultText: text });
                return {
                    formatted: typeof result === 'string' ? result : String(result ?? ''),
                    consumed: true,
                };
            } catch {
                // Thrown exceptions (e.g. 'External tool call passthrough') signal that these tool calls
                // belong to external consumers like MVU and must not be consumed.
                passthrough = true;
                return { formatted: text, consumed: false };
            }
        }
        return {
            formatted: defaultFormatToolCalls(normalized, text),
            consumed: true,
        };
    };

    const runPreprocess = (bufferText: string, isFinal: boolean): string => {
        if (!preprocessFn) return bufferText;
        try {
            const result = preprocessFn({
                buffer: bufferText,
                final: isFinal,
                state: { ...preprocessState },
            });
            if (typeof result === 'string') return result;
            if (result && typeof result === 'object') {
                if (result.state && typeof result.state === 'object') {
                    preprocessState = { ...result.state };
                }
                const out = typeof result.output === 'string' ? result.output : '';
                if (!isFinal && !out && typeof result.hold === 'string' && result.hold && lastEmittedText) {
                    return lastEmittedText;
                }
                return out;
            }
        } catch {
            // Preserve bufferText on unexpected preprocessing errors rather than dropping reply text.
        }
        return bufferText;
    };

    const evaluateCurrent = (isFinal: boolean): { text: string; consumed: boolean } => {
        const { formatted, consumed } = formatPayload(rawTextBuffer, latestToolCalls);
        const processed = runPreprocess(formatted, isFinal);
        lastEmittedText = processed;
        return { text: processed, consumed };
    };

    return {
        onTextDelta(deltaContent: string): string {
            if (deltaContent) rawTextBuffer += deltaContent;
            return evaluateCurrent(false).text;
        },
        onToolCallsDelta(toolCalls: CompletionToolCall[]): string | null {
            latestToolCalls = toolCalls;
            const prevPassthrough = passthrough;
            const prevText = lastEmittedText;
            const { text, consumed } = evaluateCurrent(false);
            if (!consumed && passthrough && !prevPassthrough) return null;
            return text === prevText ? null : text;
        },
        finalize(finalContent: string, finalToolCalls?: CompletionToolCall[]): SPresetFinalizedCandidate {
            if (typeof finalContent === 'string' && finalContent.length >= rawTextBuffer.length) {
                rawTextBuffer = finalContent;
            }
            if (Array.isArray(finalToolCalls)) {
                latestToolCalls = finalToolCalls;
            }
            const { text, consumed } = evaluateCurrent(true);
            return {
                content: text,
                toolCalls: consumed ? undefined : finalToolCalls,
                consumed,
            };
        },
    };
}

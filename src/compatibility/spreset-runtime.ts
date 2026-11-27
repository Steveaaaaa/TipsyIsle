import {
    hasActiveSPreset,
    readSPresetConfig,
    type SPresetConfig,
    type SPresetOutputPreprocessing,
} from './spreset-config';

export interface SPresetFinalRequestInput {
    request: Record<string, any>;
    rawPreset: Record<string, any>;
}

export interface SPresetFinalRequestOutput {
    request: Record<string, any>;
    outputPreprocessing?: SPresetOutputPreprocessing;
    applied: boolean;
    deletedReasoningEffort: boolean;
}

/**
 * Compiles an SPreset JS callback expression (`({ ... }) => ...` or `async ({ ... }) => ...`).
 */
export function compileSPresetFn<T extends (...args: any[]) => any>(code: string, label: string): T {
    const trimmed = String(code ?? '').trim();
    if (!trimmed) throw new Error(`SPreset ${label} 脚本为空`);
    const expr = trimmed.replace(/;+\s*$/, '');
    try {
        const fn = new Function(`"use strict"; return (\n${expr}\n);`)();
        if (typeof fn === 'function') return fn as T;
    } catch {
        // Fall through to statement-body wrapper if author wrote a function body.
    }
    try {
        const fn = new Function('arg', `"use strict";\n${trimmed}`);
        return fn as unknown as T;
    } catch (error) {
        throw new Error(`SPreset ${label} 脚本编译失败：${error instanceof Error ? error.message : String(error)}`);
    }
}

/**
 * Evaluates a `ToolBindings[promptId]` code block (either `return { ... }` body or JSON/expression descriptor)
 * into an OpenAI-style `{ type: 'function', function: { name, description, parameters } }` definition.
 */
function evaluateToolBindingDescriptor(code: string): Record<string, any> | null {
    const trimmed = String(code ?? '').trim();
    if (!trimmed) return null;
    let descriptor: any;
    try {
        descriptor = new Function(`"use strict";\n${trimmed}`)();
    } catch {
        descriptor = new Function(`"use strict"; return (\n${trimmed}\n);`)();
    }
    if (!descriptor || typeof descriptor !== 'object') return null;
    if (descriptor.type === 'function' && descriptor.function && typeof descriptor.function === 'object') {
        return {
            type: 'function',
            function: {
                name: String(descriptor.function.name ?? ''),
                description: typeof descriptor.function.description === 'string' ? descriptor.function.description : '',
                parameters: descriptor.function.parameters ?? { type: 'object', properties: {} },
            },
        };
    }
    if (typeof descriptor.name === 'string' && descriptor.name.trim()) {
        return {
            type: 'function',
            function: {
                name: descriptor.name.trim(),
                description: typeof descriptor.description === 'string' ? descriptor.description : '',
                parameters: descriptor.parameters ?? { type: 'object', properties: {} },
            },
        };
    }
    return null;
}

function isPromptOrderEnabled(rawPreset: Record<string, any> | undefined, identifier: string): boolean {
    if (!rawPreset || !Array.isArray(rawPreset.prompt_order)) return true;
    const orders = rawPreset.prompt_order as Array<{ character_id?: number; order?: Array<{ identifier?: string; enabled?: boolean }> }>;
    const group = orders.find((o) => Number(o?.character_id) === 100001) ?? orders[0];
    if (!Array.isArray(group?.order)) return true;
    const entry = group.order.find((item) => item?.identifier === identifier);
    return entry ? entry.enabled !== false : true;
}

/** Injects enabled SPreset `ToolBindings` into `request.tools` without duplicating existing tool names. */
export function applySPresetToolBindings(
    request: Record<string, any>,
    config: SPresetConfig,
    rawPreset?: Record<string, any>,
): void {
    const bindings = config.toolBindings;
    if (!bindings) return;
    const existingTools = Array.isArray(request.tools) ? [...request.tools] : [];
    const seenNames = new Set(
        existingTools
            .map((tool) => String(tool?.function?.name ?? tool?.name ?? '').trim())
            .filter(Boolean),
    );
    let added = false;
    for (const [promptId, binding] of Object.entries(bindings)) {
        if (!binding?.enabled || !binding.code?.trim()) continue;
        if (!isPromptOrderEnabled(rawPreset, promptId)) continue;
        try {
            const toolDef = evaluateToolBindingDescriptor(binding.code);
            const toolName = String(toolDef?.function?.name ?? '').trim();
            if (!toolDef || !toolName || seenNames.has(toolName)) continue;
            existingTools.push(toolDef);
            seenNames.add(toolName);
            added = true;
        } catch {
            // Skip malformed tool descriptor rather than crashing unrelated generation.
        }
    }
    if (added) request.tools = existingTools;
}

/** Applies SPreset `ChatSquash` when explicitly enabled. */
export function applySPresetChatSquash(request: Record<string, any>, config: SPresetConfig): void {
    const squash = config.chatSquash;
    if (!squash?.enabled || !Array.isArray(request.messages) || request.messages.length === 0) return;
    const separate = typeof squash.separate === 'string' ? squash.separate : '\n\n';
    const targetRole = typeof squash.role === 'string' && squash.role.trim() ? squash.role.trim() : 'user';
    const preserveSystem = squash.preserveSystem !== false;
    const prefix = typeof squash.prefix === 'string' ? squash.prefix : '';
    const suffix = typeof squash.suffix === 'string' ? squash.suffix : '';

    const keptSystem: any[] = [];
    const textChunks: string[] = [];
    const mediaParts: any[] = [];

    for (const msg of request.messages) {
        if (!msg || typeof msg !== 'object') continue;
        if (preserveSystem && msg.role === 'system' && keptSystem.length === textChunks.length && textChunks.length === 0) {
            keptSystem.push(msg);
            continue;
        }
        if (typeof msg.content === 'string') {
            if (msg.content) textChunks.push(msg.content);
        } else if (Array.isArray(msg.content)) {
            const texts: string[] = [];
            for (const part of msg.content) {
                if (typeof part === 'string') texts.push(part);
                else if (part?.type === 'text') texts.push(String(part.text ?? ''));
                else if (part && typeof part === 'object') mediaParts.push(part);
            }
            const joined = texts.join('');
            if (joined) textChunks.push(joined);
        }
    }

    const squashedText = `${prefix}${textChunks.join(separate)}${suffix}`;
    const squashedMessage = mediaParts.length > 0
        ? { role: targetRole, content: [...(squashedText ? [{ type: 'text', text: squashedText }] : []), ...mediaParts] }
        : { role: targetRole, content: squashedText };
    request.messages = [...keptSystem, squashedMessage];
}

function sanitizeStructuredRequest(value: unknown): Record<string, any> {
    return JSON.parse(JSON.stringify(value ?? {}));
}

/**
 * Executes SPreset request pipeline inside the compatibility window realm:
 * `ChatSquash` -> `ToolBindings` -> `FinalRequestProcessing.script({ request })`.
 */
export async function runSPresetFinalRequestInRealm(
    args: SPresetFinalRequestInput,
): Promise<SPresetFinalRequestOutput> {
    const { request, rawPreset } = args;
    const config = readSPresetConfig(rawPreset);
    if (!config || !hasActiveSPreset(rawPreset)) {
        return { request, applied: false, deletedReasoningEffort: false };
    }

    const draft = structuredClone(request ?? {});
    const hadReasoningEffort = Object.prototype.hasOwnProperty.call(draft, 'reasoning_effort');

    applySPresetChatSquash(draft, config);
    applySPresetToolBindings(draft, config, rawPreset);

    let finalRequest = draft;
    if (config.finalRequestProcessing?.enabled && config.finalRequestProcessing.script?.trim()) {
        const hook = compileSPresetFn<(ctx: { request: Record<string, any> }) => Promise<Record<string, any> | void> | Record<string, any> | void>(
            config.finalRequestProcessing.script,
            'FinalRequestProcessing',
        );
        const returned = await hook({ request: draft });
        if (returned && typeof returned === 'object' && !Array.isArray(returned)) {
            finalRequest = returned;
        }
    }

    const deletedReasoningEffort =
        hadReasoningEffort && !Object.prototype.hasOwnProperty.call(finalRequest, 'reasoning_effort');

    return {
        request: sanitizeStructuredRequest(finalRequest),
        outputPreprocessing: config.outputPreprocessing,
        applied: true,
        deletedReasoningEffort,
    };
}

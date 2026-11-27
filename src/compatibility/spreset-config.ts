export interface SPresetToolBinding {
    enabled?: boolean;
    code?: string;
    valid?: boolean;
    uuid?: string;
    resolvedName?: string;
    editorMode?: string;
    form?: Record<string, unknown>;
}

export interface SPresetToolCallFormatter {
    enabled?: boolean;
    script?: string;
}

export interface SPresetOutputPreprocessing {
    enabled?: boolean;
    script?: string;
    consumeToolCalls?: boolean;
    toolCallFormatter?: SPresetToolCallFormatter;
}

export interface SPresetFinalRequestProcessing {
    enabled?: boolean;
    script?: string;
}

export interface SPresetChatSquash {
    enabled?: boolean;
    separate?: string;
    role?: string;
    prefix?: string;
    suffix?: string;
    preserveSystem?: boolean;
    [key: string]: unknown;
}

export interface SPresetRegexBinding {
    enabled?: boolean;
    regexes?: unknown[];
}

export interface SPresetConfig {
    regexBinding?: SPresetRegexBinding;
    toolBindings?: Record<string, SPresetToolBinding>;
    finalRequestProcessing?: SPresetFinalRequestProcessing;
    outputPreprocessing?: SPresetOutputPreprocessing;
    chatSquash?: SPresetChatSquash;
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
}

function unwrapRawPreset(presetOrRaw: unknown): Record<string, unknown> | null {
    const record = asRecord(presetOrRaw);
    if (!record) return null;
    const rawData = asRecord(record.rawData);
    return rawData ?? record;
}

function normalizeToolCallFormatter(raw: unknown): SPresetToolCallFormatter | undefined {
    const obj = asRecord(raw);
    if (!obj) return undefined;
    return {
        enabled: obj.enabled !== undefined ? Boolean(obj.enabled) : undefined,
        script: typeof obj.script === 'string' ? obj.script : undefined,
    };
}

function normalizeOutputPreprocessing(raw: unknown): SPresetOutputPreprocessing | undefined {
    const obj = asRecord(raw);
    if (!obj) return undefined;
    return {
        enabled: obj.enabled !== undefined ? Boolean(obj.enabled) : undefined,
        script: typeof obj.script === 'string' ? obj.script : undefined,
        consumeToolCalls: obj.consumeToolCalls !== undefined ? Boolean(obj.consumeToolCalls) : undefined,
        toolCallFormatter: normalizeToolCallFormatter(obj.toolCallFormatter),
    };
}

function normalizeFinalRequestProcessing(raw: unknown): SPresetFinalRequestProcessing | undefined {
    const obj = asRecord(raw);
    if (!obj) return undefined;
    return {
        enabled: obj.enabled !== undefined ? Boolean(obj.enabled) : undefined,
        script: typeof obj.script === 'string' ? obj.script : undefined,
    };
}

function normalizeRegexBinding(raw: unknown): SPresetRegexBinding | undefined {
    const obj = asRecord(raw);
    if (!obj) return undefined;
    return {
        enabled: obj.enabled !== undefined ? Boolean(obj.enabled) : undefined,
        regexes: Array.isArray(obj.regexes) ? obj.regexes : undefined,
    };
}

function normalizeToolBindings(raw: unknown): Record<string, SPresetToolBinding> | undefined {
    const obj = asRecord(raw);
    if (!obj) return undefined;
    const result: Record<string, SPresetToolBinding> = {};
    for (const [key, value] of Object.entries(obj)) {
        const entry = asRecord(value);
        if (!entry) continue;
        result[key] = {
            enabled: entry.enabled !== undefined ? Boolean(entry.enabled) : undefined,
            code: typeof entry.code === 'string' ? entry.code : undefined,
            valid: entry.valid !== undefined ? Boolean(entry.valid) : undefined,
            uuid: typeof entry.uuid === 'string' ? entry.uuid : undefined,
            resolvedName: typeof entry.resolvedName === 'string' ? entry.resolvedName : undefined,
            editorMode: typeof entry.editorMode === 'string' ? entry.editorMode : undefined,
            form: asRecord(entry.form) ?? undefined,
        };
    }
    return Object.keys(result).length ? result : undefined;
}

function normalizeChatSquash(raw: unknown): SPresetChatSquash | undefined {
    const obj = asRecord(raw);
    if (!obj) return undefined;
    return { ...obj, enabled: obj.enabled !== undefined ? Boolean(obj.enabled) : undefined };
}

function parseSPresetSection(rawObj: Record<string, unknown> | null): SPresetConfig | null {
    if (!rawObj) return null;
    // Security & privacy: never read or execute LogUpload / logUpload telemetry config.
    const regexBinding = normalizeRegexBinding(rawObj.RegexBinding ?? rawObj.regexBinding);
    const toolBindings = normalizeToolBindings(rawObj.ToolBindings ?? rawObj.toolBindings);
    const finalRequestProcessing = normalizeFinalRequestProcessing(
        rawObj.FinalRequestProcessing ?? rawObj.finalRequestProcessing,
    );
    const outputPreprocessing = normalizeOutputPreprocessing(
        rawObj.OutputPreprocessing ?? rawObj.outputPreprocessing,
    );
    const chatSquash = normalizeChatSquash(rawObj.ChatSquash ?? rawObj.chatSquash);
    if (!regexBinding && !toolBindings && !finalRequestProcessing && !outputPreprocessing && !chatSquash) {
        return null;
    }
    return {
        ...(regexBinding ? { regexBinding } : {}),
        ...(toolBindings ? { toolBindings } : {}),
        ...(finalRequestProcessing ? { finalRequestProcessing } : {}),
        ...(outputPreprocessing ? { outputPreprocessing } : {}),
        ...(chatSquash ? { chatSquash } : {}),
    };
}

function readLegacySPresetPromptEntry(rawPreset: Record<string, unknown>): Record<string, unknown> | null {
    if (!Array.isArray(rawPreset.prompts)) return null;
    const entry = rawPreset.prompts.find(
        (item) => asRecord(item)?.identifier === 'SPresetSettings' && typeof asRecord(item)?.content === 'string',
    ) as { content?: string } | undefined;
    if (!entry?.content) return null;
    try {
        return asRecord(JSON.parse(entry.content));
    } catch {
        return null;
    }
}

/**
 * Reads SPreset configuration from `extensions.SPreset`, falling back to legacy `SPresetSettings` prompt JSON.
 * `LogUpload` is intentionally stripped and never surfaced.
 */
export function readSPresetConfig(presetOrRaw: unknown): SPresetConfig | null {
    const raw = unwrapRawPreset(presetOrRaw);
    if (!raw) return null;
    const ext = asRecord(raw.extensions);
    const primary = parseSPresetSection(asRecord(ext?.SPreset));
    const fallback = parseSPresetSection(readLegacySPresetPromptEntry(raw));
    if (!primary && !fallback) return null;
    if (!primary) return fallback;
    if (!fallback) return primary;
    return {
        regexBinding: primary.regexBinding ?? fallback.regexBinding,
        toolBindings: primary.toolBindings ?? fallback.toolBindings,
        finalRequestProcessing: primary.finalRequestProcessing ?? fallback.finalRequestProcessing,
        outputPreprocessing: primary.outputPreprocessing ?? fallback.outputPreprocessing,
        chatSquash: primary.chatSquash ?? fallback.chatSquash,
    };
}

/** Returns true when a preset enables any SPreset execution hook that needs compat runtime support. */
export function hasActiveSPreset(presetOrRaw: unknown): boolean {
    const config = readSPresetConfig(presetOrRaw);
    if (!config) return false;
    if (config.finalRequestProcessing?.enabled && config.finalRequestProcessing.script?.trim()) return true;
    if (config.outputPreprocessing?.enabled && config.outputPreprocessing.script?.trim()) return true;
    if (config.outputPreprocessing?.consumeToolCalls) return true;
    if (config.outputPreprocessing?.toolCallFormatter?.enabled && config.outputPreprocessing.toolCallFormatter.script?.trim()) return true;
    if (config.chatSquash?.enabled) return true;
    if (config.toolBindings && Object.values(config.toolBindings).some((binding) => binding.enabled && binding.code?.trim())) {
        return true;
    }
    return false;
}

/** Extracts enabled RegexBinding regexes from raw or normalized preset data. */
export function extractSPresetRegexScripts(presetOrRaw: unknown): unknown[] {
    const config = readSPresetConfig(presetOrRaw);
    if (!config?.regexBinding || config.regexBinding.enabled === false) return [];
    return Array.isArray(config.regexBinding.regexes) ? config.regexBinding.regexes : [];
}

/**
 * Identifies remote SPreset loader scripts (e.g. `regex_bind/inject.js`) that inject remote code into the page.
 * Legitimate inline author scripts such as `菜单` (`CatGodOracle`) are preserved.
 */
export function isRemoteSPresetInjectorScript(script: { name?: string; content?: string } | null | undefined): boolean {
    if (!script || typeof script.content !== 'string') return false;
    const content = script.content;
    if (/regex_bind\/inject\.js/i.test(content)) return true;
    if (/\bsrc\s*=\s*['"`][^'"`]*inject\.js/i.test(content) && (/^\s*spreset\s*$/i.test(script.name ?? '') || /regex_bind/i.test(content))) {
        return true;
    }
    return false;
}

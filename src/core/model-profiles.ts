export interface StoryConnectionProfile {
    id: string;
    name: string;
    source: string;
    baseUrl: string;
    apiKey: string;
    model: string;
    reasoningEffort: string;
    promptPostProcessing: string;
    useSystemPrompt: string;
}

export const DEFAULT_CONNECTION_PROFILE_VALUES = {
    source: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    model: 'gpt-4o',
    reasoningEffort: 'auto',
    promptPostProcessing: 'auto',
    useSystemPrompt: 'auto',
} as const;

const SOURCE_DEFAULTS: Record<string, { baseUrl: string; model: string }> = {
    openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o' },
    'openai-responses': { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o' },
    claude: { baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-4-20250514' },
    makersuite: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-2.5-pro' },
    vertexai: { baseUrl: '', model: 'gemini-2.5-pro' },
    deepseek: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
    openrouter: { baseUrl: 'https://openrouter.ai/api/v1', model: 'openai/gpt-4o' },
    custom: { baseUrl: '', model: '' },
};

const VALID_REASONING = new Set(['auto', 'low', 'medium', 'high', 'max']);
const VALID_POST_PROCESS = new Set(['auto', 'none', 'merge', 'merge_tools', 'semi', 'semi_tools', 'strict', 'strict_tools', 'single']);
const VALID_USE_SYSPROMPT = new Set(['auto', 'on', 'off']);

export function defaultParametersForSource(source: string): {
    source: string;
    baseUrl: string;
    model: string;
    reasoningEffort: string;
    promptPostProcessing: string;
    useSystemPrompt: string;
} {
    const normalized = String(source || DEFAULT_CONNECTION_PROFILE_VALUES.source).trim() || DEFAULT_CONNECTION_PROFILE_VALUES.source;
    const preset = SOURCE_DEFAULTS[normalized] ?? {
        baseUrl: DEFAULT_CONNECTION_PROFILE_VALUES.baseUrl,
        model: DEFAULT_CONNECTION_PROFILE_VALUES.model,
    };
    return {
        source: normalized,
        baseUrl: preset.baseUrl,
        model: preset.model,
        reasoningEffort: DEFAULT_CONNECTION_PROFILE_VALUES.reasoningEffort,
        promptPostProcessing: DEFAULT_CONNECTION_PROFILE_VALUES.promptPostProcessing,
        useSystemPrompt: DEFAULT_CONNECTION_PROFILE_VALUES.useSystemPrompt,
    };
}

function pickValid(value: unknown, valid: ReadonlySet<string>, fallback: string): string {
    return typeof value === 'string' && valid.has(value) ? value : fallback;
}

export function normalizeConnectionProfile(raw: unknown): StoryConnectionProfile | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const item = raw as Record<string, unknown>;
    const name = typeof item.name === 'string' ? item.name.trim() : '';
    if (!name) return null;
    const source = typeof item.source === 'string' && item.source.trim()
        ? item.source.trim()
        : DEFAULT_CONNECTION_PROFILE_VALUES.source;
    const defaults = defaultParametersForSource(source);
    return {
        id: typeof item.id === 'string' && item.id.trim() ? item.id.trim() : `profile_${name}`,
        name,
        source,
        baseUrl: typeof item.baseUrl === 'string' ? item.baseUrl.trim() : defaults.baseUrl,
        apiKey: typeof item.apiKey === 'string' ? item.apiKey : '',
        model: typeof item.model === 'string' ? item.model.trim() : defaults.model,
        reasoningEffort: pickValid(item.reasoningEffort, VALID_REASONING, defaults.reasoningEffort),
        promptPostProcessing: pickValid(item.promptPostProcessing, VALID_POST_PROCESS, defaults.promptPostProcessing),
        useSystemPrompt: pickValid(item.useSystemPrompt, VALID_USE_SYSPROMPT, defaults.useSystemPrompt),
    };
}

export function parseConnectionProfiles(raw: unknown): StoryConnectionProfile[] {
    let list: unknown;
    if (Array.isArray(raw)) {
        list = raw;
    } else if (typeof raw === 'string' && raw.trim()) {
        try {
            list = JSON.parse(raw);
        } catch {
            return [];
        }
    }
    if (!Array.isArray(list)) return [];
    const seen = new Set<string>();
    const result: StoryConnectionProfile[] = [];
    for (const entry of list) {
        const normalized = normalizeConnectionProfile(entry);
        if (!normalized || seen.has(normalized.id)) continue;
        seen.add(normalized.id);
        result.push(normalized);
    }
    return result;
}

export function serializeConnectionProfiles(profiles: readonly StoryConnectionProfile[]): string {
    return JSON.stringify(profiles);
}

export function profileFromSettings(
    name: string,
    values: Record<string, unknown>,
    existingId?: string,
): StoryConnectionProfile {
    const label = name.trim();
    if (!label) throw new Error('请填写渠道名称。');
    const source = String(values['api.chat_completion_source'] ?? DEFAULT_CONNECTION_PROFILE_VALUES.source).trim()
        || DEFAULT_CONNECTION_PROFILE_VALUES.source;
    const defaults = defaultParametersForSource(source);
    return {
        id: existingId?.trim() || `conn_${crypto.randomUUID()}`,
        name: label,
        source,
        baseUrl: typeof values['api.custom_url'] === 'string' ? values['api.custom_url'].trim() : defaults.baseUrl,
        apiKey: typeof values['api.key'] === 'string' ? values['api.key'] : '',
        model: typeof values['api.model'] === 'string' ? values['api.model'].trim() : defaults.model,
        reasoningEffort: pickValid(values['sampler.reasoning_effort'], VALID_REASONING, defaults.reasoningEffort),
        promptPostProcessing: pickValid(values['sampler.prompt_post_processing'], VALID_POST_PROCESS, defaults.promptPostProcessing),
        useSystemPrompt: pickValid(values['sampler.use_sysprompt'], VALID_USE_SYSPROMPT, defaults.useSystemPrompt),
    };
}

export function settingsPatchFromProfile(profile: StoryConnectionProfile): Record<string, unknown> {
    const normalized = normalizeConnectionProfile(profile) ?? {
        ...DEFAULT_CONNECTION_PROFILE_VALUES,
        id: profile.id,
        name: profile.name,
    };
    return {
        'api.active_profile': normalized.id,
        'api.chat_completion_source': normalized.source,
        'api.custom_url': normalized.baseUrl,
        'api.key': normalized.apiKey,
        'api.model': normalized.model,
        'sampler.reasoning_effort': normalized.reasoningEffort,
        'sampler.prompt_post_processing': normalized.promptPostProcessing,
        'sampler.use_sysprompt': normalized.useSystemPrompt,
    };
}

export function upsertConnectionProfile(
    profiles: readonly StoryConnectionProfile[],
    incoming: StoryConnectionProfile,
): StoryConnectionProfile[] {
    const byId = profiles.findIndex(item => item.id === incoming.id);
    if (byId >= 0) {
        return profiles.map((item, index) => index === byId ? incoming : item);
    }
    const byName = profiles.findIndex(item => item.name === incoming.name);
    if (byName >= 0) {
        const updated = { ...incoming, id: profiles[byName].id };
        return profiles.map((item, index) => index === byName ? updated : item);
    }
    return [...profiles, incoming];
}

export function removeConnectionProfile(
    profiles: readonly StoryConnectionProfile[],
    id: string,
): StoryConnectionProfile[] {
    return profiles.filter(item => item.id !== id);
}

export function suggestConnectionProfileName(values: Record<string, unknown>): string {
    const model = typeof values['api.model'] === 'string' ? values['api.model'].trim() : '';
    const source = String(values['api.chat_completion_source'] ?? 'openai').trim();
    if (model) return model;
    return source || '默认渠道';
}

export const PROFILE_OWNED_SETTING_KEYS = [
    'api.chat_completion_source',
    'api.custom_url',
    'api.key',
    'api.model',
    'sampler.reasoning_effort',
    'sampler.prompt_post_processing',
    'sampler.use_sysprompt',
] as const;

export function findMatchingConnectionProfile(
    profiles: readonly StoryConnectionProfile[],
    values: Record<string, unknown>,
): StoryConnectionProfile | undefined {
    const source = String(values['api.chat_completion_source'] ?? DEFAULT_CONNECTION_PROFILE_VALUES.source).trim()
        || DEFAULT_CONNECTION_PROFILE_VALUES.source;
    const baseUrl = typeof values['api.custom_url'] === 'string' ? values['api.custom_url'].trim() : '';
    const model = typeof values['api.model'] === 'string' ? values['api.model'].trim() : '';
    const apiKey = typeof values['api.key'] === 'string' ? values['api.key'] : '';
    if (!baseUrl && !model) return undefined;
    return profiles.find(profile =>
        profile.source === source &&
        profile.baseUrl === baseUrl &&
        profile.model === model &&
        profile.apiKey === apiKey,
    );
}

export function syncActiveProfileInSettingsPatch(
    currentValues: Record<string, unknown>,
    patch: Record<string, unknown>,
): Record<string, unknown> {
    const merged = { ...currentValues, ...patch };
    const activeId = String(merged['api.active_profile'] ?? '').trim();
    if (!activeId || 'api.connection_profiles' in patch) return patch;
    if (!PROFILE_OWNED_SETTING_KEYS.some(key => key in patch)) return patch;
    const profiles = parseConnectionProfiles(merged['api.connection_profiles']);
    const active = profiles.find(item => item.id === activeId);
    if (!active) return patch;
    const updated = profileFromSettings(active.name, merged, active.id);
    const nextProfiles = upsertConnectionProfile(profiles, updated);
    return {
        ...patch,
        'api.connection_profiles': serializeConnectionProfiles(nextProfiles),
    };
}

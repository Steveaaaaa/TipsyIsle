import { fetchModelCatalog } from '../core/model-catalog';
import { waitForReplicaCommit } from '../store/persistence';
import { streamLlmCompletion, type CompletionResult, type StreamCompletionRequest } from '../core/platform-bridge';
import { presetSamplingParameters } from '../core/generation-settings';
import { resolvePromptPostProcessing, resolveUseSystemPrompt } from '../core/prompt-post-process';
import { getSchemaValues } from '../registry/schema-registry';
import { finishPromptTemplateTask, runPromptPipelineAsync } from '../pipeline/pipeline-worker-client';
import { createPromptAssemblyInput, commitPromptTask, workspaceStore, getActivePreset, setStatusBanner, ensureTemplatePreload, updateHelperGenerationCount } from '../store/workspace-store';
import { placeholderPromptDefaultOrder, type HelperGenerationConfig, type HelperRolePrompt, type HelperPlaceholder, type PromptInjection } from './contracts';
import { normalizePromptInjection } from './prompt-injections';
import type { PresetPromptSlot } from '../types';
import type { AssemblePromptInput } from '../pipeline/prompt-assembler';

const tasks = new Map<string, { controller: AbortController; session: string; silent: boolean }>();
const own = (value: object, key: PropertyKey) => Object.prototype.hasOwnProperty.call(value, key);
export function proxyPresetNames(): string[] {
    return ((getSchemaValues()['api.proxy_presets'] as Array<{ name: string }> | undefined) ?? []).map(item => item.name);
}
export async function helperModelList(api: { apiurl: string; key?: string; source?: string }): Promise<string[]> {
    return (await fetchModelCatalog({ baseUrl: api.apiurl, apiKey: api.key, source: api.source })).map(model => model.id);
}
function object(value: unknown, name: string): asserts value is Record<string, any> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} 必须是对象`);
}
function keys(value: Record<string, any>, allowed: string[], name: string): void {
    const unsupported = Object.keys(value).filter(key => !allowed.includes(key));
    if (unsupported.length) throw new Error(`${name} 参数尚未接通：${unsupported.join('、')}`);
}
function rolePrompt(value: unknown): asserts value is HelperRolePrompt {
    object(value, '提示词'); keys(value, ['role', 'content', 'image'], '提示词');
    if (!['system', 'user', 'assistant'].includes(value.role) || typeof value.content !== 'string') throw new Error('提示词必须包含有效的 role 和字符串 content');
}
function validate(config: HelperGenerationConfig, raw: boolean): void {
    object(config, '生成配置');
    keys(config, ['generation_id', 'preset_name', 'user_input', 'image', 'tools', 'tool_choice', 'should_stream', 'should_silence', 'should_return_reasoning', 'overrides', 'injects', 'max_chat_history', 'custom_api', 'json_schema', ...(raw ? ['ordered_prompts'] : [])], '生成配置');
    for (const key of ['generation_id', 'preset_name', 'user_input'] as const) if (config[key] !== undefined && typeof config[key] !== 'string') throw new Error(`${key} 必须是字符串`);
    if (!config.generation_id?.trim()) throw new Error('generation_id 不能为空');
    for (const key of ['should_stream', 'should_silence', 'should_return_reasoning'] as const) if (config[key] !== undefined && typeof config[key] !== 'boolean') throw new Error(`${key} 必须是布尔值`);
    if (config.max_chat_history !== undefined && config.max_chat_history !== 'all' && (!Number.isInteger(config.max_chat_history) || config.max_chat_history < 0)) throw new Error('max_chat_history 必须是非负整数或 all');
    if (config.overrides !== undefined) {
        object(config.overrides, 'overrides');
        keys(config.overrides, placeholderPromptDefaultOrder.filter(key => key !== 'user_input'), 'overrides');
        for (const [key, value] of Object.entries(config.overrides)) {
            if (value === undefined) continue;
            if (key === 'chat_history') {
                object(value, 'chat_history'); keys(value, ['prompts', 'with_depth_entries', 'author_note'], 'chat_history');
                if (value.prompts !== undefined) { if (!Array.isArray(value.prompts)) throw new Error('chat_history.prompts 必须是数组'); value.prompts.forEach(rolePrompt); }
                if (value.with_depth_entries !== undefined && typeof value.with_depth_entries !== 'boolean') throw new Error('with_depth_entries 必须是布尔值');
                if (value.author_note !== undefined && typeof value.author_note !== 'string') throw new Error('author_note 必须是字符串');
            } else if (typeof value !== 'string') throw new Error(`${key} 覆盖值必须是字符串`);
        }
    }
    if (config.ordered_prompts !== undefined) {
        if (!Array.isArray(config.ordered_prompts)) throw new Error('ordered_prompts 必须是数组');
        config.ordered_prompts.forEach(prompt => { if (typeof prompt === 'string') { if (!placeholderPromptDefaultOrder.includes(prompt)) throw new Error(`未知内置提示词：${prompt}`); } else rolePrompt(prompt); });
    }
    if (config.injects !== undefined) {
        if (!Array.isArray(config.injects)) throw new Error('injects 必须是数组');
        config.injects.forEach((prompt, index) => normalizePromptInjection(prompt, `${config.generation_id}:${index}`));
    }
    if (config.custom_api !== undefined) {
        object(config.custom_api, 'custom_api');
        keys(config.custom_api, ['apiurl', 'key', 'model', 'source', 'proxy_preset', 'custom_include_body', 'custom_exclude_body', 'custom_include_headers', 'max_tokens', 'temperature', 'frequency_penalty', 'presence_penalty', 'top_p', 'top_k'], 'custom_api');
        for (const [key, value] of Object.entries(config.custom_api)) {
            if (value === undefined) continue;
            if (key.startsWith('custom_')) continue;
            if (['apiurl', 'key', 'model', 'source', 'proxy_preset'].includes(key)) { if (typeof value !== 'string') throw new Error(`${key} 必须是字符串`); }
            else if (value !== 'same_as_preset' && value !== 'unset' && (typeof value !== 'number' || !Number.isFinite(value))) throw new Error(`${key} 必须是有限数值、same_as_preset 或 unset`);
        }
    }
    if (config.json_schema !== undefined) {
        object(config.json_schema, 'json_schema'); keys(config.json_schema, ['name', 'value', 'description', 'strict'], 'json_schema');
        if (!config.json_schema.name || typeof config.json_schema.name !== 'string') throw new Error('json_schema.name 必须是非空字符串');
        object(config.json_schema.value, 'json_schema.value');
        if (config.json_schema.strict !== undefined && typeof config.json_schema.strict !== 'boolean') throw new Error('json_schema.strict 必须是布尔值');
        if (config.json_schema.description !== undefined && typeof config.json_schema.description !== 'string') throw new Error('json_schema.description 必须是字符串');
    }
}

function rawSlots(order: Array<HelperPlaceholder | HelperRolePrompt>): PresetPromptSlot[] {
    return order.map((prompt, index) => ({ identifier: typeof prompt === 'string' ? prompt : `helper_custom_${index}`,
        name: typeof prompt === 'string' ? prompt : `自定义提示词 ${index}`, role: typeof prompt === 'string' ? 'system' : prompt.role,
        content: typeof prompt === 'string' ? '' : prompt.content, enabled: true, injectionOrder: index }));
}
function updateTaskCount(): void {
    updateHelperGenerationCount(() => [...tasks.values()].filter(task => !task.silent).length);
}
export function stopHelperGeneration(id?: string, session?: string, nonSilentOnly = false): boolean {
    let stopped = false;
    for (const [key, task] of tasks) if ((!id || key === id) && (!session || task.session === session) && (!nonSilentOnly || !task.silent)) {
        task.controller.abort(new Error(`生成 ${key} 已停止`)); stopped = true;
    }
    return stopped;
}

/** Helper generate is a return-only task. It does not append chat messages or settle chat MVU state. */
export async function generateForHelper(config: HelperGenerationConfig, raw: boolean, progress: (id: string, text: string, reasoning: string) => void, persistentInjections: PromptInjection[] = [],
    internal?: { signal?: AbortSignal; onCancel?(): void; onPrepared?(): void; provider?: StreamCompletionRequest['provider']; configureInput?(input: AssemblePromptInput): void }): Promise<string | Partial<CompletionResult> & { content: string }> {
    await waitForReplicaCommit();
    validate(config, raw);
    if (!Array.isArray(persistentInjections)) throw new Error('提示词注入必须是数组');
    const injections = persistentInjections.map(prompt => normalizePromptInjection(prompt, prompt?.id));
    const id = config.generation_id!;
    if (tasks.has(id)) throw new Error(`生成 ID 已在使用：${id}`);
    const state = workspaceStore.getState();
    const settings = getSchemaValues();
    const api = { ...config.custom_api };
    if (api.proxy_preset) {
        const proxy = (settings['api.proxy_presets'] as Array<{ name: string; url: string; password?: string }> | undefined)?.find(item => item.name === api.proxy_preset);
        if (proxy) { api.apiurl = proxy.url; api.key = proxy.password ?? ''; }
        else setStatusBanner(`找不到代理预设「${api.proxy_preset}」，使用提供的 API 地址或当前连接`);
    }
    const controller = new AbortController();
    const reportCancel = () => { if (!internal?.signal?.aborted) internal?.onCancel?.(); };
    controller.signal.addEventListener('abort', reportCancel, { once: true });
    const cancel = () => controller.abort(internal?.signal?.reason);
    internal?.signal?.throwIfAborted();
    internal?.signal?.addEventListener('abort', cancel, { once: true });
    tasks.set(id, { controller, session: state.activeChatId, silent: config.should_silence === true });
    updateTaskCount();
    try {
        await ensureTemplatePreload();
        controller.signal.throwIfAborted();
        const input = createPromptAssemblyInput([...injections, ...(config.injects ?? []).map((prompt, index) => normalizePromptInjection(prompt, `${id}:${index}`))]);
        if (api.model !== undefined) input.modelName = api.model;
        const currentPreset = getActivePreset(state);
        const usingSelectedPreset = Boolean(!raw && config.preset_name && config.preset_name !== 'in_use');
        const selected = usingSelectedPreset ? state.presets.find(preset => preset.name === config.preset_name) : currentPreset;
        if (!selected) throw new Error(`找不到预设：${config.preset_name}`);
        const samplerPreset = selected;
        // Upstream preset_name changes prompts/settings, while regexes remain those of the active preset.
        // Keep the active preset ID as variable-scope context even when selecting another prompt layout.
        input.preset = { ...structuredClone(selected), id: currentPreset.id, regexScripts: structuredClone(currentPreset.regexScripts ?? []) };
        if (usingSelectedPreset) {
            input.maxContextTokens = selected.maxContextTokens ?? input.maxContextTokens;
            input.maxResponseTokens = selected.maxResponseTokens ?? input.maxResponseTokens;
            input.promptPostProcessing = resolvePromptPostProcessing(samplerPreset);
        }
        // Raw layouts have no author-note placeholder; preserve its configured chat depth.
        if (raw && config.overrides?.chat_history?.author_note !== undefined) {
            const authorNote = (currentPreset.promptSlots ?? currentPreset.prompts ?? []).find(slot => ['authorsNote', 'authors_note'].includes(slot.identifier));
            input.injections!.push({ id: `${id}:author_note`, content: config.overrides.chat_history.author_note,
                role: authorNote?.role ?? 'system', position: 'in_chat', depth: authorNote?.injectionDepth ?? 4 });
        }
        if (raw) input.preset = { ...input.preset, prompts: [], promptSlots: rawSlots(config.ordered_prompts ?? [...placeholderPromptDefaultOrder]) };
        if (typeof api.max_tokens === 'number') {
            if (!Number.isInteger(api.max_tokens) || api.max_tokens <= 0) throw new Error('max_tokens 必须是正整数');
            input.maxResponseTokens = api.max_tokens;
        }
        // Only prompt data crosses into the author origin. Connection credentials stay in this host.
        input.helperGeneration = { config: { user_input: config.user_input, max_chat_history: config.max_chat_history, overrides: config.overrides }, raw };
        const requestedParameters = presetSamplingParameters(samplerPreset, usingSelectedPreset ? undefined : settings);
        // Helper's public return contract selects one response; do not pay for unused preset candidates.
        delete requestedParameters.n;
        for (const key of ['max_tokens', 'temperature', 'top_p', 'top_k', 'frequency_penalty', 'presence_penalty'] as const) {
            if (!own(api, key) || api[key] === undefined || api[key] === 'same_as_preset') continue;
            if (api[key] === 'unset') delete requestedParameters[key]; else requestedParameters[key] = api[key];
        }
        if (config.json_schema) requestedParameters.response_format = { type: 'json_schema', json_schema: { name: config.json_schema.name, schema: config.json_schema.value, strict: config.json_schema.strict ?? true, ...(config.json_schema.description ? { description: config.json_schema.description } : {}) } };
        if (config.tools?.length) { requestedParameters.tools = config.tools; requestedParameters.tool_choice = config.tool_choice === 'any' ? 'required' : config.tool_choice ?? 'auto'; }
        input.generationSettings = { parameters: requestedParameters, model: api.model ?? String(settings['api.model'] ?? ''),
            stream: config.should_stream ?? false, source: api.source ?? String(settings['api.chat_completion_source'] ?? 'openai') };
        internal?.configureInput?.(input);
        const images = async (value: import('./contracts').HelperImage | undefined) => Promise.all((value === undefined ? [] : Array.isArray(value) ? value : [value]).map(item => typeof item === 'string' ? item : new Promise<string>((resolve, reject) => {
            const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error); reader.readAsDataURL(item);
        })));
        input.messageImages = {};
        if (config.image) input.messageImages.helper_user_input = await images(config.image);
        await Promise.all((config.overrides?.chat_history?.prompts ?? []).map(async (prompt, index) => { if (prompt.image) input.messageImages![`helper_history_${index}`] = await images(prompt.image); }));
        await Promise.all((config.ordered_prompts ?? []).map(async (prompt, index) => { if (typeof prompt === 'object' && prompt.image) input.messageImages![`preset_helper_custom_${index}`] = await images(prompt.image); }));
        const assembled = await runPromptPipelineAsync(input, controller.signal);
        const baseUrl = (api.apiurl ?? String(settings['api.custom_url'] ?? '')).trim();
        try {
            if (assembled.compatibilityWarnings?.length) setStatusBanner(assembled.compatibilityWarnings[0]);
            controller.signal.throwIfAborted();
            if (workspaceStore.getState().activeChatId !== state.activeChatId) throw new Error('生成准备期间会话已切换');
            if (!internal?.provider && !/^https?:\/\//i.test(baseUrl)) throw new Error('请配置有效的 HTTP(S) API 地址');
            await commitPromptTask(assembled, input, controller.signal);
        } catch (error) { await finishPromptTemplateTask(assembled, false).catch(() => {}); throw error; }
        internal?.onPrepared?.();
        const parameters = assembled.generationSettings?.parameters ?? requestedParameters;
        const outputMessages = assembled.messages;
        const shouldStream = assembled.generationSettings?.stream ?? config.should_stream ?? false;
        const response = await streamLlmCompletion({ source: api.source ?? String(settings['api.chat_completion_source'] ?? 'openai'), baseUrl,
            apiKey: api.key ?? String(settings['api.key'] ?? ''), model: assembled.generationSettings?.model ?? api.model ?? String(settings['api.model'] ?? ''),
            messages: outputMessages, includeBody: api.custom_include_body, excludeBody: api.custom_exclude_body, includeHeaders: api.custom_include_headers,
            parameters, useSystemPrompt: resolveUseSystemPrompt(samplerPreset, usingSelectedPreset ? undefined : settings), stream: shouldStream, signal: controller.signal, provider: internal?.provider,
            onToken: (text, reasoning = '') => { if (shouldStream && !controller.signal.aborted) progress(id, text, reasoning); } });
        controller.signal.throwIfAborted();
        return config.should_return_reasoning || response.tool_calls?.length ? { content: response.content, ...(response.reasoning ? { reasoning: response.reasoning } : {}),
            ...(response.reasoning_signature ? { reasoning_signature: response.reasoning_signature } : {}), ...(response.tool_calls?.length ? { tool_calls: response.tool_calls } : {}) } : response.content;
    } finally {
        internal?.signal?.removeEventListener('abort', cancel);
        controller.signal.removeEventListener('abort', reportCancel);
        tasks.delete(id); updateTaskCount();
    }
}

import { createReactiveStore } from '../store/reactive-store';
import { platformStorage } from '../core/platform-bridge';
import { registerSnapshotSource, persistRegisteredSnapshots } from '../store/persistence';
import type { SchemaFieldDescriptor } from '../types';
import { mvuFields } from './mvu-fields';
import { vectorFields } from './vector-fields';
import { DEFAULT_CONTEXT_TOKENS, DEFAULT_RESPONSE_TOKENS, DEFAULT_WORLDINFO_BUDGET_PERCENT } from '../core/generation-defaults';

export interface SchemaRegistryState {
    fields: Record<string, SchemaFieldDescriptor>;
    groupsOrder: string[];
    values: Record<string, unknown>;
}

const BUILTIN_SAMPLER_AND_UI_SCHEMAS: SchemaFieldDescriptor[] = [
    { id: 'helper.render_depth', title: '互动页面预加载楼数', type: 'number', defaultValue: 0,
        group: '酒馆助手 · 渲染', mobileWeight: 'essential', validation: { min: 0, step: 1 },
        description: '从最新楼层向前计数；0 为自动。开场页面会预加载，其余楼层翻到附近时加载。' },
    ...mvuFields,
    ...vectorFields,
    { id: 'sampler.tokenizer', type: 'select', defaultValue: 'auto', group: '核心采样 (Core Sampling)', title: 'Token 分词器', mobileWeight: 'advanced',
        description: '自动匹配已知 GPT 模型的词表；其他模型使用 cl100k 估算。计数不含厂商隐藏消息包装及图片成本。',
        options: ['auto', 'cl100k_base', 'o200k_base', 'estimate'].map(value => ({ value, label: value })) },
    {
        id: 'api.chat_completion_source',
        type: 'select',
        defaultValue: 'openai',
        group: '模型与连接 (Connection)',
        title: '推理源协议 (Completion Source)',
        description: '选择后端大模型请求协议。完全动态传递，不绑定特定写死厂商。',
        mobileWeight: 'essential',
        options: [
            { value: 'openai', label: 'OpenAI / 兼容接口 (OpenAI-Compatible)' },
            { value: 'openai-responses', label: 'OpenAI Responses' },
            { value: 'claude', label: 'Anthropic Claude' },
            { value: 'makersuite', label: 'Google Gemini (AI Studio)' },
            { value: 'vertexai', label: 'Google Vertex AI' },
            { value: 'deepseek', label: 'DeepSeek 官方' },
            { value: 'openrouter', label: 'OpenRouter' },
            { value: 'custom', label: '自定义端点 (Custom Endpoint)' },
        ],
    },
    {
        id: 'api.custom_url',
        type: 'string',
        defaultValue: 'https://api.openai.com/v1',
        group: '模型与连接 (Connection)',
        title: 'API 基础地址 (Base URL)',
        description: '兼容 OpenAI / Claude / Gemini 的反向代理或官方接口地址。',
        mobileWeight: 'essential',
        placeholder: 'https://api.example.com/v1',
    },
    {
        id: 'api.model',
        type: 'string',
        defaultValue: 'gpt-4o',
        group: '模型与连接 (Connection)',
        title: '模型标识 (Model ID)',
        description: '发送给上游端点的模型名称（例如 claude-3-7-sonnet、deepseek-chat、gemini-2.5-pro）。',
        mobileWeight: 'essential',
        placeholder: '输入或选择模型 ID',
    },
    {
        id: 'api.key',
        type: 'secret',
        defaultValue: '',
        group: '模型与连接 (Connection)',
        title: 'API Key',
        description: '保存在当前浏览器的连接凭据，仅在发送请求时交给所选服务。',
        mobileWeight: 'essential',
    },
    {
        id: 'api.stream',
        type: 'boolean',
        defaultValue: true,
        group: '模型与连接 (Connection)',
        title: '流式输出 (Streaming SSE)',
        description: '开启后实时逐字渲染回复并流式触发沙盒状态栏更新。',
        mobileWeight: 'essential',
    },
    {
        id: 'sampler.temperature',
        type: 'number',
        defaultValue: 0.95,
        group: '核心采样 (Core Sampling)',
        title: '温度 (Temperature)',
        description: '控制回复的随机性与创造力。数值越高越发散，越低越稳定。',
        mobileWeight: 'essential',
        validation: { min: 0, max: 2, step: 0.01 },
    },
    {
        id: 'sampler.max_tokens',
        type: 'number',
        defaultValue: DEFAULT_RESPONSE_TOKENS,
        group: '核心采样 (Core Sampling)',
        title: '单次最大回复长度 (Max Tokens)',
        description: '单次生成允许输出的最大 Token 数量，默认 16,384；这是上限，模型可以提前结束。',
        mobileWeight: 'essential',
        validation: { min: 64, max: 65536, step: 64 },
    },
    {
        id: 'sampler.context_max_tokens',
        type: 'number',
        defaultValue: DEFAULT_CONTEXT_TOKENS,
        group: '核心采样 (Core Sampling)',
        title: '上下文预算上限 (Context Window)',
        description: '默认 262,144 Token，供提示词、历史、世界书及回复预留共同使用；请按所用模型的实际上下文容量调整。',
        mobileWeight: 'essential',
        validation: { min: 1024, max: 2000000, step: 1024 },
    },
    {
        id: 'sampler.top_p',
        type: 'number',
        defaultValue: 0.95,
        group: '高阶采样 (Advanced Sampling)',
        title: '核采样 (Top P)',
        description: '仅从累积概率达到 P 的候选词中采样（1.0 为不截断）。',
        mobileWeight: 'advanced',
        validation: { min: 0, max: 1, step: 0.01 },
    },
    {
        id: 'sampler.top_k',
        type: 'number',
        defaultValue: 0,
        group: '高阶采样 (Advanced Sampling)',
        title: 'Top K 采样',
        description: '仅保留概率最高的前 K 个候选词（0 表示禁用）。',
        mobileWeight: 'advanced',
        validation: { min: 0, max: 500, step: 1 },
    },
    {
        id: 'sampler.min_p',
        type: 'number',
        defaultValue: 0.05,
        group: '高阶采样 (Advanced Sampling)',
        title: '最小相对概率 (Min P)',
        description: '按最高概率词的比例设置动态截断下限，能在高温度下依然保持逻辑连贯。',
        mobileWeight: 'advanced',
        validation: { min: 0, max: 1, step: 0.01 },
    },
    {
        id: 'sampler.frequency_penalty',
        type: 'number',
        defaultValue: 0,
        group: '高阶采样 (Advanced Sampling)',
        title: '频率惩罚 (Frequency Penalty)',
        description: '根据词语在文中已出现的次数施加惩罚，抑制复读。',
        mobileWeight: 'advanced',
        validation: { min: -2, max: 2, step: 0.05 },
    },
    {
        id: 'sampler.presence_penalty',
        type: 'number',
        defaultValue: 0,
        group: '高阶采样 (Advanced Sampling)',
        title: '存在惩罚 (Presence Penalty)',
        description: '只要词语出现过即施加惩罚，鼓励引入新话题与新词汇。',
        mobileWeight: 'advanced',
        validation: { min: -2, max: 2, step: 0.05 },
    },
    {
        id: 'sampler.reasoning_effort',
        type: 'select',
        defaultValue: 'auto',
        group: '思考与推理 (Reasoning)',
        title: '思考强度 (Reasoning Effort)',
        description: '针对支持推理链（Thinking / Reasoning）的模型控制思考预算。',
        mobileWeight: 'standard',
        options: [
            { value: 'auto', label: '自动 / 模型默认 (Auto)' },
            { value: 'low', label: '轻量思考 (Low)' },
            { value: 'medium', label: '均衡思考 (Medium)' },
            { value: 'high', label: '深度思考 (High)' },
            { value: 'max', label: '极限思考 (Max)' },
        ],
    },
    {
        id: 'lorebook.scan_depth',
        type: 'number',
        defaultValue: 6,
        group: '世界书与管线 (Lorebook & Pipeline)',
        title: '默认世界书扫描楼层数 (Scan Depth)',
        description: '默认往回扫描最近多少条聊天消息来触发世界书关键词。',
        mobileWeight: 'standard',
        validation: { min: 1, max: 100, step: 1 },
    },
    {
        id: 'lorebook.max_recursion_steps',
        type: 'number',
        defaultValue: 4,
        group: '世界书与管线 (Lorebook & Pipeline)',
        title: '最大递归触发层数 (Max Recursion)',
        description: '世界书条目内容再次触发其他世界书条目的最大递归深度（防止死循环）。',
        mobileWeight: 'advanced',
        validation: { min: 0, max: 16, step: 1 },
    },
    {
        id: 'lorebook.budget_percent',
        type: 'number',
        defaultValue: DEFAULT_WORLDINFO_BUDGET_PERCENT,
        group: '世界书与管线 (Lorebook & Pipeline)',
        title: '世界书预算占比 (%)',
        description: '激活的世界书条目最多可占用的上下文窗口百分比，默认 50%；未使用的额度仍可用于聊天历史。',
        mobileWeight: 'advanced',
        validation: { min: 5, max: 90, step: 5 },
    },
    {
        id: 'sandbox.enable_html_frames',
        type: 'boolean',
        defaultValue: true,
        group: '沙盒与生态兼容 (Sandbox & TavernHelper)',
        title: '启用原生 HTML/状态栏沙盒渲染',
        description: '自动识别消息中的 HTML 块与前端正则，在隔离 iframe 中渲染状态栏并注入 TavernHelper 兼容桥。',
        mobileWeight: 'essential',
    },
    {
        id: 'ui.user_name',
        type: 'string',
        defaultValue: 'User',
        group: '界面与身份 (Identity & UI)',
        title: '对话称呼 ({{user}})',
        description: '在提示词宏 {{user}} 和对话流中展示的当前用户名。',
        mobileWeight: 'essential',
    },
    {
        id: 'ui.theme_mode',
        type: 'select',
        defaultValue: 'obsidian',
        group: '界面与身份 (Identity & UI)',
        title: '视觉主题 (Theme)',
        description: '切换现代工作台配色方案。',
        mobileWeight: 'essential',
        options: [
            { value: 'obsidian', label: '曜石暗夜 (Obsidian Dark)' },
            { value: 'oled', label: '纯粹 OLED 黑 (True OLED)' },
            { value: 'aurora', label: '极光雾蓝 (Aurora Slate)' },
            { value: 'paper', label: '暖调羊皮纸 (Warm Paper)' },
        ],
    },
];

function buildInitialRegistryState(): SchemaRegistryState {
    const fields: Record<string, SchemaFieldDescriptor> = {};
    const groupsOrder: string[] = [];
    const values: Record<string, unknown> = {};

    for (const descriptor of BUILTIN_SAMPLER_AND_UI_SCHEMAS) {
        fields[descriptor.id] = descriptor;
        values[descriptor.id] = descriptor.defaultValue;
        if (!groupsOrder.includes(descriptor.group)) {
            groupsOrder.push(descriptor.group);
        }
    }

    try {
        const raw = globalThis.localStorage?.getItem('tt:modern:schema_values');
        if (raw) {
            const parsed = JSON.parse(raw) as Record<string, unknown>;
            if (parsed && typeof parsed === 'object') {
                Object.assign(values, parsed);
            }
        }
    } catch {
        // Ignore storage errors.
    }

    return { fields, groupsOrder, values };
}

export const schemaRegistryStore = createReactiveStore<SchemaRegistryState>(() => buildInitialRegistryState());
export const isStorySetting = (key: string) => /^(sampler\.|lorebook\.)/.test(key)
    || ['mvu.mode', 'mvu.automatic', 'mvu.update_chat', 'mvu.sendas_assistant', 'mvu.preset', 'mvu.prompt_strategy', 'mvu.random_header', 'mvu.disable_thinking', 'mvu.pseudo_stream'].includes(key);
export function storySettings() { return Object.fromEntries(Object.entries(schemaRegistryStore.getState().values).filter(([key]) => isStorySetting(key))); }
registerSnapshotSource('story_settings', storySettings);
registerSnapshotSource('local_settings', () => Object.fromEntries(Object.entries(schemaRegistryStore.getState().values).filter(([key]) => !isStorySetting(key))));
export async function hydrateStorySettings() {
    const [local, story] = await Promise.all([
        platformStorage.loadSnapshot<Record<string, unknown> | null>('local_settings', null),
        platformStorage.loadSnapshot<Record<string, unknown> | null>('story_settings', null),
    ]);
    schemaRegistryStore.setState(draft => { Object.assign(draft.values, local, story); });
}

export function registerSchemaField<T>(descriptor: SchemaFieldDescriptor<T>): void {
    schemaRegistryStore.setState((draft) => {
        draft.fields[descriptor.id] = descriptor;
        if (!draft.groupsOrder.includes(descriptor.group)) {
            draft.groupsOrder.push(descriptor.group);
        }
        if (!(descriptor.id in draft.values)) {
            draft.values[descriptor.id] = descriptor.defaultValue;
        }
    });
}

export function registerSchemaFields(descriptors: SchemaFieldDescriptor[]): void {
    for (const d of descriptors) {
        registerSchemaField(d);
    }
}

export function setSchemaValue(id: string, value: unknown): void {
    setSchemaValues({ [id]: value });
}

/** Apply a preset as one settings change and one local storage write. */
export function setSchemaValues(values: Record<string, unknown>, persist = true): void {
    schemaRegistryStore.setState((draft) => {
        for (const [id, value] of Object.entries(values)) {
        const descriptor = draft.fields[id];
        let coerced = value;
        if (descriptor?.type === 'number') {
            const num = Number(value);
            if (Number.isFinite(num)) {
                const min = descriptor.validation?.min;
                const max = descriptor.validation?.max;
                coerced = min !== undefined && num < min ? min : max !== undefined && num > max ? max : num;
            }
        } else if (descriptor?.type === 'boolean') {
            coerced = Boolean(value);
        }
        draft.values[id] = coerced;
        }
        if (persist) try {
            globalThis.localStorage?.setItem('tt:modern:schema_values', JSON.stringify(draft.values));
        } catch {
            // Ignore storage errors.
        }
    });
    if (persist) void persistRegisteredSnapshots().catch(error => globalThis.dispatchEvent?.(new CustomEvent('tipsy-storage-error', { detail: String(error) })));
}

export function getSchemaValue<T = unknown>(id: string, fallback?: T): T {
    const state = schemaRegistryStore.getState();
    if (id in state.values) {
        return state.values[id] as T;
    }
    if (id in state.fields) {
        return state.fields[id]!.defaultValue as T;
    }
    return fallback as T;
}

export function exportSamplerParametersPayload(extraOverrides?: Record<string, unknown>): Record<string, unknown> {
    const state = schemaRegistryStore.getState();
    const output: Record<string, unknown> = {};
    for (const [id, val] of Object.entries(state.values)) {
        if (id.startsWith('sampler.')) {
            output[id.slice('sampler.'.length)] = val;
        } else if (id.startsWith('api.')) {
            output[id.slice('api.'.length)] = val;
        }
    }
    if (extraOverrides) {
        Object.assign(output, extraOverrides);
    }
    return output;
}

export function getSchemaValues(): Record<string, unknown> { return { ...schemaRegistryStore.getState().values }; }




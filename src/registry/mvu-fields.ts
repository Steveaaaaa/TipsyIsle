import type { SchemaFieldDescriptor } from '../types';
import { DEFAULT_MVU_RESPONSE_TOKENS } from '../core/generation-defaults';

const group = 'MVU 变量更新';
const field = (id: string, title: string, type: SchemaFieldDescriptor['type'], defaultValue: unknown, extra: Partial<SchemaFieldDescriptor> = {}): SchemaFieldDescriptor =>
    ({ id: `mvu.${id}`, title, type, defaultValue, group, mobileWeight: 'standard', description: '', ...extra });
const options = (values: string[]) => values.map(value => ({ value, label: value }));
export const mvuFields: SchemaFieldDescriptor[] = [
    field('mode', '更新方式', 'select', '随AI输出', { options: options(['随AI输出', '额外模型解析']), mobileWeight: 'essential' }),
    field('automatic', '自动请求额外模型', 'boolean', true),
    field('notify_loading', '显示 MVU 加载通知', 'boolean', true, { mobileWeight: 'advanced' }),
    field('notify_initialized', '显示变量初始化通知', 'boolean', true, { mobileWeight: 'advanced' }),
    field('notify_error', '显示变量命令错误通知', 'boolean', false, { description: '关闭时仍保留兼容诊断。', mobileWeight: 'advanced' }),
    field('notify_analysis', '显示额外解析通知', 'boolean', true, { mobileWeight: 'advanced' }),
    field('update_chat', '同步 MVU 到聊天变量', 'boolean', false, { description: '角色主世界书的 [config_override] 可覆盖此项；消息候选始终保留独立变量。', mobileWeight: 'advanced' }),
    field('sendas_assistant', '将其他名字的回复按助手结算', 'boolean', false, { description: '关闭时按上游规则跳过非当前角色名的助手回复。', mobileWeight: 'advanced' }),
    field('source', '额外模型连接', 'select', '与插头相同', { options: options(['与插头相同', '自定义', '更多']) }),
    field('protocol', '独立连接协议', 'select', 'openai', { options: [{ value: 'openai', label: 'OpenAI 兼容' }, { value: 'claude', label: 'Anthropic' }, { value: 'makersuite', label: 'Google Gemini' }, { value: 'openai-responses', label: 'OpenAI Responses' }], mobileWeight: 'advanced' }),
    field('provider', 'Pi 服务商', 'string', 'openai', { description: '更多连接使用 Pi 目录的服务商标识，如 openai、anthropic、google、openrouter。', mobileWeight: 'advanced' }),
    field('auth_type', 'Pi 认证方式', 'select', 'api_key', { options: [{ value: 'api_key', label: 'API Key' }, { value: 'oauth', label: '已授权账号' }], mobileWeight: 'advanced' }),
    field('provider_api', 'Pi 协议', 'string', '', { description: '留空采用目录协议；自定义模型可填 openai-completions、openai-responses、anthropic-messages、google-generative-ai 等。', mobileWeight: 'advanced' }),
    field('thinking', 'Pi 推理强度', 'select', 'default', { options: options(['default', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']), mobileWeight: 'advanced' }),
    field('context_window', 'Pi 上下文上限', 'number', 0, { description: '0 使用模型目录值。', validation: { min: 0, step: 1 }, mobileWeight: 'advanced' }),
    field('url', '独立 API 地址', 'string', '', { placeholder: 'https://api.example.com/v1', mobileWeight: 'advanced' }),
    field('key', '独立 API Key', 'secret', '', { mobileWeight: 'advanced' }),
    field('model', '独立模型名称', 'string', '', { mobileWeight: 'advanced' }),
    field('preset', '提示词预设', 'string', 'in_use', { description: 'in_use 使用当前预设；也可填写已有预设的完整名称。' }),
    field('prompt_strategy', '提示词策略', 'select', '使用内置破限', { options: options(['使用内置破限', '使用当前预设', '使用其他预设']) }),
    field('random_header', '随机头部', 'boolean', true, { description: '额外模型解析使用的 Gemini 随机头部；按角色卡作者要求开关。' }),
    field('disable_thinking', '关闭额外模型推理', 'boolean', false, { mobileWeight: 'advanced' }),
    field('pseudo_stream', '兼容假流式', 'boolean', false, { description: '请求流式响应并在完成后统一解析。', mobileWeight: 'advanced' }),
    ...[['temperature', '温度', 1], ['frequency_penalty', '频率惩罚', 0], ['presence_penalty', '存在惩罚', 0], ['top_p', 'Top P', 1], ['top_k', 'Top K', 0]].map(([id, title, value]) => field(String(id), `独立模型${title}`, 'number', value, { mobileWeight: 'advanced' })),
    field('include_body', '独立请求体覆盖 JSON', 'textarea', '{}', { mobileWeight: 'advanced' }),
    field('exclude_body', '独立请求体排除字段', 'textarea', '[]', { description: 'JSON 字符串数组，支持点路径。', mobileWeight: 'advanced' }),
    field('headers', '独立请求头 JSON', 'secret', '{}', { mobileWeight: 'advanced' }),
    field('profiles', '连接方案 JSON', 'textarea', '[]', { description: '支持上游 api方案列表格式。密钥随本机设置保存。', mobileWeight: 'advanced' }),
    field('profile', '当前连接方案', 'string', '', { description: '留空使用以上连接；填写方案完整名称。', mobileWeight: 'advanced' }),
    field('format', '变量更新应答格式', 'select', '聊天消息', { options: options(['聊天消息', '格式化输出', '格式化输出(v4兼容)', '工具调用']) }),
    field('history', '发送最近消息数', 'number', 2, { validation: { min: 2, max: 100, step: 1 } }),
    field('max_tokens', '额外模型最大回复 Token', 'number', DEFAULT_MVU_RESPONSE_TOKENS, { validation: { min: 1, step: 1 }, mobileWeight: 'advanced' }),
    field('request_mode', '请求方式', 'select', '依次请求，失败后重试', { options: options(['依次请求，失败后重试', '同时请求多次', '先请求一次, 失败后再同时请求多次']) }),
    field('attempts', '请求次数', 'number', 3, { description: '并行模式采用首个有效结果并取消其余请求；可能产生多份请求费用。', validation: { min: 1, max: 10, step: 1 }, mobileWeight: 'advanced' }),
    field('min_chars', '最小触发字数', 'number', 0, { validation: { min: 0, step: 1 }, mobileWeight: 'advanced' }),
    field('trigger', '触发标签正则', 'string', '', { description: '留空表示不限制；可使用 /表达式/flags。', mobileWeight: 'advanced' }),
    field('whitelist', '世界书条目白名单正则', 'string', '', { mobileWeight: 'advanced' }),
    field('blacklist', '世界书条目黑名单正则', 'string', '', { mobileWeight: 'advanced' }),
    field('task', '额外模型更新任务', 'textarea', '根据当前变量状态、世界书中的变量更新规则和最新剧情，计算本轮变量变化。只输出 <UpdateVariable> 更新块，内部使用角色卡约定的更新命令或 <JSONPatch> 操作数组。不要续写剧情。', { mobileWeight: 'advanced' }),
];

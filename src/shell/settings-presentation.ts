import type { SchemaFieldDescriptor } from '../types';
import type { IconName } from './Icon';

// Display metadata only. Stored keys, values and compatibility contracts stay
// in the registry; labels can change without changing the running story.
export const settingsCategories = [
    { id: 'connection', label: '模型连接', icon: 'cpu', description: '设置生成剧情使用的接口、密钥和模型。' },
    { id: 'story', label: '故事运行', icon: 'branch', description: '变量更新、作者页面和世界书的运行设置。' },
    { id: 'plugins', label: '插件', icon: 'plugin', description: '安装和管理微醺屿插件，查看每个插件的权限与运行日志。' },
    { id: 'reading', label: '阅读与显示', icon: 'book', description: '选择回复在生成过程中如何呈现，或前往外观调整阅读样式。' },
    { id: 'profile', label: '个人资料', icon: 'user', description: '管理头像、称呼与个人特征；故事专属资料优先于全局默认。' },
    { id: 'data', label: '数据管理', icon: 'archive', description: '管理导入的故事、世界书、预设与会话。' },
    { id: 'sync', label: '双端互通', icon: 'refresh', description: '同一局域网内同步故事与存档，在电脑和手机之间继续剧情。' },
    { id: 'advanced', label: '高级与诊断', icon: 'settings', description: '作者配置、运行诊断和不常用的技术选项。一般无需调整。' },
] as const satisfies readonly { id: string; label: string; icon: IconName; description: string }[];
export type SettingsCategory = typeof settingsCategories[number]['id'];

export const pluginSettingsDestinations = [
    { id: 'overview', title: '插件管理', description: '导入插件包、管理已安装的插件和酒馆兼容扩展。', keywords: '安装插件 下载 扩展 .tipsy-plugin 启用 停用 卸载 模型连接' },
    { id: 'permissions', title: '插件权限', description: '选择插件，查看它申请的权限，调整对资源和连接的授权。', keywords: '权限管理 查看权限 授权 grant permission' },
    { id: 'logs', title: '插件运行日志', description: '选择插件，查看本次运行记录或只看失败。', keywords: '插件日志 运行日志 插件诊断 错误 日志 log' },
] as const;
export type PluginSettingsDestination = typeof pluginSettingsDestinations[number]['id'];

export const storyToolDestinations = [
    { id: 'regex', category: 'story' as const, title: '正则管理', description: '查看、开关、添加、编辑与删除全局、预设及故事正则规则。', keywords: '正则 正则管理 regex 替换 美化 状态栏 前端' },
    { id: 'scripts', category: 'story' as const, title: '酒馆助手脚本管理', description: '查看、开关、添加、编辑与删除酒馆助手（TavernHelper）脚本。', keywords: '酒馆助手 脚本 脚本管理 tavernhelper script mvu 开关' },
] as const;

const help = (title: string, description: string): Partial<SchemaFieldDescriptor> => ({ title, description });
export const settingsFieldLabels: Record<string, Partial<SchemaFieldDescriptor>> = {
    'api.connection_profiles': help('已保存模型渠道', '可保存多个不同中转或官方渠道，并一起记录推理强度、提示词后处理与原厂 System 通道。'),
    'api.active_profile': help('当前模型渠道', '快速在不同已保存的模型渠道之间切换。'),
    'api.chat_completion_source': help('接口协议', '按服务商提供的接口类型选择。中转站与兼容接口选「OpenAI / 兼容接口」；OpenAI Responses、Claude、Gemini、DeepSeek、OpenRouter 均可直连。'),
    'api.custom_url': help('API 地址', '填写服务商提供的基础地址，例如 https://api.example.com/v1，不必填写密钥或模型名称。'),
    'api.model': help('模型名称', '填写地址和密钥后，可获取服务商的模型列表并选择；也可以直接填写模型 ID。'),
    'api.key': help('API Key · 密钥', '填写所选服务商提供的密钥。该连接用于生成剧情；额外解析也可以沿用此连接。'),
    'api.stream': help('流式输出', '开启后，在模型生成过程中逐步显示回复；正文和作者组件的呈现方式在「阅读与显示」中设置。'),
    'sampler.temperature': help('回复随机性 · 温度', '数值越高，措辞和情节通常越多变。使用作者预设时，可先保留预设带入的值。'),
    'sampler.max_tokens': help('单次回复长度上限', '默认 16,384 Token，可能包括推理内容。模型可以提前结束；过低可能截断正文或组件。'),
    'sampler.context_max_tokens': help('上下文容量', '默认 262,144 Token，供提示词、历史、世界书及回复预留共同使用。请按所用模型的容量设置。'),
    'sampler.tokenizer': help('Token 计数方式', '默认自动选择词表。无法精确匹配的模型会采用估算，通常无需手动更换。'),
    'sampler.top_p': help('Top P', '限制候选词的累计概率范围，1 表示不截断；按模型或预设的建议调整。'),
    'sampler.top_k': help('Top K', '只考虑概率最高的若干候选词。0 表示不使用此限制，部分接口不支持。'),
    'sampler.min_p': help('Min P', '根据最高候选词的概率过滤低概率词。部分接口不支持，通常沿用预设即可。'),
    'sampler.frequency_penalty': help('频率惩罚', '按词语的重复次数降低其出现概率，用于减少重复表达。'),
    'sampler.presence_penalty': help('存在惩罚', '降低已出现词语的概率，可能使回复引入更多新内容。'),
    'sampler.reasoning_effort': help('模型推理强度', '只对支持此参数的模型生效。较高强度可能增加等待时间和 Token 消耗。'),
    'sampler.prompt_post_processing': help('提示词后处理', '对应酒馆的 Prompt Post-Processing。依赖 Semi-strict / Strict / Single 的破限预设，建议保持「跟随预设」或按预设说明手动指定。'),
    'sampler.use_sysprompt': help('原厂 System 提示词通道', '仅影响 Gemini / Claude 原厂协议。开启时只把开头连续 system 放入顶层 system，文末 @depth 0 等中间 system 会留在原位转为 user；关闭时全部转为 user。'),
    'helper.render_depth': help('互动页面预加载楼数', '设为 0 时自动选择预加载楼数。翻阅旧消息时，互动页面会随滚动加载。'),
    'sandbox.enable_html_frames': help('显示作者互动页面', '呈现故事自带的 HTML 封面、状态栏和按钮。关闭后这些互动内容将无法显示。'),
    'lorebook.scan_depth': help('世界书扫描消息数', '默认读取最近多少条消息来匹配世界书关键词；故事和条目自身的配置也会参与。'),
    'lorebook.max_recursion_steps': help('世界书递归触发层数', '已激活条目还可以触发其他条目；此值限制递归层数。通常按作者或预设要求设置。'),
    'lorebook.budget_percent': help('世界书预算占比', '默认最多占上下文的 50%；未使用的额度仍可用于聊天历史。世界书实际注入越多，留给历史的空间越少。'),
    'mvu.mode': { ...help('变量更新方式', '变量包括数值、状态、人物关系等。额外解析会在剧情回复后再发起模型请求，产生额外费用。'), options: [
        { value: '随AI输出', label: '随剧情回复更新' }, { value: '额外模型解析', label: '使用额外模型解析' },
    ] },
    'mvu.automatic': help('回复后自动解析', '开启后，每次符合触发条件的剧情回复完成时自动请求解析；关闭后不自动发起。'),
    'mvu.source': { ...help('解析使用的连接', '可以直接沿用剧情模型的地址和密钥，也可以为变量解析单独配置。'), options: [
        { value: '与插头相同', label: '沿用剧情模型连接' }, { value: '自定义', label: '单独配置 API' }, { value: '更多', label: '其他服务商与账号授权' },
    ] },
    'mvu.protocol': help('解析接口协议', '第三方 Chat Completions 接口选择 OpenAI 兼容。其他协议按服务商要求选择。'),
    'mvu.url': help('解析 API 地址', '填写额外解析服务的基础地址。此处的地址与剧情连接分开保存。'),
    'mvu.key': help('解析 API Key · 密钥', '填写这个解析服务对应的密钥；选择“沿用剧情模型连接”时，无需重复填写。'),
    'mvu.model': help('解析模型名称', '可从这个解析连接获取模型列表，也可手动填写。它可以与剧情模型不同。使用已保存方案时，先点击“编辑这份方案”再修改。'),
    'mvu.provider': help('模型服务商', '用于读取服务商模型目录或进行账号授权；填写目录标识，例如 anthropic、google、openrouter。'),
    'mvu.auth_type': help('连接认证方式', 'API Key 使用下方的密钥；已授权账号使用本机网关中保存的服务商授权。'),
    'mvu.provider_api': help('服务商协议标识', '通常留空，由模型目录确定。手动接入时才填写 openai-completions、anthropic-messages 等标识。'),
    'mvu.thinking': help('解析模型推理强度', '仅服务商支持时生效；default 使用模型默认值，off 关闭，其他档位控制推理强度。'),
    'mvu.context_window': help('解析模型上下文容量', '0 使用模型目录中的容量；手填时按所选模型的实际容量填写。'),
    'mvu.format': help('应答格式', '按故事作者要求选择。作者所说的“格式化输出（v4兼容）”对应下方同名选项。'),
    'mvu.random_header': help('随机头部', '额外解析请求中的 Gemini 兼容选项。作者要求关闭时，在这里关闭；通常不要随意更改。'),
    'mvu.prompt_strategy': help('解析提示词来源', '可使用内置变量解析提示词、当前叙事预设，或另一份已导入预设。'),
    'mvu.preset': help('解析使用的预设', '填写已导入预设的完整名称；in_use 表示当前预设。只在选择“使用其他预设”时使用。'),
    'mvu.history': help('解析时发送的最近消息数', '解析模型会参考这些最近消息及当前变量状态。更多历史会增加请求用量。'),
    'mvu.max_tokens': help('解析回复长度上限', '为变量说明和更新指令保留的最大 Token 数。过低可能造成更新内容被截断。'),
    'mvu.request_mode': help('失败重试与并行方式', '通常保留依次请求即可。并行请求可能同时产生多份费用，只采用首个有效结果。'),
    'mvu.attempts': help('最多请求次数', '依次模式为尝试次数；并行模式可能同时请求多次。数值越大，潜在用量越高。'),
    'mvu.disable_thinking': help('关闭解析模型推理', '向接口发送关闭推理的请求参数，仅在接口支持时生效。'),
    'mvu.pseudo_stream': help('解析请求使用流式传输', '兼容作者所说的“假流式”：接收时使用流式连接，收到完整内容后再统一解析变量。'),
    'mvu.min_chars': help('最小触发字数', '剧情回复达到这个字数才触发自动解析。0 不限制。'),
    'mvu.trigger': help('触发标签正则', '只解析符合表达式的回复；留空不限制。支持 /表达式/flags，一般按作者要求填写。'),
    'mvu.whitelist': help('解析世界书白名单', '只向解析请求提供名称匹配的世界书条目。留空不限制，使用正则表达式。'),
    'mvu.blacklist': help('解析世界书黑名单', '从解析请求排除名称匹配的世界书条目。留空不排除，使用正则表达式。'),
    'mvu.task': help('变量解析任务说明', '额外解析时发给模型的工作指令。一般使用默认内容，或按故事作者要求修改。'),
    'mvu.update_chat': help('同步变量到聊天作用域', '供依赖聊天变量的作者脚本读取。故事内的 [config_override] 可覆盖此项。'),
    'mvu.sendas_assistant': help('结算其他名字的角色回复', '允许以其他角色名发送的助手消息参与变量更新。通常保留故事作者的配置。'),
    'mvu.notify_loading': help('变量处理通知', '显示变量框架准备和处理状态。'),
    'mvu.notify_initialized': help('初始化完成通知', '变量准备完成后显示简短提示。'),
    'mvu.notify_error': help('变量指令错误通知', '出现无法执行的变量命令时弹出提示。关闭后仍可在运行诊断中查看。'),
    'mvu.notify_analysis': help('额外解析进度通知', '显示额外模型解析的等待和完成状态。'),
    'mvu.headers': help('自定义解析请求头 · JSON', '额外附加的 HTTP 请求头，以字符串键值对象填写。一般无需更改。'),
    'mvu.include_body': help('附加解析请求参数 · JSON', '把对象中的字段合并进独立解析请求体。仅按服务商或作者要求修改。'),
    'mvu.exclude_body': help('排除解析请求参数 · JSON', '填写要移除字段的字符串数组，例如 ["top_k"]，支持点路径。'),
    'mvu.profiles': help('连接方案原始数据 · JSON', '用于与上游方案交换或手动修正。常规操作请使用连接方案的选择、保存和删除按钮。'),
    'mvu.profile': help('当前解析连接方案', '选择已保存方案后，方案中的连接和解析参数优先于下方手填值。'),
    'vectors.enabled': help('世界书语义检索', '使用嵌入模型按语义查找世界书内容。会把相关条目和最近消息发送给嵌入服务，可能产生额外费用。'),
    'vectors.all': help('检索所有启用条目', '关闭时，只检索作者标记为向量检索的条目。'),
    'vectors.url': help('嵌入 API 地址', '填写支持嵌入模型的接口地址，与剧情模型连接分开配置。'),
    'vectors.key': help('嵌入 API Key · 密钥', '填写嵌入服务的密钥。此服务用于语义检索，不负责生成剧情。'),
    'vectors.model': help('嵌入模型名称', '可获取服务商的模型列表并选择嵌入模型；列表可能同时包含对话模型，请按服务商说明选择。也可直接填写嵌入模型 ID。'),
    'vectors.query': help('检索参考消息数', '使用最近多少条消息作为语义检索依据。'),
    'vectors.max_entries': help('每本世界书最多匹配条目数', '限制单次检索从每本世界书选入的条目数量。'),
    'vectors.threshold': help('语义相似度门槛', '数值越高，匹配通常越严格；过高可能找不到相关条目。'),
    'vectors.chunk_size': help('条目分块字符数', '长条目计算嵌入时按此长度分块。通常保留默认值。'),
};

for (const [id, title, description] of [
    ['temperature', '解析随机性 · 温度', '控制解析输出的随机性。通常优先遵循模型或作者建议。'],
    ['frequency_penalty', '解析频率惩罚', '按重复次数抑制词语，部分解析服务不支持。'],
    ['presence_penalty', '解析存在惩罚', '减少已出现词语，部分解析服务不支持。'],
    ['top_p', '解析 Top P', '解析模型的累计概率采样范围，1 表示不截断。'],
    ['top_k', '解析 Top K', '解析模型考虑的候选词数量，0 表示不使用此限制。'],
]) settingsFieldLabels[`mvu.${id}`] = help(title, description);

export function settingsCategoryForField(id: string): SettingsCategory {
    if (id === 'api.stream') return 'reading';
    if (id.startsWith('api.') || id.startsWith('sampler.')) return 'connection';
    if (id.startsWith('mvu.') || id.startsWith('helper.') || id.startsWith('lorebook.') || id.startsWith('vectors.') || id === 'sandbox.enable_html_frames') return 'story';
    if (id.startsWith('ui.')) return id === 'ui.user_name' ? 'profile' : 'reading';
    return 'advanced';
}

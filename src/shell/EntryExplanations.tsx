import { useId } from 'react';

export const messageRoles = {
    system: { name: '系统指令', help: '将内容作为给模型的规则或要求，例如叙事风格和行为约束。不是电脑系统，也不是故事中的人物。' },
    user: { name: '用户消息', help: '将内容作为用户消息交给模型；这是提示词中的消息类型，不会替你发送一条可见聊天。' },
    assistant: { name: '助手消息', help: '将内容作为助手消息交给模型，可用于提供回复示例或引导后续输出。' },
};

export function ExplainedValue({ label, value, explanation }: { label: string; value: string; explanation: string }) {
    const id = useId();
    return <div className="ttm-explained-value"><div><span>{label}</span><strong>{value}</strong></div><details><summary aria-controls={id}>说明</summary><p id={id}>{explanation}</p></details></div>;
}

export function depthDescription(depth: number) {
    return depth === 0 ? '聊天记录末尾' : `最近 ${depth} 条消息之前`;
}
export const depthExplanation = '从本次发送给模型的聊天记录末尾向前数消息，不是对话轮数。0 表示放在末尾；超出可用记录长度时，放在这段记录开头。';

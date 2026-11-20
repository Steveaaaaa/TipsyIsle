import type { PromptInjection } from './contracts';

/** Filters stay inside the author origin; only resolved prompt data may cross RPC. */
export function normalizePromptInjection(value: unknown, id: string, allowFilter = false): PromptInjection {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('提示词注入必须是对象');
    const prompt = value as Record<string, any>;
    const unsupported = Object.keys(prompt).filter(key => !['id', 'role', 'content', 'position', 'depth', 'should_scan', ...(allowFilter ? ['filter'] : [])].includes(key));
    if (unsupported.length) throw new Error(`提示词注入参数尚未接通：${unsupported.join('、')}`);
    if (!id || typeof id !== 'string') throw new Error('提示词注入 id 必须是非空字符串');
    const role = prompt.role ?? 'system';
    const content = prompt.content ?? '';
    const position = prompt.position ?? 'in_chat';
    const depth = prompt.depth ?? 0;
    const should_scan = prompt.should_scan ?? false;
    if (!['system', 'user', 'assistant'].includes(role) || typeof content !== 'string') throw new Error('提示词注入必须包含有效的 role 和字符串 content');
    if (!['in_chat', 'none'].includes(position)) throw new Error(`未知注入位置：${position}`);
    if (!Number.isInteger(depth) || depth < 0) throw new Error('注入 depth 必须是非负整数');
    if (typeof should_scan !== 'boolean') throw new Error('should_scan 必须是布尔值');
    if (allowFilter && prompt.filter != null && typeof prompt.filter !== 'function') throw new Error('注入 filter 必须是函数');
    return { id, role, content, position, depth, should_scan };
}

export async function resolvePromptInjections(items: unknown[], idFor: (item: any, index: number) => string): Promise<PromptInjection[]> {
    const result: PromptInjection[] = [];
    for (const [index, item] of items.entries()) {
        const prompt = normalizePromptInjection(item, idFor(item, index), true);
        const filter = (item as { filter?: () => boolean | Promise<boolean> }).filter;
        if (!filter || await filter()) result.push(prompt);
    }
    return result;
}

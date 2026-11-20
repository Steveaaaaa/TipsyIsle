import type { AssembledChatMessage, LorebookEntry } from '../types';

interface Instruction { type: 'pos' | 'target' | 'regex'; entry: LorebookEntry; role: 'system' | 'user' | 'assistant'; position?: number; target?: string; occurrence?: number; after: boolean; pattern?: RegExp; content: string }

/** Resolve every anchor against the same message array, then insert from the end. */
export async function injectTemplateEntries(messages: AssembledChatMessage[], entries: LorebookEntry[], expand: (entry: LorebookEntry, role: Instruction['role']) => Promise<string>, warn: (message: string) => void): Promise<AssembledChatMessage[]> {
    const instructions: Instruction[] = [];
    for (const entry of entries) {
        const roleRaw = /\brole=(\w+)/.exec(entry.comment)?.[1];
        const role = roleRaw === 'assistant' || roleRaw === 'user' ? roleRaw : 'system';
        const base = { entry, role, after: /\bat=after\b/.test(entry.comment), content: '' } as Instruction;
        const pos = /\bpos=(-?\d+)/.exec(entry.comment);
        const target = /\btarget=(\w+)/.exec(entry.comment);
        const regex = /\bregex=(?:"([^"]*)"|'([^']*)'|(\S+))/.exec(entry.comment);
        if (pos) { base.type = 'pos'; base.position = Number(pos[1]); }
        else if (target) { base.type = 'target'; base.target = target[1]; base.occurrence = Number(/\bindex=(-?\d+)/.exec(entry.comment)?.[1] ?? 1) || 1; }
        else if (regex) {
            base.type = 'regex';
            try { base.pattern = new RegExp(regex[1] ?? regex[2] ?? regex[3]); }
            catch { warn(`世界书「${entry.world}/${entry.comment}」的 @INJECT 正则无效，已跳过`); continue; }
        } else { warn(`世界书「${entry.world}/${entry.comment}」缺少 @INJECT pos/target/regex 参数，已跳过`); continue; }
        base.content = await expand(entry, role);
        if (base.content.trim()) instructions.push(base);
    }
    const result = messages.slice();
    const insert = (queue: Array<{ item: Instruction; index: number }>) => {
        queue.sort((a, b) => b.index - a.index || b.item.entry.order - a.item.entry.order || Number(b.item.type === 'pos') - Number(a.item.type === 'pos'));
        for (const { item, index } of queue) result.splice(index, 0, { role: item.role, content: item.content, sourceId: `template-inject:${item.entry.world}:${item.entry.uid}`, sourceLabel: item.entry.comment, tokens: 0 });
    };
    const positioned: Array<{ item: Instruction; index: number }> = [];
    for (const item of instructions) {
        if (item.type === 'pos') {
            const value = item.position!;
            positioned.push({ item, index: Math.max(0, Math.min(result.length, value === 0 ? 0 : value < 0 ? result.length + value : value - 1)) });
        } else if (item.type === 'target') {
            const targets = result.flatMap((message, index) => message.role === item.target ? [index] : []);
            const occurrence = item.occurrence!;
            const target = targets[occurrence < 0 ? targets.length + occurrence : occurrence - 1];
            if (target !== undefined) positioned.push({ item, index: target + Number(item.after) });
            else warn(`世界书「${item.entry.world}/${item.entry.comment}」没有匹配的 @INJECT 目标楼层`);
        }
    }
    insert(positioned);
    const regexes: Array<{ item: Instruction; index: number }> = [];
    for (const item of instructions.filter(item => item.type === 'regex')) {
        const index = result.findIndex(message => item.pattern!.test(message.content));
        if (index >= 0) regexes.push({ item, index: index + Number(item.after) });
        else warn(`世界书「${item.entry.world}/${item.entry.comment}」的 @INJECT 正则没有匹配到消息`);
    }
    insert(regexes);
    return result;
}

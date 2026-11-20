import _ from 'lodash';
import { closeUpdateMarkup, findUpdateMarkupBlocks } from './mvu-markup';
import { readMvuCommands } from './mvu-commands';

/** Objects are compared by leaf; arrays stay whole to avoid repeated insertions. */
export function buildMvuRepairTask(previous: unknown, current: unknown): string {
    const changes: string[] = [];
    let remaining = 12000;
    const summarize = (value: unknown) => {
        const text = JSON.stringify(value);
        return text === undefined ? '（不存在）' : text.length > 1000 ? text.slice(0, 1000) + '…[截断]' : text;
    };
    const visit = (before: any, after: any, path: string) => {
        if (changes.length >= 120 || remaining <= 0 || Object.is(before, after)) return;
        if (_.isPlainObject(before) && _.isPlainObject(after)) {
            for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
                visit(before[key], after[key], `${path}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`);
                if (changes.length >= 120 || remaining <= 0) break;
            }
        } else if (!_.isEqual(before, after)) {
            const line = `${path || '/'}: ${summarize(before)} -> ${summarize(after)}`;
            changes.push(line.slice(0, remaining)); remaining -= line.length;
        }
    };
    visit(previous, current, '');
    return `本次是增量变量校正。当前变量已经执行本楼原更新；只补充遗漏或纠正与最新剧情、世界书规则明确冲突的错误。
不得重复已有正确更新，不重算或覆盖整份变量，不为凑格式生成无关操作。所有修正以当前状态为基准；优先使用绝对值替换，数组按完整值替换。
用户补充方向仅指定核验重点，不能创造剧情事实或覆盖变量规则。证据不足保持不变。
只返回一个 <UpdateVariable><JSONPatch>操作数组</JSONPatch></UpdateVariable>；若指定格式化输出或工具调用，服从其结构。无需校正时返回空数组。
本楼已落地变化（最多 120 项、12000 字符；未展示内容不能视为待删除）：
${changes.join('\n') || '（无）'}`;
}

/** Append after existing operations, without activating truncated JSONPatch content. */
export function appendMvuRepair(message: string, repair: string): string {
    let content = repair.trim();
    const wrappers = findUpdateMarkupBlocks(content, 'update');
    const wrapper = wrappers.length === 1 ? wrappers[0] : undefined;
    if (wrapper?.closed && wrapper.start === 0 && wrapper.end === content.length) content = content.slice(wrapper.contentStart, wrapper.contentEnd).trim();
    if (!content) return message;
    const target = findUpdateMarkupBlocks(message, 'update').filter(block => block.closed).sort((a, b) => a.end - b.end).at(-1);
    const tail = target ? message.slice(target.end) : '';
    if (target && !readMvuCommands(tail + closeUpdateMarkup(tail)).commands.length) {
        return message.slice(0, target.contentEnd) + closeUpdateMarkup(message.slice(target.contentStart, target.contentEnd))
            + '\n' + content + '\n' + message.slice(target.contentEnd);
    }
    return `${message}${closeUpdateMarkup(message)}\n<UpdateVariable>${content}</UpdateVariable>`;
}

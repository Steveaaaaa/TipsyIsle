import type { ChatMessageNode } from '../types';
import { normalizeMvuVariables } from '../pipeline/mvu-data';
import { swipeId } from '../store/chat-tree';
import { routeExtra } from './baibai-route';

// Author extras have their own per-swipe table. Internal branch state must survive
// setChatMessages({ extra: ... }) and must not leak through getChatMessages().extra.
const internalKeys = new Set(['swipeVariables', 'chatVariables', 'timedStates', 'swipeHostMetadata', 'tipsy_host_illustrations', 'swipeChatVariables', 'swipeTimedStates',
    'templateState', 'swipeTemplateStates', 'helperSwipeInfo', 'helperTopLevel', 'tipsy_template_render', 'tipsy_template_source', 'tipsy_generation_incomplete',
    'tipsy_mvu_initialized', 'tipsy_mvu_initialization_pending', 'tipsy_template_variables_initialized', 'tipsy_generation_terminal', 'tipsy_metrics']);
export function messageExtra(node: ChatMessageNode, swipe = node.activeSwipeIndex, metadata?: Record<string, unknown>): Record<string, unknown> {
    const table = node.extra?.helperSwipeInfo as Record<string, Record<string, unknown>> | undefined;
    const original = node.swipes[swipe];
    return structuredClone(routeExtra(node, table?.[swipe] ?? (typeof original === 'object' ? original.extra : undefined)
        ?? Object.fromEntries(Object.entries(node.extra ?? {}).filter(([key]) => !internalKeys.has(key))), metadata, swipe));
}
export function messageTopLevel(node: ChatMessageNode): Record<string, unknown> {
    return structuredClone((node.extra?.helperTopLevel as Record<string, unknown> | undefined) ?? {});
}
export const hostHiddenKey = 'tipsy_host_hidden_messages';
export const hostIllustrationKey = 'tipsy_host_illustrations';
export interface HostIllustration { path: string; prompt: string }
export function hostMessageHidden(node: ChatMessageNode, metadata?: Record<string, unknown>): boolean {
    return node.isHidden === true || (metadata?.[hostHiddenKey] as Record<string, boolean> | undefined)?.[swipeId(node)] === true;
}
function object(value: unknown, label: string): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}必须为对象`);
    return value as Record<string, unknown>;
}
export function validateMessageRefresh(value: unknown): asserts value is 'none' | 'affected' | 'all' | undefined {
    if (value !== undefined && !['none', 'affected', 'all'].includes(String(value))) throw new Error('消息 refresh 必须为 none、affected 或 all');
}
/** Pure, fully validated change plan; callers publish only after every item succeeds. */
export function patchHelperMessage(node: ChatMessageNode, item: Record<string, any>, currentVariables: Record<string, unknown>): { node: ChatMessageNode; variables: Record<string, unknown> } {
    const supported = ['message_id', 'name', 'role', 'is_hidden', 'message', 'data', 'extra', 'swipe_id', 'swipes', 'swipes_data', 'swipes_info'];
    const unknown = Object.keys(item).filter(key => !supported.includes(key));
    if (unknown.length) throw new Error(`未知消息字段：${unknown.join('、')}`);
    if (item.name !== undefined && typeof item.name !== 'string') throw new Error('消息名称必须为字符串');
    if (item.role !== undefined && !['system', 'assistant', 'user'].includes(item.role)) throw new Error('消息角色无效');
    if (item.is_hidden !== undefined && typeof item.is_hidden !== 'boolean') throw new Error('消息隐藏状态必须为布尔值');
    if (item.message !== undefined && typeof item.message !== 'string') throw new Error('消息正文必须为字符串');
    if (item.data !== undefined) object(item.data, '消息变量');
    if (item.extra !== undefined) object(item.extra, '消息 extra');
    if (item.swipe_id !== undefined && !Number.isInteger(item.swipe_id)) throw new Error('swipe_id 必须为整数');
    for (const key of ['swipes', 'swipes_data', 'swipes_info']) {
        if (item[key] === undefined) continue;
        if (!Array.isArray(item[key]) || item[key].length > 16384) throw new Error(`${key} 必须为至多 16384 项的数组`);
        for (const value of item[key]) if (value != null) {
            if (key === 'swipes') { if (typeof value !== 'string') throw new Error('swipes 正文必须为字符串'); }
            else object(value, key);
        }
    }
    const next = structuredClone(node);
    next.extra ??= {};
    const oldVariables = { ...(next.extra.swipeVariables as Record<string, Record<string, unknown>> ?? {}), [node.activeSwipeIndex]: structuredClone(currentVariables) };
    const oldInfo = Object.fromEntries(node.swipes.map((_, index) => [index, messageExtra(node, index)]));
    const hasSingle = item.message !== undefined || item.data !== undefined;
    const hasSwipes = ['swipe_id', 'swipes', 'swipes_data', 'swipes_info'].some(key => item[key] !== undefined);
    if (!hasSingle && hasSwipes) {
        const lengths = ['swipes', 'swipes_data', 'swipes_info'].flatMap(key => item[key] === undefined ? [] : [item[key].length as number]);
        const length = lengths.length ? Math.max(...lengths) : node.swipes.length;
        if (!length) throw new Error('消息至少需要一个 swipe');
        next.swipes = Array.from({ length }, (_, index) => {
            const previous = node.swipes[index];
            if (item.swipes === undefined) return previous ?? '';
            const content = item.swipes[index] ?? '';
            // An unchanged candidate keeps its reasoning/tool metadata.
            return typeof previous === 'object' && previous.content === content ? previous : content;
        });
        next.activeSwipeIndex = Math.max(0, Math.min(length - 1, item.swipe_id ?? node.activeSwipeIndex));
        next.extra.swipeVariables = Object.fromEntries(Array.from({ length }, (_, index) => [index,
            normalizeMvuVariables(structuredClone(item.swipes_data?.[index] ?? (item.swipes_data ? {} : oldVariables[index] ?? {}))).variables]));
        next.extra.helperSwipeInfo = Object.fromEntries(Array.from({ length }, (_, index) => [index,
            structuredClone(item.swipes_info?.[index] ?? (item.swipes_info ? {} : oldInfo[index] ?? {}))]));
        // Removed/replaced swipes must not inherit another response's derived state.
        for (const key of ['swipeChatVariables', 'swipeTimedStates', 'swipeTemplateStates', 'tipsy_template_render', 'tipsy_template_source', 'tipsy_template_variables_initialized', 'tipsy_metrics']) {
            const previous = next.extra[key] as Record<string, unknown> | undefined;
            next.extra[key] = Object.fromEntries(Object.entries(previous ?? {}).filter(([index]) => Number(index) < length
                && (item.swipes === undefined || item.swipes[Number(index)] === (typeof node.swipes[Number(index)] === 'string' ? node.swipes[Number(index)] : (node.swipes[Number(index)] as any)?.content))));
        }
    } else {
        if (item.message !== undefined) {
            const swipe = next.swipes[node.activeSwipeIndex];
            next.swipes[node.activeSwipeIndex] = typeof swipe === 'string' ? item.message : { ...swipe, content: item.message };
        }
        next.extra.swipeVariables = { ...oldVariables, ...(item.data === undefined ? {} : { [node.activeSwipeIndex]: normalizeMvuVariables(structuredClone(item.data)).variables }) };
        next.extra.helperSwipeInfo = { ...oldInfo, ...(item.extra === undefined ? {} : { [node.activeSwipeIndex]: structuredClone(item.extra) }) };
    }
    next.speakerName = item.name ?? next.speakerName;
    next.role = item.role ?? next.role;
    next.isHidden = item.is_hidden ?? next.isHidden ?? false;
    if (item.role !== undefined) {
        const info = (next.extra.helperSwipeInfo as Record<string, Record<string, unknown>>)[next.activeSwipeIndex];
        if (next.role === 'system') info.type = 'narrator'; else delete info.type;
    }
    const selected = next.swipes[next.activeSwipeIndex];
    next.content = typeof selected === 'string' ? selected : selected.content;
    if (next.activeSwipeIndex !== node.activeSwipeIndex || !hasSingle && item.swipes !== undefined) next.reasoning = typeof selected === 'string' ? '' : selected.reasoning ?? '';
    const matched = new Set<number>();
    next.swipeIds = next.swipes.map((candidate, index) => {
        if (hasSingle || item.swipes === undefined) return swipeId(node, index);
        const text = typeof candidate === 'string' ? candidate : candidate.content;
        const same = (old: ChatMessageNode['swipes'][number]) => (typeof old === 'string' ? old : old.content) === text;
        const previous = node.swipes[index] !== undefined && same(node.swipes[index]) && !matched.has(index) ? index
            : node.swipes.findIndex((old, oldIndex) => !matched.has(oldIndex) && same(old));
        if (previous < 0) return `swipe_${crypto.randomUUID()}`;
        matched.add(previous); return swipeId(node, previous);
    });
    const ids = new Set(next.swipeIds);
    if (next.branchBases) next.branchBases = Object.fromEntries(Object.entries(next.branchBases).filter(([id]) => ids.has(id)));
    if (next.branchStates) next.branchStates = Object.fromEntries(Object.entries(next.branchStates).filter(([id]) => ids.has(id)));
    if (next.nativePluginReplies) next.nativePluginReplies = Object.fromEntries(Object.entries(next.nativePluginReplies).filter(([id]) => ids.has(id)));
    if (next.nativePluginOpeningRoutes) next.nativePluginOpeningRoutes = Object.fromEntries(Object.entries(next.nativePluginOpeningRoutes).filter(([id]) => ids.has(id)));
    next.updatedAt = Date.now();
    return { node: next, variables: structuredClone((next.extra.swipeVariables as Record<string, Record<string, unknown>>)[next.activeSwipeIndex] ?? {}) };
}

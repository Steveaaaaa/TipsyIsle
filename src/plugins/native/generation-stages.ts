import { z } from 'zod';
import type { GenerationInput, MessageRef, PromptStageInput, WorldActivation } from '../../../packages/plugin-sdk/index.js';
import { prepareTokenCounter } from '../../pipeline/token-counter';
import type { AssemblePromptInput } from '../../pipeline/prompt-assembler';
import type { LiteralHistoryEdit, LiteralInjection, NativeAfterScan, NativePromptInput } from '../../pipeline/native-prompt-input';
import { hostMessageHidden } from '../../compatibility/chat-message-codec';
import { activePlugins, assertPluginActive, errorMessage, reportPlugin } from './catalog';
import { localId, refSchema, roleSchema } from './edits';
import { invokeNativePlugin } from './host';
import { liveStory, messageRef, sameMessageRef, settled } from './story-port';

const injection = z.strictObject({ text: z.string().trim().min(1).max(12_000), role: roleSchema.optional(),
    position: z.enum(['beforePrompt', 'afterHistory', 'atDepth', 'scanOnly']).optional(), depth: z.number().int().min(0).max(1000).optional() });
const beforeSchema = z.strictObject({ injections: z.array(injection.extend({ scan: z.boolean().optional() })).max(12).optional(),
    macros: z.record(localId, z.string().max(2600)).optional() });
const historyEdit = z.discriminatedUnion('type', [z.strictObject({ type: z.literal('omit'), from: refSchema, through: refSchema.optional() }),
    z.strictObject({ type: z.literal('replace'), from: refSchema, through: refSchema.optional(), text: injection.shape.text, role: roleSchema.optional() })]);
const afterSchema = z.strictObject({ injections: z.array(injection).max(12).optional(), history: z.array(historyEdit).max(24).optional() });
const activationsSchema = z.array(z.strictObject({ book: z.string().max(200), uid: z.union([z.string().max(200), z.number()]),
    label: z.string().max(200), reason: z.string().max(100).optional(), matchedKeys: z.array(z.string().max(200)).max(12) })).max(100);
const pending = new Map<string, (activations: WorldActivation[], count: number) => Promise<NativeAfterScan | undefined>>();
const pluginLimit = 1024, totalLimit = 4096;

export async function readNativeAfterScan(id: unknown, activations: unknown, count: unknown) {
    if (typeof id !== 'string') return;
    const hook = pending.get(id);
    if (!hook) return;
    pending.delete(id);
    return hook(activationsSchema.parse(activations), z.number().int().nonnegative().parse(count));
}

export async function prepareNativePrompt(input: AssemblePromptInput, kind: GenerationInput['kind'], signal: AbortSignal) {
    const plugins = activePlugins().filter(plugin => plugin.grants.includes('generation.pipeline') && plugin.manifest.pipeline?.length)
        .sort((a, b) => a.manifest.id < b.manifest.id ? -1 : 1);
    if (!plugins.length) return;
    const view = liveStory(), route = view.route;
    if (!route) return;
    const id = crypto.randomUUID();
    const byId = new Map(input.messages.filter(settled).map(node => [node.id, messageRef(node)]));
    const historyIds = (input.interceptedHistory ?? input.messages.filter(node => !hostMessageHidden(node, input.chatMetadata)))
        .map(row => 'id' in row ? row.id : row.messageId).filter((id): id is string => typeof id === 'string' && byId.has(id));
    const history = { first: byId.get(historyIds[0]) ?? null, last: byId.get(historyIds.at(-1) ?? '') ?? null, count: historyIds.length };
    const positions = new Map(historyIds.map((id, index) => [id, index]));
    const position = (ref: MessageRef) => sameMessageRef(byId.get(ref.messageId), ref) ? positions.get(ref.messageId) ?? -1 : -1;
    let countTokens: Awaited<ReturnType<typeof prepareTokenCounter>>;
    try { countTokens = await prepareTokenCounter(input.modelName, input.tokenizer); }
    catch (error) {
        for (const plugin of plugins) reportPlugin(plugin.manifest.id, '生成阶段', 'skipped', 0, errorMessage(error));
        return;
    }
    signal.throwIfAborted();
    let remaining = Math.min(totalLimit, Math.max(0, (input.maxContextTokens ?? 262144) - (input.maxResponseTokens ?? 8192)));
    const used = new Map<string, number>();
    const budget = (pluginId: string) => Math.min(pluginLimit - (used.get(pluginId) ?? 0), remaining);
    const spend = (pluginId: string, tokens: number) => { used.set(pluginId, (used.get(pluginId) ?? 0) + tokens); remaining -= tokens; };
    const contributions = async (stage: PromptStageInput['stage'], activations?: WorldActivation[], activationCount?: number) => {
        const packet: PromptStageInput = { id, kind, maxTokens: pluginLimit, stage, route, history, activations, activationCount };
        const candidates = plugins.filter(plugin => plugin.manifest.pipeline?.includes(stage));
        const result = await Promise.all(candidates.map(async plugin => {
            try {
                assertPluginActive(plugin);
                return await invokeNativePlugin({ mode: stage, input: { ...packet, maxTokens: budget(plugin.manifest.id) }, id, plugin, view,
                    target: history.last ?? undefined, external: signal });
            } catch { return null; }
        }));
        return candidates.map((plugin, index) => ({ plugin, output: result[index] }));
    };
    const before = await contributions('beforeScan');
    signal.throwIfAborted();
    const plan: NativePromptInput = { id, injections: [], macros: {}, afterScan: plugins.some(plugin => plugin.manifest.pipeline?.includes('afterScan')) };
    for (const { plugin, output } of before) {
        const pluginId = plugin.manifest.id;
        if (output === null) continue;
        try {
            assertPluginActive(plugin);
            const result = beforeSchema.parse(output);
            const macros = Object.entries(result.macros ?? {});
            if (macros.some(([key]) => !plugin.manifest.macros?.includes(key))) throw new Error('返回了清单中未声明的生成宏');
            const tokens = (result.injections ?? []).reduce((n, item) => n + countTokens(item.text) + 8, 0) + macros.reduce((n, [, value]) => n + countTokens(value), 0);
            if (tokens > budget(pluginId)) { reportPlugin(pluginId, '世界书扫描前', 'skipped', 0, `本轮剩余 ${budget(pluginId)} Token`); continue; }
            spend(pluginId, tokens);
            for (const [index, item] of (result.injections ?? []).entries()) plan.injections.push({ ...item, source: `plugin:${pluginId}:before:${index}`, label: plugin.manifest.name });
            for (const [key, value] of macros) plan.macros[`${pluginId}::${key}`] = value;
            reportPlugin(pluginId, '世界书扫描前', 'ok', 0);
        } catch (error) { reportPlugin(pluginId, '世界书扫描前', 'error', 0, errorMessage(error)); }
    }
    const afterScan = async (activations: WorldActivation[], activationCount: number): Promise<NativeAfterScan | undefined> => {
        if (signal.aborted) return;
        const injections: LiteralInjection[] = [], history: LiteralHistoryEdit[] = [];
        const occupied: { start: number; end: number }[] = [];
        const after = await contributions('afterScan', activations, activationCount);
        if (signal.aborted) return;
        for (const { plugin, output } of after) {
            const pluginId = plugin.manifest.id;
            if (output === null) continue;
            try {
                assertPluginActive(plugin);
                const result = afterSchema.parse(output);
                const edits = (result.history ?? []).map(edit => ({ edit, start: position(edit.from), end: position(edit.through ?? edit.from) }));
                if (edits.some(({ start, end }) => start < 0 || end < start)) throw new Error('历史范围不在本轮发送的路线中');
                if (result.injections?.some(item => item.position === 'scanOnly')) throw new Error('扫描结束后不能再提供扫描内容');
                const tokens = (result.injections ?? []).reduce((n, item) => n + countTokens(item.text) + 8, 0)
                    + edits.reduce((n, { edit }) => n + (edit.type === 'replace' ? countTokens(edit.text) + 8 : 0), 0);
                if (tokens > budget(pluginId)) { reportPlugin(pluginId, '世界书扫描后', 'skipped', 0, `本轮剩余 ${budget(pluginId)} Token`); continue; }
                spend(pluginId, tokens);
                for (const [index, item] of (result.injections ?? []).entries()) injections.push({ ...item, source: `plugin:${pluginId}:after:${index}`, label: plugin.manifest.name });
                for (const [index, { edit, start, end }] of edits.entries()) {
                    if (occupied.some(item => item.start <= end && item.end >= start)) {
                        reportPlugin(pluginId, '世界书扫描后', 'skipped', 0, `楼层范围 ${edit.from.messageId} 已由排在前面的改动处理`); continue;
                    }
                    occupied.push({ start, end });
                    history.push({ from: edit.from.messageId, through: (edit.through ?? edit.from).messageId, source: `plugin:${pluginId}:history:${index}`,
                        label: plugin.manifest.name, ...(edit.type === 'replace' ? { text: edit.text, role: edit.role } : {}) });
                }
                reportPlugin(pluginId, '世界书扫描后', 'ok', 0);
            } catch (error) { reportPlugin(pluginId, '世界书扫描后', 'error', 0, errorMessage(error)); }
        }
        return { injections, history };
    };
    if (!plan.afterScan && !plan.injections.length && !Object.keys(plan.macros).length) return;
    if (plan.afterScan) pending.set(id, afterScan);
    return { plan, afterScan, close: () => { pending.delete(id); } };
}

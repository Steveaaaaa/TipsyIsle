import { prepareTokenCounter } from '../../pipeline/token-counter';
import type { AssemblePromptInput } from '../../pipeline/prompt-assembler';
import type { AssembledChatMessage, AssembledPromptResult } from '../../types';
import { canRun, pluginById, reportPlugin } from './catalog';
import { combinedPluginPromptLimit, pluginPromptLimit, type NativeContribution } from './host';

/** A literal addendum to the model request. Never evaluated as an author template,
 * fed to worldbook matching, or exposed as chat history. */
export async function applyNativeContributions(result: AssembledPromptResult, input: AssemblePromptInput, contributions: NativeContribution[], outgoing: AssembledChatMessage[], signal: AbortSignal) {
    if (!contributions.length) return outgoing;
    let count: Awaited<ReturnType<typeof prepareTokenCounter>>;
    try { count = await prepareTokenCounter(result.generationSettings?.model ?? input.modelName, input.tokenizer); }
    catch {
        for (const item of contributions) reportPlugin(item.id, '生成补充', 'skipped', item.elapsed, '无法计算模型的 Token 预算');
        return outgoing;
    }
    signal.throwIfAborted();
    const response = Number(result.generationSettings?.parameters.max_tokens ?? input.maxResponseTokens ?? 0);
    let budget = Math.min(combinedPluginPromptLimit, Math.max(0, (input.maxContextTokens ?? result.tokenUsage.budget ?? 0)
        - (Number.isFinite(response) ? response : input.maxResponseTokens ?? 0) - outgoing.reduce((sum, message) => sum + message.tokens, 0)));
    const messages: AssembledChatMessage[] = [];
    for (const item of contributions) {
        const plugin = pluginById(item.id);
        if (!plugin || !canRun(plugin) || plugin.digest !== item.digest) continue;
        const content = `［${item.name}］\n${item.text}`;
        let tokens: number;
        try { tokens = count(content) + 8; }
        catch { reportPlugin(item.id, '生成补充', 'skipped', item.elapsed, '无法计算这段文本的 Token 数'); continue; }
        if (tokens > pluginPromptLimit || tokens > budget) {
            reportPlugin(item.id, '生成补充', 'skipped', item.elapsed, `需要 ${tokens} Token，本轮剩余 ${Math.min(budget, pluginPromptLimit)} Token`);
            continue;
        }
        budget -= tokens;
        messages.push({ role: 'system', content, sourceId: `native-plugin:${item.id}`, sourceLabel: `原生插件：${item.name}`, tokens });
        reportPlugin(item.id, '生成补充', 'ok', item.elapsed, `已使用 ${tokens} Token`);
    }
    if (!messages.length) return outgoing;
    const at = outgoing.findIndex(message => message.role !== 'system');
    const index = at < 0 ? outgoing.length : at;
    return [...outgoing.slice(0, index), ...messages, ...outgoing.slice(index)];
}

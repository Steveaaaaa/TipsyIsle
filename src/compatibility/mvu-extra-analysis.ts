import { workspaceStore, getActiveChatMessages, getActiveCharacter, getActiveLorebooks, getCharacterWorldbooks, getEffectiveMvuSettings, setStatusBanner, setMvuExtraAnalysisActive } from '../store/workspace-store';
import { compileMvuRegex } from '../pipeline/mvu-settings';
import { supportsMvuExtraAnalysis } from '../pipeline/mvu-worldbooks';
import { generateForHelper, stopHelperGeneration } from './helper-generation';
import { commandCompatibilityRuntime, publishCompatibilityGenerationProgress } from './runtime-client';
import { findUpdateMarkupBlocks } from '../pipeline/mvu-markup';
import { readMvuCommands } from '../pipeline/mvu-commands';
import { parseMvuStructuredValue, mvuJsonValue } from '../pipeline/mvu-values';
import type { HelperGenerationConfig } from './contracts';
import type { CompletionResult } from '../core/platform-bridge';
import { resolveMvuConnection } from './mvu-connection';
import { mvuPrompts } from '../pipeline/mvu-prompts';
import { showNotification } from '../store/notification-store';

const matches = (regex: RegExp | undefined, text: string) => { if (!regex) return true; regex.lastIndex = 0; return regex.test(text); };
let activeAnalyses = 0;
let preparationQueue: Promise<void> = Promise.resolve();
const responseSchema = { type: 'object', properties: { analysis: { type: 'string' }, json_patch: { type: 'array', items: { type: 'object',
    properties: { op: { type: 'string' }, path: { type: 'string' }, from: { type: 'string' }, value: {} }, required: ['op', 'path'] } },
    }, required: ['analysis', 'json_patch'] };

export function normalizeExtraAnalysisResult(result: string | Partial<CompletionResult> & { content: string }): string {
    let text = typeof result === 'string' ? result : result.content;
    const tool = typeof result === 'string' ? undefined : result.tool_calls?.find(call => call.function.name === 'update_variables');
    if (tool) text = tool.function.arguments;
    const updates = findUpdateMarkupBlocks(text, 'update');
    const last = updates.filter(block => block.closed).at(-1) ?? updates.at(-1);
    let body = last ? text.slice(last.contentStart, last.contentEnd) : text;
    const commands = readMvuCommands(body);
    const patchesInBody = findUpdateMarkupBlocks(body, 'patch');
    if (patchesInBody.some(block => !block.closed)) throw new Error('额外模型的 JSONPatch 标签不完整');
    if (commands.commands.length || patchesInBody.some(block => !block.discarded)) return `<UpdateVariable>${body}</UpdateVariable>`;
    const parsed = mvuJsonValue(parseMvuStructuredValue(body));
    const patches = Array.isArray(parsed) ? parsed : parsed.json_patch ?? parsed.patch ?? parsed.operations;
    if (!Array.isArray(patches)) throw new Error('额外模型未返回变量更新命令或 JSONPatch 数组');
    const analysis = !Array.isArray(parsed) && typeof parsed.analysis === 'string' ? parsed.analysis : '';
    // Formatted output includes author-visible analysis as well as operations.
    // Preserve both sections so existing card display regexes see the upstream shape.
    body = `<Analysis>\n${analysis}\n</Analysis>\n<JSONPatch>\n${JSON.stringify(patches, null, 2)}\n</JSONPatch>`;
    readMvuCommands(body);
    return `<UpdateVariable>${body}</UpdateVariable>`;
}

/** Opt-in extra analysis uses the same generation stack and keeps credentials in the main host. */
export async function analyzeMvuReply(text: string, variables: Record<string, unknown>, parentSignal: AbortSignal, force = false,
    repair?: { task: string; direction: string }, targetId?: string): Promise<string> {
    const state = workspaceStore.getState(), card = getActiveCharacter(state);
    const { settings: effectiveSettings, warnings } = getEffectiveMvuSettings(state);
    let settings = effectiveSettings;
    if (warnings.length) setStatusBanner(warnings[0]);
    if (!repair && (settings['mvu.mode'] !== '额外模型解析' || !force && settings['mvu.automatic'] === false)) return text;
    if (!force) {
        const trigger = compileMvuRegex(String(settings['mvu.trigger'] ?? ''));
        if (trigger.error) { setStatusBanner(`MVU 触发正则无效，本轮不请求额外模型：${trigger.error}`); return text; }
        if (Array.from(text.trim()).length < Number(settings['mvu.min_chars'] ?? 0) || !matches(trigger.regex, text)) return text;
    }
    const binding = getCharacterWorldbooks(card, state);
    if (!supportsMvuExtraAnalysis(getActiveLorebooks(state), binding.primary)) {
        if (force) throw new Error('角色主世界书需要包含 [mvu_update] 或 [mvu_plot] 条目才能使用额外解析');
        return text;
    }
    const messages = getActiveChatMessages(state);
    const targetIndex = targetId ? messages.findIndex(message => message.id === targetId) : messages.length - 1;
    const target = messages[targetIndex];
    if (!target || targetIndex <= 0 || !variables.stat_data) return text;
    const connection = resolveMvuConnection(settings);
    settings = connection.settings;
    const format = String(settings['mvu.format'] ?? '聊天消息');
    const task = (repair?.task ?? String(settings['mvu.task'] ?? '')) + '\n当前变量状态：\n' + JSON.stringify(variables.stat_data)
        + (format === '聊天消息' ? '' : '\n仅返回 {"analysis":"...","json_patch":[...]} 对象。');
    const history = messages.slice(0, targetIndex).map(message => ({ role: message.role, content: message.content }));
    history.push({ role: 'assistant', content: text });
    const raw = settings['mvu.prompt_strategy'] === '使用内置破限';
    const gemini = connection.api.model?.toLowerCase().includes('gemini');
    const config: HelperGenerationConfig = { user_input: repair ? `只对当前状态执行必要增量校正，不重复已生效操作。核验重点：${repair.direction.trim().slice(0, 500) || '自动检查遗漏和明确错误'}。` : '执行变量更新任务，不续写剧情。', should_silence: false, should_stream: settings['mvu.pseudo_stream'] === true,
        preset_name: settings['mvu.prompt_strategy'] === '使用其他预设' ? String(settings['mvu.preset'] || '') : 'in_use', should_return_reasoning: false,
        overrides: { chat_history: { prompts: history.slice(-Math.max(2, Number(settings['mvu.history'] ?? 2))) } },
        injects: raw ? [] : [{ role: 'system', position: 'in_chat', depth: 0, should_scan: false, content: task },
            { role: 'system', position: 'in_chat', depth: 2, should_scan: false, content: '<past_observe>' },
            { role: 'system', position: 'in_chat', depth: 1, should_scan: false, content: '</past_observe>' }],
        custom_api: connection.api };
    if (raw) config.ordered_prompts = [
        ...(gemini && settings['mvu.random_header'] ? [{ role: 'system' as const, content: Array.from({ length: 4 }, () => crypto.randomUUID().slice(0, 8)).join('\n') }] : []),
        { role: 'system', content: gemini ? mvuPrompts.gemini_head : mvuPrompts.claude_head },
        { role: 'system', content: '<additional_information>' }, 'persona_description', 'char_description', 'world_info_before', 'world_info_after',
        { role: 'system', content: '</additional_information>\n<past_observe>' }, 'chat_history',
        { role: 'system', content: '</past_observe>' }, { role: 'system', content: task }, 'user_input',
        { role: 'system', content: gemini ? mvuPrompts.gemini_tail : mvuPrompts.claude_tail },
    ];
    if (format === '格式化输出') config.json_schema = { name: 'mvu_update', strict: false, value: responseSchema };
    if (format === '格式化输出(v4兼容)') config.custom_api!.custom_include_body = { ...config.custom_api!.custom_include_body, response_format: { type: 'json_object' } };
    if (format === '工具调用') { config.tools = [{ type: 'function', function: { name: 'update_variables', description: 'Update story variables using JSONPatch operations.', parameters: responseSchema } }]; config.tool_choice = 'required'; }
    const controller = new AbortController();
    const cancel = () => controller.abort(parentSignal.reason);
    parentSignal.throwIfAborted();
    parentSignal.addEventListener('abort', cancel, { once: true });
    const signal = controller.signal;
    activeAnalyses++;
    setMvuExtraAnalysisActive(true);
    const notificationId = settings['mvu.notify_analysis'] !== false
        ? showNotification('正在解析变量…', { kind: 'progress' }) : undefined;
    let analysisCompleted = false;
    try {
        const attempt = async (attemptSignal: AbortSignal): Promise<string> => {
            attemptSignal.throwIfAborted();
            const previous = preparationQueue;
            let releasePreparation!: () => void;
            preparationQueue = new Promise<void>(resolve => { releasePreparation = resolve; });
            await previous;
            let generation_id = `mvu:${crypto.randomUUID()}`;
            try {
                attemptSignal.throwIfAborted();
                // Author callbacks receive request data, never the user's stored connection key.
                const { key, apiurl, source, custom_include_headers, ...publicApi } = config.custom_api!;
                const prepared = await commandCompatibilityRuntime('prepareHelperGeneration', [structuredClone({ ...config, generation_id, custom_api: publicApi }), raw], true);
                const requestConfig = prepared.generationConfig!;
                generation_id = requestConfig.generation_id!;
                attemptSignal.throwIfAborted();
                const result = await generateForHelper({ ...requestConfig, custom_api: { ...requestConfig.custom_api, proxy_preset: undefined,
                    apiurl, key, source, custom_include_headers } },
                    raw, publishCompatibilityGenerationProgress, prepared.injections, { signal: attemptSignal, provider: connection.provider, onPrepared: releasePreparation,
                    onCancel: () => controller.abort(new DOMException('额外解析已停止', 'AbortError')), configureInput: input => {
                    input.mvuExtraAnalysis = true;
                    if (connection.provider?.contextWindow) input.maxContextTokens = connection.provider.contextWindow;
                    input.macroLastUserMessage = task;
                    input.mvuWorldbookFilter = { primary: binding.primary, character: [binding.primary, ...binding.additional].filter((name): name is string => !!name),
                        whitelist: String(settings['mvu.whitelist'] ?? ''), blacklist: String(settings['mvu.blacklist'] ?? ''),
                        characterWhitelist: String(settings['mvu.character_whitelist'] ?? ''), characterBlacklist: String(settings['mvu.character_blacklist'] ?? '') };
                } });
                attemptSignal.throwIfAborted();
                const finished = await commandCompatibilityRuntime('finishHelperGeneration', [generation_id, result], true);
                attemptSignal.throwIfAborted();
                const current = workspaceStore.getState(), latest = getActiveChatMessages(current).find(message => message.id === target.id);
                if (current.activeChatId !== state.activeChatId || current.activeCharacterId !== card.id || !latest || latest.activeSwipeIndex !== target.activeSwipeIndex) {
                    controller.abort(new DOMException('额外模型解析所属消息已切换', 'AbortError')); signal.throwIfAborted();
                }
                const block = normalizeExtraAnalysisResult(finished.generationResult!);
                analysisCompleted = true;
                return repair ? block : `${text.trimEnd()}\n\n${block}`;
            } catch (error) {
                stopHelperGeneration(generation_id, state.activeChatId);
                await commandCompatibilityRuntime('cancelHelperGeneration', [generation_id]).catch(() => {});
                attemptSignal.throwIfAborted();
                throw error;
            } finally { releasePreparation(); }
        };
        const count = Math.max(1, Math.min(10, Math.floor(Number(settings['mvu.attempts'] ?? 3))));
        const parallel = async () => {
            const group = new AbortController();
            const combined = AbortSignal.any([signal, group.signal]);
            const requests = Array.from({ length: count }, () => attempt(combined));
            try { return await Promise.any(requests); }
            catch (error) { signal.throwIfAborted(); throw error instanceof AggregateError ? error.errors.at(-1) : error; }
            finally { group.abort(new DOMException('已选出结果，取消同批请求', 'AbortError')); await Promise.allSettled(requests); }
        };
        if (settings['mvu.request_mode'] === '同时请求多次') return await parallel();
        if (settings['mvu.request_mode'] === '先请求一次, 失败后再同时请求多次') {
            try { return await attempt(signal); } catch { signal.throwIfAborted(); return await parallel(); }
        }
        let lastError: unknown;
        for (let index = 0; index < count; index++) {
            try { return await attempt(signal); } catch (error) { signal.throwIfAborted(); lastError = error; }
        }
        throw lastError;
    } catch (error) {
        analysisCompleted = false;
        if (notificationId) showNotification(signal.aborted ? '变量解析已停止' : `变量解析失败：${error instanceof Error ? error.message : String(error)}`,
            { id: notificationId, kind: signal.aborted ? 'info' : 'error' });
        throw error;
    } finally {
        if (notificationId && analysisCompleted) showNotification('变量解析完成', { id: notificationId, kind: 'success' });
        parentSignal.removeEventListener('abort', cancel);
        activeAnalyses--; setMvuExtraAnalysisActive(() => activeAnalyses > 0);
    }
}

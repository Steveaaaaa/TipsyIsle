import type { ToolDeclaration } from '../../../packages/plugin-sdk/index.js';
import { streamLlmCompletion, type CompletionRequestMessage, type CompletionToolCall, type StreamCompletionRequest } from '../../core/platform-bridge';
import { activePlugins, assertPluginActive, reportPlugin, type InstalledPlugin } from './catalog';
import { jsonObject, signature } from './edits';
import { invokeNativePlugin } from './host';
import { liveStory } from './story-port';
import { validateJson } from './storage';
import { checkToolSchema } from './tool-schema';
import { untilAbort } from './abortable';

interface Tool { plugin: InstalledPlugin; declaration: ToolDeclaration; name: string }
const rounds = 4, callsPerRound = 6, resultLimit = 6000;

export async function streamStoryWithNativeTools(req: StreamCompletionRequest, onPreview: (delta: { content: string; reasoning: string } | null) => void) {
    const view = liveStory();
    const plugins = activePlugins().filter(plugin => plugin.grants.includes('generation.tools') && plugin.manifest.tools?.length);
    if (!view.ref || !plugins.length) return streamLlmCompletion(req);
    const raw = { ...req.parameters, ...req.includeBody };
    if (Number(raw.n) > 1 || raw.tools || raw.functions || raw.tool_choice && raw.tool_choice !== 'auto'
        || req.excludeBody?.some(key => /^(?:tools|tool_choice|messages)(?:\.|$)/.test(key))) {
        for (const plugin of plugins) reportPlugin(plugin.manifest.id, '模型工具', 'skipped', 0, '本轮使用多候选或已指定其他工具');
        return streamLlmCompletion(req);
    }
    const tools = (await Promise.all(plugins.sort((a, b) => a.manifest.id < b.manifest.id ? -1 : 1).map(async plugin => {
        const prefix = (await signature(plugin.manifest.id)).slice(0, 12);
        return Promise.all(plugin.manifest.tools!.map(async declaration => {
            const tail = (await signature(declaration.id)).slice(0, 8);
            return { plugin, declaration, name: `tp_${prefix}_${declaration.id.slice(0, 35)}_${tail}` };
        }));
    }))).flat().slice(0, 64);
    req.signal?.throwIfAborted();
    const generationId = crypto.randomUUID(), byName = new Map(tools.map(tool => [tool.name, tool]));
    const definitions = tools.map(({ declaration, name }) => ({ type: 'function' as const, function: { name, description: declaration.description, parameters: declaration.parameters } }));
    const messages: CompletionRequestMessage[] = [...req.messages];
    const signal = req.signal ?? new AbortController().signal;
    const includeBody = req.includeBody && { ...req.includeBody };
    if (includeBody) { delete includeBody.tools; delete includeBody.tool_choice; }
    const callTool = async (call: CompletionToolCall) => {
        const tool = byName.get(call.function.name);
        if (!tool) return { ok: false, error: 'Unknown tool' };
        try {
            assertPluginActive(tool.plugin);
            if (call.function.arguments.length > 48_000) throw new Error('工具参数过长');
            const args = jsonObject(JSON.parse(call.function.arguments));
            await untilAbort(checkToolSchema(tool.declaration.parameters, args), signal);
            const value = validateJson(await invokeNativePlugin({ mode: 'tool', plugin: tool.plugin, view,
                target: view.ref?.head ?? undefined, id: `${generationId}:${call.id}`, input: { id: tool.declaration.id, args, generationId }, external: signal }), resultLimit);
            return { ok: true, value };
        } catch {
            signal.throwIfAborted();
            return { ok: false, error: 'Tool failed. Check its arguments and continue without it if necessary.' };
        }
    };
    for (let round = 0; ; round++) {
        signal.throwIfAborted();
        let callingTool = false;
        const result = await streamLlmCompletion({ ...req, includeBody, messages,
            parameters: { ...req.parameters, tools: definitions, tool_choice: round < rounds ? 'auto' : 'none' },
            onToolCall: () => { callingTool = true; onPreview(null); },
            onToken: (content, reasoning = '') => { if (!callingTool) onPreview({ content, reasoning }); },
        });
        const calls = result.tool_calls;
        // A round can start with text and still end with tools. Author listeners
        // and the summary channel receive only the final round of this turn.
        if (!calls?.length) { req.onToken(result.content, result.reasoning); return result; }
        if (round === rounds || calls.length > callsPerRound || new Set(calls.map(call => call.id)).size !== calls.length || calls.some(call => !call.id)) {
            throw new Error('模型工具未能在本轮限制内结束');
        }
        messages.push({ role: 'assistant', content: result.content, tool_calls: calls, reasoning_content: result.reasoning || undefined, reasoning_signature: result.reasoning_signature });
        const outputs = await Promise.all(calls.map(callTool));
        signal.throwIfAborted();
        for (const [index, call] of calls.entries()) messages.push({ role: 'tool', tool_call_id: call.id, name: call.function.name,
            content: JSON.stringify(outputs[index]), isError: !outputs[index].ok });
    }
}

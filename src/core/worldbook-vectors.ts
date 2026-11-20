import { getSchemaValues } from '../registry/schema-registry';
import { scopedVariableStore } from '../store/scoped-variable-store';
import { detectRuntimeFlavor } from './platform-bridge';
import { filterMvuWorldbooks } from '../pipeline/mvu-worldbooks';
import { evaluateMacros } from '../pipeline/macro-regex-engine';
import { parseWorldInfoDecorators, isSpecialWorldInfo } from '../pipeline/worldinfo-decorators';
import type { AssemblePromptInput } from '../pipeline/prompt-assembler';
import { hostMessageHidden } from '../compatibility/chat-message-codec';

/** Only the main host sends embeddings. Preview/render/preload never create paid requests. */
export async function prepareWorldbookVectors(input: AssemblePromptInput, signal?: AbortSignal): Promise<void> {
    if (input.templateTask || input.templatePreview) return;
    const settings = getSchemaValues(), extension = scopedVariableStore.getState().extension.vectors ?? {};
    if (!(extension.enabled_world_info ?? settings['vectors.enabled'])) return;
    const all = extension.enabled_for_all ?? settings['vectors.all'];
    const books = input.mvuWorldbookFilter ? filterMvuWorldbooks(input.lorebooks, input.mvuWorldbookFilter, input.mvuExtraAnalysis === true) : input.lorebooks;
    const expand = (text: string) => evaluateMacros(text, { userName: input.userName, charName: input.character.name,
        variables: structuredClone(input.initialVariables ?? {}), globalVariables: structuredClone(input.initialGlobalVariables ?? {}) });
    const entries = books.flatMap(book => book.entries.filter(entry => !entry.disabled && (entry.vectorized || all) && entry.content && !isSpecialWorldInfo(entry))
        .map(entry => ({ world: book.name, uid: entry.uid, content: expand(parseWorldInfoDecorators(entry.content).content) })));
    if (!entries.length) return;
    const history = input.helperGeneration?.config.overrides?.chat_history?.prompts ?? input.interceptedHistory ?? input.messages.filter(message => !hostMessageHidden(message, input.chatMetadata));
    const query = history.slice(-Math.max(1, Number(extension.query ?? settings['vectors.query'] ?? 2))).map(message => expand(message.content)).join('\n');
    if (!query.trim()) return;
    if (await detectRuntimeFlavor() !== 'local-gateway') throw new Error('世界书向量检索需要本地网关');
    const response = await fetch('/api/tipsy-isle/vectors/query', { method: 'POST', signal, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entries, query, baseUrl: settings['vectors.url'], apiKey: settings['vectors.key'], model: settings['vectors.model'],
            threshold: extension.score_threshold ?? settings['vectors.threshold'], maxEntries: extension.max_entries ?? settings['vectors.max_entries'], chunkSize: settings['vectors.chunk_size'] }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? `向量检索失败 (${response.status})`);
    input.vectorActivations = result.matches.map((entry: { world: string; uid: string | number }) => `${entry.world}::${entry.uid}`);
}

import { scanLorebooks } from '../pipeline/lorebook-scanner';
import { prepareTokenCounter, type TokenizerSelection } from '../pipeline/token-counter';
import { getActiveCharacter, getActiveLorebooks, getActivePersona, getActiveChatMessages, workspaceStore } from '../store/workspace-store';
import { getWorldbookGroups } from '../store/workspace/library';
import { schemaRegistryStore } from '../registry/schema-registry';
import { worldinfoSettings } from './worldbook-host';
import { toNativeWorldbookEntry } from './worldbook-codec';

export async function scanCompatibilityWorldbooks(params: Record<string, any>) {
    const state = workspaceStore.getState();
    const character = getActiveCharacter(state);
    const settings = worldinfoSettings();
    const registry = schemaRegistryStore.getState().values;
    const contextSize = Number(params.maxContext) || Number(registry['sampler.context_max_tokens']) || 8192;
    const budget = Math.min(Math.round(contextSize * settings.context_percentage / 100) || 1, settings.budget_cap > 0 ? settings.budget_cap : Infinity);
    const groups = getWorldbookGroups(state);
    const characterBooks = new Set([...groups.character, ...groups.additional]);
    const lorebooks = getActiveLorebooks(state).map(book => ({ ...book, entries: book.entries.map(entry => {
        const raw = entry.rawData as Record<string, any> | undefined;
        return { ...entry, caseSensitive: raw?.caseSensitive ?? raw?.extensions?.case_sensitive ?? settings.case_sensitive,
            matchWholeWords: raw?.matchWholeWords ?? raw?.extensions?.match_whole_words ?? settings.match_whole_words,
            useGroupScoring: raw?.useGroupScoring ?? raw?.extensions?.use_group_scoring ?? settings.use_group_scoring };
    }) }));
    // Tavern passes newest first; the shared scanner consumes chronological text.
    const text: string[] = Array.isArray(params.chat) ? params.chat.map(String).reverse() : [];
    const extra = params.globalScanData ?? {};
    const countTokens = await prepareTokenCounter(String(registry['api.model'] ?? ''), (registry['sampler.tokenizer'] ?? 'auto') as TokenizerSelection);
    const result = await scanLorebooks({ lorebooks, recentMessagesText: text, additionalScanText: params.additionalScanText,
        scanDepth: settings.scan_depth, maxRecursionSteps: settings.recursive ? settings.max_recursion_steps : 0,
        recursive: settings.recursive, minActivations: settings.min_activations, maxScanDepth: settings.max_depth,
        generationType: extra.trigger ?? 'normal', character, currentMessageCount: getActiveChatMessages(state).length,
        timedStates: state.timedStates, preview: params.isDryRun === true, tokenBudget: budget, countTokens,
        priority: entry => settings.insertion_strategy === 'evenly' ? 0 : Number(characterBooks.has(entry.world ?? '')) * (settings.insertion_strategy === 'character_first' ? -1 : 1),
        extraScanText: { matchPersonaDescription: extra.personaDescription ?? getActivePersona(state)?.description,
            matchCharacterDescription: extra.characterDescription ?? character.description,
            matchCharacterPersonality: extra.characterPersonality ?? character.personality,
            matchCharacterDepthPrompt: extra.characterDepthPrompt ?? character.depthPrompt?.prompt,
            matchScenario: extra.scenario ?? character.scenario, matchCreatorNotes: extra.creatorNotes ?? character.creatorNotes },
    });
    const current = workspaceStore.getState();
    if (current.activeChatId !== state.activeChatId || current.branchEpoch !== state.branchEpoch) throw new Error('世界书扫描所属路线已切换');
    return result.activatedEntries.map(toNativeWorldbookEntry);
}

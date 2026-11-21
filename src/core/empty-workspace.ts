import { normalizePreset } from '../pipeline/normalizer';
import type { NormalizedCharacterCard, NormalizedPreset } from '../types';

// Internal empty values keep read-only inspectors usable; never added to catalogs.
export const EMPTY_CHARACTER: NormalizedCharacterCard = { id: '', name: '', avatar: '', characterVersion: '',
    description: '', personality: '', scenario: '', firstMessage: '', alternateGreetings: [], mesExample: '',
    systemPrompt: '', postHistoryInstructions: '', creatorNotes: '', tags: [], regexScripts: [] };
// Structural slots assemble the user's card, worldbooks and history without adding a writing instruction.
export const NO_PRESET: NormalizedPreset = { ...normalizePreset({ name: '未使用预设', main_prompt: '' }), id: '', rawData: {} };
NO_PRESET.promptSlots!.splice(7, 0, { identifier: 'authorsNote', name: '作者注释位置', role: 'system', content: '',
    enabled: true, marker: true, injectionPosition: 'in_chat', injectionDepth: 4, injectionOrder: 7 });
export function emptyStory() {
    return { sessionKind: 'character' as const, freeChat: undefined, branchEpoch: 0, chatMetadata: undefined, nativePluginRoute: undefined, branchExtensionKeys: [], deletedMessageIds: [], activeCharacterId: '', activeChatId: '', messages: [], activeLeafId: null, timedStates: {},
        templateInjections: [], templateActivations: [], lastAssembledPrompt: null,
        storyWorldbooks: undefined, storyCharacterBinding: undefined, storyCharacter: undefined, storyPersona: undefined, storyImportFingerprint: undefined, portableStory: undefined };
}

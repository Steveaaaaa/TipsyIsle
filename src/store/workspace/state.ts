import type { ChatSessionKind, FreeChatDetails } from '../chat-archives';
import { createReactiveStore } from '../reactive-store';
import type { StreamDisplayMode } from '../../pipeline/streaming-message';
import type { PluginBuckets } from '../../plugins/native/storage';
import type { StoryChange } from '../../../packages/plugin-sdk/index.js';
import type { AssembledPromptResult, ChatMessageNode, LorebookTimedState, NormalizedCharacterCard, NormalizedLorebook, NormalizedPreset } from '../../types';
import type { TemplatePromptInjection } from '../../pipeline/template-injections';

export interface WorkspaceState {
    branchEpoch?: number;
    chatMetadata?: Record<string, unknown>;
    nativePluginRoute?: PluginBuckets;
    nativeStoryReply?: StoryChange;
    branchExtensionKeys?: string[];
    deletedMessageIds?: string[];
    storyWorldbooks?: NormalizedLorebook[];
    storyCharacterBinding?: { primary: string | null; additional: string[] };
    storyCharacter?: NormalizedCharacterCard;
    storyPersona?: import('../../types').UserPersona;
    streamDisplayModes: Record<string, StreamDisplayMode>;
    userName: string;
    personas: import('../../types').UserPersona[];
    activePersonaId: string | null;
    characters: NormalizedCharacterCard[];
    activeCharacterId: string;
    lorebooks: NormalizedLorebook[];
    activeLorebookIds: string[];
    characterWorldbookBindings: Record<string, { primary: string | null; additional: string[] }>;
    chatWorldbookBindings: Record<string, string | null>;
    presets: NormalizedPreset[];
    activePresetId: string;
    inUsePreset?: NormalizedPreset;
    activeChatId: string;
    sessionKind: ChatSessionKind;
    freeChat?: FreeChatDetails;
    storyImportFingerprint?: string;
    portableStory?: boolean;
    messages: ChatMessageNode[];
    activeLeafId: string | null;
    timedStates: Record<string, LorebookTimedState>;
    lastAssembledPrompt: AssembledPromptResult | null;
    isGenerating: boolean;
    mvuExtraAnalysisActive: boolean;
    helperGenerationCount: number;
    streamingReasoning: string;
    nativeToolPreview?: { id: string; content: string; reasoning: string };
    templateRenderRevision: number;
    templateInjections: TemplatePromptInjection[];
    templateActivations: Array<{ world: string; uid: string | number; force: boolean }>;
}

export function initialWorkspace(): WorkspaceState {
    return {
        userName: '用户',
        streamDisplayModes: {},
        personas: [],
        activePersonaId: null,
        characters: [],
        activeCharacterId: '',
        lorebooks: [],
        activeLorebookIds: [],
        characterWorldbookBindings: {},
        chatWorldbookBindings: {},
        presets: [],
        inUsePreset: undefined,
        activePresetId: '',
        activeChatId: '',
        sessionKind: 'character',
        messages: [],
        activeLeafId: null,
        timedStates: {},
        lastAssembledPrompt: null,
        isGenerating: false,
        mvuExtraAnalysisActive: false,
        helperGenerationCount: 0,
        streamingReasoning: '',
        templateRenderRevision: 0,
        templateInjections: [],
        templateActivations: [],
    };
}

export const workspaceStore = createReactiveStore<WorkspaceState>(initialWorkspace);

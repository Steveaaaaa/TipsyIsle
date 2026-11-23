import { beforeEach, describe, expect, it } from 'vitest';
import {
    defaultParametersForSource,
    normalizeConnectionProfile,
    parseConnectionProfiles,
    profileFromSettings,
    removeConnectionProfile,
    serializeConnectionProfiles,
    settingsPatchFromProfile,
    upsertConnectionProfile,
} from '../src/core/model-profiles';
import { schemaRegistryStore, setSchemaValues } from '../src/registry/schema-registry';
import { initialWorkspace } from '../src/store/workspace/state';
import { applyArchivedChatState } from '../src/store/workspace/sessions';
import {
    createChat,
    getActiveLorebooks,
    getActivePreset,
    getCharacterWorldbooks,
    selectPreset,
    setCharacterWorldbookBinding,
    setGlobalWorldbookEnabled,
    workspaceStore,
} from '../src/store/workspace-store';
import type { NormalizedCharacterCard, NormalizedLorebook, NormalizedPreset } from '../src/types';

function makeCard(id: string, name: string, embedded?: NormalizedLorebook): NormalizedCharacterCard {
    return {
        id,
        name,
        description: `${name} desc`,
        personality: '',
        scenario: '',
        firstMessage: `Hello from ${name}`,
        alternateGreetings: [],
        mesExample: '',
        systemPrompt: '',
        postHistoryInstructions: '',
        creatorNotes: '',
        tags: [],
        extensions: {},
        embeddedLorebook: embedded ?? null,
    };
}

function makeBook(id: string, name: string): NormalizedLorebook {
    return {
        id,
        name,
        entries: [{
            uid: 1,
            keys: ['test'],
            secondaryKeys: [],
            content: `${name} content`,
            comment: `${name} entry`,
            constant: true,
            selective: false,
            disabled: false,
            position: 'before_char',
            order: 100,
        }],
    };
}

function makePreset(id: string, name: string, temperature: number): NormalizedPreset {
    return {
        id,
        name,
        temperature,
        rawData: { temperature, custom_prompt_post_processing: '' },
        promptSlots: [{ identifier: 'main', name: 'Main', role: 'system', content: `${name} main`, enabled: true }],
    };
}

beforeEach(() => {
    workspaceStore.setState(initialWorkspace());
    setSchemaValues({
        'api.active_profile': '',
        'api.connection_profiles': '[]',
        'api.chat_completion_source': 'openai',
        'api.custom_url': 'https://api.openai.com/v1',
        'api.key': '',
        'api.model': 'gpt-4o',
        'sampler.reasoning_effort': 'auto',
        'sampler.prompt_post_processing': 'auto',
        'sampler.use_sysprompt': 'auto',
        'sampler.temperature': 0.95,
    }, false);
});

describe('story model connection profiles', () => {
    it('provides sensible defaults for unset parameters and fills missing fields on load', () => {
        const geminiDefaults = defaultParametersForSource('makersuite');
        expect(geminiDefaults).toEqual({
            source: 'makersuite',
            baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
            model: 'gemini-2.5-pro',
            reasoningEffort: 'auto',
            promptPostProcessing: 'auto',
            useSystemPrompt: 'auto',
        });

        const normalized = normalizeConnectionProfile({
            name: '旧渠道',
            source: 'claude',
            baseUrl: 'https://api.anthropic.com',
            apiKey: 'sk-ant-test',
            model: 'claude-sonnet-4-20250514',
        });
        expect(normalized).toMatchObject({
            name: '旧渠道',
            source: 'claude',
            reasoningEffort: 'auto',
            promptPostProcessing: 'auto',
            useSystemPrompt: 'auto',
        });
    });

    it('saves, updates, switches, and deletes multiple channels including reasoning, post-processing, and use_sysprompt', () => {
        const ch1 = profileFromSettings('Gemini 官方', {
            'api.chat_completion_source': 'makersuite',
            'api.custom_url': 'https://generativelanguage.googleapis.com/v1beta',
            'api.key': 'gm-key',
            'api.model': 'gemini-2.5-pro',
            'sampler.reasoning_effort': 'high',
            'sampler.prompt_post_processing': 'semi',
            'sampler.use_sysprompt': 'off',
        });
        const ch2 = profileFromSettings('Claude 中转', {
            'api.chat_completion_source': 'claude',
            'api.custom_url': 'https://proxy.example.com',
            'api.key': 'cl-key',
            'api.model': 'claude-3-7-sonnet',
            'sampler.reasoning_effort': 'medium',
            'sampler.prompt_post_processing': 'strict',
            'sampler.use_sysprompt': 'on',
        });

        let list = upsertConnectionProfile([], ch1);
        list = upsertConnectionProfile(list, ch2);
        const restored = parseConnectionProfiles(serializeConnectionProfiles(list));
        expect(restored).toHaveLength(2);

        const patch1 = settingsPatchFromProfile(restored[0]);
        expect(patch1).toEqual({
            'api.active_profile': ch1.id,
            'api.chat_completion_source': 'makersuite',
            'api.custom_url': 'https://generativelanguage.googleapis.com/v1beta',
            'api.key': 'gm-key',
            'api.model': 'gemini-2.5-pro',
            'sampler.reasoning_effort': 'high',
            'sampler.prompt_post_processing': 'semi',
            'sampler.use_sysprompt': 'off',
        });

        // Update by same name preserves id and updates advanced parameters
        const updatedCh1 = profileFromSettings('Gemini 官方', {
            ...patch1,
            'sampler.reasoning_effort': 'max',
        });
        list = upsertConnectionProfile(list, updatedCh1);
        expect(list).toHaveLength(2);
        expect(list[0].id).toBe(ch1.id);
        expect(list[0].reasoningEffort).toBe('max');

        list = removeConnectionProfile(list, ch2.id);
        expect(list.map(item => item.name)).toEqual(['Gemini 官方']);
    });
});

describe('multi-worldbook bindings (global universal + character 1:N) and remembered character presets', () => {
    it('supports multiple universal global worldbooks and preserves them across free chat transitions', () => {
        const cardA = makeCard('char_a', '角色A');
        const wb1 = makeBook('wb_1', '通用文风书');
        const wb2 = makeBook('wb_2', '通用禁词书');
        const wb3 = makeBook('wb_3', '通用规则书');

        workspaceStore.setState(draft => {
            draft.characters = [cardA];
            draft.lorebooks = [wb1, wb2, wb3];
        });
        createChat(cardA, false);

        setGlobalWorldbookEnabled(wb1.id, true);
        setGlobalWorldbookEnabled(wb2.id, true);
        setGlobalWorldbookEnabled(wb3.id, true);
        expect(workspaceStore.getState().activeLorebookIds).toEqual([wb1.id, wb2.id, wb3.id]);
        expect(getActiveLorebooks().map(book => book.id)).toEqual([wb1.id, wb2.id, wb3.id]);

        // Switching to free chat should hide worldbooks during free chat without wiping global selection
        applyArchivedChatState({
            id: 'free_1',
            kind: 'free',
            characterId: '',
            messages: [],
            activeLeafId: null,
            timedStates: {},
        });
        expect(getActiveLorebooks()).toEqual([]);
        expect(workspaceStore.getState().activeLorebookIds).toEqual([wb1.id, wb2.id, wb3.id]);

        // Returning to a character story restores all 3 universal worldbooks automatically
        createChat(cardA, false);
        expect(getActiveLorebooks().map(book => book.id)).toEqual([wb1.id, wb2.id, wb3.id]);
    });

    it('supports 1:N character worldbooks (primary + multiple additional) combined with universal global books', () => {
        const embedded = makeBook('wb_emb', '角色内嵌书');
        const cardA = makeCard('char_a', '角色A', embedded);
        const wbExtra1 = makeBook('wb_e1', '补充设定一');
        const wbExtra2 = makeBook('wb_e2', '补充设定二');
        const wbGlobal = makeBook('wb_g1', '全局通用书');

        workspaceStore.setState(draft => {
            draft.characters = [cardA];
            draft.lorebooks = [wbExtra1, wbExtra2, wbGlobal];
        });
        createChat(cardA, false);
        setGlobalWorldbookEnabled(wbGlobal.id, true);
        setCharacterWorldbookBinding(cardA.id, embedded.name, [wbExtra1.name, wbExtra2.name, embedded.name, wbExtra1.name]);

        const binding = getCharacterWorldbooks(cardA);
        expect(binding).toEqual({
            primary: embedded.name,
            additional: [wbExtra1.name, wbExtra2.name],
        });
        expect(getActiveLorebooks().map(book => book.name)).toEqual([
            embedded.name,
            wbExtra1.name,
            wbExtra2.name,
            wbGlobal.name,
        ]);
    });

    it('remembers each character last-used preset and worldbooks across switches without clobbering active channel settings', () => {
        const cardA = makeCard('char_a', '角色A');
        const cardB = makeCard('char_b', '角色B');
        const wbA1 = makeBook('wb_a1', '世界书A1');
        const wbA2 = makeBook('wb_a2', '世界书A2');
        const wbB1 = makeBook('wb_b1', '世界书B1');
        const wbGlobal = makeBook('wb_global', '全局通用书');
        const preset1 = makePreset('p1', '古风预设', 0.7);
        const preset2 = makePreset('p2', '现代预设', 1.15);

        workspaceStore.setState(draft => {
            draft.characters = [cardA, cardB];
            draft.lorebooks = [wbA1, wbA2, wbB1, wbGlobal];
            draft.presets = [preset1, preset2];
        });

        // Pin an active model channel with custom post-processing & use_sysprompt
        setSchemaValues({
            'api.active_profile': 'chan_gemini',
            'sampler.reasoning_effort': 'high',
            'sampler.prompt_post_processing': 'semi',
            'sampler.use_sysprompt': 'off',
        }, false);

        // Configure Character A: preset1 + [wbA1, wbA2] + global wbGlobal
        createChat(cardA, false);
        setGlobalWorldbookEnabled(wbGlobal.id, true);
        selectPreset(preset1.id);
        setCharacterWorldbookBinding(cardA.id, wbA1.name, [wbA2.name]);

        // Switch to Character B: preset2 + [wbB1]
        createChat(cardB, false);
        selectPreset(preset2.id);
        setCharacterWorldbookBinding(cardB.id, wbB1.name, []);
        expect(getActivePreset().id).toBe(preset2.id);
        expect(getActiveLorebooks().map(book => book.name)).toEqual([wbB1.name, wbGlobal.name]);

        // Switch back to Character A (new chat): restores preset1 + [wbA1, wbA2] + global wbGlobal
        createChat(cardA, false);
        expect(getActivePreset().id).toBe(preset1.id);
        expect(schemaRegistryStore.getState().values['sampler.temperature']).toBe(0.7);
        expect(getActiveLorebooks().map(book => book.name)).toEqual([wbA1.name, wbA2.name, wbGlobal.name]);

        // Re-opening an older archived chat of Character A keeps latest remembered preset/worldbooks & active channel settings
        applyArchivedChatState({
            id: 'chat_a_old',
            characterId: cardA.id,
            messages: [],
            activeLeafId: null,
            timedStates: {},
            continuation: {
                activePresetId: preset2.id,
                inUsePreset: preset2,
                activeLorebookIds: [],
                userName: '用户',
                activePersonaId: null,
                extensions: {},
                variables: { global: {}, chat: {}, message: {} },
                settings: {
                    'sampler.temperature': 1.2,
                    'sampler.reasoning_effort': 'low',
                    'sampler.prompt_post_processing': 'none',
                    'sampler.use_sysprompt': 'on',
                },
                characterBinding: { primary: wbB1.name, additional: [] },
            },
        });
        expect(getActivePreset().id).toBe(preset1.id);
        expect(getActiveLorebooks().map(book => book.name)).toEqual([wbA1.name, wbA2.name, wbGlobal.name]);
        expect(schemaRegistryStore.getState().values['sampler.reasoning_effort']).toBe('high');
        expect(schemaRegistryStore.getState().values['sampler.prompt_post_processing']).toBe('semi');
        expect(schemaRegistryStore.getState().values['sampler.use_sysprompt']).toBe('off');
    });
});

import { describe, it, expect } from 'vitest';
import { assemblePromptPipeline } from '../src/pipeline/prompt-assembler';
import { filterMvuWorldbooks } from '../src/pipeline/mvu-worldbooks';
import { formatMvuMessageContent } from '../src/pipeline/mvu-commands';
import { messageNeedsAuthorHost } from '../src/compatibility/message-host-requirements';
import { classifyLibraryJson } from '../src/store/workspace/library';
import type { NormalizedCharacterCard, NormalizedLorebook, NormalizedPreset } from '../src/types';

const baseCard: NormalizedCharacterCard = {
    id: 'char_mvu_test',
    name: '测试角色',
    avatar: '',
    description: '角色设定',
    personality: '',
    scenario: '',
    firstMessage: '开场白',
    alternateGreetings: [],
    mesExample: '',
    systemPrompt: '',
    postHistoryInstructions: '',
    creatorNotes: '',
    tags: [],
    regexScripts: [],
};

const basePreset: NormalizedPreset = {
    id: 'preset_mvu_test',
    name: '测试预设',
    prompts: [
        { identifier: 'main', name: 'Main', role: 'system', content: 'System prompt', enabled: true },
        { identifier: 'worldInfoBefore', name: 'World Info (before)', role: 'system', content: '', marker: true, enabled: true },
        { identifier: 'worldInfoAfter', name: 'World Info (after)', role: 'system', content: '', marker: true, enabled: true },
        { identifier: 'chatHistory', name: 'Chat History', role: 'system', content: '', marker: true, enabled: true },
    ],
    promptOrder: ['main', 'worldInfoBefore', 'worldInfoAfter', 'chatHistory'],
    maxContextTokens: 8192,
    maxResponseTokens: 1024,
    regexScripts: [],
};

describe('MVU dialogue prompt assembly & rendering fixes', () => {
    it('expands {{format_message_variable::stat_data}} in lorebook entries instead of "null"', async () => {
        const lorebook: NormalizedLorebook = {
            id: 'wb_mvu',
            name: 'MVU测试书',
            entries: [
                {
                    uid: 1,
                    world: 'MVU测试书',
                    comment: '1️⃣⚙当前变量',
                    content: '<status_current_variable>\n{{format_message_variable::stat_data}}\n</status_current_variable>',
                    keys: [],
                    secondaryKeys: [],
                    selectiveLogic: 'AND_ANY',
                    selective: false,
                    constant: true,
                    disabled: false,
                    order: 100,
                    position: 'before_char',
                    depth: 4,
                    role: 'system',
                    probability: 100,
                    useProbability: false,
                },
            ],
        };

        const result = await assemblePromptPipeline({
            character: baseCard,
            preset: basePreset,
            lorebooks: [lorebook],
            messages: [
                {
                    id: 'msg_0',
                    parentId: null,
                    floor: 0,
                    role: 'assistant',
                    speakerName: '测试角色',
                    content: '欢迎进入剧情。',
                    swipes: ['欢迎进入剧情。'],
                    activeSwipeIndex: 0,
                    createdAt: Date.now(),
                    extra: {
                        swipeVariables: {
                            0: {
                                stat_data: {
                                    好感度: 42,
                                    地点: '图书馆',
                                },
                            },
                        },
                    },
                },
                {
                    id: 'msg_1',
                    parentId: 'msg_0',
                    floor: 1,
                    role: 'user',
                    speakerName: '玩家',
                    content: '你好！',
                    swipes: ['你好！'],
                    activeSwipeIndex: 0,
                    createdAt: Date.now(),
                },
            ],
            userName: '玩家',
            initialMessageVariables: {
                msg_0: {
                    stat_data: {
                        好感度: 42,
                        地点: '图书馆',
                    },
                },
                msg_1: {},
            },
        });

        const joined = result.messages.map(m => m.content).join('\n');
        expect(joined).toContain('好感度: 42');
        expect(joined).toContain('地点: 图书馆');
        expect(joined).not.toContain('<status_current_variable>\nnull\n</status_current_variable>');
    });

    it('sanitizes conflicting [mvu_plot] prohibitions in inline (随AI输出) mode', () => {
        const books: NormalizedLorebook[] = [
            {
                id: 'wb_1',
                name: '双模式测试书',
                entries: [
                    {
                        uid: 1,
                        comment: '[mvu_plot]剧情输出规则',
                        content: '- 正常输出正文\n- 正文外不得输出 <UpdateVariable>\n- 保持沉浸感',
                        keys: [],
                        secondaryKeys: [],
                        selectiveLogic: 'AND_ANY',
                        selective: false,
                        constant: true,
                        disabled: false,
                        order: 100,
                        position: 'before_char',
                        depth: 4,
                        probability: 100,
                        useProbability: false,
                    },
                    {
                        uid: 2,
                        comment: '[mvu_update]变量输出格式',
                        content: '请在回复末尾输出 <UpdateVariable> 块。',
                        keys: [],
                        secondaryKeys: [],
                        selectiveLogic: 'AND_ANY',
                        selective: false,
                        constant: true,
                        disabled: false,
                        order: 101,
                        position: 'before_char',
                        depth: 4,
                        probability: 100,
                        useProbability: false,
                    },
                ],
            },
        ];

        const filtered = filterMvuWorldbooks(books, {
            primary: '双模式测试书',
            character: ['双模式测试书'],
            whitelist: '',
            blacklist: '',
            inlineMode: true,
        }, false);

        const plotEntry = filtered[0].entries.find(e => e.uid === 1)!;
        expect(plotEntry.content).toContain('正常输出正文');
        expect(plotEntry.content).toContain('保持沉浸感');
        expect(plotEntry.content).not.toContain('不得输出 <UpdateVariable>');
    });

    it('appends <StatusPlaceHolderImpl/> and strips <status_current_variable> in script-free MVU settlement', () => {
        const formatted = formatMvuMessageContent('<status_current_variable>abc</status_current_variable>剧情正文内容', true);
        expect(formatted).toContain('剧情正文内容');
        expect(formatted).toContain('<StatusPlaceHolderImpl/>');
        expect(formatted).not.toContain('<status_current_variable>');
    });

    it('detects MVU frontend status bar scripts as requiring author host', () => {
        expect(messageNeedsAuthorHost('<script>const vars = getVariables({ type: "message" });</script>')).toBe(true);
        expect(messageNeedsAuthorHost('<script>await waitGlobalInitialized("Mvu"); Mvu.getMvuData();</script>')).toBe(true);
    });

    it('classifies standalone regex JSON and TavernHelper script JSON files', () => {
        expect(classifyLibraryJson({ findRegex: '/foo/g', replaceString: 'bar' }).kind).toBe('regex');
        expect(classifyLibraryJson([{ find_regex: '/foo/g', replace_string: 'bar' }]).kind).toBe('regex');
        expect(classifyLibraryJson({ type: 'script', name: 'MVU脚本', enabled: true, content: 'console.log(1)' }).kind).toBe('tavern-script');
        expect(classifyLibraryJson([{ type: 'folder', name: '脚本组', enabled: true, scripts: [] }]).kind).toBe('tavern-script');
    });
});

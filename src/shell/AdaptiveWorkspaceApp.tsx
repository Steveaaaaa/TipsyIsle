import { StoryRoutes, openStoryRoutes } from './StoryRoutes';
import { AssetActionMenu, AssetMoreButton, type MenuPoint } from './AssetActionMenu';
import { storyIdentity } from '../core/story-identity';
import { StoryGalleryPanel } from './StoryGalleryPanel';
import { readStoryGallery } from '../core/story-gallery';
import { CharacterLibraryItem } from './CharacterLibraryItem';
import { GenerationActivity } from './GenerationActivity';
import { NotificationRegion } from './NotificationRegion';
import { DeleteAssetDialog, type DeleteAssetTarget } from './DeleteAssetDialog';
import { useNativeNavigation } from './useNativeNavigation';
import { initializeLanSync, lanSyncStore, beginWorldbookEditing, finishWorldbookEditing } from '../core/sync/engine';
import { WorldbookSyncReview } from './WorldbookSyncReview';
import { hydrateStorySettings } from '../registry/schema-registry';
import { DEFAULT_CONTEXT_TOKENS } from '../core/generation-defaults';
import { compatibilityOrigin, initializeNativeRuntime, isNativeRuntime } from '../core/native-runtime';
import { pickNativeAsset } from '../core/platform-files';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { stopHelperGeneration } from '../compatibility/helper-generation';
import { compatibilityComposer, connectCompatibilityComposer, connectCompatibilityComposerSubmit, editCompatibilityComposer } from '../compatibility/composer-bridge';
import { cardNeedsAuthorHost, messageNeedsAuthorHost, regexesNeedAuthorHost } from '../compatibility/message-host-requirements';
import { globalRegexes } from '../store/global-regex-store';
import { resolvedQuickReplyConfig, quickReplyContextItems } from '../sandbox/quick-reply';
import { QuickReplyMenu } from './QuickReplyMenu';
import { SettingsPanel } from './SettingsPanel';
import { PersonaSettings } from './PersonaSettings';
import { useReadingMode } from './useReadingMode';
import { AnchoredDialog } from './AnchoredDialog';
import { WorldbookEntriesPanel, worldbookPositions } from './WorldbookEntriesPanel';
import { MvuRepairPanel } from './MvuRepairPanel';
import { refreshExtensionCatalog } from '../compatibility/extension-host';
import { readExtensionVariables } from '../compatibility/extension-variables';
import {
    appendChatMessage,
    deleteChatMessage,
    editChatMessage,
    formatMessageForDisplay,
    isMessageTemplatePending,
    getActiveCharacter,
    getActiveChatMessages,
    getActiveLorebooks,
    getActivePersona,
    getActivePreset,
    getAvailableWorldbooks,
    getCharacterWorldbooks,
    getChatBranchOptions,
    listArchivedChats,
    restoreArchivedChat,
    selectChatBranch,
    selectPreset,
    startNewChat,
    updatePresetPrompt,
    updateCharacterDocument,
    updateLorebookEntry,
    replaceActiveWorldbookEntries,
    hydrateWorkspaceFromPlatform,
    authorMessageRevision,
    importAssetFile,
    clearImportedWorkspace,
    refreshPromptInspectorPreview,
    observePromptInspector,
    selectCharacter,
    sendUserMessageAndGenerate,
    regenerateLastAssistantMessage,
    reprocessLastMvuMessage,
    setStatusBanner,
    setGlobalWorldbookEnabled,
    stopActiveGeneration,
    exportCharacterAsPng,
    swipeChatMessage,
    persistWorkspaceNow,
    workspaceStore,
} from '../store/workspace-store';
import {
    getScopedVariables,
    hydrateVariablesFromPlatform,
    replaceScopedVariables,
    resolveMergedVariables,
    scopedVariableStore,
} from '../store/scoped-variable-store';
import { hydrateThemeFromPlatform, readingColorScheme, themeEngineStore, toggleReadingColorScheme } from '../theme/theme-engine';
import { appearanceDevice, appearanceStore, hydrateAppearance, pauseAppearance } from '../theme/appearance-store';
import { applyAppearanceStyle, compileAppearance, wallpaperStyle } from '../theme/appearance-style';
import { assetUrl, defaultText, partText, placements, textOf, type Area, type Part, type Widget } from '../theme/appearance-model';
import { ShellArt, ShellBrand, ShellPartIcon, ShellWidget } from '../theme/appearance-shell';
import { Icon } from './Icon';
import { CharacterAvatar } from './CharacterAvatar';
import { ThemeStudioPanel } from '../theme/ThemeStudioPanel';
import { VirtualChatStream } from './VirtualChatStream';
import { CompatibilityChat } from '../compatibility/CompatibilityChat';
import { installWorkspaceCompatibility } from '../compatibility/workspace-host';
import { getWorkspaceScripts } from '../store/workspace-store';
import { CharacterDetailsPanel, MvuCharacterSettingsEditor, PresetEntriesPanel } from './AssetInspectorPanel';
import { SlotMount } from '../plugins/slot-registry';
import { NativePluginCommandHost, PluginButtons, WorkspacePluginMenu } from '../plugins/native/PluginCommands';
import { initializeNativePlugins } from '../plugins/native/catalog';
import { observeNativeRoutes } from '../plugins/native/host';
import { initializeStoryChanges } from '../plugins/native/events';
import type { VariableScopeLevel } from '../types';
import { registeredSnapshots, suspendRegisteredPersistence } from '../store/persistence';
import { commandCompatibilityRuntime, compatibilityStoryReady, getCompatibilityScriptButtons, subscribeCompatibilityScriptButtons, getCompatibilityExtensionMenu, subscribeCompatibilityExtensionMenu, getCompatibilityIllustrationAvailable } from '../compatibility/runtime-client';
import { hostIllustrationKey, type HostIllustration } from '../compatibility/chat-message-codec';
import { swipeId } from '../store/chat-tree';
import { beginSyncAssetEdit, setStoryRuntimeLoading } from '../core/sync/activity';
import { GuideWelcome, OnboardingTour, needsFirstRunGuide, rememberFirstRunGuide, type GuideStep } from './OnboardingTour';
import type { SettingsCategory } from './settings-presentation';
import { ChatComposerInput } from './ChatComposerInput';
import type { ReactNode } from 'react';

type InspectorTab = 'prompt-tree' | 'variables' | 'theme-studio' | 'schema-settings';
type MobileTab = 'characters' | 'chat' | 'inspector';
installWorkspaceCompatibility();
let bootstrap: Promise<void> | undefined;
function initializeWorkspace(): Promise<void> {
    return bootstrap ??= (async () => {
        await initializeNativeRuntime();
        await hydrateThemeFromPlatform();
        await hydrateAppearance();
          await hydrateStorySettings();
        const finish = suspendRegisteredPersistence();
        try {
            await hydrateVariablesFromPlatform();
            await hydrateWorkspaceFromPlatform(false);
            await refreshExtensionCatalog();
            await initializeStoryChanges(authorMessageRevision, registeredSnapshots()).catch(error => console.warn('无法载入插件存档日志', error));
            await finish(true);
            observeNativeRoutes();
            void initializeNativePlugins().catch(() => {});
            // Sync initialization itself waits for the author runtime and a quiet moment.
            setTimeout(() => {
                void initializeLanSync().catch(error => setStatusBanner(`互通初始化失败：${String(error)}`));
            }, 0);
        } catch (error) { await finish(false); throw error; }
    })().catch(error => { bootstrap = undefined; throw error; });
}

function reportActionError(label: string, error: unknown): void {
    setStatusBanner(`${label}失败：${error instanceof Error ? error.message : String(error)}`, { kind: 'error' });
}

async function runUiAction<T>(label: string, action: () => Promise<T>, fallback: T): Promise<T> {
    try {
        return await action();
    } catch (error) {
        reportActionError(label, error);
        return fallback;
    }
}

function runStoreAction(label: string, action: () => void): boolean {
    try {
        action();
        return true;
    } catch (error) {
        reportActionError(label, error);
        return false;
    }
}

export function AdaptiveWorkspaceApp() {
    const syncArchiveRevision = lanSyncStore.useStore(s => s.archiveRevision);
    useEffect(() => {
        const onStorageError = (event: Event) => setStatusBanner(String((event as CustomEvent).detail));
        window.addEventListener('tipsy-storage-error', onStorageError);
        return () => window.removeEventListener('tipsy-storage-error', onStorageError);
    }, []);
    const state = workspaceStore.useStore();
    const variableState = scopedVariableStore.useStore();
    const themeState = themeEngineStore.useStore();
    const darkReading = readingColorScheme(themeState.tokens.bgPrimary) === 'dark';
    const readingColorAction = darkReading ? '切换到日间配色' : '切换到夜间配色';
    const savedSkin = appearanceStore.useStore(state => state.saved);
    const skinDevice = appearanceDevice.useStore();
    const skin = skinDevice.paused ? undefined : savedSkin ?? undefined;
    const [appearanceOpen, setAppearanceOpen] = useState(false);
    const skinCss = useMemo(() => skin ? compileAppearance(skin) : '', [skin]);
    const appName = textOf(skin, 'name') || defaultText.name;
    useLayoutEffect(() => { applyAppearanceStyle(document, skinCss); }, [skinCss]);
    useEffect(() => { document.title = textOf(skin, 'window') || (skin ? appName : '微醺屿 · TipsyIsle'); }, [appName, skin]);
    useEffect(() => {
        const recover = (event: KeyboardEvent) => {
            if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'u') { event.preventDefault(); pauseAppearance(true); setAppearanceOpen(true); }
        };
        window.addEventListener('keydown', recover);
        return () => window.removeEventListener('keydown', recover);
    }, []);

    const [inputDraft, setInputDraft] = useState('');
    useEffect(() => connectCompatibilityComposer(inputDraft, setInputDraft), [inputDraft]);
    const scriptButtons = useSyncExternalStore(subscribeCompatibilityScriptButtons, getCompatibilityScriptButtons);
    const extensionMenu = useSyncExternalStore(subscribeCompatibilityExtensionMenu, getCompatibilityExtensionMenu);
    const canIllustrate = useSyncExternalStore(subscribeCompatibilityExtensionMenu, getCompatibilityIllustrationAvailable);
    const [extensionPanel, setExtensionPanel] = useState(false);
    const [illustrationId, setIllustrationId] = useState<string>();
    const [illustrationPrompt, setIllustrationPrompt] = useState('');
    const [illustrating, setIllustrating] = useState(false);
    const illustrationAnchor = useRef<HTMLDivElement>(null);
    useEffect(() => { setExtensionPanel(false); setIllustrationId(undefined); }, [state.activeChatId, state.branchEpoch]);
    const openIllustration = useCallback((id: string) => { setIllustrationPrompt(''); setIllustrationId(id); }, []);
    useEffect(() => {
        const open = (event: Event) => openIllustration((event as CustomEvent<string>).detail);
        window.addEventListener('tipsy-extension-illustration', open);
        return () => window.removeEventListener('tipsy-extension-illustration', open);
    }, [openIllustration]);
    const [workspaceReady, setWorkspaceReady] = useState(false);
    const [readyStory, setReadyStory] = useState('');
    useEffect(() => {
        const ready = (event: Event) => setReadyStory((event as CustomEvent<string>).detail);
        const reset = () => setReadyStory('');
        window.addEventListener('tipsy-compatibility-ready', ready);
        window.addEventListener('tipsy-compatibility-reload', reset);
        window.addEventListener('tipsy-compatibility-fault', reset);
        return () => {
            window.removeEventListener('tipsy-compatibility-ready', ready);
            window.removeEventListener('tipsy-compatibility-reload', reset);
            window.removeEventListener('tipsy-compatibility-fault', reset);
        };
    }, []);
    const [guide, setGuide] = useState<'welcome' | 'tour' | null>(null);
    const [settingsDestination, setSettingsDestination] = useState<{ category: SettingsCategory; revision: number }>({ category: 'connection', revision: 0 });
    useEffect(() => {
        if (workspaceReady && needsFirstRunGuide()) { rememberFirstRunGuide(); setGuide('welcome'); }
    }, [workspaceReady]);
    useLayoutEffect(() => {
        if (!workspaceReady) return;
        const bars = document.querySelectorAll<HTMLElement>('.ttm-composer-quickbar, .ttm-composer-hint');
        const measure = () => bars.forEach(bar => {
            const value = `${bar.scrollHeight}px`;
            if (bar.style.getPropertyValue('--expanded-height') !== value) bar.style.setProperty('--expanded-height', value);
        });
        const observer = new ResizeObserver(measure);
        const mutations = new MutationObserver(measure);
        bars.forEach(bar => { observer.observe(bar); mutations.observe(bar, { subtree: true, childList: true, characterData: true }); });
        measure();
        return () => { observer.disconnect(); mutations.disconnect(); };
    }, [workspaceReady]);
    const [initializationError, setInitializationError] = useState('');
    const [inspectorTab, setInspectorTab] = useState<Exclude<InspectorTab, 'theme-studio'>>('schema-settings');
    const [mobileTab, setMobileTab] = useState<MobileTab>('chat');
    const [inspectorOpen, setInspectorOpen] = useState(false);
    const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
    const [characterSearch, setCharacterSearch] = useState('');
    const [characterTag, setCharacterTag] = useState('');
    const [characterSort, setCharacterSort] = useState('original');
    const [characterPage, setCharacterPage] = useState(0);
    const [denseLibrary, setDenseLibrary] = useState<boolean | null>(null);
    const [assetDialog, setAssetDialog] = useState<{ kind: 'presets' | 'lorebook'; anchor: HTMLElement } | null>(null);
    useEffect(() => assetDialog?.kind === 'presets' ? beginSyncAssetEdit() : undefined, [assetDialog?.kind]);
    const [deleteAsset, setDeleteAsset] = useState<DeleteAssetTarget | null>(null);
    const [assetMenu, setAssetMenu] = useState<(DeleteAssetTarget & { point?: MenuPoint }) | null>(null);
    const [characterDetails, setCharacterDetails] = useState<{ id: string; anchor: HTMLElement } | null>(null);
    const openAssetMenu = (target: DeleteAssetTarget, point?: MenuPoint) => setAssetMenu(previous =>
        previous?.anchor === target.anchor && previous.kind === target.kind && previous.id === target.id ? null : { ...target, point });
    const [personaAnchor, setPersonaAnchor] = useState<HTMLElement | null>(null);
    const [galleryDialog, setGalleryDialog] = useState<{ id: string; name: string; anchor: HTMLElement } | null>(null);
    const openAsset = (kind: 'presets' | 'lorebook', anchor: HTMLElement) => {
        if (kind === 'lorebook') beginWorldbookEditing();
        setAssetDialog({ kind, anchor });
    };
    const [historyOpen, setHistoryOpen] = useState(false);
    const [toolsOpen, setToolsOpen] = useState(false);
    const [lorebookHitsOpen, setLorebookHitsOpen] = useState(false);
    const { reading, restore: restoreReadingControls, compact: compactReadingControls, onReadingActivity } = useReadingMode(state.activeChatId);
    const [replyPosition, setReplyPosition] = useState<{ id?: string; away: boolean }>({ away: false });
    const [jumpRequest, setJumpRequest] = useState(0);
    const [dismissedReply, setDismissedReply] = useState('');
    const [fadingReply, setFadingReply] = useState('');
    useEffect(() => { if (reading) { setHistoryOpen(false); setToolsOpen(false); } }, [reading]);
    const [compactLayout, setCompactLayout] = useState(() => window.matchMedia('(max-width: 1024px)').matches);
    const device = compactLayout ? 'mobile' : 'desktop';
    const localPlacement = skinDevice.paused ? undefined : skinDevice.layouts[device];
    const placed = useMemo(() => placements(skin, device, localPlacement), [skin, device, localPlacement]);
    useEffect(() => {
        const media = window.matchMedia('(max-width: 1024px)');
        const update = () => setCompactLayout(media.matches);
        media.addEventListener('change', update);
        return () => media.removeEventListener('change', update);
    }, []);
    const inspectorVisible = compactLayout ? mobileTab === 'inspector' : inspectorOpen;
    useEffect(() => {
        if (workspaceReady && (inspectorVisible && inspectorTab === 'prompt-tree' || assetDialog?.kind === 'lorebook' && lorebookHitsOpen)) return observePromptInspector();
    }, [workspaceReady, inspectorVisible, inspectorTab, lorebookHitsOpen, assetDialog?.kind]);
    const openInspector = (tab: InspectorTab) => {
        if (tab === 'theme-studio') { setAppearanceOpen(true); return; }
        restoreReadingControls();
        setInspectorTab(tab);
        setInspectorOpen(true);
        setMobileTab('inspector');
    };
    const closeInspector = () => { setInspectorOpen(false); setMobileTab('chat'); };
    useNativeNavigation(() => {
        if (assetMenu) { setAssetMenu(null); return true; }
        if (historyOpen || toolsOpen) { setHistoryOpen(false); setToolsOpen(false); return true; }
        if (inspectorOpen || mobileTab !== 'chat') { closeInspector(); return true; }
        if (reading) { restoreReadingControls(); return true; }
        return false;
    });
    useEffect(() => {
        const onEscape = (event: KeyboardEvent) => {
            if (event.key !== 'Escape' || event.defaultPrevented) return;
            restoreReadingControls();
            setInspectorOpen(false); setHistoryOpen(false); setToolsOpen(false); setMobileTab('chat');
        };
        window.addEventListener('keydown', onEscape);
        return () => window.removeEventListener('keydown', onEscape);
    }, []);
    const [selectedVarScope, setSelectedVarScope] = useState<VariableScopeLevel>('chat');
    const [newVarKey, setNewVarKey] = useState('');
    const [newVarVal, setNewVarVal] = useState('');
    const [variableValueMode, setVariableValueMode] = useState<'text' | 'json'>('text');
    const [archivedChats, setArchivedChats] = useState<Array<{ id: string; characterId: string; label: string }>>([]);
    const [selectedArchivedChatId, setSelectedArchivedChatId] = useState('');
    const fileInputRef = useRef<HTMLInputElement | null>(null);
    const [importing, setImporting] = useState(false);
    const [clearing, setClearing] = useState(false);
    const [switchingCharacter, setSwitchingCharacter] = useState<string | null>(null);

    const activeCharacter = getActiveCharacter(state);
    const hasStory = !!activeCharacter.id;
    const canPlay = readyStory === state.activeChatId && compatibilityStoryReady(state.activeChatId);
    useEffect(() => { if (workspaceReady && !hasStory) setStoryRuntimeLoading(false); }, [workspaceReady, hasStory]);
    const activeStoryIdentity = storyIdentity(activeCharacter);
    const [galleryStoryId, setGalleryStoryId] = useState('');
    useEffect(() => {
        let active = true;
        if (!activeCharacter.id) { setGalleryStoryId(''); return; }
        void readStoryGallery(activeCharacter.id).then(value => { if (active) setGalleryStoryId(value ? activeCharacter.id : ''); }).catch(() => { if (active) setGalleryStoryId(''); });
        return () => { active = false; };
    }, [activeCharacter.id, workspaceReady]);
    const enterCharacter = async (characterId: string) => {
        if (characterId === state.activeCharacterId) { setMobileTab('chat'); return; }
        setSwitchingCharacter(characterId);
        try {
            await selectCharacter(characterId); setMobileTab('chat');
        } catch (error) { reportActionError('切换故事', error); }
        finally { setSwitchingCharacter(null); }
    };
    const beginNewChat = () => { void runUiAction('开始新对话', startNewChat, undefined); };
    const filteredCharacters = useMemo(() => {
        const query = characterSearch.trim().toLocaleLowerCase();
        const matches = state.characters.filter(character => (!characterTag || character.tags?.includes(characterTag)) && (!query || `${character.name} ${character.creator ?? ''} ${(character.tags ?? []).join(' ')}`.toLocaleLowerCase().includes(query)));
        return characterSort === 'name' ? matches.sort((a, b) => storyIdentity(a).name.localeCompare(storyIdentity(b).name, 'zh-CN', { numeric: true })) : matches;
    }, [state.characters, characterSearch, characterTag, characterSort]);
    const characterTags = useMemo(() => [...new Set(state.characters.flatMap(character => character.tags ?? []))].sort((a, b) => a.localeCompare(b, 'zh-CN')), [state.characters]);
    useEffect(() => setCharacterPage(0), [characterSearch, characterTag, characterSort]);
    const pageCount = Math.max(1, Math.ceil(filteredCharacters.length / 12));
    const currentCharacterPage = Math.min(characterPage, pageCount - 1);
    const visibleCharacters = filteredCharacters.slice(currentCharacterPage * 12, (currentCharacterPage + 1) * 12);
    const mvuPrimaryName = getCharacterWorldbooks(activeCharacter, state).primary;
    const mvuPrimaryBook = getAvailableWorldbooks(state).find(book => book.name === mvuPrimaryName);
    const activePreset = getActivePreset(state);
    const activeLorebooks = useMemo(() => getActiveLorebooks(state), [state.characters, state.activeCharacterId, state.lorebooks,
        state.activeLorebookIds, state.characterWorldbookBindings, state.chatWorldbookBindings, state.activeChatId, state.personas, state.activePersonaId]);
    const activeMessages = useMemo(() => getActiveChatMessages(state), [state.messages, state.activeLeafId]);
    const illustrationNode = illustrationId ? activeMessages.find(message => message.id === illustrationId) : undefined;
    const illustrations = illustrationNode ? (illustrationNode.extra?.[hostIllustrationKey] as Record<string, HostIllustration[]> | undefined)?.[swipeId(illustrationNode)] ?? [] : [];
    async function generateIllustration() {
        if (!illustrationNode || !illustrationPrompt.trim() || illustrating) return;
        const { id, content } = illustrationNode, key = swipeId(illustrationNode), prompt = illustrationPrompt.trim();
        const { activeChatId, branchEpoch } = workspaceStore.getState();
        setIllustrating(true);
        try {
            const generated = await runUiAction('生成配图', async () => {
                const { illustrationPath: path } = await commandCompatibilityRuntime('extensionIllustration', [prompt], true);
                if (!path?.startsWith('/user/images/')) throw new Error('未取得图库图片');
                const current = workspaceStore.getState();
                const target = getActiveChatMessages(current).find(message => message.id === id);
                if (current.activeChatId !== activeChatId || current.branchEpoch !== branchEpoch || !target || swipeId(target) !== key || target.content !== content) return false;
                workspaceStore.setState(draft => {
                    const message = draft.messages.find(message => message.id === id)!;
                    const table = (message.extra ??= {})[hostIllustrationKey] as Record<string, HostIllustration[]> | undefined;
                    message.extra[hostIllustrationKey] = { ...table, [key]: [...table?.[key] ?? [], { path, prompt }] };
                });
                await persistWorkspaceNow();
                return true;
            }, false);
            if (generated) setStatusBanner('配图已保存到柏宝绘图库。', { kind: 'success' });
        } finally { setIllustrating(false); }
    }
    const latestReply = useMemo(() => [...activeMessages].reverse().find(node => node.role === 'assistant'), [activeMessages]);
    const replyId = useMemo(() => !state.isGenerating && !state.helperGenerationCount && !state.mvuExtraAnalysisActive && latestReply &&
        !latestReply.extra?.tipsy_generation_incomplete && !isMessageTemplatePending(latestReply) ? latestReply.id : undefined,
        [latestReply, state.isGenerating, state.helperGenerationCount, state.mvuExtraAnalysisActive, state.templateRenderRevision]);
    const replyAway = replyPosition.id === replyId && replyPosition.away;
    const replyKey = replyId ? `${state.activeChatId}:${replyId}:${latestReply?.activeSwipeIndex}` : '';
    const reportReplyPosition = useCallback((away: boolean) => {
        setReplyPosition(previous => previous.id === replyId && previous.away === away ? previous : { id: replyId, away });
    }, [replyId]);
    const quickReplySettings = readExtensionVariables(variableState.extension, 'quickReplyV2');
    const activeQuickReplies = useMemo(() => quickReplySettings.isEnabled
        ? resolvedQuickReplyConfig(quickReplySettings, state.activeChatId, state.activeCharacterId).setList.filter((link: any) => link.isVisible !== false)
            .flatMap((link: any) => link.set.qrList.filter((reply: any) => !reply.isHidden).map((reply: any) => ({ set: link.set.name, ...reply,
                menu: quickReplyContextItems(quickReplySettings, link.set.name, reply.id) }))) : [],
        [quickReplySettings, state.activeChatId, state.activeCharacterId]);
    const branchOptions = useMemo(() => getChatBranchOptions(state), [state.messages, state.activeLeafId]);
    const scripts = getWorkspaceScripts(state);
    const globalRules = globalRegexes();
    const messageHostRequired = useMemo(() => cardNeedsAuthorHost(activeCharacter) || regexesNeedAuthorHost(activePreset.regexScripts) || regexesNeedAuthorHost(globalRules),
        [activeCharacter, activePreset.regexScripts, globalRules]);
    const compatibilityView = useMemo(() => galleryStoryId === activeCharacter.id || scripts.some(script => script.enabled) ||
        messageHostRequired || activeMessages.some(node => messageNeedsAuthorHost(node.content) || /<%|\[RENDER:|@@render_(?:before|after)/.test(node.content)) ||
        activeLorebooks.some(book => book.entries.some(entry => /<%|\[RENDER:|@@render_(?:before|after)/.test(entry.comment + '\n' + entry.content))),
        [scripts, activeMessages, activeLorebooks, galleryStoryId, activeCharacter.id, messageHostRequired]);

    useEffect(() => {
        let active = true;
        void initializeWorkspace().then(() => { if (active) setWorkspaceReady(true); })
            .catch(error => { if (active) setInitializationError(error instanceof Error ? error.message : String(error)); });
        return () => { active = false; };
    }, []);

    useEffect(() => {
        let cancelled = false;
        void runUiAction('读取已保存会话', async () => {
            const chats = await listArchivedChats();
            if (!cancelled) {
                setArchivedChats(chats);
                setSelectedArchivedChatId('');
            }
        }, undefined);
        return () => { cancelled = true; };
        }, [state.activeChatId, syncArchiveRevision]);

    const scopeContext = {
        presetId: activePreset.id,
        characterId: activeCharacter.id,
        chatId: state.activeChatId,
        messageId: activeMessages.at(-1)?.id,
        floor: activeMessages.at(-1)?.floor,
    };

    const executeCommand = async (rawScript: string): Promise<string> => (await commandCompatibilityRuntime('slash', [rawScript], true)).pipe ?? '';

    const runSlashCommand = (rawScript: string): Promise<string> =>
        runUiAction('执行指令', () => executeCommand(rawScript), '');
    const requestGenerate = (promptOverride?: string): Promise<string> =>
        compatibilityStoryReady(state.activeChatId) ? runUiAction('生成回复', () => sendUserMessageAndGenerate(promptOverride), '') : Promise.resolve('');
    const refreshPreview = () => {
        void runUiAction('更新提示词预览', refreshPromptInspectorPreview, undefined);
    };

    const handleSendInput = async (text = inputDraft, fromAuthor = false) => {
        const trimmed = text.trim();
        if (!trimmed || !fromAuthor && !compatibilityStoryReady(state.activeChatId) || state.isGenerating || state.helperGenerationCount > 0) return;
        compatibilityComposer('');
        const sent = await runUiAction('发送消息', async () => {
            if (trimmed.startsWith('/')) await executeCommand(trimmed);
            else await sendUserMessageAndGenerate(trimmed);
            return true;
        }, false);
        if (!sent && !compatibilityComposer()) compatibilityComposer(trimmed);
    };
    useEffect(() => connectCompatibilityComposerSubmit(text => handleSendInput(text, true)), [inputDraft, state.activeChatId, state.isGenerating, state.helperGenerationCount]);

    const importPickedFile = async (file: File) => {
        setImporting(true);
        try { setStatusBanner(await importAssetFile(file)); setSidebarCollapsed(false); setMobileTab('characters'); }
        catch (err) { reportActionError('导入', err); }
        finally { setImporting(false); }
    };
    const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        e.target.value = '';
        if (file) await importPickedFile(file);
    };
    const chooseAssetFile = async () => {
        if (!isNativeRuntime()) { fileInputRef.current?.click(); return; }
        setImporting(true);
        try { const file = await pickNativeAsset(); if (file) await importPickedFile(file); }
        catch (error) { reportActionError('选择文件', error); }
        finally { setImporting(false); }
    };

    const variablesVisible = inspectorTab === 'variables' && inspectorVisible;
    const currentScopeVariables = useMemo(() => variablesVisible ? getScopedVariables(selectedVarScope, scopeContext) : {},
        [variablesVisible, selectedVarScope, variableState, activeCharacter, activePreset, state.activeChatId, state.activeLeafId]);
    const mergedVariables = useMemo(() => variablesVisible ? resolveMergedVariables(scopeContext) : {},
        [variablesVisible, variableState, activeCharacter, activePreset, state.activeChatId, state.activeLeafId]);
    const promptInfo = state.lastAssembledPrompt;
    const writeInspectorVariables = async (next: Record<string, unknown>) => {
        if (!hasStory) { replaceScopedVariables(next, selectedVarScope, scopeContext); return; }
        const previous = getScopedVariables(selectedVarScope, scopeContext);
        const session = state.activeChatId;
        const result = await commandCompatibilityRuntime('validateVariables', [selectedVarScope, next]);
        if (workspaceStore.getState().activeChatId !== session || JSON.stringify(getScopedVariables(selectedVarScope, scopeContext)) !== JSON.stringify(previous)) throw new Error('校验期间变量或会话已变化，请重新操作');
        replaceScopedVariables(result.variables ?? next, selectedVarScope, scopeContext);
    };

    const openSettings = (category: SettingsCategory) => {
        setSettingsDestination(previous => ({ category, revision: previous.revision + 1 }));
        openInspector('schema-settings');
    };
    const showLibrary = () => { restoreReadingControls(); setSidebarCollapsed(false); setInspectorOpen(false); setMobileTab('characters'); };
    const navigateGuide = (step: GuideStep) => {
        restoreReadingControls(); setHistoryOpen(false); setToolsOpen(false);
        if (step === 'import' || step === 'resources') showLibrary();
        else if (step === 'profile' || step === 'connection' || step === 'plugins' || step === 'sync') openSettings(step);
        else { closeInspector(); if (step === 'history' || (step === 'routes' && hasStory)) setHistoryOpen(true); }
    };
    const replayGuide = () => { rememberFirstRunGuide(); setGuide('welcome'); };
    const guideAction = (step: GuideStep, target?: HTMLElement) => {
        if (step === 'import') void chooseAssetFile();
        else if (step === 'profile') setPersonaAnchor(target ?? document.body);
        else if (step === 'plugins') {
            const entry = document.querySelector<HTMLButtonElement>('[data-guide-action="plugins"]');
            if (entry && entry.getClientRects().length) { entry.scrollIntoView({ block: 'nearest' }); entry.focus({ preventScroll: true }); }
            else openSettings('plugins');
        }
        else if (step === 'routes') {
            if (hasStory) { closeInspector(); openStoryRoutes(undefined, target); }
            else showLibrary();
        }
        else if (step === 'play' && !hasStory) showLibrary();
        else target?.querySelector<HTMLElement>('input, button, select')?.focus();
    };
    const presetPanel = (
                    <section className="ttm-asset-workspace">
                        <div className="ttm-asset-workspace-header">
                        <label className="ttm-section-heading" htmlFor="narrative-preset-select">叙事预设</label>
                        <select
                            id="narrative-preset-select"
                            className="ttm-select-input"
                            aria-label="当前叙事预设"
                            value={activePreset.id}
                            onChange={(event) => runStoreAction('切换预设', () => selectPreset(event.target.value))}
                        >
                            <option value="">不使用预设</option>
                            {state.presets.map((p) => (
                                <option key={p.id} value={p.id}>
                                    {p.name}
                                </option>
                            ))}
                        </select>
                        {activePreset.id && <AssetMoreButton label="预设更多操作" expanded={assetMenu?.kind === 'preset'} onOpen={anchor => openAssetMenu({ kind: 'preset', id: activePreset.id, name: activePreset.name, anchor })} />}
                        </div>
                        {!activePreset.id && <div className="ttm-empty-search"><p>当前未使用预设。角色卡、世界书与聊天历史仍会正常组装，不额外添加平台叙事指令。可导入作者推荐的预设，再在上方选用。</p><button type="button" className="ttm-btn-secondary" disabled={importing} onClick={() => void chooseAssetFile()}>导入预设 JSON</button></div>}
                        {activePreset.id && <PresetEntriesPanel
                            key={activePreset.id}
                            preset={activePreset}
                            disabled={state.isGenerating || state.helperGenerationCount > 0}
                            onUpdatePrompt={(identifier, patch) => {
                                const updated = runStoreAction('更新预设词条', () => updatePresetPrompt(activePreset.id, identifier, patch));
                                if (updated && patch.content !== undefined) setStatusBanner('预设词条内容已保存。');
                                return updated;
                            }}
                        />}
                    </section>
    );
    const worldbookPanel = <section className="ttm-asset-workspace">
        <WorldbookEntriesPanel books={getAvailableWorldbooks(state)}
            menuBookId={assetMenu?.kind === 'worldbook' ? assetMenu.id : undefined}
            onMoreBook={(book, anchor) => openAssetMenu({ kind: 'worldbook', id: book.id, name: book.name, anchor })}
            activeBookIds={activeLorebooks.map(book => book.id)} globalBookIds={state.activeLorebookIds}
            disabled={state.isGenerating || state.helperGenerationCount > 0}
            onToggleBook={(bookId, enabled) => { runStoreAction('更新世界书', () => setGlobalWorldbookEnabled(bookId, enabled)); }}
            onToggle={(bookId, uid, enabled) => { runStoreAction('更新世界书', () => updateLorebookEntry(bookId, uid, { disabled: !enabled })); }} />
        <details className="ttm-worldbook-activation" onToggle={event => setLorebookHitsOpen(event.currentTarget.open)}><summary>本轮激活情况</summary>
            {lorebookHitsOpen && <div className="ttm-worldbook-activation-content">{promptInfo ? <>
                <h3 className="ttm-sub-heading">本轮激活词条（{promptInfo.activatedLorebookEntries.length}）</h3>
                {promptInfo.activatedLorebookEntries.map(hit => <div key={JSON.stringify([hit.world, (hit.entry || hit).uid])} className="ttm-hit-card">
                    <strong>{(hit.entry || hit).comment}</strong>
                    <p className="ttm-asset-help">插入位置：{worldbookPositions[(hit.entry || hit).position] ?? '其他位置'} · 匹配词：{(hit.matchedKeys || []).join('、') || '常驻或状态延续'}</p>
                    <pre className="ttm-entry-body">{(hit.entry || hit).content}</pre>
                </div>)}
            </> : <p role="status">正在计算激活情况…</p>}</div>}
        </details>
    </section>;
    const advancedTools = <>
        <div className="ttm-editor-actions"><button type="button" className="ttm-mini-btn" onClick={() => setInspectorTab('prompt-tree')}>提示词诊断</button><button type="button" className="ttm-mini-btn" onClick={() => setInspectorTab('variables')}>变量管理</button></div>
        {hasStory && <CharacterDetailsPanel key={activeCharacter.id} mode="advanced" character={activeCharacter} disabled={state.isGenerating || state.helperGenerationCount > 0} onSaveDocument={(document) => runStoreAction('保存角色卡', () => updateCharacterDocument(activeCharacter.id, document))} />}
                    {mvuPrimaryBook && <MvuCharacterSettingsEditor key={`${activeCharacter.id}:${mvuPrimaryBook.id}`} book={mvuPrimaryBook} disabled={state.isGenerating || state.helperGenerationCount > 0} />}
    </>;
    const dataTools = <>
                    <details className="ttm-asset-text-section ttm-data-management">
                            <summary>测试数据管理</summary>
                            <p className="ttm-asset-help">删除所有导入的角色卡、世界书、预设、会话和变量，回到空馆藏。保留个人资料（昵称、头像、人设）、模型连接与外观设置，不创建备份。</p>
                            <button type="button" className="ttm-btn-secondary" disabled={clearing || importing || switchingCharacter !== null || state.isGenerating || state.helperGenerationCount > 0}
                                onClick={() => {
                                    if (!window.confirm('清空所有导入内容和会话？此操作无法撤销。个人资料、模型连接与外观设置会保留。')) return;
                                    setClearing(true);
                                    void runUiAction('清空测试内容', clearImportedWorkspace, undefined).finally(() => setClearing(false));
                                }}>{clearing ? '正在清空…' : '一键清空测试内容'}</button>
                    </details>

    </>;

    // Do not expose import/edit/generation actions while persisted state is only
    // partially hydrated. A failed load can be retried without replacing saved data.
    if (!workspaceReady) return <div className="ttm-app-root ttm-loading" data-ti-shell="startup" aria-busy={!initializationError}>
        <main className="ttm-loading-content">
            <div className="ttm-loading-emblem" data-ti-part="startup-art" aria-hidden="true"><ShellArt skin={skin} id="startup" fallback={<Icon name="book" width={36} height={36} />} /></div>
            <h1 data-ti-type="heading">{appName}</h1>
            <p className="ttm-loading-subtitle">{textOf(skin, 'startup-title')}</p>
            <div className="ttm-loading-status" role={initializationError ? 'alert' : 'status'}>
                {!initializationError && <span className="ttm-loading-spinner" aria-hidden="true" />}
                <span>{initializationError ? `读取失败：${initializationError}` : textOf(skin, 'startup-status')}</span>
            </div>
            {initializationError && <button type="button" className="ttm-btn-secondary" onClick={() => {
                setInitializationError('');
                void initializeWorkspace().then(() => setWorkspaceReady(true)).catch(error => setInitializationError(error instanceof Error ? error.message : String(error)));
            }}>重新读取</button>}
        </main>
    </div>;

    const navTabs = { 'mobile-library': 'characters', 'mobile-chat': 'chat', 'mobile-appearance': 'theme', 'mobile-settings': 'inspector' } as const;
    const generating = state.isGenerating || state.helperGenerationCount > 0;
    const lastMessage = activeMessages.at(-1);
    const widgets = new Map(skin?.widgets.map(widget => [widget.id, widget]));
    const skinWallpaper = wallpaperStyle(skin);
    const widgetAction = (action: Widget['action'], anchor: HTMLElement) => {
        if (action === 'routes' && hasStory) openStoryRoutes(undefined, anchor);
        if (action === 'settings') openInspector('schema-settings');
        if (action === 'appearance') setAppearanceOpen(true);
    };
    const shellParts = (area: Area): ReactNode => placed[area].map(id => {
        const widget = widgets.get(id);
        if (widget && skin) return <ShellWidget key={id} skin={skin} widget={widget} values={{ character: hasStory ? activeStoryIdentity.name : '未选择故事', messages: activeMessages.length, library: state.characters.length }} onAction={widgetAction} />;
        const part = id as Part;
        const button = (action: (anchor: HTMLButtonElement) => void, options: { disabled?: boolean; iconOnly?: boolean; className?: string; label?: string; title?: string; pressed?: boolean; current?: 'page' } = {}) => {
            const label = partText(skin, part, options.label);
            return <button key={id} type="button" data-ti-part={id} className={options.className ?? (options.iconOnly ? 'ttm-icon-btn' : area === 'toolbar' || area === 'more' || area.startsWith('input-') ? 'ttm-chip-btn' : 'ttm-btn-secondary')}
                title={options.title ?? label} aria-label={options.iconOnly ? options.title ?? label : undefined} aria-pressed={part === 'history' ? undefined : options.pressed} aria-expanded={part === 'history' ? historyOpen : undefined} aria-controls={part === 'history' ? 'ttm-conversation-history' : undefined} aria-current={options.current} disabled={options.disabled} onClick={event => action(event.currentTarget)}>
                {part === 'profile' && !assetUrl(skin, skin?.art[part]) ? <CharacterAvatar name={state.userName} avatar={getActivePersona(state)?.image} />
                    : <ShellPartIcon skin={skin} id={part} name={part === 'focus' ? sidebarCollapsed ? 'panel' : 'focus' : undefined} size={area === 'mobile' || options.iconOnly ? 20 : area === 'toolbar' ? 15 : 17} />}
                {!options.iconOnly && <span>{label}</span>}
            </button>;
        };
        switch (part) {
            case 'focus': return button(() => setSidebarCollapsed(value => !value), { iconOnly: area === 'top', className: area === 'top' ? 'ttm-icon-btn ttm-focus-button' : undefined, pressed: sidebarCollapsed, label: sidebarCollapsed ? '显示馆藏' : '专注阅读' });
            case 'settings': return button(() => openInspector('schema-settings'), { className: area === 'top' ? 'ttm-btn-ghost' : undefined });
            case 'appearance': return button(() => setAppearanceOpen(true));
            case 'sidebar-settings': return button(() => openInspector('schema-settings'), { label: '设置' });
            case 'routes': return button(anchor => openStoryRoutes(undefined, anchor), { iconOnly: area === 'conversation', disabled: !hasStory, title: `${partText(skin, part)}，共 ${branchOptions.length} 条` });
            case 'profile': return button(setPersonaAnchor, { iconOnly: area === 'conversation', className: area === 'conversation' ? 'ttm-profile-entry ttm-icon-btn' : undefined });
            case 'history': return button(() => setHistoryOpen(value => !value), { iconOnly: area === 'conversation', className: area === 'conversation' ? `ttm-icon-btn${historyOpen ? ' is-active' : ''}` : undefined, pressed: historyOpen });
            case 'new-chat': return button(beginNewChat, { disabled: !hasStory || generating, title: '开始新对话，已有历史会保存' });
            case 'reading': return button(compactReadingControls, { disabled: !hasStory });
            case 'continue': return button(() => void requestGenerate(), { disabled: !canPlay || generating });
            case 'regenerate': return button(() => void runUiAction('重新生成', regenerateLastAssistantMessage, ''), { disabled: !canPlay || generating || lastMessage?.role !== 'assistant' || !lastMessage.parentId });
            case 'recalculate': return button(() => void runUiAction('重算变量', () => reprocessLastMvuMessage(false), ''), { disabled: generating || lastMessage?.role !== 'assistant' });
            case 'retry-analysis': return button(() => void runUiAction('重新解析变量', () => reprocessLastMvuMessage(true), ''), { disabled: generating || lastMessage?.role !== 'assistant' });
            default: {
                const tab = navTabs[part];
                const active = tab === 'theme' ? appearanceOpen : mobileTab === tab;
                return button(() => { if (tab === 'theme') setAppearanceOpen(true); else if (tab === 'inspector') openInspector('schema-settings'); else setMobileTab(tab); },
                    { className: active ? 'is-active' : '', current: active ? 'page' : undefined });
            }
        }
    });

    return (
        <div
            className={`ttm-app-root ${inspectorOpen ? 'has-inspector' : ''} ${sidebarCollapsed ? 'is-focused' : ''} ${reading && mobileTab === 'chat' ? 'is-reading' : ''}${skinWallpaper ? ' has-skin-wallpaper' : ''}`}
            data-mobile-tab={mobileTab}
        >
            {skinWallpaper && <div className="ttm-skin-wallpaper" data-ti-shell="wallpaper" aria-hidden="true" {...{ inert: '' }} style={skinWallpaper} />}
            <a className="ttm-skip-link" href="#tipsy-chat-composer" onClick={() => setMobileTab('chat')}>跳到对话输入框</a>
            <header className="ttm-topbar" data-ti-shell="topbar">
                <ShellBrand skin={skin} />
                <div className="ttm-topbar-location" data-ti-part="location"><span>{textOf(skin, 'workspace')}</span><Icon name="chevron" width={14} height={14} /><strong>{textOf(skin, 'location')}</strong></div>
                <div className="ttm-topbar-actions" data-ti-area="top">
                    <input
                        ref={fileInputRef}
                        type="file"
                        accept=".png,.json"
                        hidden
                        onChange={handleFileUpload}
                    />
                    {shellParts('top')}
                    <button type="button" className="ttm-icon-btn ttm-reading-colors" data-ti-part="reading-colors"
                        aria-label={readingColorAction} title={readingColorAction} onClick={toggleReadingColorScheme}>
                        <Icon name={darkReading ? 'sun' : 'moon'} />
                    </button>
                    <WorkspacePluginMenu />
                    <SlotMount name="chat.header.actions" />
                </div>
            </header>

            <NotificationRegion />

            {/* Three-Column Adaptive Workbench */}
            <div className="ttm-workbench">
                {/* Left Column: Character Cards, Worldbooks & Presets */}
                <aside aria-label="故事馆藏" data-ti-shell="library" className={`ttm-sidebar ${mobileTab === 'characters' ? 'is-mobile-active' : ''}`}>
                    <div className="ttm-sidebar-scroll">
                    <section className="ttm-panel-block">
                        <div className="ttm-section-head-row">
                            <h2 className="ttm-library-title" data-ti-type="heading">{textOf(skin, 'library')} <span>{state.characters.length}</span></h2>
                            <button
                                type="button"
                                className="ttm-mini-btn"
                                data-guide="import"
                                data-ti-part="import"
                                disabled={importing || clearing || state.isGenerating}
                                onClick={() => void chooseAssetFile()}
                            >
                                <ShellArt skin={skin} id="import" fallback={<Icon name="plus" width={16} height={16} />} />{importing ? '导入中…' : textOf(skin, 'import')}
                            </button>
                        </div>
                        <label className="ttm-search"><Icon name="search" width={17} height={17} /><input type="search" aria-label="搜索故事" placeholder="搜索故事、作者或标签" value={characterSearch} onChange={event => setCharacterSearch(event.target.value)} /></label>
                        <div className="ttm-library-controls">
                            <select aria-label="故事排序" value={characterSort} onChange={event => setCharacterSort(event.target.value)}><option value="original">导入顺序</option><option value="name">名称排序</option></select>
                            <button type="button" className="ttm-mini-btn" aria-pressed={denseLibrary ?? state.characters.length > 12} onClick={() => setDenseLibrary(!(denseLibrary ?? state.characters.length > 12))}>{(denseLibrary ?? state.characters.length > 12) ? '舒展显示' : '紧凑显示'}</button>
                            {characterTags.length > 0 && <select aria-label="故事标签" value={characterTag} onChange={event => setCharacterTag(event.target.value)}><option value="">全部标签</option>{characterTags.map(tag => <option key={tag} value={tag}>{tag}</option>)}</select>}
                        </div>
                        <div className={`ttm-char-list ${(denseLibrary ?? state.characters.length > 12) ? 'is-dense' : ''}`}>
                            {visibleCharacters.map(char => <CharacterLibraryItem key={char.id} character={char}
                                active={char.id === activeCharacter.id} switching={switchingCharacter === char.id}
                                disabled={state.isGenerating || state.helperGenerationCount > 0 || clearing || switchingCharacter !== null}
                                menuOpen={assetMenu?.kind === 'character' && assetMenu.id === char.id}
                                onActivate={() => void enterCharacter(char.id)}
                                onMenu={(anchor, point) => openAssetMenu({ kind: 'character', id: char.id, name: storyIdentity(char).name, anchor }, point)} />)}
                        </div>
                        {pageCount > 1 && <nav className="ttm-library-pages" aria-label="故事分页"><button className="ttm-icon-btn" type="button" aria-label="上一页故事" disabled={currentCharacterPage === 0} onClick={() => setCharacterPage(currentCharacterPage - 1)}><Icon name="chevron" style={{ transform: 'rotate(180deg)' }} /></button><label><select aria-label="故事页码" value={currentCharacterPage} onChange={event => setCharacterPage(Number(event.target.value))}>{Array.from({ length: pageCount }, (_, page) => <option key={page} value={page}>{page + 1} / {pageCount}</option>)}</select></label><button className="ttm-icon-btn" type="button" aria-label="下一页故事" disabled={currentCharacterPage === pageCount - 1} onClick={() => setCharacterPage(currentCharacterPage + 1)}><Icon name="chevron" /></button></nav>}
                        {!filteredCharacters.length && <div className="ttm-empty-search"><p>{state.characters.length ? '没有找到这个故事' : '馆藏还是空的，导入角色卡后会显示在这里。'}</p>{state.characters.length ? <button type="button" className="ttm-mini-btn" onClick={() => { setCharacterSearch(''); setCharacterTag(''); }}>清除筛选</button> : <button type="button" className="ttm-mini-btn" onClick={replayGuide}>查看使用引导</button>}</div>}
                    </section>

                    <nav className="ttm-library-shortcuts" aria-label="故事设定" data-guide="resources">
                        <button type="button" aria-haspopup="dialog" onClick={event => openAsset('presets', event.currentTarget)}><Icon name="settings" width={17} height={17} /><span>预设明细<small>{activePreset.name}</small></span><Icon name="chevron" width={14} height={14} /></button>
                        <button type="button" aria-haspopup="dialog" onClick={event => openAsset('lorebook', event.currentTarget)}><Icon name="book" width={17} height={17} /><span>世界书<small>{activeLorebooks.length} 本已启用</small></span><Icon name="chevron" width={14} height={14} /></button>
                    </nav>
                    {hasStory && <details className="ttm-sidebar-disclosure"><summary><Icon name="book" width={17} height={17} />故事资料与开场</summary>
                    <CharacterDetailsPanel
                        key={activeCharacter.id}
                        actions={<AssetMoreButton label="故事更多操作" expanded={assetMenu?.kind === 'character' && assetMenu.id === activeCharacter.id} onOpen={anchor => openAssetMenu({ kind: 'character', id: activeCharacter.id, name: activeStoryIdentity.name, anchor })} />}
                        character={activeCharacter}
                        disabled={state.isGenerating}
                        onSaveDocument={(document) => runStoreAction('保存角色卡', () => updateCharacterDocument(activeCharacter.id, document))}
                    />
                    </details>}

                    <SlotMount name="shell.sidebar.footer" />
                    </div>
                    <div className="ttm-sidebar-bottom">
                        <div className={`ttm-sidebar-bottom-actions${compactLayout && placed.sidebar.some(id => id !== 'appearance' && id !== 'sidebar-settings') ? ' has-custom-parts' : ''}`} data-ti-area="sidebar">{shellParts('sidebar')}</div>
                    </div>
                </aside>

                <main
                    id="tipsy-isle-stage"
                    className={`ttm-center-stage ${mobileTab === 'chat' ? 'is-mobile-active' : ''} ${reading ? 'is-reading' : ''}`}
                >
                    <header className="ttm-conversation-header" data-ti-shell="conversation">
                        <div className="ttm-conversation-person" data-ti-part="conversation-title"><CharacterAvatar name={hasStory ? activeStoryIdentity.name : appName} avatar={activeCharacter.avatar} /><div><h2 data-ti-type="heading">{hasStory ? activeStoryIdentity.name : appName}</h2><p>{!hasStory ? '导入或选择故事，开始你的对话' : state.mvuExtraAnalysisActive ? '正在整理本轮变量' : generating ? '故事正在续写' : `${activeMessages.length} 条消息 · ${activePreset.name}`}</p></div></div>
                        <div className="ttm-conversation-actions" data-ti-area="conversation">{shellParts('conversation')}</div>
                    </header>
                    <div id="ttm-conversation-history" className="ttm-history-panel" data-ti-shell="history" data-guide="history" hidden={!historyOpen}>
                    <div className="ttm-chat-branch-bar"><button type="button" className="ttm-btn-secondary" data-guide={hasStory ? 'routes' : undefined} disabled={!hasStory} onClick={event => openStoryRoutes(undefined, event.currentTarget)}><Icon name="branch" width={18} height={18} />故事路线 · {branchOptions.length}</button><small>查看不同回复与后续选择</small></div>
                    <div className="ttm-chat-branch-bar ttm-chat-history-bar">
                        <label htmlFor="ttm-chat-history-select">已保存会话</label>
                        <select
                            id="ttm-chat-history-select"
                            className="ttm-select-input"
                            value={selectedArchivedChatId}
                            disabled={state.isGenerating || archivedChats.length === 0}
                            onChange={(event) => setSelectedArchivedChatId(event.target.value)}
                        >
                            <option value="">恢复已保存会话</option>
                            {archivedChats.map((chat) => (
                                <option key={chat.id} value={chat.id}>{chat.label}</option>
                            ))}
                        </select>
                        <button
                            type="button"
                            className="ttm-mini-btn"
                            disabled={state.isGenerating || !selectedArchivedChatId}
                            onClick={() => void runUiAction('恢复会话', async () => {
                                await restoreArchivedChat(selectedArchivedChatId);
                                setSelectedArchivedChatId('');
                                setStatusBanner('已恢复保存的会话。');
                            }, undefined)}
                        >恢复</button>
                        <small>新对话保留旧历史</small>
                    </div>
                    </div>
                    <div ref={illustrationAnchor} className={`ttm-reading-viewport${skinWallpaper && hasStory ? ' ttm-skin-story-surface' : ''}`} data-ti-protected={hasStory ? '' : undefined}>
                    {workspaceReady && hasStory && <CompatibilityChat session={state.activeChatId} revision={state} visible={compatibilityView} extensionPanel={extensionPanel} closeExtensionPanel={() => setExtensionPanel(false)}
                        replyId={replyId} jumpRequest={jumpRequest} onReadingActivity={onReadingActivity} onReplyPosition={reportReplyPosition} />}
                    {!hasStory && <section className="ttm-start-page" data-ti-shell="empty" data-guide="play" aria-label="开始使用">
                        <span className="ttm-welcome-mark" data-ti-part="welcome-art"><ShellArt skin={skin} id="welcome" fallback={<Icon name="book" width={56} height={56} />} /></span>
                        <h2 data-ti-type="heading">{textOf(skin, state.characters.length ? 'empty-library' : 'empty')}</h2>
                        <p>给故事里的自己一个名字与形象，带上喜欢的角色卡，再连接模型。从你选择的开场出发，让一段对话，慢慢长成值得回味的故事。</p>
                        <div className="ttm-guide-buttons"><button type="button" className="ttm-btn-primary" data-guide={!state.characters.length ? 'routes' : undefined} disabled={importing || clearing} onClick={() => void chooseAssetFile()}><Icon name="upload" width={18} height={18} />{importing ? '正在导入…' : '导入角色卡'}</button>
                            {state.characters.length > 0 && <button type="button" className="ttm-btn-secondary" data-guide="routes" onClick={showLibrary}>打开馆藏</button>}
                            <button type="button" className="ttm-btn-secondary" onClick={event => setPersonaAnchor(event.currentTarget)}>设置个人资料</button>
                            <button type="button" className="ttm-btn-secondary" onClick={() => openSettings('connection')}>连接模型</button>
                            <button type="button" className="ttm-btn-secondary" onClick={replayGuide}><Icon name="book" width={18} height={18} />使用引导</button>
                        </div>
                        <p className="ttm-start-notes">在“个人资料”里写下你的称呼、外貌与性格，也可以为不同故事设置专属身份。想接着上次的旅程，点击顶部的历史图标，打开“会话与分支”找回进度；第一次来，可以让使用引导陪你熟悉常用操作。</p>
                        <div className="ttm-start-status"><span>馆藏：{state.characters.length} 个故事</span><span>{getActivePersona(state) ? '已设置个人资料' : '尚未设置个人资料'}</span></div>
                    </section>}
                    {hasStory && canPlay && !compatibilityView && <VirtualChatStream
                        key={state.activeChatId}
                        messages={activeMessages}
                        replyId={replyId}
                        jumpRequest={jumpRequest}
                        onReadingActivity={onReadingActivity}
                        onReplyPosition={reportReplyPosition}
                        characterId={activeCharacter.id}
                        characterName={activeCharacter.name}
                        characterAvatar={activeCharacter.avatar}
                        userAvatar={getActivePersona(state)?.image}
                        userName={state.userName}
                        chatId={state.activeChatId}
                        presetId={activePreset.id}
                        layoutMode={themeState.layoutMode}
                        renderFormattedContent={formatMessageForDisplay}
                        onDeleteMessage={deleteChatMessage}
                        onIllustrateMessage={canIllustrate ? openIllustration : undefined}
                        onSwipeMessage={swipeChatMessage}
                        onTriggerSlash={runSlashCommand}
                        onRequestGenerate={requestGenerate}
                        onGetChatMessages={() => getActiveChatMessages(workspaceStore.getState())}
                        onSetChatMessage={(floorOrId, newContent) => editChatMessage(String(floorOrId), newContent)}
                        onGetWorldbook={() => activeLorebooks.flatMap((w) => w.entries)}
                        onReplaceWorldbook={(entries) => Array.isArray(entries) && replaceActiveWorldbookEntries(entries)}
                    />}
                    {replyKey && dismissedReply !== replyKey && (replyAway || fadingReply === replyKey) && <button type="button" data-ti-shell="reply-control" className={`ttm-reply-start ttm-btn-secondary ${fadingReply === replyKey ? 'is-dismissed' : ''}`} disabled={fadingReply === replyKey}
                        onClick={() => { setJumpRequest(value => value + 1); if (matchMedia('(prefers-reduced-motion: reduce)').matches) setDismissedReply(replyKey); else setFadingReply(replyKey); }}
                        onAnimationEnd={event => { if (event.animationName === 'reply-dismiss') { setDismissedReply(replyKey); setFadingReply(''); } }}><Icon name="arrow" width={16} height={16} style={{ transform: 'rotate(-90deg)' }} />回到本次回复开头</button>}
                    </div>

                    {(state.nativeToolPreview?.reasoning ?? state.streamingReasoning) && (
                        <details className="ttm-reasoning-drawer">
                            <summary>思考过程</summary>
                            <p>{state.nativeToolPreview?.reasoning ?? state.streamingReasoning}</p>
                        </details>
                    )}

                    {hasStory && <footer className="ttm-composer" data-guide="play">
                        {(state.isGenerating || state.helperGenerationCount > 0) && !state.mvuExtraAnalysisActive && !activeMessages.some(message => message.extra?.tipsy_generation_incomplete) && <GenerationActivity phase="waiting" />}
                        <div className="ttm-composer-quickbar" data-ti-shell="composer-controls" data-ti-area="toolbar">
                            {shellParts('toolbar')}
                            <button type="button" data-ti-part="more" className={`ttm-chip-btn${toolsOpen ? ' is-active' : ''}`} aria-expanded={toolsOpen} aria-controls="ttm-composer-tools" onClick={() => setToolsOpen(value => !value)}><ShellArt skin={skin} id="more" fallback={<Icon name="more" width={17} height={17} />} />{textOf(skin, 'more')}</button>
                            <SlotMount name="chat.input.toolbar" />
                        </div>
                        <div id="ttm-composer-tools" className="ttm-composer-tools" data-ti-shell="composer-controls" data-ti-part="more-panel" hidden={!toolsOpen}>
                        {(scriptButtons.length > 0 || activeQuickReplies.length > 0 || extensionMenu.length > 0) && <section className="ttm-composer-shortcuts" aria-labelledby="ttm-composer-shortcuts-title">
                            <h3 id="ttm-composer-shortcuts-title">快捷功能</h3>
                            <div className="ttm-composer-quickbar">
                            {extensionMenu.map(button => <button type="button" key={button.id} className="ttm-btn-secondary" disabled={!canPlay}
                                onClick={() => {
                                    setToolsOpen(false); setExtensionPanel(true);
                                    void runUiAction(button.name, () => commandCompatibilityRuntime('extensionMenu', [button.id], true), {});
                                }}>{button.name}</button>)}
                            {scriptButtons.map((button, index) => <button key={`${button.id}:${index}`} type="button" className="ttm-btn-secondary" disabled={!canPlay || state.isGenerating || state.helperGenerationCount > 0}
                                onClick={() => void runUiAction(button.name, () => commandCompatibilityRuntime('scriptButton', [button.id], true), {})}>{button.name}</button>)}
                            {activeQuickReplies.map((reply: any, index: number) => <span key={`${reply.set}:${reply.id}:${index}`}>
                                <button type="button" className="ttm-btn-secondary" title={reply.title || `${reply.set}.${reply.label}`} disabled={!canPlay || state.isGenerating || state.helperGenerationCount > 0} onClick={() => void runUiAction('执行快捷回复', () => commandCompatibilityRuntime('quickReply', [reply.set, reply.id], true), {})}>{reply.label || reply.title || '快捷回复'}</button>
                                {reply.menu.length > 0 && <QuickReplyMenu items={reply.menu} disabled={!canPlay || state.isGenerating || state.helperGenerationCount > 0} onExecute={path => void runUiAction('执行快捷回复菜单', () => commandCompatibilityRuntime('quickReplyContext', [reply.set, reply.id, path], true), {})} />}
                            </span>)}
                            </div>
                        </section>}
                        <div className="ttm-composer-quickbar" data-ti-area="more">{shellParts('more')}</div>
                        {toolsOpen && canPlay && <div className="ttm-composer-quickbar ttm-native-composer-actions"><PluginButtons onOpen={() => setToolsOpen(false)} /></div>}

                        <MvuRepairPanel disabled={state.isGenerating || state.helperGenerationCount > 0 || activeMessages.at(-1)?.role !== 'assistant'} />
                        </div>
                        <div className="ttm-composer-row" data-ti-shell="composer-row">
                            {reading && <button type="button" className="ttm-icon-btn ttm-expand-composer" aria-label="展开会话操作" title="展开会话操作" onClick={restoreReadingControls}><Icon name="more" /></button>}
                            <div className="ttm-skin-input-tools" data-ti-area="input-before">{shellParts('input-before')}</div>
                            <ChatComposerInput
                                id="tipsy-chat-composer"
                                className="ttm-composer-input"
                                data-ti-part="input"
                                data-ti-type="composer"
                                rows={reading || compactLayout ? 1 : 2}
                                aria-label="对话内容"
                                placeholder={textOf(skin, 'input')}
                                value={inputDraft}
                                onChange={(e) => editCompatibilityComposer(e.target.value)}
                                onKeyDown={(e) => {
                                    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !e.nativeEvent.isComposing) {
                                        e.preventDefault();
                                        void handleSendInput();
                                    }
                                }}
                            />
                            <div className="ttm-skin-input-tools" data-ti-area="input-after">{shellParts('input-after')}</div>
                            {state.isGenerating || state.helperGenerationCount > 0 ? (
                                <button type="button" data-ti-part="stop" className="ttm-btn-danger ttm-composer-submit" aria-label="停止生成" title="停止生成" onClick={() => { stopActiveGeneration(); stopHelperGeneration(undefined, undefined, true); }}>
                                    <ShellArt skin={skin} id="stop" fallback={<Icon name="stop" width={18} height={18} />} /><span>{textOf(skin, 'stop')}</span>
                                </button>
                            ) : (
                                <button type="button" data-ti-part="send" className="ttm-btn-primary ttm-composer-submit" aria-label="发送消息" title={canPlay ? '发送消息' : '故事正在准备'} disabled={!canPlay || !inputDraft.trim()} onClick={() => void handleSendInput()}>
                                    <ShellArt skin={skin} id="send" fallback={<Icon name="send" width={20} height={20} />} /><span>{textOf(skin, 'send')}</span>
                                </button>
                            )}
                        </div>
                        <div className="ttm-composer-hint" data-ti-shell="composer-hint"><span>{textOf(skin, 'hint')}</span><span>Ctrl / ⌘ + Enter 发送</span></div>
                    </footer>}
                </main>

                {/* Right Column: Theme Studio, Prompt Inspector, 5-Scope Variables & Schema Settings */}
                <aside
                    id="ttm-inspector"
                    data-ti-shell="settings"
                    aria-label="外观与设置"
                    className={`ttm-inspector ${
                        mobileTab === 'inspector' ? 'is-mobile-active' : ''
                    }`}
                >
                    <div className="ttm-inspector-heading"><h2 data-ti-type="heading">设置与工具</h2><div className="ttm-inspector-heading-actions">
                        {inspectorTab === 'schema-settings' && <button type="button" className="ttm-btn-ghost ttm-inspector-guide" title="重新开始使用引导" disabled={generating} onClick={replayGuide}><Icon name="book" width={17} height={17} />使用引导</button>}
                        <button type="button" className="ttm-icon-btn" aria-label="关闭侧面板" onClick={closeInspector}><Icon name="close" /></button>
                    </div></div>
                    {(inspectorTab === 'prompt-tree' || inspectorTab === 'variables') && <button type="button" className="ttm-btn-ghost" onClick={() => setInspectorTab('schema-settings')}><Icon name="chevron" width={14} height={14} style={{ transform: 'rotate(180deg)' }} />返回设置</button>}
                    <nav className="ttm-inspector-tabs" aria-label="工具分类">
                        <button
                            type="button"
                            onClick={() => setAppearanceOpen(true)}
                        >
                            外观
                        </button>
                        <button
                            type="button"
                            aria-haspopup="dialog"
                            onClick={event => openAsset('presets', event.currentTarget)}
                        >
                            预设
                        </button>
                        <button
                            type="button"
                            aria-haspopup="dialog"
                            onClick={event => openAsset('lorebook', event.currentTarget)}
                        >
                            世界书
                        </button>
                        <button
                            type="button"
                            className={inspectorTab === 'schema-settings' ? 'is-active' : ''}
                            aria-current={inspectorTab === 'schema-settings' ? 'page' : undefined}
                            onClick={() => setInspectorTab('schema-settings')}
                        >
                            设置
                        </button>
                    </nav>

                    <div className="ttm-inspector-content" key={inspectorTab}>{inspectorVisible && <>
                        {inspectorTab === 'prompt-tree' && !promptInfo && (
                            <p role="status">提示词预览按需计算。<button type="button" className="ttm-mini-btn" onClick={refreshPreview}>刷新预览</button></p>
                        )}
                        {inspectorTab === 'prompt-tree' && promptInfo && (
                            <div className="ttm-prompt-inspector">
                                <div className="ttm-token-meter">
                                    <div className="ttm-token-summary">
                                        <span>总上下文消耗</span>
                                        <strong>
                                            {promptInfo.tokenUsage.total} / {(promptInfo.tokenUsage.budget ?? DEFAULT_CONTEXT_TOKENS)} Tokens
                                        </strong>
                                    </div>
                                    <div className="ttm-token-breakdown">
                                        <span>预设与角色: {promptInfo.tokenUsage.system + (promptInfo.tokenUsage.character ?? 0)}</span>
                                        <span>世界书: {promptInfo.tokenUsage.lorebook}</span>
                                        <span>历史记录: {promptInfo.tokenUsage.history}</span>
                                    </div>
                                </div>

                                <div className="ttm-assembled-list">
                                    {promptInfo.messages.map((msg, idx) => (
                                        <div key={idx} className="ttm-assembled-item">
                                            <header>
                                                <span className={`ttm-role-tag is-${msg.role}`}>[{msg.role}]</span>
                                                <strong>{msg.sourceLabel}</strong>
                                                <small>{msg.estimatedTokens} tok</small>
                                            </header>
                                            <pre>{msg.content}</pre>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}

                        {variablesVisible && (
                            <div className="ttm-vars-inspector">
                                <div className="ttm-scope-selector">
                                    {(['global', 'preset', 'character', 'chat', 'message'] as VariableScopeLevel[]).map(
                                        (lv) => (
                                            <button
                                                key={lv}
                                                type="button"
                                                className={`ttm-chip-btn ${selectedVarScope === lv ? 'is-active' : ''}`}
                                                onClick={() => setSelectedVarScope(lv)}
                                            >
                                                {lv}
                                            </button>
                                        ),
                                    )}
                                </div>

                                <label className="ttm-var-value-mode">
                                    值格式
                                    <select
                                        className="ttm-select-input"
                                        value={variableValueMode}
                                        onChange={(event) => setVariableValueMode(event.target.value as 'text' | 'json')}
                                    >
                                        <option value="text">文本 / 数字</option>
                                        <option value="json">JSON（对象、数组等）</option>
                                    </select>
                                </label>
                                <div className="ttm-var-add-row">
                                    <input
                                        type="text"
                                        className="ttm-text-input"
                                        placeholder="变量名 (如 affection)"
                                        value={newVarKey}
                                        onChange={(e) => setNewVarKey(e.target.value)}
                                    />
                                    <textarea
                                        className="ttm-text-input"
                                        aria-label="变量值"
                                        rows={variableValueMode === 'json' ? 4 : 1}
                                        placeholder={variableValueMode === 'json' ? '{"value": 1}' : '值'}
                                        value={newVarVal}
                                        onChange={(e) => setNewVarVal(e.target.value)}
                                    />
                                    <button
                                        type="button"
                                        className="ttm-btn-primary"
                                        onClick={() => {
                                            if (!newVarKey.trim()) return;
                                            void runUiAction('写入变量', async () => {
                                                const num = Number(newVarVal);
                                                const value: unknown = variableValueMode === 'json'
                                                    ? JSON.parse(newVarVal)
                                                    : !Number.isNaN(num) && newVarVal.trim() !== '' ? num : newVarVal;
                                                await writeInspectorVariables({ ...currentScopeVariables, [newVarKey.trim()]: value });
                                                setNewVarKey('');
                                                setNewVarVal('');
                                            }, undefined);
                                        }}
                                    >
                                        写入
                                    </button>
                                </div>

                                <h3 className="ttm-sub-heading">当前层级 ({selectedVarScope}) 变量</h3>
                                <div className="ttm-var-table">
                                    {Object.entries(currentScopeVariables).map(([k, v]) => (
                                        <div key={k} className="ttm-var-row">
                                            <code>{k}</code>
                                            <span>{JSON.stringify(v)}</span>
                                            <button
                                                type="button"
                                                className="ttm-mini-btn"
                                                onClick={() => {
                                                    setNewVarKey(k);
                                                    setVariableValueMode('json');
                                                    setNewVarVal(JSON.stringify(v, null, 2) ?? 'null');
                                                }}
                                            >编辑</button>
                                            <button
                                                type="button"
                                                className="ttm-msg-action-btn is-danger"
                                                aria-label={`删除变量 ${k}`}
                                                onClick={() => { const next = { ...currentScopeVariables }; delete next[k]; void runUiAction('删除变量', () => writeInspectorVariables(next), undefined); }}
                                            >
                                                ×
                                            </button>
                                        </div>
                                    ))}
                                </div>

                                <h3 className="ttm-sub-heading">五级合并生效视图 (Merged Snapshot)</h3>
                                <pre className="ttm-json-preview">{JSON.stringify(mergedVariables, null, 2)}</pre>
                            </div>
                        )}

                        {inspectorTab === 'schema-settings' && <SettingsPanel key={settingsDestination.revision} initialCategory={settingsDestination.category} advancedTools={advancedTools} dataTools={dataTools} onOpenPersona={setPersonaAnchor}
                            onOpenAppearance={() => openInspector('theme-studio')}
                            onOpenAssets={(kind, anchor) => {
                                if (kind === 'characters') { closeInspector(); setSidebarCollapsed(false); setMobileTab('characters'); }
                                else openAsset(kind, anchor);
                            }} />}
                    </>}</div>
                </aside>
            </div>

            {characterDetails && (() => {
                const character = state.characters.find(card => card.id === characterDetails.id);
                return character && <AnchoredDialog compact title="故事资料" anchor={characterDetails.anchor} onClose={() => setCharacterDetails(null)}>
                    <CharacterDetailsPanel key={character.id} character={character} disabled={state.isGenerating || state.helperGenerationCount > 0}
                        actions={<AssetMoreButton label="故事更多操作" expanded={assetMenu?.kind === 'character' && assetMenu.id === character.id} onOpen={anchor => openAssetMenu({ kind: 'character', id: character.id, name: storyIdentity(character).name, anchor })} />}
                        onSaveDocument={document => runStoreAction('保存角色卡', () => updateCharacterDocument(character.id, document))} />
                </AnchoredDialog>;
            })()}
            {assetMenu && <AssetActionMenu anchor={assetMenu.anchor} point={assetMenu.point} label={`${assetMenu.name} · 更多操作`} onClose={() => setAssetMenu(null)} actions={[
                ...(assetMenu.kind === 'character' ? [
                    { label: '绑定本地图库', icon: 'upload' as const, run: () => setGalleryDialog({ id: assetMenu.id, name: assetMenu.name, anchor: assetMenu.anchor }) },
                    { label: '查看故事资料', icon: 'book' as const, run: () => setCharacterDetails(previous => previous?.id === assetMenu.id ? previous : { id: assetMenu.id, anchor: assetMenu.anchor }) },
                    { label: '导出角色卡', icon: 'download' as const, run: () => { void runUiAction('导出角色卡', async () => setStatusBanner(await exportCharacterAsPng(assetMenu.id)), undefined); } },
                ] : []),
                { label: `删除${assetMenu.kind === 'character' ? '故事' : assetMenu.kind === 'worldbook' ? '世界书' : '预设'}`, icon: 'trash', destructive: true,
                    disabled: state.isGenerating || state.helperGenerationCount > 0 || clearing || switchingCharacter !== null,
                    run: () => setDeleteAsset(assetMenu) },
            ]} />}
            {deleteAsset && <DeleteAssetDialog key={`${deleteAsset.kind}:${deleteAsset.id}`} target={deleteAsset} onClose={() => setDeleteAsset(null)} />}
            {galleryDialog && <AnchoredDialog compact title="本地图库" anchor={galleryDialog.anchor} onClose={() => setGalleryDialog(null)}><StoryGalleryPanel key={galleryDialog.id} storyId={galleryDialog.id} name={galleryDialog.name} onChanged={bound => { if (galleryDialog.id === activeCharacter.id) setGalleryStoryId(bound ? galleryDialog.id : ''); }} /></AnchoredDialog>}
            {illustrationNode && illustrationAnchor.current && <AnchoredDialog compact centered title={`第 ${illustrationNode.floor} 楼配图`} anchor={illustrationAnchor.current} onClose={() => setIllustrationId(undefined)}>
                <form className="ttm-illustration-form" onSubmit={event => { event.preventDefault(); void generateIllustration(); }}>
                    <label htmlFor="ttm-illustration-prompt">绘图标签</label>
                    <textarea id="ttm-illustration-prompt" className="ttm-select-input" rows={3} value={illustrationPrompt} onChange={event => setIllustrationPrompt(event.target.value)} />
                    <button type="submit" className="ttm-btn-primary" disabled={illustrating || !illustrationPrompt.trim()}>{illustrating ? '正在生成…' : '生成配图'}</button>
                    {illustrations.map(item => <img key={item.path} loading="lazy" src={`${compatibilityOrigin}${item.path}`} alt={item.prompt} />)}
                </form>
            </AnchoredDialog>}
            {/* Mobile Bottom Navigation Bar */}
            {personaAnchor && <AnchoredDialog compact title="个人资料" anchor={personaAnchor} onClose={() => setPersonaAnchor(null)}><PersonaSettings key={activeCharacter.id} onSaved={() => { setPersonaAnchor(null); setStatusBanner('个人资料已保存'); }} /></AnchoredDialog>}
            <StoryRoutes /><WorldbookSyncReview /><NativePluginCommandHost />
            {assetDialog && <AnchoredDialog title={assetDialog.kind === 'presets' ? '预设明细' : '世界书'} anchor={assetDialog.anchor} onClose={() => {
                if (assetDialog.kind === 'lorebook') void runUiAction('同步世界书', finishWorldbookEditing, undefined);
                setAssetDialog(null); setLorebookHitsOpen(false);
            }}>
                {assetDialog.kind === 'presets' ? presetPanel : worldbookPanel}
            </AnchoredDialog>}
            <div className="ttm-mobile-nav-shell" aria-hidden={reading && mobileTab === 'chat'} {...(reading && mobileTab === 'chat' ? { inert: '' } : {})}>
            <div className="ttm-mobile-nav-clip"><nav className="ttm-mobile-navbar" data-ti-shell="navigation" data-ti-area="mobile" aria-label="主导航">
                {shellParts('mobile')}
            </nav>
            </div></div>
            {guide === 'welcome' && <GuideWelcome appName={appName} art={<ShellArt skin={skin} id="welcome" fallback={<Icon name="book" width={56} height={56} />} />} onStart={() => setGuide('tour')} onSkip={() => setGuide(null)} />}
            {guide === 'tour' && <OnboardingTour hasStory={hasStory} onNavigate={navigateGuide} onAction={guideAction} onFinish={() => { setGuide(null); closeInspector(); }} />}
            <ThemeStudioPanel open={appearanceOpen} device={device} onClose={() => setAppearanceOpen(false)} />
            {(savedSkin || localPlacement) && !skinDevice.paused && <button type="button" className="ttm-skin-rescue" aria-label="停用自定义外观" title="停用自定义外观" onClick={() => { pauseAppearance(true); setAppearanceOpen(true); }}><Icon name="palette" width={17} height={17} /></button>}
        </div>
    );
}




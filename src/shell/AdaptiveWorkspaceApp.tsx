import { useConversationComposer } from './useConversationComposer';
import { hasActiveSPreset } from '../compatibility/spreset-config';
import { WorkspaceInspector, type InspectorTab } from './WorkspaceInspector';
import { ConversationComposer } from './ConversationComposer';
import { ConversationHistory } from './ConversationHistory';
import { StoryConversationManager, storyConversationId } from './StoryConversationManager';
import type { ChatListEntry } from './chat-selection';
import { ConversationReading } from './ConversationReading';
import { WorkspaceHome } from './WorkspaceHome';
import { WorkspaceLibrary } from './WorkspaceLibrary';
import { NightChatList, ShelfNavigation, type NightChatEntry } from './NightChatList';
import { WorkspaceLoading } from './WorkspaceLoading';
import { initializeWorkspace } from './workspace-bootstrap';
import { readWorkspacePage, rememberWorkspacePage, type AppearancePage, type WorkspaceTab } from './workspace-page';
import { reportActionError, runStoreAction, runUiAction } from './workspace-ui-actions';
import { libraryPageSize, useLibraryFilters } from './useLibraryFilters';
import { StoryRoutes, openStoryRoutes } from './StoryRoutes';
import { StorySaveDialog } from './StorySaveDialog';
import { AssetActionMenu, AssetMoreButton, type MenuPoint } from './AssetActionMenu';
import { storyIdentity } from '../core/story-identity';
import { StoryGalleryPanel } from './StoryGalleryPanel';
import { readStoryGallery } from '../core/story-gallery';
import { NotificationRegion } from './NotificationRegion';
import { ReleaseNotesDialog } from './ReleaseNotesDialog';
import { DeleteAssetDialog, type DeleteAssetConfirmation, type DeleteAssetTarget } from './DeleteAssetDialog';
import { useNativeNavigation } from './useNativeNavigation';
import { lanSyncStore, beginWorldbookEditing, finishWorldbookEditing } from '../core/sync/engine';
import { WorldbookSyncReview } from './WorldbookSyncReview';
import { schemaRegistryStore } from '../registry/schema-registry';
import { ModelNameInput } from '../registry/ModelNameInput';
import { compatibilityOrigin, isNativeRuntime } from '../core/native-runtime';
import { checkAppUpdate } from '../core/app-update';
import { pickNativeAsset, pickNativeWorldbook } from '../core/platform-files';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { cardNeedsAuthorHost, messageNeedsAuthorHost, regexesNeedAuthorHost } from '../compatibility/message-host-requirements';
import { globalRegexes } from '../store/global-regex-store';
import { PersonaSettings } from './PersonaSettings';
import { useReadingMode } from './useReadingMode';
import { AnchoredDialog } from './AnchoredDialog';
import { SettingsDisclosure } from './SettingsPrimitives';
import { WorkspacePresetPanel, WorkspaceWorldbookPanel } from './WorkspaceAssetPanels';
import {
    attachReplyIllustration, getActiveCharacter, getActiveChatMessages, getActiveLorebooks, getActivePersona,
    getActivePreset, getAvailableWorldbooks, getCharacterWorldbooks, getChatBranchOptions, getWorkspaceScripts,
    listArchivedChats, restoreArchivedChat, startNewChat, startFreeChat, getFreeChatConnection, updateFreeChat,
    deleteWorkspaceChats, renameStoryChat, updateCharacterDocument, importAssetFile, clearImportedWorkspace, observePromptInspector,
    selectCharacter, regenerateLastAssistantMessage, reprocessLastMvuMessage, setStatusBanner,
    exportCharacterAsPng, persistWorkspaceNow, workspaceStore,
} from '../store/workspace-store';
import { readingColorScheme, themeEngineStore, toggleReadingColorScheme } from '../theme/theme-engine';
import { appearanceDevice, appearanceStore, pauseAppearance } from '../theme/appearance-store';
import { applyAppearanceStyle, compileAppearance, wallpaperStyle } from '../theme/appearance-style';
import { assetUrl, defaultText, partText, placements, textOf, type Area, type Part, type Widget } from '../theme/appearance-model';
import { ShellArt, ShellBrand, ShellPartIcon, ShellWidget } from '../theme/appearance-shell';
import { Icon } from './Icon';
import { CharacterAvatar } from './CharacterAvatar';
import { ThemeStudioPanel } from '../theme/ThemeStudioPanel';
import { CharacterDetailsPanel, MvuCharacterSettingsEditor } from './AssetInspectorPanel';
import { NativePluginCommandHost, WorkspacePluginMenu } from '../plugins/native/PluginCommands';
import { commandCompatibilityRuntime, compatibilityStoryReady, subscribeCompatibilityExtensionMenu, getCompatibilityIllustrationAvailable, getCompatibilityExtensionMenu } from '../compatibility/runtime-client';
import { hostIllustrationKey, type HostIllustration } from '../compatibility/chat-message-codec';
import { freeChatName } from '../store/chat-archives';
import { branchExcerpt, swipeId } from '../store/chat-tree';
import { beginSyncAssetEdit, setStoryRuntimeLoading } from '../core/sync/activity';
import { GuideWelcome, OnboardingTour, needsFirstRunGuide, rememberFirstRunGuide, type GuideStep } from './OnboardingTour';
import type { SettingsCategory } from './settings-presentation';
import type { ReactNode } from 'react';

export function AdaptiveWorkspaceApp() {
    const syncArchiveRevision = lanSyncStore.useStore(s => s.archiveRevision);
    useEffect(() => {
        const onStorageError = (event: Event) => setStatusBanner(String((event as CustomEvent).detail));
        window.addEventListener('tipsy-storage-error', onStorageError);
        return () => window.removeEventListener('tipsy-storage-error', onStorageError);
    }, []);
    const state = workspaceStore.useStore();
    const themeState = themeEngineStore.useStore();
    const darkReading = readingColorScheme(themeState.tokens.bgPrimary) === 'dark';
    const readingColorAction = darkReading ? '切换到日间配色' : '切换到夜间配色';
    const savedSkin = appearanceStore.useStore(state => state.saved);
    const skinDevice = appearanceDevice.useStore();
    const skin = skinDevice.paused ? undefined : savedSkin ?? undefined;
    const [appearanceOpen, setAppearanceOpen] = useState<AppearancePage>(false);
    const [mobileAppearanceMode, setMobileAppearanceMode] = useState<'editor' | 'packages'>('editor');
    const skinCss = useMemo(() => skin ? compileAppearance(skin) : '', [skin]);
    const appName = textOf(skin, 'name') || defaultText.name;
    useLayoutEffect(() => { applyAppearanceStyle(document, skinCss); }, [skinCss]);
    useEffect(() => { document.title = textOf(skin, 'window') || (skin ? appName : '微醺屿 · TipsyIsle'); }, [appName, skin]);
    useEffect(() => {
        const recover = (event: KeyboardEvent) => {
            if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'u') {
                event.preventDefault();
                pauseAppearance(true);
                if (window.matchMedia('(max-width: 1024px)').matches) {
                    setMobileAppearanceMode('editor');
                    setAppearanceOpen(false);
                    setInspectorOpen(false);
                    setMobileTab('theme');
                } else {
                    setAppearanceOpen('editor');
                }
            }
        };
        window.addEventListener('keydown', recover);
        return () => window.removeEventListener('keydown', recover);
    }, []);

    const isFree = state.sessionKind === 'free';
    const settings = schemaRegistryStore.useStore(s => s.values);
    const freeConnection = getFreeChatConnection(state, settings);
    const needsConnection = !freeConnection.baseUrl || !freeConnection.model;
    const canIllustrate = useSyncExternalStore(subscribeCompatibilityExtensionMenu, getCompatibilityIllustrationAvailable);
    const hasExtensionMenu = useSyncExternalStore(subscribeCompatibilityExtensionMenu, getCompatibilityExtensionMenu).length > 0;
    const [extensionPanel, setExtensionPanel] = useState(false);
    const [extensionFloors, setExtensionFloors] = useState(false);
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
    useEffect(() => { if (workspaceReady) void checkAppUpdate(); }, [workspaceReady]);
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
    }, [workspaceReady, state.activeChatId]);
    const [initializationError, setInitializationError] = useState('');
    const [inspectorTab, setInspectorTab] = useState<InspectorTab>('schema-settings');
    const [mobileTab, setMobileTab] = useState<WorkspaceTab>('chat');
    const [homeOpen, setHomeOpen] = useState(true);
    const [nightShelf, setNightShelf] = useState(false);
    const [inspectorOpen, setInspectorOpen] = useState(false);
    const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
    const libraryFilters = useLibraryFilters(state.characters);
    const { characterSearchRef, setCharacterSearch, setCharacterTag, setCharacterSort, setCharacterPage, filteredCharacters } = libraryFilters;
    const [assetDialog, setAssetDialog] = useState<{ kind: 'presets' | 'lorebook'; anchor: HTMLElement } | null>(null);
    useEffect(() => assetDialog?.kind === 'presets' ? beginSyncAssetEdit() : undefined, [assetDialog?.kind]);
    const [deleteAsset, setDeleteAsset] = useState<DeleteAssetConfirmation | null>(null);
    const [deleteSelection, setDeleteSelection] = useState<Set<string> | null>(null);
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
    const [storyConversationAnchor, setStoryConversationAnchor] = useState<HTMLElement>();
    const [toolsOpen, setToolsOpen] = useState(false);
    const [lorebookHitsOpen, setLorebookHitsOpen] = useState(false);
    const { reading, restore: restoreReadingControls, compact: compactReadingControls, onReadingActivity } = useReadingMode(state.activeChatId);
    useEffect(() => { if (reading) { setHistoryOpen(false); setToolsOpen(false); setStoryConversationAnchor(undefined); } }, [reading]);
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
    const openAppearance = useCallback((mode: 'editor' | 'packages' = 'editor') => {
        if (compactLayout) {
            restoreReadingControls();
            setMobileAppearanceMode(mode);
            setAppearanceOpen(false);
            setNightShelf(false);
            setInspectorOpen(false);
            setHistoryOpen(false);
            setToolsOpen(false);
            setStoryConversationAnchor(undefined);
            setMobileTab('theme');
        } else {
            setAppearanceOpen(mode);
        }
    }, [compactLayout, restoreReadingControls]);
    useEffect(() => {
        if (compactLayout && appearanceOpen) {
            setMobileAppearanceMode(appearanceOpen);
            setAppearanceOpen(false);
            setMobileTab('theme');
        } else if (!compactLayout && mobileTab === 'theme') {
            setMobileTab('chat');
            setAppearanceOpen(mobileAppearanceMode);
        }
    }, [compactLayout, appearanceOpen, mobileTab, mobileAppearanceMode]);
    const openInspector = (tab: InspectorTab | 'theme-studio') => {
        if (tab === 'theme-studio') { openAppearance('packages'); return; }
        restoreReadingControls();
        setInspectorTab(tab);
        setInspectorOpen(true);
        setMobileTab('inspector');
    };
    const closeInspector = () => { setInspectorOpen(false); setMobileTab('chat'); };
    const showHome = () => {
        restoreReadingControls(); setNightShelf(false); setHomeOpen(true); setHistoryOpen(false); setToolsOpen(false); setStoryConversationAnchor(undefined); closeInspector();
    };
    const resumeConversation = () => {
        setNightShelf(workspaceStore.getState().sessionKind === 'free'); setHomeOpen(false); setStoryConversationAnchor(undefined); closeInspector();
    };
    const showNightList = () => {
        restoreReadingControls(); setNightShelf(true); setSidebarCollapsed(false); setInspectorOpen(false);
        setHistoryOpen(false); setToolsOpen(false); setStoryConversationAnchor(undefined); setMobileTab(compactLayout ? 'free' : 'chat');
        if (workspaceStore.getState().sessionKind === 'free') setHomeOpen(false);
    };
    useNativeNavigation(() => {
        if (assetMenu) { setAssetMenu(null); return true; }
        if (storyConversationAnchor) { setStoryConversationAnchor(undefined); return true; }
        if (deleteSelection && mobileTab === 'characters') { setDeleteSelection(null); return true; }
        if (historyOpen || toolsOpen) { setHistoryOpen(false); setToolsOpen(false); return true; }
        if (mobileTab === 'free') { showHome(); return true; }
        if (inspectorOpen || mobileTab !== 'chat') { closeInspector(); return true; }
        if (reading) { restoreReadingControls(); return true; }
        if (compactLayout && isFree && !homeOpen) { showNightList(); return true; }
        return false;
    });
    useEffect(() => {
        const onEscape = (event: KeyboardEvent) => {
            if (event.key !== 'Escape' || event.defaultPrevented) return;
            if (storyConversationAnchor) { setStoryConversationAnchor(undefined); storyConversationAnchor.focus({ preventScroll: true }); return; }
            if (deleteSelection && !deleteAsset && !inspectorVisible && (compactLayout ? mobileTab === 'characters' : !nightShelf)) {
                event.preventDefault(); setDeleteSelection(null); return;
            }
            restoreReadingControls();
            setInspectorOpen(false); setHistoryOpen(false); setToolsOpen(false);
            if (mobileTab !== 'free') setMobileTab('chat');
        };
        window.addEventListener('keydown', onEscape);
        return () => window.removeEventListener('keydown', onEscape);
    }, [storyConversationAnchor, deleteSelection, deleteAsset, inspectorVisible, compactLayout, mobileTab, nightShelf, restoreReadingControls]);
    const [archivedChats, setArchivedChats] = useState<Awaited<ReturnType<typeof listArchivedChats>>>([]);
    const [archivesLoaded, setArchivesLoaded] = useState(false);
    const [archiveRefresh, setArchiveRefresh] = useState(0);
    const [newChatMenu, setNewChatMenu] = useState<HTMLElement>();
    const [freeEditor, setFreeEditor] = useState<{ anchor: HTMLElement; kind: 'title' | 'model'; id: string; value: string }>();
    const [savingFreeEdit, setSavingFreeEdit] = useState(false);
    const [storySave, setStorySave] = useState<{ anchor: HTMLElement; mode: 'import' | 'export' }>();
    const fileInputRef = useRef<HTMLInputElement | null>(null);
    const worldbookFileInputRef = useRef<HTMLInputElement | null>(null);
    const stayAfterImportRef = useRef(false);
    const [importing, setImporting] = useState(false);
    const [clearing, setClearing] = useState(false);
    const [switchingCharacter, setSwitchingCharacter] = useState<string | null>(null);

    const activeCharacter = getActiveCharacter(state);
    const hasStory = !isFree && !!activeCharacter.id;
    const canPlay = isFree ? workspaceReady : readyStory === state.activeChatId && compatibilityStoryReady(state.activeChatId);
    const hasChat = isFree || hasStory;
    const showingHome = homeOpen || !hasChat;
    const showingNightEmpty = !compactLayout && nightShelf && !isFree;
    const showNightShelf = compactLayout ? mobileTab === 'free' : nightShelf;
    const visibleChatId = showingHome || showingNightEmpty ? null : state.activeChatId || null;
    useLayoutEffect(() => {
        if (workspaceReady) rememberWorkspacePage({ tab: mobileTab, chatId: visibleChatId, appearance: compactLayout ? (mobileTab === 'theme' ? mobileAppearanceMode : false) : appearanceOpen, nightShelf });
    }, [workspaceReady, mobileTab, visibleChatId, compactLayout, mobileAppearanceMode, appearanceOpen, nightShelf]);
    const freeTitle = state.freeChat?.title || (state.messages.length ? freeChatName : '新对话');
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
        if (characterId === state.activeCharacterId) { resumeConversation(); return; }
        setSwitchingCharacter(characterId);
        try {
            await selectCharacter(characterId);
            if (workspaceStore.getState().activeCharacterId === characterId) resumeConversation();
        } catch (error) { reportActionError('切换故事', error); }
        finally { setSwitchingCharacter(null); }
    };
    const beginFreeChat = () => runUiAction(`开始${freeChatName}`, async () => {
        const currentId = workspaceStore.getState().activeChatId;
        await startFreeChat();
        if (workspaceStore.getState().activeChatId === currentId) return false;
        restoreReadingControls(); setSidebarCollapsed(false); resumeConversation(); setHistoryOpen(false); setToolsOpen(false);
        return true;
    }, false);
    const openNightChat = (id: string) => void runUiAction('打开夜灯会话', async () => {
        if (workspaceStore.getState().activeChatId !== id) await restoreArchivedChat(id);
        if (workspaceStore.getState().activeChatId !== id) return;
        resumeConversation(); setHistoryOpen(false); setToolsOpen(false);
    }, undefined);
    const selectedCards = useMemo(() => deleteSelection ? state.characters.filter(card => deleteSelection.has(card.id)) : [], [deleteSelection, state.characters]);
    const deletionBlocked = state.isGenerating || state.helperGenerationCount > 0 || state.mvuExtraAnalysisActive || importing || clearing || switchingCharacter !== null;
    const toggleDeleteSelection = (id: string) => setDeleteSelection(previous => {
        if (!previous) return previous;
        const next = new Set(previous);
        if (next.has(id)) next.delete(id); else next.add(id);
        return next;
    });
    const mvuPrimaryName = getCharacterWorldbooks(activeCharacter, state).primary;
    const mvuPrimaryBook = getAvailableWorldbooks(state).find(book => book.name === mvuPrimaryName);
    const activePreset = getActivePreset(state);
    const activeLorebooks = useMemo(() => getActiveLorebooks(state), [state.sessionKind, state.characters, state.activeCharacterId, state.lorebooks,
        state.activeLorebookIds, state.characterWorldbookBindings, state.storyCharacterBinding, state.storyWorldbooks, state.chatWorldbookBindings, state.activeChatId, state.personas, state.activePersonaId]);
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
                if (!attachReplyIllustration({ chatId: activeChatId, branchEpoch, messageId: id, swipeId: key, content }, { path, prompt })) return false;
                await persistWorkspaceNow();
                return true;
            }, false);
            if (generated) setStatusBanner('配图已保存到柏宝绘图库。', { kind: 'success' });
        } finally { setIllustrating(false); }
    }
    const branchOptions = useMemo(() => getChatBranchOptions(state), [state.messages, state.activeLeafId]);
    const lastMessage = activeMessages.at(-1);
    const nightChats: NightChatEntry[] = archivedChats.filter(chat => chat.kind === 'free' && chat.id !== state.activeChatId).reverse()
        .map(chat => ({ ...chat, title: chat.messageCount ? chat.title : chat.title === freeChatName ? '新对话' : chat.title }));
    if (isFree && state.activeChatId) nightChats.unshift({ id: state.activeChatId, title: freeTitle, messageCount: activeMessages.length,
        lastActivity: lastMessage?.updatedAt ?? lastMessage?.createdAt ?? state.freeChat?.createdAt });
    nightChats.sort((a, b) => (b.lastActivity ?? 0) - (a.lastActivity ?? 0));
    const scripts = getWorkspaceScripts(state);
    const globalRules = globalRegexes();
    const messageHostRequired = useMemo(() => cardNeedsAuthorHost(activeCharacter) || regexesNeedAuthorHost(activePreset.regexScripts) || regexesNeedAuthorHost(globalRules),
        [activeCharacter, activePreset.regexScripts, globalRules]);
    const compatibilityView = useMemo(() => (extensionFloors && hasExtensionMenu) || galleryStoryId === activeCharacter.id || scripts.some(script => script.enabled) ||
        hasActiveSPreset(activePreset) || messageHostRequired || activeMessages.some(node => messageNeedsAuthorHost(node.content) || /<%|\[RENDER:|@@render_(?:before|after)/.test(node.content)) ||
        activeLorebooks.some(book => book.entries.some(entry => /<%|\[RENDER:|@@render_(?:before|after)/.test(entry.comment + '\n' + entry.content))),
        [extensionFloors, hasExtensionMenu, scripts, activePreset, activeMessages, activeLorebooks, galleryStoryId, activeCharacter.id, messageHostRequired]);

    const finishStartup = useCallback(() => {
        const restored = workspaceStore.getState();
        const hasConversation = restored.sessionKind === 'free' ? !!restored.activeChatId : !!getActiveCharacter(restored).id;
        const page = readWorkspacePage(hasConversation ? restored.activeChatId : null);
        const isCompact = window.matchMedia('(max-width: 1024px)').matches;
        setHomeOpen(page.chatId === null);
        setNightShelf(page.nightShelf);
        if (isCompact) {
            if (page.tab === 'theme' || page.appearance) {
                setMobileAppearanceMode(page.appearance || 'editor');
                setMobileTab('theme');
                setAppearanceOpen(false);
            } else {
                setMobileTab(page.tab);
                setAppearanceOpen(false);
            }
            setInspectorOpen(page.tab === 'inspector');
        } else {
            if (page.tab === 'theme') {
                setMobileTab('chat');
                setAppearanceOpen(current => current || page.appearance || 'editor');
            } else {
                setMobileTab(page.tab);
                setAppearanceOpen(current => current || page.appearance);
            }
            setInspectorOpen(page.tab === 'inspector');
        }
        setWorkspaceReady(true);
    }, []);
    useEffect(() => {
        let active = true;
        void initializeWorkspace().then(() => { if (active) finishStartup(); })
            .catch(error => { if (active) setInitializationError(error instanceof Error ? error.message : String(error)); });
        return () => { active = false; };
    }, [finishStartup]);

    useEffect(() => {
        if (!workspaceReady) return;
        let cancelled = false;
        void runUiAction('读取已保存会话', async () => {
            const chats = await listArchivedChats();
            if (!cancelled) setArchivedChats(chats);
        }, undefined).finally(() => { if (!cancelled) setArchivesLoaded(true); });
        return () => { cancelled = true; };
        }, [workspaceReady, state.activeChatId, syncArchiveRevision, archiveRefresh]);

    const importPickedFile = async (file: File, options?: { stayInPlace?: boolean }) => {
        setImporting(true);
        try {
            setStatusBanner(await importAssetFile(file));
            if (!options?.stayInPlace) showLibrary();
        }
        catch (err) { reportActionError('导入', err); }
        finally { setImporting(false); }
    };
    const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        e.target.value = '';
        const stayInPlace = stayAfterImportRef.current;
        stayAfterImportRef.current = false;
        if (file) await importPickedFile(file, { stayInPlace });
    };
    const handleWorldbookFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        e.target.value = '';
        if (file) await importPickedFile(file, { stayInPlace: true });
    };
    const chooseAssetFile = async (stayInPlace = false) => {
        if (!isNativeRuntime()) {
            stayAfterImportRef.current = stayInPlace;
            fileInputRef.current?.click();
            return;
        }
        setImporting(true);
        try { const file = await pickNativeAsset(); if (file) await importPickedFile(file, { stayInPlace }); }
        catch (error) { reportActionError('选择文件', error); }
        finally { setImporting(false); }
    };
    const chooseWorldbookFile = async () => {
        if (!isNativeRuntime()) { worldbookFileInputRef.current?.click(); return; }
        setImporting(true);
        try { const file = await pickNativeWorldbook(); if (file) await importPickedFile(file, { stayInPlace: true }); }
        catch (error) { reportActionError('选择世界书', error); }
        finally { setImporting(false); }
    };

    const openSettings = (category: SettingsCategory) => {
        setSettingsDestination(previous => ({ category, revision: previous.revision + 1 }));
        openInspector('schema-settings');
    };
    const composer = useConversationComposer(state, canPlay, needsConnection, () => openSettings('connection'));
    const showLibrary = () => {
        restoreReadingControls(); setNightShelf(false); setSidebarCollapsed(false); setInspectorOpen(false); setStoryConversationAnchor(undefined); setMobileTab('characters');
        if (isFree && !compactLayout) setHomeOpen(true);
    };
    const navigateGuide = (step: GuideStep) => {
        restoreReadingControls(); setHistoryOpen(false); setToolsOpen(false);
        if (step === 'import' || step === 'story-save' || (step === 'play' && !hasStory)) {
            setDeleteSelection(null);
            if (step === 'play') { setCharacterSearch(''); setCharacterTag(''); }
            showLibrary();
        }
        else if (step === 'connection') openSettings('connection');
        else if (step === 'model-chat' || (step === 'history' && isFree)) showHome();
        else if (step !== 'reading-colors') resumeConversation();
    };
    const replayGuide = () => { rememberFirstRunGuide(); setGuide('welcome'); };
    const advancedTools = !isFree && <>
        <div className="ttm-editor-actions"><button type="button" className="ttm-mini-btn" onClick={() => setInspectorTab('prompt-tree')}>提示词诊断</button><button type="button" className="ttm-mini-btn" onClick={() => setInspectorTab('variables')}>变量管理</button></div>
        {hasStory && <CharacterDetailsPanel key={activeCharacter.id} mode="advanced" character={activeCharacter} disabled={state.isGenerating || state.helperGenerationCount > 0} onSaveDocument={(document) => runStoreAction('保存角色卡', () => updateCharacterDocument(activeCharacter.id, document))} />}
                    {mvuPrimaryBook && <MvuCharacterSettingsEditor key={`${activeCharacter.id}:${mvuPrimaryBook.id}`} book={mvuPrimaryBook} disabled={state.isGenerating || state.helperGenerationCount > 0} />}
    </>;
    const dataTools = <>
                    <SettingsDisclosure title="清空测试数据">
                            <p className="ttm-asset-help">删除所有导入的角色卡、世界书、预设、会话和变量，回到空馆藏。保留个人资料（昵称、头像、人设）、模型连接与外观设置，不创建备份。</p>
                            <button type="button" className="ttm-btn-secondary" disabled={clearing || importing || switchingCharacter !== null || state.isGenerating || state.helperGenerationCount > 0}
                                onClick={() => {
                                    if (!window.confirm('清空所有导入内容和会话？此操作无法撤销。个人资料、模型连接与外观设置会保留。')) return;
                                    setClearing(true);
                                    void runUiAction('清空测试内容', clearImportedWorkspace, undefined).finally(() => setClearing(false));
                                }}>{clearing ? '正在清空…' : '一键清空测试内容'}</button>
                    </SettingsDisclosure>

    </>;

    // Keep workspace actions unavailable until persisted state has loaded.
    if (!workspaceReady) return <WorkspaceLoading skin={skin} appName={appName} initializationError={initializationError} onRetry={() => {
        setInitializationError('');
        void initializeWorkspace().then(finishStartup).catch(error => setInitializationError(error instanceof Error ? error.message : String(error)));
    }} />;

    const navTabs = { 'mobile-library': 'characters', 'mobile-chat': 'chat', 'mobile-appearance': 'theme', 'mobile-settings': 'inspector' } as const;
    const generating = state.isGenerating || state.helperGenerationCount > 0;
    const storyChats = archivedChats.filter(chat => chat.kind !== 'free');
    const storyActiveId = hasStory ? state.activeChatId : '';
    const manageStoryChats = !isFree || showingHome;
    const nightActionsBusy = clearing || generating || state.mvuExtraAnalysisActive || !!switchingCharacter;
    const shelfNavigation = !compactLayout && <ShelfNavigation night={nightShelf} libraryLabel={textOf(skin, 'library')} onLibrary={showLibrary} onNight={showNightList} />;
    const regenerate = () => {
        if (isFree && needsConnection) openSettings('connection');
        else void runUiAction('重新生成', regenerateLastAssistantMessage, '');
    };
    const saveFreeEdit = () => {
        if (!freeEditor || savingFreeEdit || freeEditor.kind === 'title' && !freeEditor.value.trim()) return;
        const { id, kind, value } = freeEditor;
        setSavingFreeEdit(true);
        void runUiAction('保存对话', async () => {
            await updateFreeChat(id, kind === 'title' ? { title: value.trim() } : { model: value.trim() || undefined });
            setArchiveRefresh(value => value + 1); setFreeEditor(undefined);
        }, undefined).finally(() => setSavingFreeEdit(false));
    };
    const removeChats = async (ids: string[], kind: 'character' | 'free') => {
        const result = await deleteWorkspaceChats(ids, kind);
        const removed = new Set(result.ids);
        setArchivedChats(chats => chats.filter(chat => !removed.has(chat.id)));
        setArchiveRefresh(value => value + 1);
        if (kind === 'free') for (const id of removed) composer.forgetFreeDraft(id);
        if (result.removedCurrent) {
            setExtensionPanel(false);
            if (kind === 'free') { showHome(); showNightList(); }
            else { setHomeOpen(true); setNightShelf(false); setHistoryOpen(false); setToolsOpen(false); closeInspector(); }
        }
    };
    const storyConversationEntries = (): ChatListEntry[] => {
        const entries = storyChats.filter(chat => chat.id !== state.activeChatId).reverse()
            .sort((a, b) => (b.lastActivity ?? 0) - (a.lastActivity ?? 0))
            .map(chat => ({ id: chat.id, title: chat.title || chat.characterName, characterName: chat.characterName, preview: chat.preview,
                messageCount: chat.messageCount, lastActivity: chat.lastActivity }));
        if (storyActiveId) entries.unshift({ id: storyActiveId, title: state.storyChatTitle || activeStoryIdentity.name,
            characterName: activeStoryIdentity.name, preview: branchExcerpt(lastMessage?.content ?? '', 90),
            messageCount: activeMessages.length, lastActivity: lastMessage?.updatedAt ?? lastMessage?.createdAt });
        return entries;
    };
    const widgets = new Map(skin?.widgets.map(widget => [widget.id, widget]));
    const skinWallpaper = wallpaperStyle(skin);
    const widgetAction = (action: Widget['action'], anchor: HTMLElement) => {
        if (action === 'routes' && hasStory) openStoryRoutes(undefined, anchor);
        if (action === 'settings') openInspector('schema-settings');
        if (action === 'appearance') openAppearance('editor');
    };
    const shellParts = (area: Area): ReactNode => placed[area].map(id => {
        const widget = widgets.get(id);
        if (widget && skin) return <ShellWidget key={id} skin={skin} widget={widget} values={{ character: hasStory ? activeStoryIdentity.name : '未选择故事', messages: activeMessages.length, library: state.characters.length }} onAction={widgetAction} />;
        const part = id as Part;
        if ((isFree || showingHome) && ['routes', 'continue', 'recalculate', 'retry-analysis'].includes(part)) return null;
        const opensNewChatMenu = part === 'new-chat' && (!isFree || showingHome);
        const button = (action: (anchor: HTMLButtonElement) => void, options: { disabled?: boolean; iconOnly?: boolean; className?: string; label?: string; title?: string; pressed?: boolean; current?: 'page' } = {}) => {
            const label = partText(skin, part, options.label);
            return <button key={id} type="button" data-ti-part={id} className={options.className ?? (options.iconOnly ? 'ttm-icon-btn' : area === 'toolbar' || area === 'more' || area.startsWith('input-') ? 'ttm-chip-btn' : 'ttm-btn-secondary')}
                title={options.title ?? label} aria-label={options.iconOnly ? options.title ?? label : undefined} aria-pressed={part === 'history' ? undefined : options.pressed} aria-expanded={part === 'history' ? manageStoryChats ? !!storyConversationAnchor : historyOpen : opensNewChatMenu ? !!newChatMenu : undefined} aria-haspopup={part === 'history' && manageStoryChats && compactLayout ? 'dialog' : opensNewChatMenu ? 'menu' : undefined} aria-controls={part === 'history' ? manageStoryChats ? storyConversationId : 'ttm-conversation-history' : undefined} aria-current={options.current} disabled={options.disabled} onClick={event => action(event.currentTarget)}>
                {part === 'profile' && !assetUrl(skin, skin?.art[part]) ? <CharacterAvatar name={state.userName} avatar={getActivePersona(state)?.image} fallback="user" />
                    : <ShellPartIcon skin={skin} id={part} name={part === 'focus' ? sidebarCollapsed ? 'panel' : 'focus' : undefined} size={area === 'mobile' || options.iconOnly ? 20 : area === 'toolbar' ? 15 : 17} />}
                {!options.iconOnly && <span>{label}</span>}
            </button>;
        };
        switch (part) {
            case 'focus': return button(() => setSidebarCollapsed(value => !value), { iconOnly: area === 'top', className: area === 'top' ? 'ttm-icon-btn ttm-focus-button' : undefined, pressed: sidebarCollapsed, label: sidebarCollapsed ? '显示馆藏' : '专注阅读' });
            case 'settings': return button(() => openInspector('schema-settings'), { className: area === 'top' ? 'ttm-btn-ghost' : undefined });
            case 'appearance': return button(() => openAppearance('editor'));
            case 'sidebar-settings': return button(() => openInspector('schema-settings'), { label: '设置' });
            case 'routes': return button(anchor => openStoryRoutes(undefined, anchor), { iconOnly: area === 'conversation', disabled: !hasStory, title: `${partText(skin, part)}，共 ${branchOptions.length} 条` });
            case 'profile': return button(setPersonaAnchor, { iconOnly: area === 'conversation', className: area === 'conversation' ? 'ttm-profile-entry ttm-icon-btn' : undefined });
            case 'history': return manageStoryChats ? button(anchor => setStoryConversationAnchor(current => current ? undefined : anchor), {
                label: '会话', title: '故事会话', className: area === 'conversation' ? 'ttm-btn-ghost ttm-story-chat-trigger' : undefined,
            }) : button(() => setHistoryOpen(value => !value), { title: '当前分支', iconOnly: area === 'conversation', className: area === 'conversation' ? `ttm-icon-btn${historyOpen ? ' is-active' : ''}` : undefined });
            case 'new-chat': return button(anchor => {
                if (isFree && !showingHome) void beginFreeChat();
                else setNewChatMenu(newChatMenu ? undefined : anchor);
            }, { disabled: !workspaceReady || (isFree ? nightActionsBusy : generating), title: '新建对话', iconOnly: isFree && area === 'conversation' });
            case 'reading': return button(compactReadingControls, { disabled: !hasChat });
            case 'continue': return button(() => void composer.requestGenerate(), { disabled: !canPlay || generating });
            case 'regenerate': return button(regenerate, { label: isFree && lastMessage?.role === 'user' ? '生成回复' : undefined,
                disabled: !canPlay || generating || !(lastMessage?.role === 'assistant' && lastMessage.parentId || isFree && lastMessage?.role === 'user') });
            case 'recalculate': return button(() => void runUiAction('重算变量', () => reprocessLastMvuMessage(false), ''), { disabled: generating || lastMessage?.role !== 'assistant' });
            case 'retry-analysis': return button(() => void runUiAction('重新解析变量', () => reprocessLastMvuMessage(true), ''), { disabled: generating || lastMessage?.role !== 'assistant' });
            default: {
                const tab = navTabs[part];
                const active = tab === 'theme' ? (compactLayout ? mobileTab === 'theme' : !!appearanceOpen) : mobileTab === tab || tab === 'chat' && mobileTab === 'free';
                return button(() => { if (tab === 'theme') openAppearance('editor'); else if (tab === 'inspector') openInspector('schema-settings'); else if (tab === 'characters') showLibrary(); else if (hasChat) resumeConversation(); else showHome(); },
                    { className: active ? 'is-active' : '', current: active ? 'page' : undefined });
            }
        }
    });

    const storyConversationManager = storyConversationAnchor && manageStoryChats && <StoryConversationManager mobile={compactLayout} anchor={storyConversationAnchor} entries={storyConversationEntries()} activeId={storyActiveId}
        loaded={archivesLoaded} busy={nightActionsBusy || importing} routes={branchOptions.length} onClose={() => { setStoryConversationAnchor(undefined); storyConversationAnchor.focus({ preventScroll: true }); }}
        onOpen={async id => {
            if (workspaceStore.getState().activeChatId !== id) await restoreArchivedChat(id);
            if (workspaceStore.getState().activeChatId !== id) throw new Error('会话暂时无法切换，请稍后再试');
            resumeConversation(); setHistoryOpen(false); setToolsOpen(false); storyConversationAnchor.focus({ preventScroll: true });
        }}
        onNew={async () => {
            if (!hasStory) { showLibrary(); return; }
            await startNewChat();
            if (workspaceStore.getState().activeChatId === storyActiveId) throw new Error('请等待当前操作完成');
            resumeConversation(); setToolsOpen(false);
        }}
        onRename={async (id, title) => {
            await renameStoryChat(id, title);
            setArchivedChats(chats => chats.map(chat => chat.id === id ? { ...chat, title: title.trim() } : chat));
            setArchiveRefresh(value => value + 1);
        }}
        onDelete={ids => removeChats(ids, 'character')}
        onSave={(anchor, mode) => setStorySave({ anchor, mode })} />;

    return (
        <div
            className={`ttm-app-root ${inspectorOpen ? 'has-inspector' : ''} ${sidebarCollapsed ? 'is-focused' : ''} ${reading && !showingHome && mobileTab === 'chat' ? 'is-reading' : ''}${skinWallpaper ? ' has-skin-wallpaper' : ''}`}
            data-mobile-tab={mobileTab}
        >
            {skinWallpaper && <div className="ttm-skin-wallpaper" data-ti-shell="wallpaper" aria-hidden="true" {...{ inert: '' }} style={skinWallpaper} />}
            {hasChat && <a className="ttm-skip-link" href="#tipsy-chat-composer" onClick={resumeConversation}>跳到对话输入框</a>}
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
                    <input
                        ref={worldbookFileInputRef}
                        type="file"
                        accept=".json"
                        hidden
                        onChange={handleWorldbookFileUpload}
                    />
                    {shellParts('top')}
                    <button type="button" className="ttm-btn-ghost ttm-home-link" data-guide="home" aria-label="首页" title="返回首页" aria-current={showingHome && !showNightShelf && (!compactLayout || mobileTab === 'chat') ? 'page' : undefined} onClick={showHome}>
                        <Icon name="home" width={18} height={18} /><span>首页</span>
                    </button>
                    <button type="button" className="ttm-btn-ghost ttm-quick-chat" disabled={clearing} onClick={showNightList} title="打开夜灯会话列表"
                        aria-current={showNightShelf || (isFree && !showingHome && mobileTab === 'chat') ? 'page' : undefined}>
                        <Icon name="chat" width={16} height={16} /><span>{freeChatName}</span>
                    </button>
                    <button type="button" className="ttm-icon-btn ttm-reading-colors" data-ti-part="reading-colors" data-guide="reading-colors"
                        aria-label={readingColorAction} title={readingColorAction} onClick={toggleReadingColorScheme}>
                        <Icon name={darkReading ? 'sun' : 'moon'} />
                    </button>
                    <WorkspacePluginMenu />
                </div>
            </header>

            <NotificationRegion />
            <ReleaseNotesDialog />

            {/* Three-Column Adaptive Workbench */}
            <div className="ttm-workbench">
                <WorkspaceLibrary skin={skin} state={state} mobileActive={mobileTab === 'characters'} compactLayout={compactLayout} hidden={!compactLayout && nightShelf} shelfNavigation={shelfNavigation}
                    sidebarParts={shellParts('sidebar')} hasCustomSidebarParts={placed.sidebar.some(id => id !== 'appearance' && id !== 'sidebar-settings')}
                    activeCharacter={activeCharacter} activeStoryIdentity={activeStoryIdentity} activePreset={activePreset} activeLorebooks={activeLorebooks}
                    isFree={isFree} hasStory={hasStory} importing={importing} clearing={clearing} switchingCharacter={switchingCharacter}
                    filters={libraryFilters} deleteSelection={deleteSelection} selectedCards={selectedCards}
                    deletionBlocked={deletionBlocked} assetMenu={assetMenu} openAssetMenu={openAssetMenu} openAsset={openAsset}
                    onImport={() => chooseAssetFile(false)} onImportStory={anchor => setStorySave({ anchor, mode: 'import' })} onReplayGuide={replayGuide}
                    onEnterCharacter={enterCharacter} onToggleDeleteSelection={toggleDeleteSelection} onExitDeleteSelection={() => setDeleteSelection(null)}
                    onConfirmDelete={setDeleteAsset} />
                <NightChatList mobile={compactLayout} visible={showNightShelf} navigation={shelfNavigation}
                    entries={nightChats} activeId={isFree ? state.activeChatId : ''} loaded={archivesLoaded} busy={nightActionsBusy}
                    onNew={() => void beginFreeChat()} onOpen={openNightChat}
                    onEdit={(entry, anchor) => setFreeEditor({ kind: 'title', anchor, id: entry.id, value: entry.title })}
                    onDelete={ids => removeChats(ids, 'free')} />

                <main
                    id="tipsy-isle-stage"
                    className={`ttm-center-stage ${mobileTab === 'chat' ? 'is-mobile-active' : ''} ${reading && !showingHome ? 'is-reading' : ''}`}
                >
                    <header className="ttm-conversation-header" data-ti-shell="conversation">
                        {!showingHome && isFree && compactLayout && <button className="ttm-btn-ghost ttm-night-back" type="button" onClick={showNightList}>
                            <Icon name="chevron" width={14} height={14} />夜灯会话
                        </button>}
                        {showingHome || showingNightEmpty ? <div className="ttm-conversation-person" data-ti-part="conversation-title"><div><h2 data-ti-type="heading">{showingNightEmpty ? freeChatName : '首页'}</h2></div></div> :
                        <div className="ttm-conversation-person" data-ti-part="conversation-title"><CharacterAvatar name={hasStory ? activeStoryIdentity.name : appName} avatar={hasStory ? activeCharacter.avatar : '/icons/192x192.png'} /><div><h2 data-ti-type="heading" title={isFree ? freeTitle : undefined}>{isFree ? freeTitle : activeStoryIdentity.name}</h2>{isFree ? <button type="button" className="ttm-free-model" disabled={generating} title={needsConnection ? '连接模型' : `切换本次对话的模型：${freeConnection.model}`} onClick={event => {
                            if (!freeConnection.baseUrl) openSettings('connection');
                            else setFreeEditor({ kind: 'model', anchor: event.currentTarget, id: state.activeChatId, value: state.freeChat?.model ?? freeConnection.model });
                        }}>{needsConnection ? '连接模型' : freeConnection.model}<Icon name="chevron" width={12} height={12} /></button> : <p>{state.mvuExtraAnalysisActive ? '正在整理本轮变量' : generating ? '故事正在续写' : `${activeMessages.length} 条消息 · ${activePreset.name}`}</p>}</div></div>}
                        <div className="ttm-conversation-actions" data-ti-area="conversation">{shellParts('conversation')}</div>
                    </header>
                    {!compactLayout && storyConversationManager}
                    {!manageStoryChats && <ConversationHistory historyOpen={historyOpen} branchOptions={branchOptions} lastMessage={lastMessage} generating={generating} />}
                    {showingNightEmpty ? <div className="ttm-night-blank"><p>{nightChats.length ? '打开一段夜灯会话' : '还没有打开的夜灯会话'}</p></div> : showingHome && <WorkspaceHome skin={skin} hasStory={hasStory} hasCards={state.characters.length > 0}
                        importing={importing} clearing={clearing} generating={generating} onResume={resumeConversation}
                        onShowLibrary={() => { showLibrary(); if (!compactLayout) requestAnimationFrame(() => characterSearchRef.current?.focus()); }}
                        onImport={() => chooseAssetFile(false)} onOpenFree={showNightList} onFinishGuide={() => setGuide(null)}
                        onOpenPersona={setPersonaAnchor} onOpenConnection={() => openSettings('connection')} onReplayGuide={replayGuide} />}
                    <div className="ttm-active-conversation" hidden={showingHome || showingNightEmpty}>
                    <ConversationReading state={state} activeMessages={activeMessages} activeCharacter={activeCharacter} activePreset={activePreset}
                        activeLorebooks={activeLorebooks} isFree={isFree} hasStory={hasStory} hasChat={hasChat} canPlay={canPlay}
                        workspaceReady={workspaceReady} needsConnection={needsConnection} onOpenConnection={() => openSettings('connection')}
                        layoutMode={themeState.layoutMode} hasWallpaper={!!skinWallpaper} illustrationAnchor={illustrationAnchor}
                        compatibilityView={compatibilityView} extensionPanel={extensionPanel} closeExtensionPanel={() => setExtensionPanel(false)}
                        onReadingActivity={onReadingActivity} onIllustrateMessage={canIllustrate ? openIllustration : undefined}
                        runSlashCommand={composer.runSlashCommand} requestGenerate={composer.requestGenerate} />

                    {hasChat && <ConversationComposer skin={skin} state={state} activeMessages={activeMessages} isFree={isFree} canPlay={canPlay}
                        needsConnection={needsConnection} reading={reading} compactLayout={compactLayout} toolsOpen={toolsOpen}
                        setToolsOpen={setToolsOpen} onOpenExtension={() => setExtensionPanel(true)} extensionFloors={extensionFloors} setExtensionFloors={setExtensionFloors} restoreReadingControls={restoreReadingControls}
                        scriptButtons={composer.scriptButtons} extensionMenu={composer.extensionMenu} activeQuickReplies={composer.activeQuickReplies} shellParts={shellParts}
                        draft={composer.draft} onDraftChange={composer.editDraft} onSend={composer.send} />}
                    </div>
                </main>

                {compactLayout && <ThemeStudioPanel inline open={mobileTab === 'theme'} showPackages={mobileAppearanceMode === 'packages'} device={device} onClose={closeInspector} />}

                <WorkspaceInspector tab={inspectorTab} onTabChange={setInspectorTab} mobileActive={mobileTab === 'inspector'} visible={inspectorVisible}
                    state={state} activeMessages={activeMessages} activeCharacter={activeCharacter} activePreset={activePreset}
                    hasStory={hasStory} generating={generating} settingsDestination={settingsDestination}
                    advancedTools={advancedTools} dataTools={dataTools} onOpenPersona={setPersonaAnchor} onReplayGuide={replayGuide}
                    onClose={closeInspector} onOpenAppearance={() => openAppearance('editor')} onOpenAppearancePackages={() => openInspector('theme-studio')}
                    onOpenAsset={openAsset} onShowCharacters={showLibrary} />
            </div>

            {characterDetails && (() => {
                const character = state.characters.find(card => card.id === characterDetails.id);
                return character && <AnchoredDialog compact title="故事资料" anchor={characterDetails.anchor} onClose={() => setCharacterDetails(null)}>
                    <CharacterDetailsPanel key={character.id} character={character} disabled={state.isGenerating || state.helperGenerationCount > 0}
                        actions={<AssetMoreButton label="故事更多操作" expanded={assetMenu?.kind === 'character' && assetMenu.id === character.id} onOpen={anchor => openAssetMenu({ kind: 'character', id: character.id, name: storyIdentity(character).name, anchor })} />}
                        onSaveDocument={document => runStoreAction('保存角色卡', () => updateCharacterDocument(character.id, document))} />
                </AnchoredDialog>;
            })()}
            {newChatMenu && <AssetActionMenu anchor={newChatMenu} label="新建对话" onClose={() => setNewChatMenu(undefined)} actions={[
                { label: '角色聊天', icon: 'book', disabled: generating, run: () => {
                    if (!hasStory) { showLibrary(); return; }
                    void runUiAction('开始角色聊天', async () => { await startNewChat(); resumeConversation(); setHistoryOpen(false); }, undefined);
                } },
                { label: `${freeChatName}（和模型对话）`, icon: 'chat', disabled: generating, run: beginFreeChat },
            ]} />}
            {compactLayout && storyConversationManager}
            {freeEditor && <AnchoredDialog compact centered fitContent anchor={freeEditor.anchor} closeDisabled={savingFreeEdit} onClose={() => setFreeEditor(undefined)}
                title={freeEditor.kind === 'model' ? '切换本次对话的模型' : '重命名对话'}>
                <form className="ttm-free-edit" onSubmit={event => { event.preventDefault(); saveFreeEdit(); }}>
                    {freeEditor.kind === 'title' && <label>对话名称<input autoFocus className="ttm-text-input" value={freeEditor.value} maxLength={100} onChange={event => setFreeEditor({ ...freeEditor, value: event.target.value })} /></label>}
                    {freeEditor.kind === 'model' && <>
                        <label htmlFor="ttm-field-free-model">模型名称</label>
                        <ModelNameInput fieldId="api.model" inputId="ttm-field-free-model" value={freeEditor.value} settings={settings} disabled={savingFreeEdit}
                            placeholder={String(settings['api.model'] || '选择或填写模型名称')} onChange={value => setFreeEditor(previous => previous && { ...previous, value })} />
                        <button type="button" className="ttm-mini-btn" disabled={savingFreeEdit} onClick={() => setFreeEditor({ ...freeEditor, value: '' })}>跟随默认模型</button>
                    </>}
                    <div className="ttm-editor-actions">
                        <button type="button" className="ttm-btn-secondary" disabled={savingFreeEdit} onClick={() => setFreeEditor(undefined)}>取消</button>
                        <button type="submit" className="ttm-btn-primary" disabled={savingFreeEdit || freeEditor.kind === 'title' && !freeEditor.value.trim()}>保存</button>
                    </div>
                </form>
            </AnchoredDialog>}
            {storySave && <StorySaveDialog anchor={storySave.anchor} mode={storySave.mode} onClose={() => setStorySave(undefined)}
                sessions={[...(hasStory && activeMessages.length ? [{ id: state.activeChatId, label: `当前会话 · ${activeCharacter.name}` }] : []), ...archivedChats.filter(chat => chat.kind !== 'free')]}
                startId={hasStory && activeMessages.length ? state.activeChatId : storyChats.at(-1)?.id ?? ''}
                onOpened={() => { setStorySave(undefined); setStoryConversationAnchor(undefined); setHistoryOpen(false); setToolsOpen(false); setExtensionPanel(false); resumeConversation(); setStatusBanner('故事已恢复，可以接着聊。', { kind: 'success' }); }}
                onExported={() => { setStorySave(undefined); setStatusBanner('已导出故事存档。', { kind: 'success' }); }} />}
            {assetMenu && <AssetActionMenu anchor={assetMenu.anchor} point={assetMenu.point} label={`${assetMenu.name} · 更多操作`} onClose={() => setAssetMenu(null)} actions={[
                ...(assetMenu.kind === 'character' ? [
                    { label: '绑定本地图库', icon: 'upload' as const, run: () => setGalleryDialog({ id: assetMenu.id, name: assetMenu.name, anchor: assetMenu.anchor }) },
                    { label: '查看故事资料', icon: 'book' as const, run: () => setCharacterDetails(previous => previous?.id === assetMenu.id ? previous : { id: assetMenu.id, anchor: assetMenu.anchor }) },
                    { label: '导出角色卡', icon: 'download' as const, run: () => { void runUiAction('导出角色卡', async () => setStatusBanner(await exportCharacterAsPng(assetMenu.id)), undefined); } },
                ] : []),
                { label: `删除${assetMenu.kind === 'character' ? '角色卡…' : assetMenu.kind === 'worldbook' ? '世界书' : '预设'}`, icon: 'trash', destructive: true,
                    disabled: deletionBlocked,
                    run: () => {
                        if (assetMenu.kind !== 'character') { setDeleteAsset({ ...assetMenu, kind: assetMenu.kind }); return; }
                        setCharacterDetails(null);
                        if (!assetMenu.anchor.closest('.ttm-char-list')) {
                            let index = filteredCharacters.findIndex(card => card.id === assetMenu.id);
                            if (index < 0) {
                                setCharacterSearch(''); setCharacterTag(''); setCharacterSort('original');
                                index = state.characters.findIndex(card => card.id === assetMenu.id);
                            }
                            setCharacterPage(Math.max(0, Math.floor(index / libraryPageSize)));
                        }
                        showLibrary();
                        setDeleteSelection(new Set([assetMenu.id]));
                    } },
            ]} />}
            {deleteAsset && <DeleteAssetDialog key={deleteAsset.kind === 'characters' ? 'characters' : `${deleteAsset.kind}:${deleteAsset.id}`} target={deleteAsset}
                onClose={() => { setDeleteAsset(null); requestAnimationFrame(() => { if (deleteAsset.anchor.isConnected) deleteAsset.anchor.focus({ preventScroll: true }); }); }}
                onDeleted={() => { setDeleteAsset(null); if (deleteAsset.kind === 'characters') setDeleteSelection(null); }} />}
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
                {assetDialog.kind === 'presets'
                    ? <WorkspacePresetPanel state={state} assetMenu={assetMenu} openAssetMenu={openAssetMenu} activePreset={activePreset} importing={importing} onImport={() => chooseAssetFile(true)} />
                    : <WorkspaceWorldbookPanel state={state} assetMenu={assetMenu} openAssetMenu={openAssetMenu} activeLorebooks={activeLorebooks} lorebookHitsOpen={lorebookHitsOpen} setLorebookHitsOpen={setLorebookHitsOpen} importing={importing} onImportWorldbook={chooseWorldbookFile} />}
            </AnchoredDialog>}
            {guide === 'tour' && <OnboardingTour hasStory={hasStory} hasCards={state.characters.length > 0} onNavigate={navigateGuide} onFinish={() => setGuide(null)} />}
            <div className="ttm-mobile-nav-shell" aria-hidden={reading && !showingHome && mobileTab === 'chat'} {...(reading && !showingHome && mobileTab === 'chat' ? { inert: '' } : {})}>
            <div className="ttm-mobile-nav-clip"><nav className="ttm-mobile-navbar" data-ti-shell="navigation" data-ti-area="mobile" aria-label="主导航">
                {shellParts('mobile')}
            </nav>
            </div></div>
            {guide === 'welcome' && <GuideWelcome appName={appName} art={<ShellArt skin={skin} id="welcome" fallback={<img className="ttm-home-mark" src="/icons/192x192.png" alt="" />} />} onStart={() => setGuide('tour')} onSkip={() => setGuide(null)} />}
            {!compactLayout && <ThemeStudioPanel open={!!appearanceOpen} showPackages={appearanceOpen === 'packages'} device={device} onClose={() => setAppearanceOpen(false)} />}
            {(savedSkin || localPlacement) && !skinDevice.paused && <button type="button" className="ttm-skin-rescue" aria-label="停用自定义外观" title="停用自定义外观" onClick={() => { pauseAppearance(true); openAppearance('editor'); }}><Icon name="palette" width={17} height={17} /></button>}
        </div>
    );
}

import type { Dispatch, ReactNode, SetStateAction } from 'react';
import { stopHelperGeneration } from '../compatibility/helper-generation';
import { commandCompatibilityRuntime, type getCompatibilityExtensionMenu, type getCompatibilityScriptButtons } from '../compatibility/runtime-client';
import { PluginButtons } from '../plugins/native/PluginCommands';
import { SlotMount } from '../plugins/slot-registry';
import type { quickReplyContextItems } from '../sandbox/quick-reply';
import { stopActiveGeneration, type WorkspaceState } from '../store/workspace-store';
import { textOf, type Appearance, type Area } from '../theme/appearance-model';
import { ShellArt } from '../theme/appearance-shell';
import type { ChatMessageNode } from '../types';
import { ChatComposerInput } from './ChatComposerInput';
import { GenerationActivity } from './GenerationActivity';
import { Icon } from './Icon';
import { MvuRepairPanel } from './MvuRepairPanel';
import { QuickReplyMenu } from './QuickReplyMenu';
import { runUiAction } from './workspace-ui-actions';

interface ConversationComposerProps {
    skin?: Appearance;
    state: WorkspaceState;
    activeMessages: ChatMessageNode[];
    isFree: boolean;
    canPlay: boolean;
    needsConnection: boolean;
    reading: boolean;
    compactLayout: boolean;
    toolsOpen: boolean;
    setToolsOpen: Dispatch<SetStateAction<boolean>>;
    onOpenExtension: () => void;
    restoreReadingControls: () => void;
    scriptButtons: ReturnType<typeof getCompatibilityScriptButtons>;
    extensionMenu: ReturnType<typeof getCompatibilityExtensionMenu>;
    activeQuickReplies: { set: string; id: number; title?: string; label?: string; menu: ReturnType<typeof quickReplyContextItems> }[];
    shellParts: (area: Area) => ReactNode;
    draft: string;
    onDraftChange: (value: string) => void;
    onSend: () => Promise<void>;
}

export function ConversationComposer({
    skin, state, activeMessages, isFree, canPlay, needsConnection, reading,
    compactLayout, toolsOpen, setToolsOpen, onOpenExtension, restoreReadingControls, scriptButtons, extensionMenu,
    activeQuickReplies, shellParts, draft, onDraftChange, onSend,
}: ConversationComposerProps) {
    return (
        <footer className="ttm-composer">
            {(state.isGenerating || state.helperGenerationCount > 0) && !state.mvuExtraAnalysisActive && !activeMessages.some(message => message.extra?.tipsy_generation_incomplete) && <GenerationActivity phase="waiting" />}
            <div className="ttm-composer-quickbar" data-ti-shell="composer-controls" data-ti-area="toolbar">
                {shellParts('toolbar')}
                <button type="button" data-ti-part="more" className={`ttm-chip-btn${toolsOpen ? ' is-active' : ''}`} aria-expanded={toolsOpen} aria-controls="ttm-composer-tools" onClick={() => setToolsOpen(value => !value)}><ShellArt skin={skin} id="more" fallback={<Icon name="more" width={17} height={17} />} />{textOf(skin, 'more')}</button>
                {!isFree && <SlotMount name="chat.input.toolbar" />}
            </div>
            <div id="ttm-composer-tools" className="ttm-composer-tools" data-ti-shell="composer-controls" data-ti-part="more-panel" hidden={!toolsOpen}>
            {!isFree && (scriptButtons.length > 0 || activeQuickReplies.length > 0 || extensionMenu.length > 0) && <section className="ttm-composer-shortcuts" aria-labelledby="ttm-composer-shortcuts-title">
                <h3 id="ttm-composer-shortcuts-title">快捷功能</h3>
                <div className="ttm-composer-quickbar">
                {extensionMenu.map(button => <button type="button" key={button.id} className="ttm-btn-secondary" disabled={!canPlay}
                    onClick={() => {
                        setToolsOpen(false); onOpenExtension();
                        void runUiAction(button.name, () => commandCompatibilityRuntime('extensionMenu', [button.id], true), {});
                    }}>{button.name}</button>)}
                {scriptButtons.map((button, index) => <button key={`${button.id}:${index}`} type="button" className="ttm-btn-secondary" disabled={!canPlay || state.isGenerating || state.helperGenerationCount > 0}
                    onClick={() => void runUiAction(button.name, () => commandCompatibilityRuntime('scriptButton', [button.id], true), {})}>{button.name}</button>)}
                {activeQuickReplies.map((reply, index) => <span key={`${reply.set}:${reply.id}:${index}`}>
                    <button type="button" className="ttm-btn-secondary" title={reply.title || `${reply.set}.${reply.label}`} disabled={!canPlay || state.isGenerating || state.helperGenerationCount > 0} onClick={() => void runUiAction('执行快捷回复', () => commandCompatibilityRuntime('quickReply', [reply.set, reply.id], true), {})}>{reply.label || reply.title || '快捷回复'}</button>
                    {reply.menu.length > 0 && <QuickReplyMenu items={reply.menu} disabled={!canPlay || state.isGenerating || state.helperGenerationCount > 0} onExecute={path => void runUiAction('执行快捷回复菜单', () => commandCompatibilityRuntime('quickReplyContext', [reply.set, reply.id, path], true), {})} />}
                </span>)}
                </div>
            </section>}
            <div className="ttm-composer-quickbar" data-ti-area="more">{shellParts('more')}</div>
            {!isFree && toolsOpen && canPlay && <div className="ttm-composer-quickbar ttm-native-composer-actions"><PluginButtons onOpen={() => setToolsOpen(false)} /></div>}

            {!isFree && <MvuRepairPanel disabled={state.isGenerating || state.helperGenerationCount > 0 || activeMessages.at(-1)?.role !== 'assistant'} />}
            </div>
            <div className="ttm-composer-row" data-ti-shell="composer-row">
                {reading && <button type="button" className="ttm-icon-btn ttm-expand-composer" aria-label="展开会话操作" title="展开会话操作" onClick={restoreReadingControls}><Icon name="more" /></button>}
                <div className="ttm-skin-input-tools" data-ti-area="input-before">{shellParts('input-before')}</div>
                <ChatComposerInput
                    id="tipsy-chat-composer"
                    data-guide="play"
                    className="ttm-composer-input"
                    data-ti-part="input"
                    data-ti-type="composer"
                    rows={reading || compactLayout ? 1 : 2}
                    aria-label="对话内容"
                    placeholder={isFree ? '发消息给 AI…' : textOf(skin, 'input')}
                    value={draft}
                    onChange={event => onDraftChange(event.target.value)}
                    onKeyDown={(e) => {
                        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !e.nativeEvent.isComposing) {
                            e.preventDefault();
                            void onSend();
                        }
                    }}
                />
                <div className="ttm-skin-input-tools" data-ti-area="input-after">{shellParts('input-after')}</div>
                {state.isGenerating || state.helperGenerationCount > 0 ? (
                    <button type="button" data-ti-part="stop" className="ttm-btn-danger ttm-composer-submit" aria-label="停止生成" title="停止生成" onClick={() => { stopActiveGeneration(); stopHelperGeneration(undefined, undefined, true); }}>
                        <ShellArt skin={skin} id="stop" fallback={<Icon name="stop" width={18} height={18} />} /><span>{textOf(skin, 'stop')}</span>
                    </button>
                ) : (
                    <button type="button" data-ti-part="send" className="ttm-btn-primary ttm-composer-submit" aria-label={isFree && needsConnection ? '连接模型' : '发送消息'} title={isFree && needsConnection ? '连接模型' : canPlay ? '发送消息' : '故事正在准备'} disabled={!canPlay || !draft.trim()} onClick={() => void onSend()}>
                        <ShellArt skin={skin} id="send" fallback={<Icon name="send" width={20} height={20} />} /><span>{isFree && needsConnection ? '连接模型' : textOf(skin, 'send')}</span>
                    </button>
                )}
            </div>
            {!isFree && <div className="ttm-composer-hint" data-ti-shell="composer-hint"><span>{textOf(skin, 'hint')}</span><span>Ctrl / ⌘ + Enter 发送</span></div>}
        </footer>
    );
}

import type { ReactNode } from 'react';
import { storyIdentity } from '../core/story-identity';
import { SlotMount } from '../plugins/slot-registry';
import { updateCharacterDocument, type WorkspaceState } from '../store/workspace-store';
import { textOf, type Appearance } from '../theme/appearance-model';
import { ShellArt } from '../theme/appearance-shell';
import type { NormalizedCharacterCard, NormalizedLorebook, NormalizedPreset } from '../types';
import { AssetMoreButton, type MenuPoint } from './AssetActionMenu';
import { CharacterDetailsPanel } from './AssetInspectorPanel';
import { CharacterLibraryItem } from './CharacterLibraryItem';
import type { DeleteAssetConfirmation, DeleteAssetTarget } from './DeleteAssetDialog';
import { Icon } from './Icon';
import type { useLibraryFilters } from './useLibraryFilters';
import { runStoreAction } from './workspace-ui-actions';

interface WorkspaceLibraryProps {
    skin?: Appearance;
    state: WorkspaceState;
    mobileActive: boolean;
    compactLayout: boolean;
    sidebarParts: ReactNode;
    hasCustomSidebarParts: boolean;
    activeCharacter: NormalizedCharacterCard;
    activeStoryIdentity: ReturnType<typeof storyIdentity>;
    activePreset: NormalizedPreset;
    activeLorebooks: NormalizedLorebook[];
    isFree: boolean;
    hasStory: boolean;
    importing: boolean;
    clearing: boolean;
    switchingCharacter: string | null;
    filters: ReturnType<typeof useLibraryFilters>;
    deleteSelection: Set<string> | null;
    selectedCards: NormalizedCharacterCard[];
    deletionBlocked: boolean;
    assetMenu: DeleteAssetTarget | null;
    openAssetMenu: (target: DeleteAssetTarget, point?: MenuPoint) => void;
    openAsset: (kind: 'presets' | 'lorebook', anchor: HTMLElement) => void;
    onImport: () => Promise<void>;
    onImportStory: (anchor: HTMLElement) => void;
    onReplayGuide: () => void;
    onEnterCharacter: (id: string) => Promise<void>;
    onToggleDeleteSelection: (id: string) => void;
    onExitDeleteSelection: () => void;
    onConfirmDelete: (target: DeleteAssetConfirmation) => void;
}

export function WorkspaceLibrary({
    skin, state, mobileActive, compactLayout, sidebarParts, hasCustomSidebarParts, activeCharacter,
    activeStoryIdentity, activePreset, activeLorebooks, isFree, hasStory, importing, clearing,
    switchingCharacter, filters, deleteSelection, selectedCards, deletionBlocked, assetMenu, openAssetMenu,
    openAsset, onImport, onImportStory, onReplayGuide, onEnterCharacter, onToggleDeleteSelection,
    onExitDeleteSelection, onConfirmDelete,
}: WorkspaceLibraryProps) {
    const { characterSearch, setCharacterSearch, characterSearchRef, characterTag, setCharacterTag, characterSort, setCharacterSort,
        setCharacterPage, denseLibrary, setDenseLibrary, filteredCharacters, characterTags, pageCount, currentCharacterPage, visibleCharacters } = filters;
    return (
        <aside aria-label="故事馆藏" data-ti-shell="library" className={`ttm-sidebar ${mobileActive ? 'is-mobile-active' : ''}`}>
            <div className="ttm-sidebar-scroll">
            <section className="ttm-panel-block">
                <h2 className="ttm-library-title" data-ti-type="heading"><span title={textOf(skin, 'library')}>{textOf(skin, 'library')}</span><small aria-label={`${state.characters.length} 个故事`}>{state.characters.length}</small></h2>
                <div className="ttm-library-imports" role="group" aria-label="导入到馆藏">
                    <button
                        type="button"
                        className="ttm-mini-btn ttm-library-import-primary"
                        data-guide="import"
                        data-ti-part="import"
                        disabled={importing || clearing || state.isGenerating}
                        onClick={() => void onImport()}
                    >
                        <ShellArt skin={skin} id="import" fallback={<Icon name="plus" width={16} height={16} />} /><span>{importing ? '导入中…' : skin?.text.import ?? '导入素材'}</span>
                    </button>
                    <button type="button" className="ttm-mini-btn" data-guide="story-save" disabled={importing || clearing} onClick={event => onImportStory(event.currentTarget)}>
                        <Icon name="archive" width={16} height={16} /><span>导入存档</span>
                    </button>
                </div>
                <label className="ttm-search"><Icon name="search" width={17} height={17} /><input ref={characterSearchRef} type="search" aria-label="搜索故事" placeholder="搜索故事、作者或标签" value={characterSearch} onChange={event => { setCharacterSearch(event.target.value); setCharacterPage(0); }} /></label>
                <div className="ttm-library-controls">
                    <select aria-label="故事排序" value={characterSort} onChange={event => { setCharacterSort(event.target.value); setCharacterPage(0); }}><option value="original">导入顺序</option><option value="name">名称排序</option></select>
                    <button type="button" className="ttm-mini-btn" aria-pressed={denseLibrary ?? state.characters.length > 12} onClick={() => setDenseLibrary(!(denseLibrary ?? state.characters.length > 12))}>{(denseLibrary ?? state.characters.length > 12) ? '舒展显示' : '紧凑显示'}</button>
                    {characterTags.length > 0 && <select aria-label="故事标签" value={characterTag} onChange={event => { setCharacterTag(event.target.value); setCharacterPage(0); }}><option value="">全部标签</option>{characterTags.map(tag => <option key={tag} value={tag}>{tag}</option>)}</select>}
                </div>
                <div className={`ttm-char-list ${(denseLibrary ?? state.characters.length > 12) ? 'is-dense' : ''}`}>
                    {visibleCharacters.map(char => <CharacterLibraryItem key={char.id} character={char}
                        active={char.id === activeCharacter.id} switching={switchingCharacter === char.id}
                        disabled={deletionBlocked}
                        selected={deleteSelection?.has(char.id)}
                        menuOpen={assetMenu?.kind === 'character' && assetMenu.id === char.id}
                        onActivate={() => { if (deleteSelection) onToggleDeleteSelection(char.id); else void onEnterCharacter(char.id); }}
                        onMenu={(anchor, point) => openAssetMenu({ kind: 'character', id: char.id, name: storyIdentity(char).name, anchor }, point)} />)}
                </div>
                {pageCount > 1 && <nav className="ttm-library-pages" aria-label="故事分页"><button className="ttm-icon-btn" type="button" aria-label="上一页故事" disabled={currentCharacterPage === 0} onClick={() => setCharacterPage(currentCharacterPage - 1)}><Icon name="chevron" style={{ transform: 'rotate(180deg)' }} /></button><label><select aria-label="故事页码" value={currentCharacterPage} onChange={event => setCharacterPage(Number(event.target.value))}>{Array.from({ length: pageCount }, (_, page) => <option key={page} value={page}>{page + 1} / {pageCount}</option>)}</select></label><button className="ttm-icon-btn" type="button" aria-label="下一页故事" disabled={currentCharacterPage === pageCount - 1} onClick={() => setCharacterPage(currentCharacterPage + 1)}><Icon name="chevron" /></button></nav>}
                {!filteredCharacters.length && <div className="ttm-empty-search"><p>{state.characters.length ? '没有找到这个故事' : '馆藏还是空的，导入角色卡后会显示在这里。'}</p>{state.characters.length ? <button type="button" className="ttm-mini-btn" onClick={() => { setCharacterSearch(''); setCharacterTag(''); setCharacterPage(0); }}>清除筛选</button> : <button type="button" className="ttm-mini-btn" onClick={onReplayGuide}>查看使用引导</button>}</div>}
            </section>

            {!isFree && <nav className="ttm-library-shortcuts" aria-label="故事设定">
                <button type="button" aria-haspopup="dialog" onClick={event => openAsset('presets', event.currentTarget)}><Icon name="settings" width={17} height={17} /><span>预设明细<small>{activePreset.name}</small></span><Icon name="chevron" width={14} height={14} /></button>
                <button type="button" aria-haspopup="dialog" onClick={event => openAsset('lorebook', event.currentTarget)}><Icon name="book" width={17} height={17} /><span>世界书<small>{activeLorebooks.length} 本已启用</small></span><Icon name="chevron" width={14} height={14} /></button>
            </nav>}
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
            <div className={`ttm-sidebar-bottom${deleteSelection ? ' is-selecting' : ''}`}>
                {deleteSelection ? <div className="ttm-library-selection" role="group" aria-label="删除角色卡">
                    <span role="status">已选 {selectedCards.length} 张</span>
                    <button type="button" className="ttm-mini-btn" onClick={onExitDeleteSelection}>退出多选</button>
                    <button type="button" className="ttm-mini-btn ttm-library-delete" aria-haspopup="dialog" disabled={deletionBlocked || !selectedCards.length}
                        onClick={event => onConfirmDelete({ kind: 'characters', anchor: event.currentTarget, cards: selectedCards.map(card => ({ id: card.id, name: storyIdentity(card).name })) })}>
                        <Icon name="trash" width={16} height={16} />删除所选
                    </button>
                </div> : <div className={`ttm-sidebar-bottom-actions${compactLayout && hasCustomSidebarParts ? ' has-custom-parts' : ''}`} data-ti-area="sidebar">{sidebarParts}</div>}
            </div>
        </aside>
    );
}

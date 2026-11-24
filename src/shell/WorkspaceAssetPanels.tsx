import { useMemo, useState } from 'react';
import {
    getActiveCharacter,
    getAvailableWorldbooks,
    getCharacterWorldbooks,
    selectPreset,
    setCharacterWorldbookBinding,
    setGlobalWorldbookEnabled,
    setStatusBanner,
    updateLorebookEntry,
    updatePresetPrompt,
    type WorkspaceState,
} from '../store/workspace-store';
import type { NormalizedLorebook, NormalizedPreset } from '../types';
import { AssetMoreButton } from './AssetActionMenu';
import { PresetEntriesPanel } from './AssetInspectorPanel';
import type { DeleteAssetTarget } from './DeleteAssetDialog';
import { Icon } from './Icon';
import { WorldbookEntriesPanel, worldbookPositions } from './WorldbookEntriesPanel';
import { runStoreAction } from './workspace-ui-actions';

interface AssetPanelProps {
    state: WorkspaceState;
    assetMenu: DeleteAssetTarget | null;
    openAssetMenu: (target: DeleteAssetTarget) => void;
}

export function WorkspacePresetPanel({ state, assetMenu, openAssetMenu, activePreset, importing, onImport }: AssetPanelProps & {
    activePreset: NormalizedPreset;
    importing: boolean;
    onImport: () => Promise<void>;
}) {
    const activeCharacter = getActiveCharacter(state);
    const remembersCharacter = state.sessionKind === 'character' && Boolean(activeCharacter.id);
    return (
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
            {remembersCharacter && (
                <p className="ttm-asset-memory-note">
                    已按角色「{activeCharacter.name}」记住当前预设，切换角色后自动恢复。
                </p>
            )}
            {!activePreset.id && <div className="ttm-empty-search"><p>当前未使用预设。角色卡、世界书与聊天历史仍会正常组装，不额外添加平台叙事指令。可导入作者推荐的预设，再在上方选用。</p><button type="button" className="ttm-btn-secondary" disabled={importing} onClick={() => void onImport()}>导入预设 JSON</button></div>}
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
}

export function WorkspaceWorldbookPanel({
    state, assetMenu, openAssetMenu, activeLorebooks, setLorebookHitsOpen, importing, onImportWorldbook,
}: AssetPanelProps & {
    activeLorebooks: NormalizedLorebook[];
    lorebookHitsOpen: boolean;
    setLorebookHitsOpen: (open: boolean) => void;
    importing: boolean;
    onImportWorldbook: () => Promise<void>;
}) {
    const promptInfo = state.lastAssembledPrompt;
    const books = getAvailableWorldbooks(state);
    const disabled = state.isGenerating || state.helperGenerationCount > 0;
    const activeCharacter = getActiveCharacter(state);
    const hasCharacter = state.sessionKind === 'character' && Boolean(activeCharacter.id);
    const charBinding = hasCharacter ? getCharacterWorldbooks(activeCharacter, state) : null;
    const embeddedBook = hasCharacter ? (activeCharacter.characterBook ?? activeCharacter.embeddedLorebook) : null;

    const [activeTab, setActiveTab] = useState<'entries' | 'bindings' | 'activation'>('entries');
    const [bindingScope, setBindingScope] = useState<'character' | 'global'>(() => hasCharacter ? 'character' : 'global');
    const [bindingSearch, setBindingSearch] = useState('');
    const [bindingSelectedOnly, setBindingSelectedOnly] = useState(false);
    const [selectedBookId, setSelectedBookId] = useState(() => (
        activeLorebooks.length > 0 && books.length > activeLorebooks.length ? '__active__' : ''
    ));

    const switchTab = (tab: 'entries' | 'bindings' | 'activation') => {
        setActiveTab(tab);
        setLorebookHitsOpen(tab === 'activation');
    };

    const openBookEntries = (bookId: string) => {
        setSelectedBookId(bookId);
        switchTab('entries');
    };

    const embeddedOwnerByBookId = useMemo(() => {
        const owners = new Map<string, { id: string; name: string }>();
        for (const card of state.characters) {
            for (const book of [card.characterBook, card.embeddedLorebook]) {
                if (book?.id && !owners.has(book.id)) owners.set(book.id, { id: card.id, name: card.name });
            }
        }
        return owners;
    }, [state.characters]);

    const resolveBookByName = (name: string) => (
        embeddedBook?.name === name ? embeddedBook : books.find(book => book.name === name)
    );

    const globalBookSet = useMemo(() => new Set(state.activeLorebookIds), [state.activeLorebookIds]);
    const globalBookNames = useMemo(
        () => new Set(books.filter(book => globalBookSet.has(book.id)).map(book => book.name)),
        [books, globalBookSet],
    );
    const charBoundCount = charBinding ? (charBinding.primary ? 1 : 0) + charBinding.additional.length : 0;
    const effectiveScope = hasCharacter ? bindingScope : 'global';

    const toggleCharacterAdditional = (bookName: string, checked: boolean) => {
        if (!hasCharacter || !charBinding) return;
        const nextAdditional = checked
            ? [...charBinding.additional, bookName]
            : charBinding.additional.filter(name => name !== bookName);
        runStoreAction('更新角色世界书绑定', () => setCharacterWorldbookBinding(activeCharacter.id, charBinding.primary, nextAdditional));
    };

    const activeSummaryItems = useMemo(() => {
        type SummaryItem = {
            key: string;
            name: string;
            book?: NormalizedLorebook;
            isPrimary: boolean;
            isAdditional: boolean;
            isGlobal: boolean;
            globalBookId?: string;
        };
        const items: SummaryItem[] = [];
        const byName = new Map<string, SummaryItem>();
        const pushChar = (name: string, isPrimary: boolean) => {
            if (!name || byName.has(name)) return;
            const item: SummaryItem = {
                key: isPrimary ? `primary:${name}` : `add:${name}`,
                name,
                book: resolveBookByName(name),
                isPrimary,
                isAdditional: !isPrimary,
                isGlobal: false,
            };
            byName.set(name, item);
            items.push(item);
        };
        if (hasCharacter && charBinding?.primary) pushChar(charBinding.primary, true);
        if (hasCharacter && charBinding) {
            for (const name of charBinding.additional) pushChar(name, false);
        }
        for (const book of books) {
            if (!globalBookSet.has(book.id)) continue;
            const existing = byName.get(book.name);
            if (existing) {
                existing.isGlobal = true;
                existing.globalBookId = book.id;
            } else {
                const item: SummaryItem = {
                    key: `global:${book.id}`,
                    name: book.name,
                    book,
                    isPrimary: false,
                    isAdditional: false,
                    isGlobal: true,
                    globalBookId: book.id,
                };
                byName.set(book.name, item);
                items.push(item);
            }
        }
        return items;
    }, [books, charBinding, embeddedBook, globalBookSet, hasCharacter]);

    const query = bindingSearch.trim().toLocaleLowerCase();

    const characterChoiceGroups = useMemo(() => {
        if (!hasCharacter || !charBinding) return null;
        const seen = new Set<string>();
        const currentEmbeddedOptions: NormalizedLorebook[] = [];
        const standaloneOptions: NormalizedLorebook[] = [];
        const otherEmbeddedOptions: Array<{ book: NormalizedLorebook; ownerName: string }> = [];

        if (embeddedBook) {
            seen.add(embeddedBook.name);
            currentEmbeddedOptions.push(embeddedBook);
        }
        for (const book of books) {
            if (seen.has(book.name)) continue;
            if (!embeddedOwnerByBookId.has(book.id)) {
                seen.add(book.name);
                standaloneOptions.push(book);
            }
        }
        for (const book of books) {
            if (seen.has(book.name)) continue;
            const owner = embeddedOwnerByBookId.get(book.id);
            if (owner) {
                seen.add(book.name);
                otherEmbeddedOptions.push({ book, ownerName: owner.name });
            }
        }

        const extraNames = [
            ...(charBinding.primary && !seen.has(charBinding.primary) ? [charBinding.primary] : []),
            ...charBinding.additional.filter(name => !seen.has(name)),
        ];

        const allRows = [
            ...currentEmbeddedOptions.map(book => ({
                name: book.name,
                book,
                sourceLabel: '当前角色内嵌',
                isOtherCard: false,
            })),
            ...standaloneOptions.map(book => ({
                name: book.name,
                book,
                sourceLabel: '独立世界书',
                isOtherCard: false,
            })),
            ...extraNames.map(name => ({
                name,
                book: undefined as NormalizedLorebook | undefined,
                sourceLabel: '未导入',
                isOtherCard: false,
            })),
            ...otherEmbeddedOptions.map(({ book, ownerName }) => ({
                name: book.name,
                book,
                sourceLabel: `来自「${ownerName}」`,
                isOtherCard: true,
            })),
        ];

        const filtered = allRows.filter(row => {
            const isBound = charBinding.primary === row.name || charBinding.additional.includes(row.name);
            if (bindingSelectedOnly && !isBound) return false;
            if (!query) return true;
            return row.name.toLocaleLowerCase().includes(query) || row.sourceLabel.toLocaleLowerCase().includes(query);
        });

        const primaryRows = filtered.filter(row => !row.isOtherCard || charBinding.primary === row.name || charBinding.additional.includes(row.name));
        const otherRows = filtered.filter(row => row.isOtherCard && charBinding.primary !== row.name && !charBinding.additional.includes(row.name));

        return { currentEmbeddedOptions, standaloneOptions, otherEmbeddedOptions, extraNames, primaryRows, otherRows };
    }, [books, charBinding, embeddedBook, embeddedOwnerByBookId, hasCharacter, query, bindingSelectedOnly]);

    const globalBookGroups = useMemo(() => {
        const describeBook = (book: NormalizedLorebook) => {
            const owner = embeddedOwnerByBookId.get(book.id);
            if (embeddedBook?.id === book.id) return { book, sourceLabel: '当前角色内嵌', isOtherCard: false };
            if (owner) return { book, sourceLabel: `来自「${owner.name}」`, isOtherCard: true };
            return { book, sourceLabel: '独立世界书', isOtherCard: false };
        };
        const ordered = [
            ...(embeddedBook && books.some(b => b.id === embeddedBook.id) ? [embeddedBook] : []),
            ...books.filter(book => book.id !== embeddedBook?.id && !embeddedOwnerByBookId.has(book.id)),
            ...books.filter(book => book.id !== embeddedBook?.id && embeddedOwnerByBookId.has(book.id)),
        ].map(describeBook);

        const filtered = ordered.filter(item => {
            const enabled = globalBookSet.has(item.book.id);
            if (bindingSelectedOnly && !enabled) return false;
            if (!query) return true;
            return item.book.name.toLocaleLowerCase().includes(query) || item.sourceLabel.toLocaleLowerCase().includes(query);
        });

        const primaryRows = filtered.filter(item => !item.isOtherCard || globalBookSet.has(item.book.id));
        const otherRows = filtered.filter(item => item.isOtherCard && !globalBookSet.has(item.book.id));
        return { primaryRows, otherRows };
    }, [books, embeddedBook, embeddedOwnerByBookId, globalBookSet, query, bindingSelectedOnly]);

    const renderCharacterBindingRow = (row: NonNullable<typeof characterChoiceGroups>['primaryRows'][number]) => {
        if (!charBinding) return null;
        const isPrimary = charBinding.primary === row.name;
        const checked = charBinding.additional.includes(row.name);
        const isGlobal = globalBookNames.has(row.name);
        const book = row.book;
        return (
            <div key={row.name} className={`ttm-binding-row${checked || isPrimary ? ' is-active' : ''}${isPrimary ? ' is-primary' : ''}`}>
                <label className="ttm-binding-row-check">
                    <input
                        type="checkbox"
                        checked={isPrimary || checked}
                        disabled={disabled || isPrimary}
                        onChange={event => toggleCharacterAdditional(row.name, event.target.checked)}
                    />
                    <span className="ttm-binding-row-name">{row.name}</span>
                    <span className="ttm-binding-row-meta">
                        {isPrimary && <small className="ttm-binding-badge is-accent">主书</small>}
                        {!isPrimary && isGlobal && <small className="ttm-binding-badge">通用</small>}
                        {row.sourceLabel !== '独立世界书' && <small className="ttm-binding-badge">{row.sourceLabel}</small>}
                    </span>
                </label>
                {book && (
                    <button
                        type="button"
                        className="ttm-binding-row-open"
                        aria-label={`管理「${row.name}」词条`}
                        title={`查看并管理「${row.name}」词条`}
                        onClick={() => openBookEntries(book.id)}
                    >
                        <span>{book.entries.length} 条</span>
                        <Icon name="chevron" width={13} height={13} />
                    </button>
                )}
            </div>
        );
    };

    const renderGlobalBindingRow = (item: typeof globalBookGroups['primaryRows'][number]) => {
        const checked = globalBookSet.has(item.book.id);
        return (
            <div key={item.book.id} className={`ttm-binding-row${checked ? ' is-active' : ''}`}>
                <label className="ttm-binding-row-check">
                    <input
                        type="checkbox"
                        checked={checked}
                        disabled={disabled}
                        onChange={event => runStoreAction('更新通用世界书', () => setGlobalWorldbookEnabled(item.book.id, event.target.checked))}
                    />
                    <span className="ttm-binding-row-name">{item.book.name}</span>
                    <span className="ttm-binding-row-meta">
                        {item.sourceLabel !== '独立世界书' && <small className="ttm-binding-badge">{item.sourceLabel}</small>}
                    </span>
                </label>
                <button
                    type="button"
                    className="ttm-binding-row-open"
                    aria-label={`管理「${item.book.name}」词条`}
                    title={`查看并管理「${item.book.name}」词条`}
                    onClick={() => openBookEntries(item.book.id)}
                >
                    <span>{item.book.entries.length} 条</span>
                    <Icon name="chevron" width={13} height={13} />
                </button>
            </div>
        );
    };

    return <section className="ttm-asset-workspace">
        <div className="ttm-worldbook-nav">
            <div className="ttm-worldbook-tabs" role="tablist" aria-label="世界书功能视图">
                <button
                    type="button"
                    role="tab"
                    aria-selected={activeTab === 'entries'}
                    className={`ttm-chip-btn${activeTab === 'entries' ? ' is-active' : ''}`}
                    onClick={() => switchTab('entries')}
                >
                    词条开关
                </button>
                <button
                    type="button"
                    role="tab"
                    aria-selected={activeTab === 'bindings'}
                    className={`ttm-chip-btn${activeTab === 'bindings' ? ' is-active' : ''}`}
                    onClick={() => switchTab('bindings')}
                >
                    绑定管理（{activeLorebooks.length}）
                </button>
                <button
                    type="button"
                    role="tab"
                    aria-selected={activeTab === 'activation'}
                    className={`ttm-chip-btn${activeTab === 'activation' ? ' is-active' : ''}`}
                    onClick={() => switchTab('activation')}
                >
                    本轮激活
                </button>
            </div>
            <button
                type="button"
                className="ttm-mini-btn ttm-worldbook-import-btn"
                disabled={importing || disabled}
                onClick={() => void onImportWorldbook()}
            >
                <Icon name="upload" width={14} height={14} />
                <span>{importing ? '导入中…' : '导入'}</span>
            </button>
        </div>

        {activeTab === 'entries' && (
            <WorldbookEntriesPanel books={books}
                bookId={selectedBookId}
                onBookIdChange={setSelectedBookId}
                importing={importing}
                onImportWorldbook={onImportWorldbook}
                menuBookId={assetMenu?.kind === 'worldbook' ? assetMenu.id : undefined}
                onMoreBook={(book, anchor) => openAssetMenu({ kind: 'worldbook', id: book.id, name: book.name, anchor })}
                activeBookIds={activeLorebooks.map(book => book.id)} globalBookIds={state.activeLorebookIds}
                disabled={disabled}
                onToggleBook={(bookId, enabled) => { runStoreAction('更新世界书', () => setGlobalWorldbookEnabled(bookId, enabled)); }}
                onToggle={(bookId, uid, enabled) => { runStoreAction('更新世界书', () => updateLorebookEntry(bookId, uid, { disabled: !enabled })); }} />
        )}

        {activeTab === 'bindings' && (
            <div className="ttm-worldbook-bindings-page">
                <div className="ttm-worldbook-bindings-summary">
                    <strong>当前已生效世界书（{activeLorebooks.length}）</strong>
                    <small>通用 {state.activeLorebookIds.length} 本{hasCharacter ? ` · 角色 ${charBoundCount} 本` : ''} · 点书名可直接管理词条</small>
                </div>

                {activeSummaryItems.length > 0 ? (
                    <div className="ttm-worldbook-active-strip" role="list" aria-label="当前生效或已绑定的世界书">
                        {activeSummaryItems.map(item => {
                            const focused = !!item.book && selectedBookId === item.book.id;
                            const roleTags = [
                                item.isPrimary ? '主书' : item.isAdditional ? '附加' : '',
                                item.isGlobal ? '通用' : '',
                            ].filter(Boolean).join(' · ');
                            const removeLabel = item.isPrimary
                                ? `取消「${item.name}」主世界书`
                                : item.isAdditional
                                    ? `取消绑定「${item.name}」`
                                    : `关闭通用世界书「${item.name}」`;
                            return (
                                <div key={item.key} role="listitem" className={`ttm-active-book-pill${focused ? ' is-focused' : ''}`}>
                                    <button
                                        type="button"
                                        className="ttm-active-book-pill-main"
                                        disabled={!item.book}
                                        title={item.book ? `管理「${item.name}」词条` : item.name}
                                        onClick={() => { if (item.book) openBookEntries(item.book.id); }}
                                    >
                                        <span>{item.name}</span>
                                        {roleTags && <small>{roleTags}</small>}
                                    </button>
                                    <button
                                        type="button"
                                        className="ttm-active-book-pill-remove"
                                        disabled={disabled}
                                        aria-label={removeLabel}
                                        title={removeLabel}
                                        onClick={() => {
                                            if (item.isPrimary && hasCharacter && charBinding) {
                                                runStoreAction('更新角色主世界书', () => setCharacterWorldbookBinding(activeCharacter.id, null, charBinding.additional));
                                            } else if (item.isAdditional) {
                                                toggleCharacterAdditional(item.name, false);
                                            } else if (item.globalBookId) {
                                                runStoreAction('更新通用世界书', () => setGlobalWorldbookEnabled(item.globalBookId!, false));
                                            }
                                        }}
                                    >
                                        <Icon name="close" width={12} height={12} />
                                    </button>
                                </div>
                            );
                        })}
                    </div>
                ) : (
                    <p className="ttm-binding-empty ttm-worldbook-strip-empty">当前未启用世界书，可在下方勾选绑定或点右上角「导入」。</p>
                )}

                <div className="ttm-worldbook-manager">
                    {hasCharacter && (
                        <div className="ttm-binding-tabs" role="tablist" aria-label="世界书绑定范围">
                            <button
                                type="button"
                                role="tab"
                                aria-selected={effectiveScope === 'character'}
                                className={`ttm-mini-btn${effectiveScope === 'character' ? ' is-active' : ''}`}
                                onClick={() => setBindingScope('character')}
                            >
                                当前角色专属（{charBoundCount}）
                            </button>
                            <button
                                type="button"
                                role="tab"
                                aria-selected={effectiveScope === 'global'}
                                className={`ttm-mini-btn${effectiveScope === 'global' ? ' is-active' : ''}`}
                                onClick={() => setBindingScope('global')}
                            >
                                全局通用（{state.activeLorebookIds.length}）
                            </button>
                        </div>
                    )}

                    {effectiveScope === 'character' && hasCharacter && charBinding && characterChoiceGroups && (
                        <div className="ttm-binding-section">
                            <p className="ttm-binding-hint">角色「{activeCharacter.name}」支持 1 本主书 + 多本附加书，切换角色后自动记住。</p>
                            <div className="ttm-binding-primary-row">
                                <label htmlFor="character-primary-worldbook">主世界书</label>
                                <select
                                    id="character-primary-worldbook"
                                    className="ttm-select-input"
                                    value={charBinding.primary ?? ''}
                                    disabled={disabled}
                                    onChange={event => {
                                        const nextPrimary = event.target.value || null;
                                        runStoreAction('更新角色主世界书', () => setCharacterWorldbookBinding(activeCharacter.id, nextPrimary, charBinding.additional));
                                    }}
                                >
                                    <option value="">不设主世界书</option>
                                    {characterChoiceGroups.currentEmbeddedOptions.length > 0 && (
                                        <optgroup label="当前角色内嵌">
                                            {characterChoiceGroups.currentEmbeddedOptions.map(book => (
                                                <option key={book.id} value={book.name}>{book.name}</option>
                                            ))}
                                        </optgroup>
                                    )}
                                    {characterChoiceGroups.standaloneOptions.length > 0 && (
                                        <optgroup label="独立世界书">
                                            {characterChoiceGroups.standaloneOptions.map(book => (
                                                <option key={book.id} value={book.name}>{book.name}</option>
                                            ))}
                                        </optgroup>
                                    )}
                                    {characterChoiceGroups.otherEmbeddedOptions.length > 0 && (
                                        <optgroup label="其他角色内嵌">
                                            {characterChoiceGroups.otherEmbeddedOptions.map(({ book, ownerName }) => (
                                                <option key={book.id} value={book.name}>{book.name}（来自 {ownerName}）</option>
                                            ))}
                                        </optgroup>
                                    )}
                                    {characterChoiceGroups.extraNames.map(name => (
                                        <option key={name} value={name}>{name}（未导入）</option>
                                    ))}
                                </select>
                            </div>

                            <div className="ttm-binding-search-row">
                                <input
                                    type="search"
                                    className="ttm-text-input"
                                    aria-label="筛选可绑定的世界书"
                                    placeholder="搜索附加世界书名称…"
                                    value={bindingSearch}
                                    onChange={event => setBindingSearch(event.target.value)}
                                />
                                <button
                                    type="button"
                                    className={`ttm-mini-btn${bindingSelectedOnly ? ' is-active' : ''}`}
                                    aria-pressed={bindingSelectedOnly}
                                    onClick={() => setBindingSelectedOnly(value => !value)}
                                >
                                    仅看已选（{charBoundCount}）
                                </button>
                            </div>

                            {(characterChoiceGroups.primaryRows.length > 0 || characterChoiceGroups.otherRows.length > 0) ? (
                                <>
                                    <div className="ttm-binding-list" role="group" aria-label="角色附加世界书多选">
                                        {characterChoiceGroups.primaryRows.map(renderCharacterBindingRow)}
                                        {(query || bindingSelectedOnly) && characterChoiceGroups.otherRows.map(renderCharacterBindingRow)}
                                    </div>
                                    {!query && !bindingSelectedOnly && characterChoiceGroups.otherRows.length > 0 && (
                                        <details className="ttm-binding-other-cards">
                                            <summary>其他角色内嵌世界书（{characterChoiceGroups.otherRows.length} 本）</summary>
                                            <div className="ttm-binding-list">
                                                {characterChoiceGroups.otherRows.map(renderCharacterBindingRow)}
                                            </div>
                                        </details>
                                    )}
                                </>
                            ) : (
                                <p className="ttm-binding-empty">{books.length ? '没有匹配的世界书。' : '暂无可绑定的世界书。'}</p>
                            )}
                        </div>
                    )}

                    {effectiveScope === 'global' && (
                        <div className="ttm-binding-section">
                            <p className="ttm-binding-hint">对所有角色卡持续生效，可同时开启多本。</p>
                            <div className="ttm-binding-search-row">
                                <input
                                    type="search"
                                    className="ttm-text-input"
                                    aria-label="筛选通用世界书"
                                    placeholder="搜索通用世界书名称…"
                                    value={bindingSearch}
                                    onChange={event => setBindingSearch(event.target.value)}
                                />
                                <button
                                    type="button"
                                    className={`ttm-mini-btn${bindingSelectedOnly ? ' is-active' : ''}`}
                                    aria-pressed={bindingSelectedOnly}
                                    onClick={() => setBindingSelectedOnly(value => !value)}
                                >
                                    仅看已启用（{state.activeLorebookIds.length}）
                                </button>
                            </div>
                            {(globalBookGroups.primaryRows.length > 0 || globalBookGroups.otherRows.length > 0) ? (
                                <>
                                    <div className="ttm-binding-list" role="group" aria-label="通用世界书多选">
                                        {globalBookGroups.primaryRows.map(renderGlobalBindingRow)}
                                        {(query || bindingSelectedOnly) && globalBookGroups.otherRows.map(renderGlobalBindingRow)}
                                    </div>
                                    {!query && !bindingSelectedOnly && globalBookGroups.otherRows.length > 0 && (
                                        <details className="ttm-binding-other-cards">
                                            <summary>其他角色内嵌世界书（{globalBookGroups.otherRows.length} 本）</summary>
                                            <div className="ttm-binding-list">
                                                {globalBookGroups.otherRows.map(renderGlobalBindingRow)}
                                            </div>
                                        </details>
                                    )}
                                </>
                            ) : (
                                <p className="ttm-binding-empty">{books.length ? '没有匹配的世界书。' : '尚未导入任何世界书。'}</p>
                            )}
                        </div>
                    )}
                </div>
            </div>
        )}

        {activeTab === 'activation' && (
            <div className="ttm-worldbook-activation-page">
                {promptInfo ? (
                    promptInfo.activatedLorebookEntries.length > 0 ? (
                        <>
                            <h3 className="ttm-sub-heading">本轮激活词条（{promptInfo.activatedLorebookEntries.length}）</h3>
                            {promptInfo.activatedLorebookEntries.map(hit => (
                                <div key={JSON.stringify([hit.world, (hit.entry || hit).uid])} className="ttm-hit-card">
                                    <strong>{(hit.entry || hit).comment}</strong>
                                    <p className="ttm-asset-help">插入位置：{worldbookPositions[(hit.entry || hit).position] ?? '其他位置'} · 匹配词：{(hit.matchedKeys || []).join('、') || '常驻或状态延续'}</p>
                                    <pre className="ttm-entry-body">{(hit.entry || hit).content}</pre>
                                </div>
                            ))}
                        </>
                    ) : (
                        <p className="ttm-binding-empty">本轮暂无激活的世界书词条。</p>
                    )
                ) : (
                    <p role="status">正在计算激活情况…</p>
                )}
            </div>
        )}
    </section>;
}

import { AssetMoreButton } from './AssetActionMenu';
import { useMemo, useState } from 'react';
import type { LorebookInsertPosition, NormalizedLorebook } from '../types';
import { EntryBrowser } from './EntryBrowser';
import { EntryStatus } from './EntryStatus';
import { Icon } from './Icon';
import { ExplainedValue, messageRoles, depthDescription, depthExplanation } from './EntryExplanations';

export const worldbookPositions: Record<LorebookInsertPosition, string> = {
    before_char: '角色定义之前', after_char: '角色定义之后',
    an_top: '作者注释之前', before_an: '作者注释之前',
    an_bottom: '作者注释之后', after_an: '作者注释之后',
    at_depth: '插入聊天记录', before_example: '对话示例之前', after_example: '对话示例之后', outlet: '指定输出位置',
};

export function WorldbookEntriesPanel({
    books, disabled, onToggle, activeBookIds, globalBookIds, onToggleBook, onMoreBook, menuBookId,
    bookId: controlledBookId, onBookIdChange, onImportWorldbook, importing,
}: {
    books: NormalizedLorebook[]; disabled: boolean; activeBookIds: string[]; globalBookIds: string[];
    onToggle: (bookId: string, uid: string | number, enabled: boolean) => void;
    onToggleBook: (bookId: string, enabled: boolean) => void;
    onMoreBook?: (book: NormalizedLorebook, anchor: HTMLElement) => void;
    menuBookId?: string;
    bookId?: string;
    onBookIdChange?: (bookId: string) => void;
    onImportWorldbook?: () => Promise<void>;
    importing?: boolean;
}) {
    const [internalBookId, setInternalBookId] = useState('');
    const rawBookId = controlledBookId ?? internalBookId;
    const setBookId = onBookIdChange ?? setInternalBookId;
    const activeBookSet = useMemo(() => new Set(activeBookIds), [activeBookIds]);
    const hasActiveFilterOption = activeBookIds.length > 0 && books.length > activeBookIds.length;
    const effectiveBookId = rawBookId === '__active__'
        ? (hasActiveFilterOption ? '__active__' : '')
        : (rawBookId && books.some(book => book.id === rawBookId) ? rawBookId : '');

    const rows = useMemo(() => books.flatMap(book => book.entries.map(entry => ({
        id: JSON.stringify([book.id, entry.uid]), name: entry.comment || entry.keys.join('、') || `未命名词条 ${entry.uid}`,
        content: entry.content, enabled: !entry.disabled, group: book.name, groupId: book.id, book, entry,
    }))), [books]);
    const rowById = useMemo(() => new Map(rows.map(row => [row.id, row])), [rows]);
    const visibleRows = useMemo(() => effectiveBookId === '__active__'
        ? rows.filter(row => activeBookSet.has(row.groupId))
        : rows, [effectiveBookId, rows, activeBookSet]);

    const selectedBook = effectiveBookId && effectiveBookId !== '__active__' ? books.find(book => book.id === effectiveBookId) : undefined;
    const isGlobal = selectedBook ? globalBookIds.includes(selectedBook.id) : false;
    const isActive = selectedBook ? activeBookSet.has(selectedBook.id) : false;
    const boundOnly = isActive && !isGlobal;
    const activeBooks = useMemo(() => books.filter(book => activeBookSet.has(book.id)), [books, activeBookSet]);
    const inactiveBooks = useMemo(() => books.filter(book => !activeBookSet.has(book.id)), [books, activeBookSet]);

    if (!books.length) {
        return (
            <div className="ttm-empty-search">
                <p>尚未导入任何世界书。可导入独立世界书 JSON，或导入自带内嵌世界书的角色卡。</p>
                {onImportWorldbook && (
                    <button type="button" className="ttm-btn-secondary" disabled={disabled || importing} onClick={() => void onImportWorldbook()}>
                        <Icon name="upload" width={16} height={16} />{importing ? '导入中…' : '导入世界书 JSON'}
                    </button>
                )}
            </div>
        );
    }

    return <EntryBrowser entries={visibleRows} label="世界书词条" storageKey="tipsy-entry-favorites:worldbooks" scope={selectedBook?.id ?? ''}
        toggleDisabled={disabled}
        onToggleEnabled={(entry, enabled) => { const row = rowById.get(entry.id); if (row) onToggle(row.book.id, row.entry.uid, enabled); }}
        filters={<div className="ttm-book-filter"><label>所属世界书<select className="ttm-select-input" aria-label="所属世界书" value={effectiveBookId} onChange={event => setBookId(event.target.value)}>
            {hasActiveFilterOption && <option value="__active__">当前生效（{activeBookIds.length} 本）</option>}
            <option value="">全部世界书（{books.length} 本）</option>
            {activeBooks.length > 0 && inactiveBooks.length > 0 ? <>
                <optgroup label="当前生效">
                    {activeBooks.map(book => <option key={book.id} value={book.id}>{book.name}（{book.entries.length} 项）</option>)}
                </optgroup>
                <optgroup label="未启用">
                    {inactiveBooks.map(book => <option key={book.id} value={book.id}>{book.name}（{book.entries.length} 项）</option>)}
                </optgroup>
            </> : books.map(book => <option key={book.id} value={book.id}>{book.name}（{book.entries.length} 项）</option>)}
        </select></label>
            {selectedBook && <label className="ttm-detail-enabled"><input type="checkbox" checked={isGlobal} disabled={disabled} onChange={event => onToggleBook(selectedBook.id, event.target.checked)} />通用启用{boundOnly ? '（当前角色已绑定）' : ''}</label>}
            {selectedBook && onMoreBook && <AssetMoreButton label="世界书更多操作" expanded={menuBookId === selectedBook.id} onOpen={anchor => onMoreBook(selectedBook, anchor)} />}
        </div>}
        renderDetail={item => {
            const { entry, book } = rowById.get(item.id)!;
            const role = messageRoles[entry.role ?? 'system'] ?? messageRoles.system;
            return <div className="ttm-selected-entry" key={item.id}>
                <div className="ttm-entry-detail-meta"><span>{book.name}</span><label className="ttm-detail-enabled"><input type="checkbox" role="switch" aria-label={`启用 ${item.name}`} checked={item.enabled} disabled={disabled} onChange={event => onToggle(book.id, entry.uid, event.target.checked)} /><EntryStatus enabled={item.enabled} /></label></div>
                {!activeBookIds.includes(book.id) && <p className="ttm-entry-notice">这本世界书当前未启用。查看内容不会将它加入本轮对话；可在“所属世界书”中选择它后开启。</p>}
                <pre className="ttm-entry-body" aria-label="词条正文">{entry.content || '（此词条暂无内容）'}</pre>
                <section className="ttm-entry-explanations" aria-label="作用方式"><h4>作用方式</h4>
                    <ExplainedValue label="触发方式" value={entry.constant ? '常驻候选' : '关键词匹配'} explanation={entry.constant ? '无需关键词命中即可参与激活，仍受启用状态、预算及其他筛选条件影响。' : '按关键词和世界书的匹配规则参与激活；命中后仍可能受到概率、预算或其他条件限制。'} />
                    <p className="ttm-entry-keywords">关键词：{entry.keys.join('、') || '未设置'}{entry.secondaryKeys.length > 0 && <><br />辅助关键词：{entry.secondaryKeys.join('、')}</>}</p>
                    <ExplainedValue label="消息类型" value={role.name} explanation={role.help} />
                    <ExplainedValue label="插入位置" value={worldbookPositions[entry.position] ?? '未识别的位置'} explanation={entry.position === 'at_depth' ? '按消息深度插入本次发送给模型的聊天记录。' : entry.position === 'outlet' ? `由模板在命名位置读取此内容。输出位置名称：${entry.outletName || '未设置'}。` : '激活后在提示词组装的对应区域加入内容；目录分页和筛选不会改变插入位置。'} />
                    {entry.position === 'at_depth' && <ExplainedValue label="消息深度" value={depthDescription(Math.max(0, entry.depth ?? 4))} explanation={depthExplanation} />}
                    <ExplainedValue label="插入顺序" value={String(entry.order)} explanation="用于决定组装提示词时的插入先后，目录页码不改变此值。" />
                </section>
                <details className="ttm-entry-advanced"><summary>高级信息</summary><dl><dt>原始编号</dt><dd>{entry.uid}</dd><dt>消息类型代码</dt><dd>{entry.role ?? 'system'}</dd><dt>插入位置代码</dt><dd>{entry.position}</dd></dl></details>
            </div>;
        }} />;
}

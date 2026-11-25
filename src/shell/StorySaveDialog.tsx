import { useEffect, useRef, useState } from 'react';
import { pickNativeAsset, pickNativeStorySave, saveExport } from '../core/platform-files';
import { isNativeRuntime } from '../core/native-runtime';
import { diagnosticErrorKind, diagnosticOperation } from '../core/diagnostics';
import { makeStorySave, readStorySave, storyResourceName, storySaveExcerpt } from '../core/story-save';
import { countStoryRoutes, type StoryImport } from '../core/story-save-format';
import { getActivePreset, getAvailableWorldbooks, importStoryCharacter, importStorySave, readStoryForExport, storySaveDuplicate, workspaceStore } from '../store/workspace-store';
import { activePath } from '../store/chat-tree';
import { hostMessageHidden } from '../compatibility/chat-message-codec';
import { readingSwipeId, writeReadingBookmark } from './reading-bookmark';
import { AnchoredDialog } from './AnchoredDialog';
import { Icon } from './Icon';
import './story-save.css';

type Mode = 'import' | 'export';
type Preview = Awaited<ReturnType<typeof readStoryForExport>>;

export function StorySaveDialog({ anchor, mode, onClose, onOpened, onExported, sessions, startId }: {
    anchor: HTMLElement; mode: Mode; onClose: () => void; onOpened: () => void; onExported: () => void;
    sessions: { id: string; label: string }[]; startId: string;
}) {
    const cards = workspaceStore.useStore(state => state.characters);
    const books = workspaceStore.useStore(state => getAvailableWorldbooks(state));
    const presets = workspaceStore.useStore(state => state.presets);
    const bindings = workspaceStore.useStore(state => state.characterWorldbookBindings);
    const activeCharacterId = workspaceStore.useStore(state => state.activeCharacterId);
    const activePreset = workspaceStore.useStore(state => getActivePreset(state));
    const [data, setData] = useState<StoryImport>();
    const [fileName, setFileName] = useState('');
    const [characterId, setCharacterId] = useState('');
    const [duplicate, setDuplicate] = useState(false);
    const [exportId, setExportId] = useState(startId);
    const [includePlugins,setIncludePlugins]=useState(true);
    const [preview, setPreview] = useState<Preview>();
    const [busy, setBusy] = useState<'reading' | 'saving' | 'card' | ''>('');
    const [error, setError] = useState('');
    const fileInput = useRef<HTMLInputElement>(null);
    const cardInput = useRef<HTMLInputElement>(null);
    const parse = useRef<AbortController>();
    useEffect(() => () => parse.current?.abort(), []);
    useEffect(() => {
        let live = true;
        setDuplicate(false);
        if (data && (data.kind === 'tipsy' || characterId)) void storySaveDuplicate(data, characterId)
            .then(value => { if (live) setDuplicate(value); }, failure => { if (live) setError(errorText(failure)); });
        return () => { live = false; };
    }, [data, characterId]);
    useEffect(() => {
        let live = true;
        setPreview(undefined);
        if (mode === 'export' && exportId) void readStoryForExport(exportId).then(value => { if (live) setPreview(value); }, failure => { if (live) setError(errorText(failure)); });
        return () => { live = false; };
    }, [exportId, mode]);

    const read = async (file: File) => {
        const controller = new AbortController(); parse.current?.abort(); parse.current = controller;
        setBusy('reading'); setError(''); setData(undefined); setFileName(file.name);
        const report = diagnosticOperation('导入', '打开故事存档');
        try {
            const result = await readStorySave(file, controller.signal);
            if (controller.signal.aborted) { report('取消'); return; }
            report('成功', { stage: '读取并解析存档' });
            if (result.kind === 'tavern') setCharacterId(cards.find(card => card.name.trim().toLowerCase() === result.characterName.trim().toLowerCase())?.id ?? '');
            setData(result);
        } catch (failure) {
            report(controller.signal.aborted ? '取消' : '失败', { stage: '读取并解析存档', code: diagnosticErrorKind(failure) });
            if (!controller.signal.aborted) setError(errorText(failure));
        }
        finally { if (parse.current === controller && !controller.signal.aborted) setBusy(''); }
    };
    const choose = async () => {
        if (!isNativeRuntime()) { fileInput.current?.click(); return; }
        try { const file = await pickNativeStorySave(); if (file) await read(file); }
        catch (failure) { setError(errorText(failure)); }
    };
    const addCard = async (file: File) => {
        setBusy('card'); setError('');
        try {
            setCharacterId(await importStoryCharacter(file));
        } catch (failure) { setError(errorText(failure)); }
        finally { setBusy(''); }
    };
    const chooseCard = async () => {
        if (!isNativeRuntime()) { cardInput.current?.click(); return; }
        try { const file = await pickNativeAsset(); if (file) await addCard(file); }
        catch (failure) { setError(errorText(failure)); }
    };
    const open = async () => {
        if (!data) return;
        setBusy('saving'); setError('');
        const report = diagnosticOperation('导入', '导入故事存档');
        try {
            await importStorySave(data, characterId, duplicate, chat => {
                const last = activePath(chat.messages, chat.activeLeafId).filter(node => !hostMessageHidden(node, chat.continuation?.chatMetadata)).at(-1);
                if (last) writeReadingBookmark(chat.id, { messageId: last.id, swipeId: readingSwipeId(last), offset: 0 });
            });
            report('成功', { stage: '导入并打开存档' });
            onOpened();
        } catch (failure) {
            report('失败', { stage: '导入并打开存档', code: diagnosticErrorKind(failure) });
            setError(errorText(failure));
        }
        finally { setBusy(''); }
    };
    const exportFile = async () => {
        setBusy('saving'); setError('');
        try {
            const latest = await readStoryForExport(exportId);
            const { blob, name } = await makeStorySave(latest.chat, latest.character,includePlugins);
            if (await saveExport(blob, name)) onExported();
        } catch (failure) { setError(errorText(failure)); }
        finally { setBusy(''); }
    };
    const resource = mode === 'export' ? preview : data?.kind === 'tipsy' ? data : undefined;
    const source = resource?.chat.continuation;
    const sameName = (name: string, catalog: { name: string }[]) => catalog.some(item => storyResourceName(item.name) === storyResourceName(name));
    const collisions = data?.kind === 'tipsy' ? [
        ...(sameName(data.character.name, cards) ? [`角色：${data.character.name}`] : []),
        ...(source?.inUsePreset?.id && sameName(source.inUsePreset.name, presets) ? [`预设：${source.inUsePreset.name}`] : []),
        ...(source?.worldbooks ?? []).filter(book => sameName(book.name, books)).map(book => `世界书：${book.name}`),
    ] : [];
    const target = cards.find(card => card.id === characterId);
    const binding = target && bindings[target.id];
    const required = binding ? [binding.primary, ...binding.additional] : [typeof target?.primaryWorldbook === 'string' ? target.primaryWorldbook : null, ...target?.additionalWorldbooks ?? []];
    const missing = [...new Set(required)].filter((name): name is string => !!name && !books.some(book => book.name === name));
    const last = resource ? storySaveExcerpt(resource.chat) : data?.kind === 'tavern' ? storySaveExcerpt({ messages: data.messages, activeLeafId: data.messages.at(-1)!.id }) : '';

    return <AnchoredDialog compact fitContent className="ttm-story-save-dialog" title={mode === 'import' ? '导入故事存档' : '导出故事存档'}
        anchor={anchor} onClose={onClose} closeDisabled={busy === 'saving' || busy === 'card'}>
        <div className="ttm-story-save">
            {mode === 'import' ? <>
                <input ref={fileInput} type="file" accept=".jsonl,.tipsy-story" hidden onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void read(file); }} />
                <input ref={cardInput} type="file" accept=".png,.json" hidden onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void addCard(file); }} />
                <div className="ttm-story-save-file">
                    <button type="button" className={data ? 'ttm-btn-secondary' : 'ttm-btn-primary'} disabled={!!busy} onClick={() => void choose()}><Icon name="upload" width={16} height={16} />{data ? '换一个文件' : '选择存档文件'}</button>
                    <span>{fileName || '酒馆 .jsonl 或 TipsyIsle .tipsy-story'}</span>
                </div>
                {busy === 'reading' && <p role="status">正在读取存档…</p>}
                {data?.kind === 'tavern' && <>
                    <div className="ttm-story-save-summary"><strong>{data.characterName || '酒馆单角色聊天'}</strong><span>{data.messages.length} 条消息 · {data.candidates} 个备选回复</span></div>
                    <div className="ttm-story-save-target">
                        <label htmlFor="story-save-character">目标角色卡</label>
                        <select id="story-save-character" className="ttm-select-input" value={characterId} disabled={!!busy} onChange={event => { setError(''); setCharacterId(event.target.value); }}>
                            <option value="">{cards.length ? '选择对应的角色卡' : '馆藏里还没有角色卡'}</option>
                            {cards.map(card => <option key={card.id} value={card.id}>{card.name}{card.id === activeCharacterId ? '（当前）' : ''}</option>)}
                        </select>
                        <button type="button" className="ttm-mini-btn" disabled={!!busy} onClick={() => void chooseCard()}><Icon name="plus" width={14} height={14} />{busy === 'card' ? '正在导入…' : '导入角色卡'}</button>
                    </div>
                    <ul className="ttm-story-save-notes">
                        <li>续写预设：{activePreset.name}。卡片要求的世界书或扩展需在馆藏中准备好。</li>
                        {missing.length > 0 && <li>馆藏缺少世界书：{missing.join('、')}。</li>}
                        <li>{data.variableReplies ? `读到 ${data.variableReplies} 个回复版本带有变量。` : '未读到逐回复变量。'}{Object.keys(data.variables).length ? '已读取会话变量。' : ''}</li>
                        <li>世界书计时会重新开始。{data.hasOtherMetadata ? '这个文件里的其他扩展状态不随聊天恢复。' : ''}</li>
                    </ul>
                </>}
            </> : <div className="ttm-story-save-target">
                <label htmlFor="story-save-session">选择会话</label>
                <label><input type="checkbox" checked={includePlugins} disabled={!!busy} onChange={event=>setIncludePlugins(event.target.checked)}/>包含插件插图与路线手记</label>
                <select id="story-save-session" className="ttm-select-input" value={exportId} disabled={!!busy} onChange={event => { setError(''); setExportId(event.target.value); }}>
                    <option value="">选择要导出的会话</option>
                    {sessions.map(session => <option key={session.id} value={session.id}>{session.label}</option>)}
                </select>
            </div>}
            {resource && <>
                <div className="ttm-story-save-summary"><strong>{resource.character.name}</strong><span>{resource.chat.messages.length} 条消息 · {countStoryRoutes(resource.chat.messages)} 条路线</span></div>
                <dl className="ttm-story-save-resources">
                    <dt>预设</dt><dd>{source?.inUsePreset?.id ? source.inUsePreset.name : '无'}</dd>
                    <dt>世界书</dt><dd>{source?.worldbooks?.map(book => book.name).join('、') || '无'}</dd>
                    <dt>故事人设</dt><dd>{source?.persona?.name || '无'}</dd>
                </dl>
                <p className="ttm-asset-help">模型连接、密钥、局域网配对、第三方插件及私有数据不随存档恢复。远程素材和外置脚本仍依赖原地址；独立图库不随包保存。</p>
                {collisions.length > 0 && <p className="ttm-asset-help">本机已有同名资源（{collisions.join('；')}）。内容相同会复用，内容不同会另存。</p>}
            </>}
            {last && <blockquote className="ttm-story-save-excerpt" aria-label="最后一条可见消息">{last}</blockquote>}
            {duplicate && <p role="status">这份文件已导入。你可以另存一份，不会覆盖原会话。</p>}
            {error && <p className="ttm-story-save-error" role="alert">{error}</p>}
            <div className="ttm-editor-actions ttm-story-save-actions">
                <button type="button" className="ttm-btn-secondary" disabled={busy === 'saving' || busy === 'card'} onClick={onClose}>取消</button>
                {mode === 'import' ? <button type="button" className="ttm-btn-primary" disabled={!!busy || !data || data.kind === 'tavern' && !characterId} onClick={() => void open()}>
                    {busy === 'saving' ? '正在保存…' : duplicate ? '另存为副本' : data?.kind === 'tipsy' ? '恢复并打开' : '导入并打开'}</button>
                    : <button type="button" className="ttm-btn-primary" disabled={!!busy || !preview} onClick={() => void exportFile()}><Icon name="download" width={16} height={16} />{busy === 'saving' ? '正在导出…' : '导出 .tipsy-story'}</button>}
            </div>
        </div>
    </AnchoredDialog>;
}

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

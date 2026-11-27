import { useRef, useState } from 'react';
import { getActiveCharacter, savePlayerPersona, clearCharacterPersona, workspaceStore } from '../store/workspace-store';
import { isNativeRuntime } from '../core/native-runtime';
import { pickNativeAvatar } from '../core/platform-files';
import { CharacterAvatar } from './CharacterAvatar';
import { storyIdentity } from '../core/story-identity';

export function PersonaSettings({ onSaved }: { onSaved: () => void }) {
    const state = workspaceStore.useStore();
    const character = getActiveCharacter(state);
    const local = state.personas.find(persona => persona.connections.some(link => link.type === 'character' && [character.id, `${character.id}.png`].includes(link.id)));
    const global = state.personas.find(persona => persona.is_default);
    const [scope, setScope] = useState<'global' | 'character'>(local ? 'character' : 'global');
    const [drafts, setDrafts] = useState(() => ({
        global: { name: global?.name ?? state.userName, image: global?.image ?? '', description: global?.description ?? '' },
        character: { name: (local ?? global)?.name ?? state.userName, image: (local ?? global)?.image ?? '', description: local?.description ?? '' },
    }));
    return <div className="ttm-persona-settings">
        <div className="ttm-settings-effective"><strong>当前生效</strong><span>{local ? '故事专属资料' : global ? '全局默认资料' : '尚未设置资料'}</span>
            <small>{local ? `「${storyIdentity(character).name}」优先使用故事专属资料，不与全局人设叠加。` : '称呼对应 {{user}}；未设置专属资料的故事沿用全局默认。'}</small>
        </div>
        <fieldset className="ttm-scope-options" disabled={state.isGenerating || state.helperGenerationCount > 0}><legend>编辑哪份资料</legend>
            <label><input type="radio" name="persona-scope" checked={scope === 'global'} onChange={() => setScope('global')} />全局默认</label>
            <label><input type="radio" name="persona-scope" disabled={!character.id} checked={scope === 'character'} onChange={() => setScope('character')} />当前故事专属</label>
        </fieldset>
        <PersonaEditor key={`${scope}:${character.id}`} initial={drafts[scope]} onDraft={value => setDrafts(previous => ({ ...previous, [scope]: value }))} disabled={state.isGenerating || state.helperGenerationCount > 0}
            saveLabel={scope === 'character' ? '保存此故事的资料' : '保存全局默认资料'}
            onSave={value => { savePlayerPersona(value, scope === 'character' ? character.id : undefined); onSaved(); }} />
        {scope === 'character' && local && <button type="button" className="ttm-btn-ghost" disabled={state.isGenerating || state.helperGenerationCount > 0}
            onClick={() => { clearCharacterPersona(character.id); onSaved(); }}>移除专属资料，改用全局默认</button>}
    </div>;
}

function PersonaEditor({ initial, disabled, onSave, onDraft, saveLabel }: { initial: { name: string; image: string; description: string }; disabled: boolean; onSave: (value: typeof initial) => void; onDraft: (value: typeof initial) => void; saveLabel: string }) {
    const value = initial;
    const setValue = (next: typeof initial | ((previous: typeof initial) => typeof initial)) => onDraft(typeof next === 'function' ? next(value) : next);
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(false);
    const fileInput = useRef<HTMLInputElement>(null);
    const loadAvatar = async (file: File) => {
        setLoading(true); setError('');
        try {
            const bitmap = await createImageBitmap(file);
            const size = Math.min(bitmap.width, bitmap.height);
            const canvas = document.createElement('canvas'); canvas.width = canvas.height = Math.min(size, 320);
            canvas.getContext('2d')!.drawImage(bitmap, (bitmap.width - size) / 2, (bitmap.height - size) / 2, size, size, 0, 0, canvas.width, canvas.height);
            bitmap.close();
            setValue(previous => ({ ...previous, image: canvas.toDataURL('image/webp', .88) }));
        } catch (cause) { setError(cause instanceof Error ? cause.message : '头像读取失败'); }
        finally { setLoading(false); }
    };
    const chooseAvatar = async () => {
        if (!isNativeRuntime()) { fileInput.current?.click(); return; }
        try { const file = await pickNativeAvatar(); if (file) await loadAvatar(file); }
        catch (cause) { setError(cause instanceof Error ? cause.message : '无法打开图片'); }
    };
    return <form className="ttm-persona-form" onSubmit={event => { event.preventDefault(); try { onSave(value); } catch (cause) { setError(String(cause)); } }}>
        <div className="ttm-persona-avatar-row"><CharacterAvatar name={value.name} avatar={value.image} fallback="user" /><div>
            <button type="button" className="ttm-btn-secondary" disabled={disabled || loading} onClick={() => void chooseAvatar()}>{loading ? '正在读取…' : '选择头像'}</button>
            {value.image && <button type="button" className="ttm-btn-ghost" disabled={disabled} onClick={() => setValue({ ...value, image: '' })}>移除头像</button>}
        </div></div>
        <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={event => { const file = event.target.files?.[0]; if (file) void loadAvatar(file); event.target.value = ''; }} />
        <label>称呼<input className="ttm-text-input" value={value.name} required disabled={disabled} autoComplete="nickname" onChange={event => setValue({ ...value, name: event.target.value })} /></label>
        <label>个人特征与补充设定<textarea className="ttm-textarea" rows={7} value={value.description} disabled={disabled} aria-describedby="persona-description-help" placeholder="例如：容貌俊秀，声音清朗，待人温和，习惯把衣着收拾得整洁。也可以留空，完全沿用故事设定。" onChange={event => setValue({ ...value, description: event.target.value })} /></label>
        <p id="persona-description-help" className="ttm-asset-help">这些特征会加入后续对话的提示词，在不改变故事既定身份、世界观和已发生事实的前提下自然融入。与故事明确设定冲突时，以故事设定为准；不会直接改写已有剧情或数值。</p>
        {error && <p role="alert">{error}</p>}
        <button className="ttm-btn-primary" type="submit" disabled={disabled || loading || !value.name.trim()}>{saveLabel}</button>
    </form>;
}

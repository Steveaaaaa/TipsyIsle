import { useEffect, useRef } from 'react';
import type { NormalizedCharacterCard } from '../types';
import { CharacterAvatar } from './CharacterAvatar';
import type { MenuPoint } from './AssetActionMenu';
import { storyIdentity } from '../core/story-identity';
import { Icon } from './Icon';

export function CharacterLibraryItem({ character, active, disabled, switching, menuOpen, selected, onActivate, onMenu }: {
    character: NormalizedCharacterCard; active: boolean; disabled: boolean; switching: boolean; menuOpen: boolean;
    selected?: boolean;
    onActivate: () => void; onMenu: (anchor: HTMLElement, point?: MenuPoint) => void;
}) {
    const { name } = storyIdentity(character);
    const hold = useRef<ReturnType<typeof setTimeout>>();
    const origin = useRef<MenuPoint>();
    const opened = useRef(false);
    const suppressClick = useRef(false);
    const cancelHold = () => { clearTimeout(hold.current); hold.current = undefined; origin.current = undefined; };
    const selecting = selected !== undefined;
    useEffect(() => { if (disabled || selecting) cancelHold(); return cancelHold; }, [disabled, selecting]);
    return <button type="button" className={`ttm-char-item${!selecting && active ? ' is-active' : ''}${selected ? ' is-selected' : ''}`}
        role={selecting ? 'checkbox' : undefined} aria-checked={selected} aria-pressed={selecting ? undefined : active} aria-label={selecting ? name : undefined} title={name}
        disabled={disabled} aria-haspopup={selecting ? undefined : 'menu'} aria-expanded={selecting ? undefined : menuOpen}
        onPointerDown={event => {
            cancelHold(); opened.current = false; suppressClick.current = false;
            if (selecting || event.pointerType === 'mouse' || !event.isPrimary) return;
            const anchor = event.currentTarget; const point = { x: event.clientX, y: event.clientY }; origin.current = point;
            hold.current = setTimeout(() => { hold.current = undefined; opened.current = true; suppressClick.current = true; onMenu(anchor, point); }, 500);
        }}
        onPointerMove={event => { if (origin.current && Math.hypot(event.clientX - origin.current.x, event.clientY - origin.current.y) > 10) cancelHold(); }}
        onPointerUp={cancelHold} onPointerCancel={cancelHold} onPointerLeave={cancelHold} onDragStart={event => event.preventDefault()}
        onContextMenu={event => {
            event.preventDefault(); event.stopPropagation(); cancelHold();
            if (selecting) return;
            suppressClick.current = true;
            if (!opened.current) { opened.current = true; onMenu(event.currentTarget, event.clientX || event.clientY ? { x: event.clientX, y: event.clientY } : undefined); }
        }}
        onKeyDown={event => {
            if (!selecting && (event.key === 'ContextMenu' || event.key === 'F10' && event.shiftKey)) {
                event.preventDefault(); event.stopPropagation(); opened.current = true; suppressClick.current = false; onMenu(event.currentTarget);
            } else if (event.key === 'Enter' || event.key === ' ') suppressClick.current = false;
        }}
        onClick={event => {
            if (!selecting && suppressClick.current) { event.preventDefault(); suppressClick.current = false; return; }
            onActivate();
        }}>
        {selecting && <span className="ttm-char-select-mark" aria-hidden="true">{selected && <Icon name="check" width={15} height={15} />}</span>}
        <CharacterAvatar name={name} avatar={character.avatar} />
        <div className="ttm-char-meta"><div className="ttm-char-name-row">
            <strong>{name}{switching ? ' · 正在切换…' : ''}</strong>
            {active && <span className="ttm-active-dot" aria-label="当前故事" />}
        </div><p>{character.creator ? `由 ${character.creator} 创作` : character.description.replace(/\{\{[^}]+\}\}/g, name).slice(0, 80) || '等待一段新的故事'}</p></div>
    </button>;
}

import { useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Icon, type IconName } from './Icon';
import './asset-actions.css';

export interface AssetMenuAction { label: string; icon: IconName; destructive?: boolean; disabled?: boolean; run: () => void; }
export interface MenuPoint { x: number; y: number; }

export function AssetMoreButton({ label, expanded = false, onOpen }: { label: string; expanded?: boolean; onOpen: (anchor: HTMLElement) => void }) {
    return <button type="button" className="ttm-icon-btn ttm-asset-more" aria-label={label} title={label} aria-haspopup="menu" aria-expanded={expanded}
        onClick={event => onOpen(event.currentTarget)}><Icon name="more" /></button>;
}

export function AssetActionMenu({ anchor, point, label, actions, onClose }: {
    anchor: HTMLElement; point?: MenuPoint; label: string; actions: AssetMenuAction[]; onClose: () => void;
}) {
    const ref = useRef<HTMLDivElement>(null);
    const closeRef = useRef(onClose); closeRef.current = onClose;
    const close = (restoreFocus: boolean) => {
        if (restoreFocus && anchor.isConnected) anchor.focus({ preventScroll: true });
        closeRef.current();
    };
    useLayoutEffect(() => {
        const menu = ref.current!;
        const rect = anchor.getBoundingClientRect();
        const width = menu.getBoundingClientRect().width;
        const height = menu.getBoundingClientRect().height;
        const x = point?.x ?? rect.right - width;
        let y = point?.y ?? rect.bottom + 6;
        if (y + height > innerHeight - 10) y = (point?.y ?? rect.top) - height - 6;
        menu.style.left = `${Math.max(10, Math.min(x, innerWidth - width - 10))}px`;
        menu.style.top = `${Math.max(10, Math.min(y, innerHeight - height - 10))}px`;
        (menu.querySelector<HTMLButtonElement>('button:not(:disabled)') ?? menu).focus({ preventScroll: true });
        const outside = (event: PointerEvent) => {
            if (!menu.contains(event.target as Node) && !anchor.contains(event.target as Node)) closeRef.current();
        };
        const escape = (event: KeyboardEvent) => {
            if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); }
        };
        const scroll = (event: Event) => { if (!menu.contains(event.target as Node)) closeRef.current(); };
        const resize = () => closeRef.current();
        const back = (event: Event) => { event.preventDefault(); close(true); };
        document.addEventListener('pointerdown', outside, true);
        document.addEventListener('keydown', escape, true);
        document.addEventListener('scroll', scroll, true);
        window.addEventListener('resize', resize);
        window.addEventListener('tipsy-menu-back', back);
        return () => {
            document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', escape, true);
            document.removeEventListener('scroll', scroll, true); window.removeEventListener('resize', resize); window.removeEventListener('tipsy-menu-back', back);
        };
    }, [anchor, point]);
    return createPortal(<div ref={ref} className="ttm-asset-menu" role="menu" tabIndex={-1} aria-label={label} onContextMenu={event => event.preventDefault()} onKeyDown={event => {
        if (event.key === 'Tab') { close(true); return; }
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const buttons = [...ref.current!.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
        const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const index = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
            : (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
        buttons[index]?.focus();
    }}>{actions.map((action, index) => <div key={action.label}>
        {action.destructive && index > 0 && <div className="ttm-asset-menu-divider" role="separator" />}
        <button type="button" role="menuitem" className={action.destructive ? 'is-destructive' : undefined} disabled={action.disabled}
            onClick={() => { close(true); action.run(); }}><Icon name={action.icon} width={17} height={17} /><span>{action.label}</span></button>
    </div>)}</div>, anchor.closest('dialog[open]') ?? document.body);
}

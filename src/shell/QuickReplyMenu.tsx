import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon';
import type { QuickReplyContextItem } from '../sandbox/quick-reply';

export function QuickReplyMenu({ items, disabled, onExecute }: { items: QuickReplyContextItem[]; disabled: boolean; onExecute(path: QuickReplyContextItem['path']): void }) {
    const trigger = useRef<HTMLButtonElement>(null);
    const menu = useRef<HTMLDivElement>(null);
    const [position, setPosition] = useState<{ left: number; bottom: number; maxHeight: number } | null>(null);
    const closeMenu = () => { setPosition(null); trigger.current?.focus(); };
    useEffect(() => {
        if (!position) return;
        menu.current?.querySelector('button')?.focus();
        const close = (event: MouseEvent) => { if (!menu.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setPosition(null); };
        const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); closeMenu(); } };
        const resize = () => setPosition(null);
        document.addEventListener('click', close); document.addEventListener('keydown', escape);
        window.addEventListener('resize', resize);
        return () => { document.removeEventListener('click', close); document.removeEventListener('keydown', escape); window.removeEventListener('resize', resize); };
    }, [position]);
    const renderItems = (values: QuickReplyContextItem[]) => values.map((item, index) => <div key={`${item.set}:${item.id}:${index}`} className="ttm-quick-reply-item">
        <button type="button" className="ttm-chip-btn" disabled={disabled} title={item.title || item.message}
            onClick={() => { closeMenu(); onExecute(item.path); }}>
            {item.label || item.title || item.set}
        </button>
        {item.children.length > 0 && <details>
            <summary>更多选项</summary>{renderItems(item.children)}
        </details>}
    </div>);
    return <><button ref={trigger} type="button" className="ttm-chip-btn" disabled={disabled} aria-label="快捷回复更多选项" aria-expanded={Boolean(position)} onClick={() => {
        if (position) { closeMenu(); return; }
        const rect = trigger.current!.getBoundingClientRect();
        setPosition({ left: Math.max(12, Math.min(rect.left, window.innerWidth - 292)), bottom: window.innerHeight - rect.top + 8, maxHeight: Math.max(80, Math.min(360, rect.top - 20)) });
    }}><Icon name="chevron" width={14} height={14} style={{ transform: 'rotate(90deg)' }} /></button>
    {position && createPortal(<div ref={menu} className="ttm-quick-reply-menu" aria-label="快捷回复选项" style={position}>{renderItems(items)}</div>, document.body)}</>;
}

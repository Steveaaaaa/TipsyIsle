import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { Icon } from './Icon';

const openDialogs: HTMLDialogElement[] = [];
export function topAppDialog(): HTMLDialogElement | undefined {
    for (let index = openDialogs.length - 1; index >= 0; index--) {
        const dialog = openDialogs[index]; if (dialog.isConnected && dialog.open) return dialog;
    }
}

export function AnchoredDialog({ title, anchor, onClose, children, compact = false, fitContent = false, closeDisabled = false, welcome = false, centered = false, className = '', surface = 'dialog' }: { title: string; anchor: HTMLElement; onClose: () => void; children: ReactNode; compact?: boolean; fitContent?: boolean; closeDisabled?: boolean; welcome?: boolean; centered?: boolean; className?: string; surface?: 'dialog' | 'sidebar' | 'fullscreen' }) {
    const ref = useRef<HTMLDialogElement>(null);
    const motion = useRef<Animation>();
    const closing = useRef(false);
    const close = () => {
        if (closing.current || closeDisabled) return;
        closing.current = true;
        const dialog = ref.current!;
        const current = getComputedStyle(dialog);
        const from = { opacity: current.opacity, transform: current.transform, filter: current.filter };
        motion.current?.cancel();
        dialog.classList.add('is-closing');
        const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
        motion.current = dialog.animate([from, { opacity: 0, transform: reduced ? 'none' : surface === 'sidebar' ? 'translateX(24px)' : 'translateY(8px) scale(.985)', filter: 'none' }], { duration: reduced ? 100 : 160, easing: 'ease-in', fill: 'forwards' });
        motion.current.onfinish = () => {
            dialog.close(); window.dispatchEvent(new Event('tipsy-dialog-change')); onClose(); if (anchor.isConnected) anchor.focus({ preventScroll: true });
        };
    };
    useLayoutEffect(() => {
        const dialog = ref.current!;
        const position = () => {
            if (surface !== 'dialog') {
                const width = surface === 'fullscreen' ? innerWidth : Math.min(480, innerWidth);
                Object.assign(dialog.style, { width: `${width}px`, height: `${innerHeight}px`, maxHeight: `${innerHeight}px`, left: `${innerWidth - width}px`, top: '0' });
                return;
            }
            const rect = anchor.getBoundingClientRect();
            const width = Math.min(compact ? 580 : centered ? 1160 : 1020, innerWidth - 32);
            const height = Math.min(compact ? 720 : 900, innerHeight - 32);
            const right = rect.right + 12;
            const left = innerWidth < 700 ? 16 : right + width <= innerWidth - 16 ? right : Math.max(16, rect.left - width - 12);
            dialog.style.width = `${width}px`;
            dialog.style.height = fitContent ? 'auto' : `${height}px`;
            dialog.style.maxHeight = `${height}px`;
            dialog.style.left = `${centered ? (innerWidth - width) / 2 : Math.min(left, innerWidth - width - 16)}px`;
            dialog.style.top = `${centered ? (innerHeight - height) / 2 : Math.max(16, Math.min(rect.top, innerHeight - height - 16))}px`;
        };
        position(); dialog.showModal(); openDialogs.push(dialog); window.dispatchEvent(new Event('tipsy-dialog-change'));
        const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
        const rect = anchor.getBoundingClientRect(), bounds = dialog.getBoundingClientRect();
        dialog.style.transformOrigin = anchor === document.body ? '50% 45%' : `${Math.max(0, Math.min(bounds.width, rect.left + rect.width / 2 - bounds.left))}px ${Math.max(0, Math.min(bounds.height, rect.top + rect.height / 2 - bounds.top))}px`;
        motion.current = dialog.animate(reduced ? [{ opacity: .5 }, { opacity: 1 }] : [
            { opacity: 0, transform: surface === 'sidebar' ? 'translateX(28px)' : 'translateY(20px) scale(.965)', filter: compact ? 'blur(3px)' : 'none' },
            { opacity: 1, transform: 'none', filter: 'none' },
        ], { duration: reduced ? 100 : welcome ? 520 : 360, easing: 'cubic-bezier(.16,1,.3,1)' });
        window.addEventListener('resize', position);
        return () => {
            motion.current?.cancel();
            window.removeEventListener('resize', position); dialog.close();
            const index = openDialogs.indexOf(dialog); if (index >= 0) openDialogs.splice(index, 1);
            window.dispatchEvent(new Event('tipsy-dialog-change'));
        };
    }, [anchor, surface]);
    return <dialog ref={ref} data-ti-shell={className === 'ttm-appearance-dialog' ? undefined : 'dialog'} data-dialog-surface={surface}
        className={`ttm-asset-dialog ${compact ? 'ttm-reader-dialog' : ''} ${className}`} aria-label={title}
        onCancel={event => { event.preventDefault(); close(); }}
        onKeyDown={event => { if (event.key === 'Escape') event.stopPropagation(); }}
        onClick={event => { if (event.target === event.currentTarget) { const r = event.currentTarget.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) close(); } }}>
        <header className="ttm-asset-dialog-heading"><h2>{title}</h2><button type="button" autoFocus className="ttm-icon-btn" disabled={closeDisabled} aria-label={`关闭${title}`} onClick={close}><Icon name="close" /></button></header>
        <div className="ttm-asset-dialog-content">{children}</div>
    </dialog>;
}

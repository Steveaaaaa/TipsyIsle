import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { MediaAction } from '../../../packages/plugin-sdk/index.js';
import { saveExport } from '../../core/platform-files';
import { themeEngineStore } from '../../theme/theme-engine';
import type { ChatMessageNode } from '../../types';
import { nativePluginStore } from './catalog';
import { latentFilm } from './latent-film';
import { loadMedia, mediaIdentity } from './media';
import { mountMediaSlot } from './prose-anchor';
import { dispatchMediaAction, projectMedia, type MediaProjection } from './reply-media';
import { openPluginMessageCommand } from './PluginCommands';
import { getSandboxMountedKeys, sandboxMediaStore } from './sandbox-media-bridge';
import './reply-media.css';

function useImage(owner: string, id?: string) {
    const [state, setState] = useState<{ id: string; url: string; blob: Blob; name: string }>();
    useEffect(() => {
        let live = true;
        let url = '';
        if (id) {
            void loadMedia(owner, id)
                .then(({ blob, handle }) => {
                    if (live && /^image\/(?:png|jpeg|webp)$/.test(blob.type)) {
                        url = URL.createObjectURL(blob);
                        setState({ id, url, blob, name: handle.name });
                    }
                })
                .catch(() => {});
        }
        return () => {
            live = false;
            if (url) URL.revokeObjectURL(url);
        };
    }, [owner, id]);
    return id && state?.id === id ? state : undefined;
}

function ApertureIcon({ size = 14, spinning = false }: { size?: number; spinning?: boolean }) {
    return (
        <svg className={spinning ? 'ti-aperture-spin' : undefined} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="9" />
            <path d="m14.31 8 5.74 9.94M9.69 8h11.48M7.38 12l5.74-9.94M9.69 16 3.95 6.06M14.31 16H2.83m13.79-4-5.74 9.94" />
        </svg>
    );
}

export function FilmLightbox({ slot, onClose }: { slot: MediaProjection; onClose: () => void }) {
    const { item } = slot;
    const owner = mediaIdentity(slot.plugin);
    const takes = item.takes ?? [];
    const index = takes.length ? Math.min(item.activeTake ?? 0, takes.length - 1) : 0;
    const media = useImage(owner, takes[index]?.id);
    const [pending, setPending] = useState(false);
    const [hudVisible, setHudVisible] = useState(true);

    const step = async (action: 'previous' | 'next') => {
        if (pending || takes.length < 2) return;
        setPending(true);
        try { await dispatchMediaAction(slot, action); } finally { setPending(false); }
    };

    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            if (event.key === 'Escape') onClose();
            else if (event.key === 'ArrowLeft') void step('previous');
            else if (event.key === 'ArrowRight') void step('next');
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    });

    const saveImage = async () => {
        if (!media || pending) return;
        setPending(true);
        try {
            const base = (media.name || item.label || 'lumina-frame').replace(/[\\/:*?"<>|]/g, '-');
            const ext = media.blob.type.split('/')[1] || 'webp';
            await saveExport(media.blob, /\.\w{1,6}$/.test(base) ? base : `${base}.${ext}`);
        } finally { setPending(false); }
    };

    const setStage = async () => {
        if (pending) return;
        setPending(true);
        try { await dispatchMediaAction(slot, 'stage'); } finally { setPending(false); }
    };

    const openDarkroom = () => {
        if (!item.commandId) return;
        const commandId = item.commandId;
        onClose();
        try { openPluginMessageCommand(slot.plugin.manifest.id, commandId, slot.node); } catch { /* Ignore if closed cleanly. */ }
    };

    const frameBadge = `FRAME ${String(index + 1).padStart(2, '0')} / ${String(Math.max(1, takes.length)).padStart(2, '0')}`;

    return createPortal(
        <div className="ti-film-lightbox" role="dialog" aria-modal="true" aria-label={item.label} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
            {media && <div className="ti-film-lightbox-ambient" aria-hidden="true" style={{ backgroundImage: `url(${media.url})` }} />}
            <div className="ti-film-lightbox-vignette" aria-hidden="true" />

            <header className="ti-film-lightbox-top" data-hidden={hudVisible ? 'false' : 'true'}>
                <div className="ti-film-lightbox-brand">
                    <span className="ti-film-lightbox-emblem"><ApertureIcon size={15} /></span>
                    <span className="ti-film-lightbox-series">浮光暗房</span>
                    <span className="ti-film-lightbox-counter">{frameBadge}</span>
                </div>
                <div className="ti-film-lightbox-actions">
                    {item.commandId && <button type="button" disabled={pending} onClick={openDarkroom}>精修</button>}
                    {slot.plugin.grants.includes('ui.stage') && media && <button type="button" disabled={pending} onClick={() => void setStage()}>设为舞台</button>}
                    {media && <button type="button" className="is-accent" disabled={pending} onClick={() => void saveImage()}>保存原图</button>}
                    <button type="button" className="is-close" onClick={onClose} aria-label="关闭大图">✕</button>
                </div>
            </header>

            <div className="ti-film-lightbox-stage" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
                {takes.length > 1 && hudVisible && (
                    <button type="button" className="ti-film-lightbox-nav is-prev" disabled={pending} onClick={() => void step('previous')} aria-label="上一帧">‹</button>
                )}
                {media ? (
                    <div className="ti-film-lightbox-frame">
                        <img src={media.url} alt={item.label} onClick={() => setHudVisible(v => !v)} />
                        <span className="ti-film-lightbox-corners" aria-hidden="true" />
                    </div>
                ) : (
                    <p className="ti-film-lightbox-loading"><ApertureIcon size={18} spinning /> <span>正在从银盐底片读取原图…</span></p>
                )}
                {takes.length > 1 && hudVisible && (
                    <button type="button" className="ti-film-lightbox-nav is-next" disabled={pending} onClick={() => void step('next')} aria-label="下一帧">›</button>
                )}
            </div>

            <footer className="ti-film-lightbox-bottom" data-hidden={hudVisible ? 'false' : 'true'}>
                <div className="ti-film-lightbox-placard">
                    <div className="ti-film-lightbox-meta">
                        <strong>{item.label}</strong>
                        {item.subtitle && <span>{item.subtitle}</span>}
                    </div>
                    {takes.length > 1 && (
                        <div className="ti-film-lightbox-pager">
                            <button type="button" disabled={pending} onClick={() => void step('previous')} aria-label="上一帧">‹</button>
                            <span>{index + 1} / {takes.length}</span>
                            <button type="button" disabled={pending} onClick={() => void step('next')} aria-label="下一帧">›</button>
                        </div>
                    )}
                </div>
            </footer>
        </div>,
        document.body,
    );
}

export function Darkroom({ slot }: { slot: MediaProjection }) {
    const { item } = slot;
    const owner = mediaIdentity(slot.plugin);
    const takes = item.takes ?? [];
    const index = takes.length ? Math.min(item.activeTake ?? 0, takes.length - 1) : 0;
    const media = useImage(owner, takes[index]?.id);
    const [imgLoaded, setImgLoaded] = useState(false);
    const [pending, setPending] = useState(false);
    const [fault, setFault] = useState('');
    const [lightbox, setLightbox] = useState(false);
    const [toolsOpen, setToolsOpen] = useState(false);
    const layout = themeEngineStore.useStore((state) => state.layoutMode);

    useEffect(() => {
        setImgLoaded(false);
    }, [media?.url]);

    const click = async (action: MediaAction['action'], customId?: string) => {
        if (pending) return;
        setPending(true);
        setToolsOpen(false);
        setFault('');
        try {
            await dispatchMediaAction(slot, action, customId);
        } catch (error) {
            setFault(error instanceof Error ? error.message : String(error));
        } finally {
            setPending(false);
        }
    };

    const runCommand = (commandId: string) => {
        setFault('');
        setToolsOpen(false);
        try {
            openPluginMessageCommand(slot.plugin.manifest.id, commandId, slot.node);
        } catch (error) {
            setFault(error instanceof Error ? error.message : String(error));
        }
    };

    const saveImage = async () => {
        if (!media || pending) return;
        setFault('');
        setToolsOpen(false);
        try {
            const base = (media.name || item.label || 'lumina-frame').replace(/[\\/:*?"<>|]/g, '-');
            const ext = media.blob.type.split('/')[1] || 'webp';
            await saveExport(media.blob, /\.\w{1,6}$/.test(base) ? base : `${base}.${ext}`);
        } catch (error) {
            setFault(error instanceof Error ? error.message : String(error));
        }
    };

    const button = (action: MediaAction['action'], label: string, title = label) => (
        <button
            type="button"
            disabled={pending}
            title={title}
            aria-label={title}
            onClick={() => void click(action)}
        >
            {label}
        </button>
    );

    if (item.presentation === 'bookmark') {
        return (
            <div className="ti-margin-tab">
                <button
                    type="button"
                    disabled={pending}
                    title={`${item.label} · 展开画卷`}
                    aria-label={`${item.label} · 展开画卷`}
                    onClick={() => void click('bookmark')}
                >
                    <span className="ti-bookmark-gem" aria-hidden="true">✦</span>
                    <span>{item.label}</span>
                </button>
                {media && (
                    <div className="ti-margin-preview" aria-hidden="true">
                        <img src={media.url} alt="" />
                        <span>{item.label}</span>
                    </div>
                )}
                {fault && <span role="alert" className="ti-margin-fault">{fault}</span>}
            </div>
        );
    }

    const paletteA = item.palette?.[0] ?? '#221c17';
    const paletteB = item.palette?.[1] ?? '#3b2e23';
    const developing = item.status === 'developing';
    const polaroid = layout === 'im-messenger' || item.presentation === 'polaroid';

    return (
        <>
            <figure
                className={`ti-darkroom${polaroid ? ' ti-polaroid' : ''}${imgLoaded ? ' is-revealed' : ''}`}
                style={{
                    aspectRatio: (item.aspectRatio ?? '3:2').replace(':', ' / '),
                    backgroundImage: `linear-gradient(135deg, ${paletteA}, ${paletteB})`,
                }}
                aria-busy={developing}
            >
                {developing && <div className="ti-darkroom-shimmer" aria-hidden="true" />}
                {media && (
                    <img
                        src={media.url}
                        alt={item.label}
                        className={imgLoaded ? 'is-loaded' : undefined}
                        style={{ cursor: toolsOpen ? 'pointer' : 'zoom-in' }}
                        onClick={() => {
                            if (toolsOpen) setToolsOpen(false);
                            else setLightbox(true);
                        }}
                        onLoad={() => setImgLoaded(true)}
                    />
                )}
                <span className="ti-darkroom-corners" aria-hidden="true" />
                <figcaption className={developing ? 'is-developing' : undefined}>
                    <span className="ti-darkroom-caption-title">
                        {developing && <ApertureIcon size={12} spinning />}
                        <span>{fault || (item.status === 'failed' ? '显影失败，可换一镜' : developing ? '暗房显影中…' : item.label)}</span>
                    </span>
                    {!fault && !developing && item.subtitle && <span className="ti-darkroom-subtitle">{item.subtitle}</span>}
                </figcaption>
                <div className="ti-film-dock">
                    <button
                        type="button"
                        className={`ti-film-dock-toggle${toolsOpen ? ' is-open' : ''}`}
                        aria-expanded={toolsOpen}
                        aria-label={toolsOpen ? '收起胶片操作栏' : '展开胶片操作栏'}
                        title={toolsOpen ? '收起操作' : '浮光暗房工具'}
                        onClick={() => setToolsOpen(v => !v)}
                    >
                        {toolsOpen ? <span aria-hidden="true">✕</span> : <ApertureIcon size={14} />}
                        {takes.length > 1 && <span className="ti-film-dock-badge">{index + 1}/{takes.length}</span>}
                    </button>
                    <div className="ti-film-tools" data-open={toolsOpen ? 'true' : 'false'}>
                        {takes.length > 1 && (
                            <>
                                {button('previous', '‹', '上一帧')}
                                <span>{index + 1}/{takes.length}</span>
                                {button('next', '›', '下一帧')}
                            </>
                        )}
                        {button('reroll', '↻ 换一镜', '重新生成一帧并保留旧帧')}
                        {item.commandId && (
                            <button type="button" disabled={pending} title="打开暗房精修台" aria-label="精修" onClick={() => runCommand(item.commandId!)}>
                                精修
                            </button>
                        )}
                        {(item.actions ?? []).map((act) => (
                            <button
                                key={act.id}
                                type="button"
                                disabled={pending}
                                title={act.title || act.label}
                                aria-label={act.title || act.label}
                                onClick={() => act.kind === 'command' && act.commandId ? runCommand(act.commandId) : void click('custom', act.id)}
                            >
                                {act.label}
                            </button>
                        ))}
                        {button('bookmark', '收为书签', '折叠为页边琥珀胶片签')}
                        {slot.plugin.grants.includes('ui.stage') && button('stage', '设为舞台', '将此帧设为本幕背景舞台')}
                        {media && (
                            <>
                                <button type="button" disabled={pending} title="查看大图" aria-label="查看大图" onClick={() => { setToolsOpen(false); setLightbox(true); }}>
                                    放大
                                </button>
                                <button type="button" disabled={pending} title="保存原图" aria-label="保存原图" onClick={() => void saveImage()}>
                                    保存
                                </button>
                            </>
                        )}
                    </div>
                </div>
            </figure>
            {lightbox && <FilmLightbox slot={slot} onClose={() => setLightbox(false)} />}
        </>
    );
}

export function StageLight({ slot, height }: { slot?: MediaProjection; height?: number | string }) {
    const cue = slot?.cue;
    const enabled = !!cue && cue.overrideThemeWallpaper === true;
    const media = useImage(slot ? mediaIdentity(slot.plugin) : '', enabled ? cue?.backdropMediaId : undefined);
    if (!enabled) return null;
    return (
        <div
            className="ti-stage-light"
            aria-hidden="true"
            style={{
                height,
                backgroundImage: media ? `url(${media.url})` : undefined,
                backgroundColor: cue.ambientTint,
                opacity: media ? Math.max(0.08, 1 - (cue.dimming ?? 0.76)) : 0.11,
                filter: `blur(${cue.blurPx ?? 22}px)`,
            }}
        />
    );
}

export function InlineMedia({ node, source, streaming = false }: { node: ChatMessageNode; source: string; streaming?: boolean }) {
    const latent = latentFilm.useStore((state) => state.items);
    const sandboxMountedByFrame = sandboxMediaStore.useStore((state) => state.byFrame);
    const ref = useRef<HTMLSpanElement>(null);
    const catalog = nativePluginStore.useStore((state) => state.catalog);
    const [slots, setSlots] = useState<{ mount: HTMLElement; slot: MediaProjection }[]>([]);

    useLayoutEffect(() => {
        const body = ref.current!.parentElement!;
        const mountedInSandbox = getSandboxMountedKeys(sandboxMountedByFrame, node.id);
        const next = projectMedia(node)
            .filter((slot) => !mountedInSandbox.has(slot.key))
            .reverse()
            .map((slot) => {
                const mount = document.createElement('div');
                mount.className = 'ti-inline-media-slot';
                mountMediaSlot(body, mount, slot.item.anchor);
                return { slot, mount };
            });
        setSlots(next);

        let raf = 0;
        const isStreaming = streaming || latent.some((item) => item.message === node.id) || next.some(({ slot }) => slot.item.status === 'developing');
        const observer = isStreaming && next.length && typeof MutationObserver !== 'undefined'
            ? new MutationObserver((records) => {
                const relevant = records.some((record) => {
                    const target = record.target as HTMLElement | null;
                    return target && !target.closest?.('.ti-inline-media-slot');
                });
                if (!relevant || raf) return;
                raf = requestAnimationFrame(() => {
                    raf = 0;
                    for (const { mount, slot } of next) {
                        mountMediaSlot(body, mount, slot.item.anchor);
                    }
                });
            })
            : undefined;
        observer?.observe(body, { childList: true, subtree: true });

        return () => {
            if (raf) cancelAnimationFrame(raf);
            observer?.disconnect();
            next.forEach(({ mount }) => mount.remove());
        };
    }, [node, catalog, source, streaming, latent, sandboxMountedByFrame]);

    return (
        <>
            <span ref={ref} hidden />
            {slots.map(({ mount, slot }) => createPortal(<Darkroom slot={slot} />, mount, slot.key))}
        </>
    );
}

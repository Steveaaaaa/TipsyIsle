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

export function Darkroom({ slot }: { slot: MediaProjection }) {
    const { item } = slot;
    const owner = mediaIdentity(slot.plugin);
    const takes = item.takes ?? [];
    const index = takes.length ? Math.min(item.activeTake ?? 0, takes.length - 1) : 0;
    const media = useImage(owner, takes[index]?.id);
    const [imgLoaded, setImgLoaded] = useState(false);
    const [pending, setPending] = useState(false);
    const [fault, setFault] = useState('');
    const layout = themeEngineStore.useStore((state) => state.layoutMode);

    useEffect(() => {
        setImgLoaded(false);
    }, [media?.url]);

    const click = async (action: MediaAction['action']) => {
        if (pending) return;
        setPending(true);
        setFault('');
        try {
            await dispatchMediaAction(slot, action);
        } catch (error) {
            setFault(error instanceof Error ? error.message : String(error));
        } finally {
            setPending(false);
        }
    };

    const saveImage = async () => {
        if (!media || pending) return;
        setFault('');
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
                    <span aria-hidden="true">🔖</span>
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

    const paletteA = item.palette?.[0] ?? '#25221f';
    const paletteB = item.palette?.[1] ?? '#3a3128';
    const developing = item.status === 'developing';
    const polaroid = layout === 'im-messenger' || item.presentation === 'polaroid';

    return (
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
                    onLoad={() => setImgLoaded(true)}
                />
            )}
            <figcaption className={developing ? 'is-developing' : undefined}>
                {fault || (item.status === 'failed' ? '显影失败，可换一镜' : developing ? '暗房显影中…' : item.label)}
            </figcaption>
            <div className="ti-film-tools">
                {takes.length > 1 && (
                    <>
                        {button('previous', '‹', '上一帧')}
                        <span>{index + 1}/{takes.length}</span>
                        {button('next', '›', '下一帧')}
                    </>
                )}
                {button('reroll', '↻ 换一镜', '重新生成一帧并保留旧帧')}
                {button('bookmark', '收为书签', '折叠为页边琥珀胶片签')}
                {slot.plugin.grants.includes('ui.stage') && button('stage', '设为舞台', '将此帧设为本幕背景舞台')}
                {media && (
                    <button type="button" disabled={pending} title="保存原图" aria-label="保存原图" onClick={() => void saveImage()}>
                        保存
                    </button>
                )}
            </div>
        </figure>
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

export function InlineMedia({ node, source }: { node: ChatMessageNode; source: string }) {
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
        const streaming = latent.some((item) => item.message === node.id) || next.some(({ slot }) => slot.item.status === 'developing');
        const observer = streaming && next.length && typeof MutationObserver !== 'undefined'
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
    }, [node, catalog, source, latent, sandboxMountedByFrame]);

    return (
        <>
            <span ref={ref} hidden />
            {slots.map(({ mount, slot }) => createPortal(<Darkroom slot={slot} />, mount, slot.key))}
        </>
    );
}

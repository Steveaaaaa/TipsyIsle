import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { MediaAction } from '../../packages/plugin-sdk/index.js';
import { compatibilityOrigin } from '../core/native-runtime';
import { saveExport } from '../core/platform-files';
import { nativePluginStore, type InstalledPlugin } from '../plugins/native/catalog';
import { latentFilm } from '../plugins/native/latent-film';
import { loadMedia, mediaIdentity } from '../plugins/native/media';
import { openPluginMessageCommand } from '../plugins/native/PluginCommands';
import { dispatchMediaAction, projectMedia, resolveActiveStage, type MediaProjection } from '../plugins/native/reply-media';
import { FilmLightbox, StageLight } from '../plugins/native/ReplyMediaSlot';
import { readingSwipeId } from '../shell/reading-bookmark';
import { getActiveChatMessages, workspaceStore } from '../store/workspace-store';
import type { CompatFilmSlot } from './film-surface';

export function CompatibilityFilms({
    frame,
    session,
    showStage = true,
}: {
    frame: RefObject<HTMLIFrameElement>;
    session: string;
    showStage?: boolean;
}) {
    const nodes = workspaceStore.useStore(getActiveChatMessages);
    const catalog = nativePluginStore.useStore((state) => state.catalog);
    const latent = latentFilm.useStore((state) => state.items);
    const slots = useMemo(
        () => new Map(nodes.flatMap(projectMedia).map((slot) => [slot.key, slot])),
        [nodes, catalog, latent],
    );
    const filmToken = useMemo(() => crypto.randomUUID(), [session]);
    const sentMediaIdsRef = useRef(new Set<string>());
    const inFlightMediaIdsRef = useRef(new Set<string>());
    const mediaCacheRef = useRef(new Map<string, { blob: Blob; bytes: ArrayBuffer; mime: string; name: string }>());
    const activeSessionRef = useRef(session);
    const slotsRef = useRef(slots);
    slotsRef.current = slots;

    const [visible, setVisible] = useState('');
    const [busyKeys, setBusyKeys] = useState<Record<string, boolean>>({});
    const [faults, setFaults] = useState<Record<string, string>>({});
    const [lightboxKey, setLightboxKey] = useState('');

    useEffect(() => {
        activeSessionRef.current = session;
        sentMediaIdsRef.current.clear();
        inFlightMediaIdsRef.current.clear();
        mediaCacheRef.current.clear();
        setBusyKeys({});
        setFaults({});
        setLightboxKey('');
        return () => {
            if (activeSessionRef.current === session) {
                activeSessionRef.current = '';
            }
        };
    }, [frame, session]);

    const deliverMedia = useCallback(
        (mediaId: string, plugin: InstalledPlugin, force = false) => {
            if (!mediaId) return;
            const cached = mediaCacheRef.current.get(mediaId);
            if (cached) {
                if (force || !sentMediaIdsRef.current.has(mediaId)) {
                    frame.current?.contentWindow?.postMessage(
                        {
                            kind: 'compat:film-media',
                            session,
                            mediaId,
                            bytes: cached.bytes,
                            mime: cached.mime,
                            blob: cached.blob,
                            name: cached.name,
                        },
                        compatibilityOrigin,
                    );
                    sentMediaIdsRef.current.add(mediaId);
                }
                return;
            }
            if (!force && sentMediaIdsRef.current.has(mediaId)) return;
            if (inFlightMediaIdsRef.current.has(mediaId)) return;
            inFlightMediaIdsRef.current.add(mediaId);
            const owner = mediaIdentity(plugin);
            void loadMedia(owner, mediaId)
                .then(async ({ blob, handle }) => {
                    const mime = /^image\/(?:png|jpeg|webp)$/.test(blob.type) ? blob.type : handle.mime;
                    if (!/^image\/(?:png|jpeg|webp)$/.test(mime)) return;
                    const bytes = await blob.arrayBuffer();
                    const typedBlob = blob.type === mime ? blob : new Blob([bytes], { type: mime });
                    if (activeSessionRef.current !== session) return;
                    mediaCacheRef.current.set(mediaId, { blob: typedBlob, bytes, mime, name: handle.name });
                    frame.current?.contentWindow?.postMessage(
                        {
                            kind: 'compat:film-media',
                            session,
                            mediaId,
                            bytes,
                            mime,
                            blob: typedBlob,
                            name: handle.name,
                        },
                        compatibilityOrigin,
                    );
                    sentMediaIdsRef.current.add(mediaId);
                })
                .catch(() => {
                    sentMediaIdsRef.current.delete(mediaId);
                })
                .finally(() => {
                    inFlightMediaIdsRef.current.delete(mediaId);
                });
        },
        [frame, session],
    );

    useEffect(() => {
        const win = frame.current?.contentWindow;
        if (!win) return;

        const payload: CompatFilmSlot[] = [...slots.values()].map(({ key, node, plugin, item }) => {
            const takes = item.takes ?? [];
            const takeIndex = takes.length ? Math.min(item.activeTake ?? 0, takes.length - 1) : 0;
            const mediaId = takes[takeIndex]?.id;
            return {
                key,
                message: node.id,
                swipe: readingSwipeId(node),
                anchor: item.anchor,
                status: item.status,
                label: item.label,
                subtitle: item.subtitle,
                ratio: item.aspectRatio ?? '3:2',
                palette: item.palette,
                presentation: item.presentation,
                takeIndex,
                takeCount: takes.length,
                canStage: plugin.grants.includes('ui.stage'),
                mediaId,
                commandId: item.commandId,
                actions: item.actions,
                busy: !!busyKeys[key],
                fault: faults[key],
            };
        });
        win.postMessage({ kind: 'compat:film-slots', session, filmToken, slots: payload }, compatibilityOrigin);

        for (const { plugin, item } of slots.values()) {
            const takes = item.takes ?? [];
            const takeIndex = takes.length ? Math.min(item.activeTake ?? 0, takes.length - 1) : 0;
            const mediaId = takes[takeIndex]?.id;
            if (mediaId) deliverMedia(mediaId, plugin);
        }
    }, [frame, slots, session, filmToken, busyKeys, faults, deliverMedia]);

    useEffect(() => {
        const receive = (event: MessageEvent) => {
            if (
                event.origin !== compatibilityOrigin ||
                event.source !== frame.current?.contentWindow ||
                event.data?.session !== session
            ) {
                return;
            }
            if (event.data?.kind === 'compat:film-visible') {
                setVisible(typeof event.data.visible === 'string' ? event.data.visible : '');
                return;
            }
            if (event.data?.kind === 'compat:film-media-need' && Array.isArray(event.data.mediaIds)) {
                for (const rawId of event.data.mediaIds) {
                    if (typeof rawId !== 'string' || !rawId) continue;
                    for (const slot of slotsRef.current.values()) {
                        const takes = slot.item.takes ?? [];
                        const idx = takes.length ? Math.min(slot.item.activeTake ?? 0, takes.length - 1) : 0;
                        if (takes[idx]?.id === rawId || takes.some((t) => t.id === rawId)) {
                            deliverMedia(rawId, slot.plugin, true);
                            break;
                        }
                    }
                }
                return;
            }
            if (event.data?.kind !== 'compat:film-action' || event.data?.token !== filmToken) {
                return;
            }
            const key = typeof event.data.key === 'string' ? event.data.key : '';
            const action = typeof event.data.action === 'string' ? event.data.action : '';
            const slot: MediaProjection | undefined = slotsRef.current.get(key);
            if (!slot) return;

            if (action === 'lightbox') {
                setLightboxKey(slot.key);
                return;
            }

            if (action === 'command') {
                const commandId = typeof event.data.commandId === 'string' ? event.data.commandId : '';
                if (!commandId) return;
                try {
                    openPluginMessageCommand(slot.plugin.manifest.id, commandId, slot.node);
                } catch (error) {
                    const msg = error instanceof Error ? error.message : String(error);
                    setFaults((prev) => ({ ...prev, [key]: msg }));
                }
                return;
            }

            if (action === 'save') {
                const takes = slot.item.takes ?? [];
                const idx = takes.length ? Math.min(slot.item.activeTake ?? 0, takes.length - 1) : 0;
                const mediaId = (typeof event.data.mediaId === 'string' && event.data.mediaId) || takes[idx]?.id;
                if (!mediaId) return;
                setBusyKeys((prev) => ({ ...prev, [key]: true }));
                const runSave = async () => {
                    const cached = mediaCacheRef.current.get(mediaId);
                    const loaded = cached ?? (await loadMedia(mediaIdentity(slot.plugin), mediaId).then(({ blob, handle }) => ({ blob, name: handle.name })));
                    if (!loaded) return;
                    const base = (loaded.name || slot.item.label || 'lumina-frame').replace(/[\\/:*?"<>|]/g, '-');
                    const ext = loaded.blob.type.split('/')[1] || 'webp';
                    await saveExport(loaded.blob, /\.\w{1,6}$/.test(base) ? base : `${base}.${ext}`);
                };
                void runSave()
                    .catch((error) => {
                        setFaults((prev) => ({ ...prev, [key]: error instanceof Error ? error.message : String(error) }));
                    })
                    .finally(() => {
                        setBusyKeys((prev) => {
                            const next = { ...prev };
                            delete next[key];
                            return next;
                        });
                    });
                return;
            }

            if (['previous', 'next', 'reroll', 'bookmark', 'stage', 'custom'].includes(action)) {
                const customId = typeof event.data.customId === 'string' ? event.data.customId : undefined;
                setBusyKeys((prev) => ({ ...prev, [key]: true }));
                setFaults((prev) => {
                    if (!(key in prev)) return prev;
                    const next = { ...prev };
                    delete next[key];
                    return next;
                });
                void dispatchMediaAction(slot, action as MediaAction['action'], customId)
                    .catch((error) => {
                        setFaults((prev) => ({ ...prev, [key]: error instanceof Error ? error.message : String(error) }));
                    })
                    .finally(() => {
                        setBusyKeys((prev) => {
                            const next = { ...prev };
                            delete next[key];
                            return next;
                        });
                    });
            }
        };
        window.addEventListener('message', receive);
        return () => window.removeEventListener('message', receive);
    }, [frame, session, filmToken, deliverMedia]);

    useEffect(
        () => () => frame.current?.contentWindow?.postMessage({ kind: 'compat:film-slots', session, filmToken, slots: [] }, compatibilityOrigin),
        [frame, session, filmToken],
    );

    const visibleIdx = visible ? nodes.findIndex((node) => node.id === visible) : -1;
    const stage = resolveActiveStage(nodes, visibleIdx >= 0 ? visibleIdx : nodes.length - 1);
    const tint = showStage && stage?.cue?.overrideThemeWallpaper === true ? stage.cue.ambientTint : undefined;

    useEffect(() => {
        const publish = (color?: string) =>
            frame.current?.contentWindow?.postMessage({ kind: 'compat:presentation', session, stageTint: color ?? null }, compatibilityOrigin);
        publish(tint);
        return () => publish();
    }, [frame, session, tint]);

    const lightboxSlot = lightboxKey ? slots.get(lightboxKey) : undefined;

    return (
        <div className="ti-compat-films">
            {showStage && <StageLight slot={stage} />}
            {lightboxSlot && <FilmLightbox slot={lightboxSlot} onClose={() => setLightboxKey('')} />}
        </div>
    );
}

import { useEffect, useMemo, useState, type RefObject } from 'react';
import { z } from 'zod';
import { compatibilityOrigin } from '../core/native-runtime';
import { nativePluginStore } from '../plugins/native/catalog';
import { latentFilm } from '../plugins/native/latent-film';
import { projectMedia, resolveActiveStage } from '../plugins/native/reply-media';
import { Darkroom, StageLight } from '../plugins/native/ReplyMediaSlot';
import { readingSwipeId } from '../shell/reading-bookmark';
import { getActiveChatMessages, workspaceStore } from '../store/workspace-store';

const bounds = z.array(
    z.strictObject({
        key: z.string().max(2048),
        top: z.number().finite(),
        left: z.number().nonnegative(),
        width: z.number().positive(),
        height: z.number().nonnegative(),
    }),
).max(128);

export function CompatibilityFilms({ frame, session }: { frame: RefObject<HTMLIFrameElement>; session: string }) {
    const nodes = workspaceStore.useStore(getActiveChatMessages);
    const catalog = nativePluginStore.useStore((state) => state.catalog);
    const latent = latentFilm.useStore((state) => state.items);
    const slots = useMemo(
        () => new Map(nodes.flatMap(projectMedia).map((slot) => [slot.key, slot])),
        [nodes, catalog, latent],
    );
    const [rects, setRects] = useState<z.infer<typeof bounds>>([]);
    const [visible, setVisible] = useState('');

    useEffect(() => {
        const receive = (event: MessageEvent) => {
            if (
                event.origin !== compatibilityOrigin ||
                event.source !== frame.current?.contentWindow ||
                event.data?.session !== session ||
                event.data?.kind !== 'compat:film-position'
            ) {
                return;
            }
            const valid = bounds.safeParse(event.data.rects);
            if (valid.success) {
                setRects(valid.data);
                setVisible(typeof event.data.visible === 'string' ? event.data.visible : '');
            }
        };
        window.addEventListener('message', receive);
        return () => window.removeEventListener('message', receive);
    }, [frame, session]);

    useEffect(() => {
        const send = (spaces: unknown[]) =>
            frame.current?.contentWindow?.postMessage({ kind: 'compat:film-spaces', session, spaces }, compatibilityOrigin);
        send(
            [...slots.values()].map(({ key, node, item }) => ({
                key,
                message: node.id,
                swipe: readingSwipeId(node),
                anchor: item.anchor,
                ratio: item.aspectRatio ?? '3:2',
                folded: item.presentation === 'bookmark',
            })),
        );
    }, [frame, slots, session]);

    useEffect(
        () => () => frame.current?.contentWindow?.postMessage({ kind: 'compat:film-spaces', session, spaces: [] }, compatibilityOrigin),
        [frame, session],
    );

    const visibleIdx = visible ? nodes.findIndex((node) => node.id === visible) : -1;
    const stage = resolveActiveStage(nodes, visibleIdx >= 0 ? visibleIdx : nodes.length - 1);
    const tint = stage?.cue?.overrideThemeWallpaper === true ? stage.cue.ambientTint : undefined;

    useEffect(() => {
        const publish = (color?: string) =>
            frame.current?.contentWindow?.postMessage({ kind: 'compat:presentation', session, stageTint: color ?? null }, compatibilityOrigin);
        publish(tint);
        return () => publish();
    }, [frame, session, tint]);

    return (
        <div className="ti-compat-films">
            <StageLight slot={stage} />
            {rects.map((rect) => {
                const slot = slots.get(rect.key);
                return (
                    slot && (
                        <div key={rect.key} style={{ top: rect.top, left: rect.left, width: rect.width, height: rect.height }}>
                            <Darkroom slot={slot} />
                        </div>
                    )
                );
            })}
        </div>
    );
}

import {
    definePlugin,
    type AspectRatio,
    type JobScheduleInput,
    type Json,
    type MessageRef,
    type PluginApi,
    type ReplyMediaItem,
    type RouteAddress,
} from '@tipsy-isle/plugin-sdk';
import { bindings } from './auto-binding';
import { continuity, mergeLedger, mutate, type LedgerState } from './continuity-ledger';
import { collection, recall, sceneKey } from './scene-memory';
import { defaultPaletteForScene, direct, type LayoutMode } from './shot-director';
import { darkroomPanel, frames, studio } from './studio-panel';
import { shots, surroundingContext, type ShotCandidate } from './tension-gate';
import { visualBible, type Registry } from './visual-bible';

interface ShotJobPayload {
    scene: string;
    index: number;
    slot: string;
    explicitPrompt?: string;
    custom?: string;
    aspectRatio?: AspectRatio;
    isReroll?: boolean;
    userPrompt?: string;
    surrounding?: string;
}

const SERVICE_ID = 'dev.tipsy-isle.lumina-director.visual';

function localDay() {
    const now = new Date();
    return `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
}

function pacingGap(pacing: unknown): number {
    if (pacing === 'restrained') return 3;
    if (pacing === 'dense') return 0;
    if (pacing === 'markers_only') return 0;
    return 1;
}

function buildJobInput(
    route: RouteAddress,
    messageId: string,
    swipeId: string,
    shot: ShotCandidate,
    slotIndex: number,
    target?: MessageRef,
    generationId?: string,
    focus?: { userPrompt: string; surrounding?: string },
): JobScheduleInput {
    return {
        route,
        target,
        generationId,
        key: `${messageId}:${swipeId}:shot-${slotIndex}`,
        payload: {
            scene: shot.part.slice(0, 5000),
            index: shot.index,
            slot: `shot-${slotIndex}`,
            ...(shot.explicitPrompt && { explicitPrompt: shot.explicitPrompt }),
            ...(focus?.userPrompt && { userPrompt: focus.userPrompt.slice(0, 300) }),
            ...(focus?.surrounding && { surrounding: focus.surrounding.slice(0, 600) }),
        },
    };
}

async function readUserFocus(api: { story: Pick<PluginApi['story'], 'readMessages' | 'visualSources'> }): Promise<{ userPrompt: string; targetAliases: string[] }> {
    try {
        const page = await api.story.readMessages({ limit: 4 });
        const latestUser = [...page.messages].reverse().find((m) => m.role === 'user' && m.text.trim());
        const userPrompt = latestUser?.text.trim().slice(0, 300) ?? '';
        if (!userPrompt) return { userPrompt: '', targetAliases: [] };
        const sources = await api.story.visualSources();
        const targetAliases = new Set<string>();
        for (const ch of sources.characters ?? []) {
            const allNames = [ch.name, ...ch.aliases].filter((a) => a.length >= 2);
            if (allNames.some((alias) => userPrompt.includes(alias))) {
                for (const alias of allNames) targetAliases.add(alias);
            }
        }
        if (!targetAliases.size) {
            for (const person of sources.people) {
                if (person.length >= 2 && userPrompt.includes(person)) targetAliases.add(person);
            }
        }
        return { userPrompt, targetAliases: [...targetAliases] };
    } catch {
        return { userPrompt: '', targetAliases: [] };
    }
}

function upsertSlot(items: ReplyMediaItem[] = [], item: ReplyMediaItem): ReplyMediaItem[] {
    return [...items.filter((old) => old.slotId !== item.slotId), item];
}

function buildStageCue(revision: string, backdropMediaId: string, overrideThemeWallpaper: boolean) {
    const tints = ['#5f5650', '#7a634b', '#4d606c'];
    const ambientTint = tints[backdropMediaId.charCodeAt(0) % tints.length];
    return {
        revision,
        backdropMediaId,
        blurPx: 22,
        dimming: 0.78,
        ambientTint,
        overrideThemeWallpaper,
    };
}

function resolvePresentation(
    setting: unknown,
    fallback: 'editorial' | 'bookmark' | 'polaroid',
): 'editorial' | 'bookmark' | 'polaroid' {
    if (setting === 'bookmark') return 'bookmark';
    if (setting === 'editorial') return 'editorial';
    return fallback;
}

type TextApi = { story: Pick<PluginApi['story'], 'readText' | 'getMessage'> };

async function fullText(api: TextApi, route: RouteAddress, ref: MessageRef) {
    const message = await api.story.getMessage(ref);
    if (!message || message.hidden) return '';
    if (!message.truncated) return message.text;
    let text = '';
    let offset: number | null = 0;
    while (offset !== null) {
        const page = await api.story.readText({ route, target: ref, offset, length: 12000 });
        text += page.text;
        offset = page.next;
    }
    return text;
}

export default definePlugin({
    async onReplyCheckpoint(api, event) {
        if (api.settings.enabled === false || api.settings.saved_only === true) return;
        const markersOnly = api.settings.pacing === 'markers_only';
        const focus = await readUserFocus(api);
        const presentation = api.settings.presentation_mode === 'bookmark' ? 'bookmark' : 'editorial';

        if (event.paragraphCount > 4) {
            const selected = shots(event.settledText, false, { markersOnly, ...focus });
            if (selected.length < 2) return;
            const secondShot = selected[1];
            const hasExplicit = selected.some((item) => !!item.explicitPrompt);
            if (!hasExplicit) {
                const routeState = await api.storage.read('route');
                const lastFloor = routeState.values.lastIllustratedFloor;
                const gap = pacingGap(api.settings.pacing);
                if (typeof lastFloor === 'number' && event.draft.floor > lastFloor && event.draft.floor - lastFloor <= gap) {
                    return;
                }
                const device = await api.storage.read('device');
                const usage = (device.values.dailyUsage ?? {}) as { day?: string; count?: number };
                const limit = typeof api.settings.daily_limit === 'number' ? api.settings.daily_limit : 24;
                const usedToday = usage.day === localDay() && typeof usage.count === 'number' ? usage.count : 0;
                if (usedToday >= limit) return;
            }
            await api.jobs.schedule(
                buildJobInput(event.route, event.draft.messageId, event.draft.swipeId, secondShot, 1, undefined, event.generationId, {
                    userPrompt: focus.userPrompt,
                    surrounding: surroundingContext(event.settledText, secondShot.index),
                }),
            );
            await api.replyMedia.developing({
                slotId: 'shot-1',
                label: secondShot.part.slice(0, 80) || '暗房显影中…',
                aspectRatio: '3:2',
                palette: defaultPaletteForScene(secondShot.part),
                presentation,
                anchor: { kind: 'paragraph', index: secondShot.index, excerpt: secondShot.part.slice(0, 28) },
            });
            return;
        }

        const shot = shots(event.settledText, true, { markersOnly, ...focus })[0];
        if (!shot) return;

        await api.jobs.schedule(
            buildJobInput(event.route, event.draft.messageId, event.draft.swipeId, shot, 0, undefined, event.generationId, {
                userPrompt: focus.userPrompt,
                surrounding: surroundingContext(event.settledText, shot.index),
            }),
        );

        await api.replyMedia.developing({
            slotId: 'shot-0',
            label: shot.part.slice(0, 80) || '暗房显影中…',
            aspectRatio: '3:2',
            palette: defaultPaletteForScene(shot.part),
            presentation,
            anchor: { kind: 'paragraph', index: shot.index, excerpt: shot.part.slice(0, 28) },
        });
    },

    async onReplySaved(api, event) {
        const route = api.context.route;
        if (!route || api.settings.enabled === false) return;

        const stats = await api.media.stats();
        if (stats.bytes >= stats.totalLimit * 0.8 || stats.items >= stats.maxItems * 0.8) {
            await api.jobs.schedule({ route, key: 'reclaim', queue: 'maintenance', payload: null });
        }

        const message = await api.story.getMessage(event.reply);
        if (!message || message.hidden || message.role !== 'assistant') return;

        const markersOnly = api.settings.pacing === 'markers_only';
        const text = await fullText(api, route, event.reply);
        const focus = await readUserFocus(api);
        const selected = shots(text, false, { markersOnly, ...focus });
        if (!selected.length) return;

        const routeState = await api.storage.read('route');
        const lastFloor = routeState.values.lastIllustratedFloor;
        const gap = pacingGap(api.settings.pacing);
        const hasExplicit = selected.some((item) => !!item.explicitPrompt);
        if (
            !hasExplicit &&
            typeof lastFloor === 'number' &&
            message.floor > lastFloor &&
            message.floor - lastFloor <= gap
        ) {
            return;
        }

        const device = await api.storage.read('device');
        const usage = (device.values.dailyUsage ?? {}) as { day?: string; count?: number };
        const limit = typeof api.settings.daily_limit === 'number' ? api.settings.daily_limit : 24;
        const usedToday = usage.day === localDay() && typeof usage.count === 'number' ? usage.count : 0;
        if (!hasExplicit && usedToday >= limit) return;

        for (const [index, shot] of selected.entries()) {
            await api.jobs.schedule(
                buildJobInput(route, event.reply.messageId, event.reply.swipeId, shot, index, event.reply, undefined, {
                    userPrompt: focus.userPrompt,
                    surrounding: surroundingContext(text, shot.index),
                }),
            );
        }
    },

    async onJob(api, job) {
        if (job.key === 'reclaim') {
            await api.media.reclaim();
            return;
        }
        const route = job.route;
        if (!route) return;

        const payload = job.payload as unknown as ShotJobPayload;
        const { image, chats, embedding } = await bindings(api);
        if (!image) return;

        if (!payload.isReroll && !payload.custom && !payload.explicitPrompt) {
            const device = await api.storage.read('device');
            const usage = (device.values.dailyUsage ?? {}) as { day?: string; count?: number };
            const limit = typeof api.settings.daily_limit === 'number' ? api.settings.daily_limit : 24;
            const usedToday = usage.day === localDay() && typeof usage.count === 'number' ? usage.count : 0;
            if (usedToday >= limit) return;
        }

        let target = job.target;
        const routeState = await api.storage.read('route');
        const participants = await api.story.participants();
        const sources = await api.story.visualSources();
        const registry = (routeState.values.castRegistry ?? {}) as unknown as Registry;

        const prevLedger = (routeState.values.ledger ?? {}) as LedgerState;
        const corefContext = [payload.userPrompt, payload.surrounding].filter(Boolean).join('\n');
        const { actors: subjects, ensemble } = visualBible(
            participants,
            payload.scene,
            registry,
            [...sources.people],
            sources.profiles,
            sources.characters ?? [],
            [prevLedger.location, prevLedger.weather, prevLedger.lighting].filter(Boolean).join(' '),
            corefContext,
        );

        if (!sources.characters?.length) {
            for (const actor of subjects) {
                const name = actor.name;
                const path = name && sources.gallery.find((file) => file.includes(name));
                if (path && actor.reference?.source !== 'media') {
                    actor.reference = { source: 'story.gallery', characterId: sources.characterId, path };
                }
            }
        }

        const framing =
            subjects.length === 1 && subjects[0].name && !registry[subjects[0].name]
                ? 'solo portrait, medium close-up'
                : routeState.values.lastFraming === 'wide establishing shot'
                    ? 'medium close-up'
                    : 'wide establishing shot';

        let mvu: unknown;
        if (target) {
            try {
                mvu = (await api.story.state({ route, at: target, scope: 'message', path: ['stat_data'] })).value;
            } catch {
                // MVU stat_data is optional per card.
            }
        }

        const actorNames = subjects.map((actor) => actor.name).filter((name): name is string => !!name);
        const ledger = continuity(payload.scene, (routeState.values.ledger ?? {}) as LedgerState, mvu, actorNames);
        const flashback =
            !payload.isReroll &&
            !payload.custom &&
            !payload.explicitPrompt &&
            /回到|重返|又来到|back at|return to/i.test(payload.scene);

        const scene = await recall(api, route, payload.scene, flashback ? undefined : embedding?.id).catch(() => ({
            prior: '',
            vector: undefined,
            mediaId: undefined,
        }));

        const presentation = resolvePresentation(
            api.settings.presentation_mode,
            sources.layoutMode === 'im-messenger' ? 'polaroid' : 'editorial',
        );

        const initial: ReplyMediaItem = {
            status: 'developing',
            label: payload.scene.replace(/<[^>]+>/g, '').slice(0, 80) || '故事插图',
            slotId: payload.slot,
            aspectRatio: payload.aspectRatio ?? '3:2',
            palette: defaultPaletteForScene(payload.scene),
            presentation,
            anchor: { kind: 'paragraph', index: payload.index, excerpt: payload.scene.slice(0, 28) },
        };

        async function mark(status: ReplyMediaItem['status']) {
            if (!target) return;
            const reply = target;
            await mutate(api, route!, reply, `${job.id}:${status}`, (state) => {
                const old = (state.replyMedia as ReplyMediaItem[] | undefined)?.find((item) => item.slotId === payload.slot);
                return { replyMedia: upsertSlot(state.replyMedia, { ...initial, ...old, revision: reply.revision, status }) };
            });
        }

        await mark('developing');

        if (flashback && scene.mediaId) {
            target ??= (await api.jobs.awaitReply()).reply;
            const reply = target;
            const mediaId = scene.mediaId;
            await mutate(api, route, reply, `${job.id}:flashback`, (state) => ({
                replyMedia: upsertSlot(state.replyMedia, {
                    ...initial,
                    status: 'ready',
                    revision: reply.revision,
                    takes: [{ id: mediaId, createdAt: Date.now() }],
                    activeTake: 0,
                }),
                ...(api.settings.override_wallpaper === true && {
                    stage: buildStageCue(reply.revision, mediaId, true),
                }),
            }));
            return;
        }

        try {
            let priorReplyActors: Record<string, string> | undefined;
            if (target && !payload.custom && !payload.explicitPrompt && subjects.length) {
                try {
                    const replyState = await api.storage.readAt({ route, reply: target });
                    const mediaItems = (replyState.values.replyMedia as unknown as ReplyMediaItem[] | undefined) ?? [];
                    const actorNameSet = new Set(subjects.map((a) => a.name).filter((n): n is string => !!n));
                    const extracted: Record<string, string> = {};
                    for (const item of mediaItems) {
                        if (item.slotId === payload.slot || item.status !== 'ready') continue;
                        const take = item.takes?.[item.activeTake ?? 0] ?? item.takes?.[0];
                        if (!take?.prompt) continue;
                        for (const line of take.prompt.split('\n')) {
                            const m = /^\[([^\]]+)\]\s*(.+)$/.exec(line.trim());
                            if (m && actorNameSet.has(m[1]) && !extracted[m[1]]) {
                                extracted[m[1]] = m[2].trim().slice(0, 320);
                            }
                        }
                    }
                    if (Object.keys(extracted).length) priorReplyActors = extracted;
                } catch {
                    // Best-effort intra-reply outfit consistency lookup.
                }
            }

            const plan = payload.custom
                ? {
                    caption: initial.label,
                    prompt: payload.custom,
                    negativePrompt: undefined,
                    aspectRatio: payload.aspectRatio ?? initial.aspectRatio ?? '3:2',
                    palette: initial.palette ?? defaultPaletteForScene(payload.scene),
                    presentation,
                    actors: subjects,
                    ledgerPatch: undefined,
                }
                : await direct(api, chats, {
                    scene: payload.scene,
                    explicitPrompt: payload.explicitPrompt,
                    artDirection: typeof api.settings.art_direction === 'string' ? api.settings.art_direction.trim() : '',
                    layoutMode: sources.layoutMode as LayoutMode,
                    actors: subjects,
                    ledger,
                    prior: scene.prior,
                    framing,
                    userPrompt: payload.userPrompt,
                    priorReplyActors,
                });

            const aspectRatio = payload.aspectRatio ?? plan.aspectRatio;
            const taskId = await api.models.start({
                kind: 'image',
                connection: image.id,
                prompt: plan.prompt,
                ...(plan.negativePrompt && { negativePrompt: plan.negativePrompt }),
                aspectRatio,
                actors: plan.actors,
                ...(scene.mediaId && {
                    references: [{ role: 'composition', image: { source: 'media', id: scene.mediaId }, weight: 0.25 }],
                }),
            });

            const result = (await api.tasks.await(taskId)).result;
            if (result?.kind !== 'image') throw new Error('模型未返回插图');

            const id = result.media.id;
            const archivedPrompt = !payload.custom && plan.actors.length
                ? [plan.prompt, ...plan.actors.map((actor) => `[${actor.name ?? '角色'}] ${actor.prompt}`)].join('\n')
                : plan.prompt;

            if (!target) {
                await api.replyMedia.developing({
                    slotId: payload.slot,
                    status: 'ready',
                    label: plan.caption || initial.label,
                    aspectRatio,
                    palette: plan.palette,
                    presentation: resolvePresentation(api.settings.presentation_mode, plan.presentation),
                    anchor: initial.anchor,
                    takes: [{ id, seed: result.seed, createdAt: Date.now(), prompt: archivedPrompt }],
                    activeTake: 0,
                }).catch(() => {});
                target = (await api.jobs.awaitReply()).reply;
            }
            const reply = target;
            const settledMessage = await api.story.getMessage(reply);
            await mutate(api, route, reply, `${job.id}:ready`, (state) => {
                const old: ReplyMediaItem =
                    (state.replyMedia as ReplyMediaItem[] | undefined)?.find((item) => item.slotId === payload.slot) ?? initial;
                const takes = [
                    ...(old.takes ?? []),
                    { id, seed: result.seed, createdAt: Date.now(), prompt: archivedPrompt },
                ];
                return {
                    replyMedia: upsertSlot(state.replyMedia, {
                        ...old,
                        label: plan.caption || old.label,
                        aspectRatio,
                        palette: plan.palette,
                        presentation: resolvePresentation(api.settings.presentation_mode, plan.presentation),
                        revision: reply.revision,
                        status: 'ready',
                        takes,
                        activeTake: takes.length - 1,
                    }),
                    ...(api.settings.override_wallpaper === true && {
                        stage: buildStageCue(reply.revision, id, true),
                    }),
                };
            });

            const nextLedger = mergeLedger(ledger, plan.ledgerPatch);
            await mutate(api, route, undefined, `${job.id}:continuity`, (state) => {
                const nextRegistry = { ...(state.castRegistry as Registry | undefined) };
                const firstActor = subjects[0];
                const hasOfficialRef = firstActor?.reference && firstActor.reference.source !== 'media';
                if (ensemble && subjects.length === 1 && firstActor?.name && framing.includes('portrait') && !hasOfficialRef && !nextRegistry[firstActor.name]) {
                    nextRegistry[firstActor.name] = { canonicalMediaId: id };
                }
                return {
                    ledger: nextLedger,
                    castRegistry: nextRegistry,
                    lastFraming: framing,
                    ...(settledMessage && { lastIllustratedFloor: settledMessage.floor }),
                };
            });

            if (!payload.isReroll && !payload.custom) {
                const device = await api.storage.read('device');
                const day = localDay();
                const usage = (device.values.dailyUsage ?? {}) as { day?: string; count?: number };
                const count = usage.day === day && typeof usage.count === 'number' ? usage.count + 1 : 1;
                await api.storage.patch('device', { set: { dailyUsage: { day, count } } });
            }

            await api.index.put({
                collection,
                documents: [{ id, text: payload.scene.slice(0, 1800), vector: scene.vector, value: { mediaId: id, route: sceneKey(route) } }],
            });
        } catch (error) {
            await mark('failed');
            throw error;
        }
    },

    async onMediaAction(api, input) {
        const route = api.context.route;
        if (!route) return;
        const state = await api.storage.readAt({ route, reply: input.target });
        const items = (state.values.replyMedia as unknown as ReplyMediaItem[] | undefined) ?? [];
        const slot = items.find((item) => item.slotId === input.slotId);
        if (!slot) return;

        if (input.action === 'reroll') {
            const text = await fullText(api, route, input.target);
            await api.jobs.schedule({
                key: `reroll:${input.target.messageId}:${slot.slotId}:${Date.now()}`,
                route,
                target: input.target,
                payload: {
                    slot: slot.slotId,
                    scene: text.slice(0, 5000) || slot.label,
                    index: slot.anchor?.kind === 'paragraph' ? slot.anchor.index : 0,
                    isReroll: true,
                },
            });
            return;
        }

        await mutate(api, route, input.target, `action:${Date.now()}:${Math.random()}`, (current) => {
            const list = (current.replyMedia as ReplyMediaItem[] | undefined) ?? [];
            const item = list.find((row) => row.slotId === input.slotId);
            if (!item) return {};
            const count = item.takes?.length ?? 0;
            const currentIdx = Math.min(item.activeTake ?? 0, Math.max(0, count - 1));
            const nextIdx =
                input.action === 'next' && count
                    ? (currentIdx + 1) % count
                    : input.action === 'previous' && count
                        ? (currentIdx - 1 + count) % count
                        : currentIdx;
            const activeMediaId = item.takes?.[nextIdx]?.id;
            const prevStage = current.stage as { backdropMediaId?: string; overrideThemeWallpaper?: boolean } | undefined;
            const stageEnabled = prevStage?.overrideThemeWallpaper === true;
            const stageUpdate =
                input.action === 'stage' && activeMediaId
                    ? {
                        stage:
                            stageEnabled && prevStage?.backdropMediaId === activeMediaId
                                ? null
                                : buildStageCue(input.target.revision, activeMediaId, true),
                    }
                    : (input.action === 'next' || input.action === 'previous') && stageEnabled && activeMediaId
                        ? { stage: buildStageCue(input.target.revision, activeMediaId, true) }
                        : {};

            return {
                replyMedia: upsertSlot(list, {
                    ...item,
                    activeTake: nextIdx,
                    ...(input.action === 'bookmark' && {
                        presentation: item.presentation === 'bookmark' ? 'editorial' : 'bookmark',
                    }),
                }),
                ...stageUpdate,
            };
        });
    },

    commands: {
        studio: (api, input) => studio(api, input.action?.id),
        darkroom: (api, input) =>
            darkroomPanel(
                api,
                input,
                buildStageCue,
                (route, ref) => fullText(api, route, ref),
            ),
    },

    services: {
        [SERVICE_ID]: {
            async chronicle(api) {
                const pages = (await frames(api)).filter((row) => row.mediaId).slice(-8);
                return {
                    value: pages.map((page) => ({
                        id: page.mediaId!,
                        label: `第 ${page.floor} 楼 · ${page.text.slice(0, 50)}`,
                    })) as Json,
                    media: pages.map((page) => page.mediaId!),
                };
            },
        },
    },
});

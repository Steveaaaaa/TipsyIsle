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
import { continuity, filterLedgerForShot, mergeLedger, mutate, normalizeActorKey, resolveDeceasedSet, type KnownCharacter, type LedgerState } from './continuity-ledger';
import { collection, recall, sceneKey } from './scene-memory';
import { defaultPaletteForScene, direct, type LayoutMode } from './shot-director';
import { darkroomPanel, frames, studio } from './studio-panel';
import { extractShotFromReply, narrative, shots, surroundingContext, type ShotCandidate } from './tension-gate';
import { visualBible, type Registry } from './visual-bible';

interface ShotJobPayload {
    scene: string;
    index: number;
    slot: string;
    floor?: number;
    explicitPrompt?: string;
    custom?: string;
    aspectRatio?: AspectRatio;
    isReroll?: boolean;
    userPrompt?: string;
    surrounding?: string;
    replyText?: string;
}

const SERVICE_ID = 'dev.tipsy-isle.lumina-director.visual';
const PENDING_ILLUSTRATION_TTL_MS = 300_000;

function localDay() {
    const now = new Date();
    return `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
}

function pacingGap(pacing: unknown): number {
    if (pacing === 'restrained') return 3;
    if (pacing === 'balanced') return 1;
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
    floor: number,
    target?: MessageRef,
    generationId?: string,
    focus?: { userPrompt: string; surrounding?: string; replyText?: string },
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
            floor,
            ...(shot.explicitPrompt && { explicitPrompt: shot.explicitPrompt }),
            ...(focus?.userPrompt && { userPrompt: focus.userPrompt.slice(0, 300) }),
            ...(focus?.surrounding && { surrounding: focus.surrounding.slice(0, 600) }),
            ...(focus?.replyText && { replyText: focus.replyText.slice(0, 2200) }),
        },
    };
}

type RecentMessage = Awaited<ReturnType<PluginApi['story']['readMessages']>>['messages'][number];

async function readRecentMessages(
    api: { story: Partial<Pick<PluginApi['story'], 'readMessages'>> },
): Promise<readonly RecentMessage[]> {
    if (typeof api.story.readMessages !== 'function') return [];
    try {
        return (await api.story.readMessages({ limit: 16 })).messages;
    } catch {
        return [];
    }
}

const HAN_CHAR_RE = /\p{Script=Han}/u;
const PREV_CHAR_BOUNDARY = new Set([...'和与跟被把向对让看见问找叫拉抱小阿']);
const NEXT_CHAR_BOUNDARY = new Set([...'说道问笑看望轻低点摇走站坐转抬伸拉握抱的也却便就正把被向对和与在从着了']);
const GROUP_OR_COREF_PRONOUN_RE = /她俩|她们|他俩|他们|两人|二人|姐妹|兄弟|少女|女孩|男孩|她|他/;

function textMatchesAlias(text: string, alias: string, singleCharOwners: Map<string, number>): boolean {
    if (!alias) return false;
    if (alias.length >= 2) return text.includes(alias);
    if (alias.length === 1 && HAN_CHAR_RE.test(alias) && singleCharOwners.get(alias) === 1) {
        let from = 0;
        while (from < text.length) {
            const idx = text.indexOf(alias, from);
            if (idx === -1) return false;
            const prev = idx > 0 ? text[idx - 1] : '';
            const next = idx + 1 < text.length ? text[idx + 1] : '';
            if (
                (!prev || !HAN_CHAR_RE.test(prev) || PREV_CHAR_BOUNDARY.has(prev)) &&
                (!next || !HAN_CHAR_RE.test(next) || NEXT_CHAR_BOUNDARY.has(next))
            ) {
                return true;
            }
            from = idx + 1;
        }
    }
    return false;
}

async function logDiagnostic(api: { log?: (message: string) => Promise<void> }, message: string) {
    try {
        await api.log?.(message);
    } catch {
        // Best-effort plugin diagnostic log.
    }
}

async function readUserFocus(
    api: { story: Pick<PluginApi['story'], 'visualSources'> },
    recentMessages: readonly RecentMessage[],
): Promise<{ userPrompt: string; targetAliases: string[] }> {
    try {
        const latestUser = [...recentMessages].reverse().find((m) => m.role === 'user' && m.text.trim());
        const userPrompt = latestUser?.text.trim().slice(0, 300) ?? '';
        if (!userPrompt) return { userPrompt: '', targetAliases: [] };
        const sources = await api.story.visualSources();
        const characters = sources.characters ?? [];
        const singleCharOwners = new Map<string, number>();
        for (const ch of characters) {
            for (const alias of [ch.name, ...ch.aliases]) {
                if (alias.length === 1 && HAN_CHAR_RE.test(alias)) {
                    singleCharOwners.set(alias, (singleCharOwners.get(alias) ?? 0) + 1);
                }
            }
        }
        const collectAliases = (text: string, maxCharacters = Infinity): string[] => {
            const found = new Set<string>();
            let matchedChars = 0;
            for (const ch of characters) {
                const allNames = [ch.name, ...ch.aliases].filter((a) => a.trim().length >= 1);
                if (allNames.some((alias) => textMatchesAlias(text, alias, singleCharOwners))) {
                    matchedChars++;
                    for (const alias of allNames) {
                        if (alias.length >= 2 || singleCharOwners.get(alias) === 1) found.add(alias);
                    }
                    if (matchedChars >= maxCharacters) break;
                }
            }
            if (!found.size) {
                for (const person of sources.people) {
                    if (person.length >= 2 && text.includes(person)) {
                        found.add(person);
                        if (found.size >= maxCharacters) break;
                    }
                }
            }
            return [...found];
        };

        let targetAliases = collectAliases(userPrompt);
        if (!targetAliases.length && GROUP_OR_COREF_PRONOUN_RE.test(userPrompt)) {
            const priorAssistant = [...recentMessages]
                .reverse()
                .filter((m) => m.settled && !m.hidden && m.role === 'assistant' && m.text.trim() && (latestUser ? m.floor < latestUser.floor : true));
            for (const msg of priorAssistant.slice(0, 2)) {
                const resolved = collectAliases(narrative(msg.text), 3);
                if (resolved.length) {
                    targetAliases = resolved;
                    break;
                }
            }
        }
        return { userPrompt, targetAliases };
    } catch {
        return { userPrompt: '', targetAliases: [] };
    }
}

function hasActiveMediaSlot(values: Record<string, unknown> | undefined): boolean {
    const slots = values?.replyMedia;
    if (!Array.isArray(slots)) return false;
    return slots.some((slot) => {
        if (!slot || typeof slot !== 'object') return false;
        const status = (slot as { status?: unknown }).status;
        return status === 'ready' || status === 'developing';
    });
}

async function canAutoIllustrate(
    api: {
        settings: PluginApi['settings'];
        storage: Pick<PluginApi['storage'], 'read' | 'readAt'>;
    },
    route: RouteAddress,
    currentFloor: number | undefined,
    hasExplicit: boolean,
    recentMessages: readonly RecentMessage[] = [],
): Promise<{ allowed: boolean; remainingDaily: number; reason?: string }> {
    if (hasExplicit) return { allowed: true, remainingDaily: Infinity };
    if (api.settings.pacing === 'markers_only') return { allowed: false, remainingDaily: 0, reason: '仅卡片标记模式' };

    const device = await api.storage.read('device');
    const usage = (device.values.dailyUsage ?? {}) as { day?: string; count?: number };
    const limit = typeof api.settings.daily_limit === 'number' ? api.settings.daily_limit : 24;
    const usedToday = usage.day === localDay() && typeof usage.count === 'number' ? usage.count : 0;
    const remainingDaily = Math.max(0, limit - usedToday);
    if (remainingDaily <= 0) return { allowed: false, remainingDaily: 0, reason: `已达每日上限（${usedToday}/${limit}）` };

    const gap = pacingGap(api.settings.pacing);
    if (gap <= 0 || typeof currentFloor !== 'number') {
        return { allowed: true, remainingDaily };
    }

    const routeState = await api.storage.read('route');
    const priorAssistant = recentMessages
        .filter((m) => m.settled && !m.hidden && m.role === 'assistant' && m.floor < currentFloor)
        .sort((left, right) => left.floor - right.floor);

    const refFloors: number[] = [];
    const lastFloor = routeState.values.lastIllustratedFloor;
    if (typeof lastFloor === 'number' && lastFloor < currentFloor) {
        refFloors.push(lastFloor);
    }

    const pendingRaw = routeState.values.pendingIllustratedFloor;
    if (pendingRaw && typeof pendingRaw === 'object' && !Array.isArray(pendingRaw)) {
        const pending = pendingRaw as { floor?: unknown; at?: unknown };
        if (
            typeof pending.floor === 'number' &&
            typeof pending.at === 'number' &&
            pending.floor < currentFloor &&
            Date.now() - pending.at < PENDING_ILLUSTRATION_TTL_MS
        ) {
            refFloors.push(pending.floor);
        }
    }

    if (priorAssistant.length > 0) {
        const checks = await Promise.all(
            priorAssistant.slice(-gap).map(async (m) => {
                try {
                    const replyState = await api.storage.readAt({ route, reply: m.ref });
                    return hasActiveMediaSlot(replyState.values) ? m.floor : undefined;
                } catch {
                    return undefined;
                }
            }),
        );
        for (const floor of checks) {
            if (typeof floor === 'number') refFloors.push(floor);
        }
    }

    if (refFloors.length > 0) {
        const latestRef = Math.max(...refFloors);
        const intervening =
            priorAssistant.length > 0
                ? priorAssistant.filter((m) => m.floor > latestRef).length
                : Math.max(0, Math.floor((currentFloor - latestRef) / 2) - 1);
        if (intervening < gap) {
            return { allowed: false, remainingDaily: 0, reason: `受节律间隔限制（需间隔 ${gap} 轮，当前已隔 ${intervening} 轮）` };
        }
    }

    return { allowed: true, remainingDaily };
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
        const recentMessages = await readRecentMessages(api);
        const focus = await readUserFocus(api, recentMessages);
        const presentation = api.settings.presentation_mode === 'bookmark' ? 'bookmark' : 'editorial';

        if (event.paragraphCount > 4) {
            const selected = shots(event.settledText, false, { markersOnly, ...focus });
            if (selected.length < 2) {
                await logDiagnostic(api, `流式阶段二（${event.paragraphCount} 段）未命中第二镜头`);
                return;
            }
            const secondShot = selected[1];
            const hasExplicit = selected.some((item) => !!item.explicitPrompt);
            if (api.settings.pacing === 'restrained' && !hasExplicit) return;
            const gate = await canAutoIllustrate(api, event.route, event.draft.floor, hasExplicit, recentMessages);
            if (!gate.allowed) {
                await logDiagnostic(api, `流式阶段二跳过显影：${gate.reason ?? '节律或上限限制'}`);
                return;
            }
            const replyText = narrative(event.settledText).replace(/\s+/g, ' ').trim();
            await api.jobs.schedule(
                buildJobInput(event.route, event.draft.messageId, event.draft.swipeId, secondShot, 1, event.draft.floor, undefined, event.generationId, {
                    userPrompt: focus.userPrompt,
                    surrounding: surroundingContext(event.settledText, secondShot.index),
                    replyText,
                }),
            );
            await logDiagnostic(api, `流式抢跑命中第 ${secondShot.index + 1} 段（评分 ${secondShot.score}），已排入暗房显影`);
            await api.replyMedia.developing({
                slotId: 'shot-1',
                label: secondShot.part.slice(0, 80) || '暗房显影中…',
                aspectRatio: '3:2',
                palette: defaultPaletteForScene(secondShot.part),
                presentation,
                commandId: 'darkroom',
                anchor: { kind: 'paragraph', index: secondShot.index, excerpt: secondShot.part.slice(0, 28) },
            });
            return;
        }

        const shot = shots(event.settledText, true, { markersOnly, ...focus })[0];
        if (!shot) {
            await logDiagnostic(api, `流式阶段一（${event.paragraphCount} 段）未命中高置信镜头，等待全文保存后评估`);
            return;
        }

        const gate = await canAutoIllustrate(api, event.route, event.draft.floor, !!shot.explicitPrompt, recentMessages);
        if (!gate.allowed) {
            await logDiagnostic(api, `流式阶段一跳过显影：${gate.reason ?? '节律或上限限制'}`);
            return;
        }

        const replyText = narrative(event.settledText).replace(/\s+/g, ' ').trim();
        await api.jobs.schedule(
            buildJobInput(event.route, event.draft.messageId, event.draft.swipeId, shot, 0, event.draft.floor, undefined, event.generationId, {
                userPrompt: focus.userPrompt,
                surrounding: surroundingContext(event.settledText, shot.index),
                replyText,
            }),
        );
        await logDiagnostic(api, `流式抢跑命中第 ${shot.index + 1} 段（评分 ${shot.score}），已排入暗房显影`);

        await api.replyMedia.developing({
            slotId: 'shot-0',
            label: shot.part.slice(0, 80) || '暗房显影中…',
            aspectRatio: '3:2',
            palette: defaultPaletteForScene(shot.part),
            presentation,
            commandId: 'darkroom',
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
        const recentMessages = await readRecentMessages(api);
        const focus = await readUserFocus(api, recentMessages);
        let selected = shots(text, false, { markersOnly, ...focus });
        if (!selected.length) {
            await logDiagnostic(api, `第 ${message.floor} 楼全文未命中视觉镜头（焦点词：${focus.targetAliases.slice(0, 4).join('、') || '无'}）`);
            return;
        }

        const hasExplicit = selected.some((item) => !!item.explicitPrompt);
        if (api.settings.pacing === 'restrained' && !hasExplicit) {
            selected = selected.slice(0, 1);
        }

        const gate = await canAutoIllustrate(api, route, message.floor, hasExplicit, recentMessages);
        if (!gate.allowed) {
            await logDiagnostic(api, `第 ${message.floor} 楼跳过自动显影：${gate.reason ?? '节律或上限限制'}`);
            return;
        }

        let existingSlots: ReplyMediaItem[] = [];
        try {
            const replyState = await api.storage.readAt({ route, reply: event.reply });
            if (Array.isArray(replyState.values.replyMedia)) {
                existingSlots = replyState.values.replyMedia as unknown as ReplyMediaItem[];
            }
        } catch {
            // Best-effort check against already active slots on this reply.
        }

        const replyText = narrative(text).replace(/\s+/g, ' ').trim();
        let scheduledAuto = 0;
        let scheduledAnyAutoCandidate = false;
        let scheduledSlots = 0;
        for (const [index, shot] of selected.entries()) {
            const existing = existingSlots.find((item) => item.slotId === `shot-${index}`);
            if (existing && (existing.status === 'ready' || existing.status === 'developing')) {
                if (!shot.explicitPrompt) scheduledAnyAutoCandidate = true;
                continue;
            }
            if (!hasExplicit && scheduledAuto >= gate.remainingDaily) break;
            await api.jobs.schedule(
                buildJobInput(route, event.reply.messageId, event.reply.swipeId, shot, index, message.floor, event.reply, undefined, {
                    userPrompt: focus.userPrompt,
                    surrounding: surroundingContext(text, shot.index),
                    replyText,
                }),
            );
            scheduledSlots++;
            await logDiagnostic(api, `第 ${message.floor} 楼命中第 ${shot.index + 1} 段（评分 ${shot.score}），已排入暗房显影`);
            if (!shot.explicitPrompt) {
                scheduledAuto++;
                scheduledAnyAutoCandidate = true;
            }
        }
        if (!scheduledSlots && existingSlots.some((item) => item.status === 'ready' || item.status === 'developing')) {
            await logDiagnostic(api, `第 ${message.floor} 楼已有显影槽位，跳过重复排程`);
        }

        if (scheduledAnyAutoCandidate && !hasExplicit) {
            await api.storage.patch('route', {
                set: { pendingIllustratedFloor: { floor: message.floor, at: Date.now() } },
            });
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
        const clearPending = async () => {
            if (typeof payload.floor !== 'number') return;
            try {
                const routeSnapshot = await api.storage.read('route');
                const pending = routeSnapshot.values.pendingIllustratedFloor as { floor?: unknown } | undefined;
                if (pending && typeof pending === 'object' && pending.floor === payload.floor) {
                    await mutate(api, route, undefined, `${job.id}:clear-pending`, () => ({
                        pendingIllustratedFloor: null,
                    }));
                }
            } catch {
                // Ignore cleanup error on stale/aborted routes.
            }
        };

        const { image, chats, embedding } = await bindings(api);
        if (!image) {
            await clearPending();
            return;
        }

        const recentMessages = await readRecentMessages(api);
        if (!payload.isReroll && !payload.custom && !payload.explicitPrompt) {
            const gate = await canAutoIllustrate(api, route, payload.floor, false, recentMessages);
            if (!gate.allowed) {
                await clearPending();
                return;
            }
        }

        let target = job.target;
        const routeState = await api.storage.read('route');
        const participants = await api.story.participants();
        const sources = await api.story.visualSources();
        const registry = (routeState.values.castRegistry ?? {}) as unknown as Registry;
        const prevLedger = (routeState.values.ledger ?? {}) as LedgerState;

        let mvu: unknown;
        if (target) {
            try {
                mvu = (await api.story.state({ route, at: target, scope: 'message', path: ['stat_data'] })).value;
            } catch {
                // MVU stat_data is optional per card.
            }
        }

        const knownMap = new Map<string, KnownCharacter>();
        for (const ch of sources.characters ?? []) {
            knownMap.set(normalizeActorKey(ch.name), { name: ch.name, aliases: ch.aliases });
        }
        for (const rawName of [...sources.people, ...participants.map((p) => p.name), ...Object.keys(registry)]) {
            const clean = rawName?.trim();
            if (!clean) continue;
            const norm = normalizeActorKey(clean);
            if (!knownMap.has(norm)) knownMap.set(norm, { name: clean });
        }
        const knownCharacters = [...knownMap.values()];
        const recentTexts = recentMessages
            .filter((m) => m.settled && !m.hidden && (payload.floor === undefined || m.floor <= payload.floor))
            .map((m) => ({ floor: m.floor, text: narrative(m.text) }));

        let ledger = continuity(payload.scene, prevLedger, mvu, [], {
            floor: payload.floor,
            knownCharacters,
            replyText: payload.replyText,
            recentTexts,
        });
        const deceasedSet = resolveDeceasedSet(ledger, payload.floor);
        const deceasedNormSet = new Set([...deceasedSet].map(normalizeActorKey));
        for (const ch of knownCharacters) {
            if (deceasedNormSet.has(normalizeActorKey(ch.name))) {
                for (const alias of [ch.name, ...(ch.aliases ?? [])]) {
                    if (alias.trim()) deceasedNormSet.add(normalizeActorKey(alias));
                }
            }
        }
        const activeRegistry: Registry = Object.fromEntries(
            Object.entries(registry).filter(([key]) => !deceasedNormSet.has(normalizeActorKey(key))),
        );

        const corefContext = [payload.userPrompt, payload.surrounding].filter(Boolean).join('\n');
        const { actors: subjects, ensemble } = visualBible(
            participants,
            payload.scene,
            activeRegistry,
            [...sources.people],
            sources.profiles,
            sources.characters ?? [],
            [ledger.location, ledger.weather, ledger.lighting].filter(Boolean).join(' '),
            corefContext,
            { deceased: deceasedNormSet, replyContext: payload.replyText },
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
            subjects.length === 1 && subjects[0].name && !activeRegistry[subjects[0].name]
                ? 'solo portrait, medium close-up'
                : routeState.values.lastFraming === 'wide establishing shot'
                    ? 'medium close-up'
                    : 'wide establishing shot';

        const actorNames = subjects.map((actor) => actor.name).filter((name): name is string => !!name);
        ledger = continuity(payload.scene, ledger, mvu, actorNames, {
            floor: payload.floor,
            knownCharacters,
            replyText: payload.replyText,
        });
        const flashback =
            !payload.isReroll &&
            !payload.custom &&
            !payload.explicitPrompt &&
            /回到|重返|又来到|back at|return to/i.test(payload.scene);

        const scene = await recall(api, route, payload.scene, flashback ? undefined : embedding?.id).catch(() => ({
            prior: '',
            vector: undefined,
            mediaId: undefined,
            actors: undefined as string[] | undefined,
        }));
        const subjectNormSet = new Set(actorNames.map(normalizeActorKey));
        const recalledHasDeceased = (scene.actors ?? []).some((name) => deceasedNormSet.has(normalizeActorKey(name)));
        const recalledHasAbsent = (scene.actors ?? []).some((name) => !subjectNormSet.has(normalizeActorKey(name)));
        const safeSceneMediaId = scene.mediaId && !recalledHasDeceased && !recalledHasAbsent ? scene.mediaId : undefined;
        const safePriorScene = recalledHasDeceased ? '' : scene.prior;

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
            commandId: 'darkroom',
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

        if (flashback && safeSceneMediaId) {
            target ??= (await api.jobs.awaitReply()).reply;
            const reply = target;
            const mediaId = safeSceneMediaId;
            await mutate(api, route, reply, `${job.id}:flashback`, (state) => ({
                replyMedia: upsertSlot(state.replyMedia, {
                    ...initial,
                    status: 'ready',
                    commandId: 'darkroom',
                    subtitle: '场景记忆闪回',
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
                    const actorNameSet = new Set(
                        subjects.map((a) => a.name).filter((n): n is string => !!n && !deceasedNormSet.has(normalizeActorKey(n))),
                    );
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

            const shotLedger = filterLedgerForShot(ledger, actorNames);
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
                    ledger: shotLedger,
                    prior: safePriorScene,
                    framing,
                    userPrompt: payload.userPrompt,
                    priorReplyActors,
                    replyContext: payload.replyText,
                    deceasedNames: [...deceasedSet],
                });

            const aspectRatio = payload.aspectRatio ?? plan.aspectRatio;
            const taskId = await api.models.start({
                kind: 'image',
                connection: image.id,
                prompt: plan.prompt,
                ...(plan.negativePrompt && { negativePrompt: plan.negativePrompt }),
                aspectRatio,
                actors: plan.actors,
                ...(safeSceneMediaId && {
                    references: [{ role: 'composition', image: { source: 'media', id: safeSceneMediaId }, weight: 0.25 }],
                }),
            });

            const result = (await api.tasks.await(taskId)).result;
            if (result?.kind !== 'image') throw new Error('模型未返回插图');

            const id = result.media.id;
            const safeSeed =
                typeof result.seed === 'number' && Number.isFinite(result.seed)
                    ? Math.trunc(result.seed)
                    : undefined;
            const rawArchivedPrompt = !payload.custom && plan.actors.length
                ? [plan.prompt, ...plan.actors.map((actor) => `[${actor.name ?? '角色'}] ${actor.prompt}`)].join('\n')
                : plan.prompt;
            const archivedPrompt = rawArchivedPrompt.slice(0, 4000);
            const label = (plan.caption || initial.label).slice(0, 160);
            const subtitle = [
                plan.actors.map((actor) => actor.name).filter(Boolean).join(' · '),
                safeSeed !== undefined ? `Seed ${safeSeed}` : '',
            ].filter(Boolean).join(' · ').slice(0, 120);

            if (!target) {
                await api.replyMedia.developing({
                    slotId: payload.slot,
                    status: 'ready',
                    label,
                    ...(subtitle && { subtitle }),
                    commandId: 'darkroom',
                    aspectRatio,
                    palette: plan.palette,
                    presentation: resolvePresentation(api.settings.presentation_mode, plan.presentation),
                    anchor: initial.anchor,
                    takes: [{ id, ...(safeSeed !== undefined && { seed: safeSeed }), createdAt: Date.now(), prompt: archivedPrompt }],
                    activeTake: 0,
                }).catch(() => {});
                target = (await api.jobs.awaitReply()).reply;
            }
            let reply = target;
            const buildReadyPatch = (activeReply: MessageRef) => (state: Record<string, any>) => {
                const old: ReplyMediaItem =
                    (state.replyMedia as ReplyMediaItem[] | undefined)?.find((item) => item.slotId === payload.slot) ?? initial;
                const takes = [
                    ...(old.takes ?? []),
                    { id, ...(safeSeed !== undefined && { seed: safeSeed }), createdAt: Date.now(), prompt: archivedPrompt },
                ];
                return {
                    replyMedia: upsertSlot(state.replyMedia, {
                        ...old,
                        label: (plan.caption || old.label).slice(0, 160),
                        ...(subtitle && { subtitle }),
                        commandId: 'darkroom',
                        aspectRatio,
                        palette: plan.palette,
                        presentation: resolvePresentation(api.settings.presentation_mode, plan.presentation),
                        revision: activeReply.revision,
                        status: 'ready',
                        takes,
                        activeTake: takes.length - 1,
                    }),
                    ...(api.settings.override_wallpaper === true && {
                        stage: buildStageCue(activeReply.revision, id, true),
                    }),
                };
            };
            try {
                await mutate(api, route, reply, `${job.id}:ready`, buildReadyPatch(reply));
            } catch (commitError) {
                if (String((commitError as { code?: string }).code) !== 'STALE_REPLY') {
                    throw commitError;
                }
                const page = await api.story.readPage({ route, limit: 16 });
                const fresh = page.items.find(
                    (item) => item.ref.messageId === reply.messageId && item.ref.swipeId === reply.swipeId,
                );
                if (!fresh) throw commitError;
                reply = fresh.ref;
                await mutate(api, route, reply, `${job.id}:ready:retry`, buildReadyPatch(reply));
            }
            const settledMessage = await api.story.getMessage(reply).catch(() => null);
            const resolvedFloor = settledMessage?.floor ?? payload.floor;

            const nextLedger = mergeLedger(ledger, plan.ledgerPatch, payload.floor);
            const finalDeceasedNorm = new Set([...resolveDeceasedSet(nextLedger, payload.floor)].map(normalizeActorKey));
            for (const ch of knownCharacters) {
                if (finalDeceasedNorm.has(normalizeActorKey(ch.name))) {
                    for (const alias of [ch.name, ...(ch.aliases ?? [])]) {
                        if (alias.trim()) finalDeceasedNorm.add(normalizeActorKey(alias));
                    }
                }
            }
            const drawnActors = plan.actors.filter((a) => a.name && !finalDeceasedNorm.has(normalizeActorKey(a.name)));
            await mutate(api, route, undefined, `${job.id}:continuity`, (state) => {
                const nextRegistry = { ...(state.castRegistry as Registry | undefined) };
                for (const key of Object.keys(nextRegistry)) {
                    if (finalDeceasedNorm.has(normalizeActorKey(key))) delete nextRegistry[key];
                }
                const firstActor = drawnActors[0];
                const hasOfficialRef = firstActor?.reference && firstActor.reference.source !== 'media';
                if (ensemble && drawnActors.length === 1 && firstActor?.name && framing.includes('portrait') && !hasOfficialRef && !nextRegistry[firstActor.name]) {
                    nextRegistry[firstActor.name] = { canonicalMediaId: id };
                }
                return {
                    ledger: nextLedger,
                    castRegistry: nextRegistry,
                    lastFraming: framing,
                    pendingIllustratedFloor: null,
                    ...(typeof resolvedFloor === 'number' && { lastIllustratedFloor: resolvedFloor }),
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
                documents: [{
                    id,
                    text: payload.scene.slice(0, 1800),
                    vector: scene.vector,
                    value: {
                        mediaId: id,
                        route: sceneKey(route),
                        actors: drawnActors.map((a) => a.name!).filter(Boolean),
                    },
                }],
            });
        } catch (error) {
            await clearPending();
            await mark('failed').catch(() => {});
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
            const rawText = await fullText(api, route, input.target);
            const anchorIndex = slot.anchor?.kind === 'paragraph' ? slot.anchor.index : undefined;
            const extracted = extractShotFromReply(rawText, anchorIndex);
            const targetMsg = await api.story.getMessage(input.target).catch(() => null);
            await api.jobs.schedule({
                key: `reroll:${input.target.messageId}:${slot.slotId}:${Date.now()}`,
                route,
                target: input.target,
                payload: {
                    slot: slot.slotId,
                    scene: extracted.scene.slice(0, 5000) || slot.label,
                    index: extracted.index,
                    ...(targetMsg && { floor: targetMsg.floor }),
                    ...(extracted.replyText && { replyText: extracted.replyText.slice(0, 2200) }),
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

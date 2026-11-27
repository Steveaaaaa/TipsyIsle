import type { AspectRatio, CommandInput, Immutable, Panel, PluginApi, ReplyMediaItem, RouteAddress, SurfaceBlock } from '@tipsy-isle/plugin-sdk';
import { mutate } from './continuity-ledger';
import { extractShotFromReply, sanitizeCaption } from './tension-gate';

export async function frames(api: Pick<PluginApi, 'context' | 'storage'> & { story: Pick<PluginApi['story'], 'readMessages'> }) {
    const route = api.context.route;
    if (!route) return [];
    const page = await api.story.readMessages({ limit: 16 });
    const result: { text: string; mediaId?: string; floor: number; label?: string }[] = [];
    for (const message of page.messages) {
        const state = await api.storage.readAt({ route, reply: message.ref });
        const slots = (state.values.replyMedia as unknown as ReplyMediaItem[] | undefined) ?? [];
        const item = slots[0];
        result.push({
            text: message.text.slice(0, 3000),
            floor: message.floor,
            label: item?.label ? sanitizeCaption(item.label, '剧情插图', 100) : undefined,
            mediaId: item?.takes?.[item.activeTake ?? 0]?.id,
        });
    }
    return result;
}

export async function studio(api: PluginApi, action?: string): Promise<Panel> {
    if (action === 'export' && api.context.route) {
        await api.ui.export({ title: '浮光 · 本线纪事', route: api.context.route });
    }
    const pages = await frames(api);
    const images = pages.filter((page) => page.mediaId);
    const sources = await api.story.visualSources().catch(() => null);
    const refCharacters = (sources?.characters ?? []).filter((c) => c.references.length > 0);
    const headerBlocks: SurfaceBlock[] = [];
    const badgeItems: { label: string; value?: string; tone?: 'default' | 'accent' | 'muted' }[] = [
        { label: '已定格底片', value: `${images.length} 帧`, tone: images.length ? 'accent' : 'muted' },
    ];
    if (refCharacters.length) {
        badgeItems.push({
            label: `角色档案 (${refCharacters.length})`,
            value: refCharacters.map((c) => c.name).join('、').slice(0, 100),
            tone: 'default',
        });
    }
    headerBlocks.push({ type: 'badges', items: badgeItems });

    const maxMediaBlocks = 16 - headerBlocks.length;
    const shownImages = images.length > maxMediaBlocks ? images.slice(-maxMediaBlocks) : images;
    return {
        title: '本线胶片轨',
        theme: 'darkroom',
        eyebrow: '浮光 · STORY FILMSTRIP',
        subtitle: '本条故事线已显影的银盐底片与角色视觉定妆档案。',
        blocks: [
            ...headerBlocks,
            ...(shownImages.length
                ? shownImages.map((page) => ({
                    type: 'media' as const,
                    id: page.mediaId!,
                    label: `第 ${page.floor} 楼 · ${page.label || '剧情插图'}`.slice(0, 100),
                }))
                : [{ type: 'notice' as const, tone: 'info' as const, text: '本线还没有留下胶片底片。在插件权限中勾选一个生图连接后，继续对话即可自动显影。' }]),
        ],
        actions: images.length ? [{ id: 'export', label: '导出离线图文纪事', kind: 'primary', icon: 'download' }] : [],
    };
}

export async function darkroomPanel(
    api: PluginApi,
    input: Immutable<CommandInput>,
    cueFn: (revision: string, mediaId: string, override: boolean) => Record<string, unknown>,
    fullTextFn: (route: RouteAddress, ref: NonNullable<CommandInput['target']>) => Promise<string>,
): Promise<Panel> {
    const route = api.context.route;
    const target = input.target;
    if (!route || !target) {
        return {
            title: '暗房精修台',
            theme: 'darkroom',
            eyebrow: '浮光 · LUMINA DARKROOM',
            blocks: [{ type: 'notice', tone: 'info', text: '请从一条角色回复的消息菜单打开暗房精修台。' }],
        };
    }

    const stored = await api.storage.readAt({ route, reply: target });
    const slots = (stored.values.replyMedia as unknown as ReplyMediaItem[] | undefined) ?? [];
    const primary = slots[0];
    let takes = primary?.takes ?? [];
    let activeIdx = takes.length ? Math.min(primary?.activeTake ?? 0, takes.length - 1) : 0;
    let activeTake = takes[activeIdx];

    let notice = '';
    const actionId = input.action?.id;
    const values = input.action?.values ?? {};

    const aspectOptions = [
        { value: '3:2', label: '电影标准 · 3:2' },
        { value: '16:9', label: '宽屏事件 · 16:9' },
        { value: '21:9', label: '超宽银幕 · 21:9' },
        { value: '4:3', label: '叙事中景 · 4:3' },
        { value: '3:4', label: '竖幅人像 · 3:4' },
        { value: '2:3', label: '竖幅半身 · 2:3' },
        { value: '9:16', label: '竖屏全画幅 · 9:16' },
        { value: '1:1', label: '方形抓拍 · 1:1' },
    ];
    const validRatios = new Set(aspectOptions.map((o) => o.value));
    const initialRatio = primary?.aspectRatio && validRatios.has(primary.aspectRatio) ? primary.aspectRatio : '3:2';

    if (actionId === 'select_take' && primary && takes.length > 1) {
        const picked = Number(values.value ?? values.index ?? activeIdx);
        if (Number.isInteger(picked) && picked >= 0 && picked < takes.length && picked !== activeIdx) {
            await mutate(api, route, target, `darkroom-select:${Date.now()}`, (current) => {
                const list = (current.replyMedia as ReplyMediaItem[] | undefined) ?? [];
                return {
                    replyMedia: list.map((item) =>
                        item.slotId === primary.slotId ? { ...item, activeTake: picked } : item,
                    ),
                };
            });
            activeIdx = picked;
            activeTake = takes[activeIdx];
        }
    } else if (actionId === 'develop') {
        const rawScene = await fullTextFn(route, target);
        const anchorIndex = primary?.anchor?.kind === 'paragraph' ? primary.anchor.index : undefined;
        const extracted = extractShotFromReply(rawScene, anchorIndex);
        const customPrompt = String(values.prompt ?? '').trim().slice(0, 1400);
        const rawRatio = String(values.aspect_ratio ?? values.aspectRatio ?? initialRatio);
        const aspectRatio = (validRatios.has(rawRatio) ? rawRatio : '3:2') as AspectRatio;
        await api.jobs.schedule({
            route,
            target,
            key: `refine:${target.messageId}:${Date.now()}`,
            payload: {
                slot: primary?.slotId ?? 'shot-0',
                index: extracted.index,
                scene: extracted.scene.slice(0, 3000) || sanitizeCaption(primary?.label ?? '', '叙事瞬间', 100),
                ...(extracted.replyText && { replyText: extracted.replyText.slice(0, 2200) }),
                ...(customPrompt ? { custom: customPrompt } : {}),
                aspectRatio,
            },
        });
        notice = '已投入暗房显影队列，新帧完成后会自动追加到本楼胶片叠中。';
    } else if (actionId === 'stage' && activeTake?.id) {
        await mutate(api, route, target, `darkroom-stage:${Date.now()}`, () => ({
            stage: cueFn(target.revision, activeTake.id, true),
        }));
        notice = '已将当前选中帧设为本幕舞台背景。';
    } else if (actionId === 'prune' && primary && takes.length > 1 && activeTake) {
        await mutate(api, route, target, `darkroom-prune:${Date.now()}`, (current) => {
            const list = (current.replyMedia as ReplyMediaItem[] | undefined) ?? [];
            return {
                replyMedia: list.map((item) =>
                    item.slotId === primary.slotId ? { ...item, takes: [activeTake], activeTake: 0 } : item,
                ),
            };
        });
        takes = [activeTake];
        activeIdx = 0;
        notice = '已清理本楼其余落选帧，仅保留当前选中底片。';
    }

    const stageState = stored.values.stage as { backdropMediaId?: string; overrideThemeWallpaper?: boolean } | undefined;
    const isCurrentStage = Boolean(activeTake?.id && stageState?.overrideThemeWallpaper && stageState.backdropMediaId === activeTake.id);
    const cleanSceneLabel = sanitizeCaption(primary?.label ?? '', '银盐显影底片', 100);

    const blocks: SurfaceBlock[] = [];
    if (notice) {
        blocks.push({ type: 'notice', tone: 'success', text: notice });
    }
    if (activeTake?.id) {
        blocks.push({
            type: 'media',
            id: activeTake.id,
            label: cleanSceneLabel,
            caption: primary?.subtitle?.slice(0, 240),
            meta: `FRAME ${String(activeIdx + 1).padStart(2, '0')} / ${String(takes.length).padStart(2, '0')}`.slice(0, 120),
            featured: true,
        });
        const badges: { label: string; value?: string; tone?: 'default' | 'accent' | 'muted' }[] = [
            { label: '画幅', value: initialRatio, tone: 'accent' },
            ...(activeTake.seed !== undefined ? [{ label: 'Seed', value: String(activeTake.seed), tone: 'default' as const }] : []),
            ...(isCurrentStage ? [{ label: '状态', value: '本幕舞台生效中', tone: 'accent' as const }] : []),
        ];
        blocks.push({ type: 'badges', items: badges });
        if (takes.length > 1) {
            const stripStart = Math.max(0, takes.length - 12);
            const stripTakes = takes.slice(stripStart);
            blocks.push({
                type: 'filmstrip',
                label: '本楼底片轨（点选切换定格）',
                items: stripTakes.map((take, offset) => {
                    const realIdx = stripStart + offset;
                    return {
                        id: take.id,
                        label: `第 ${realIdx + 1} 帧`,
                        caption: take.seed !== undefined ? `Seed ${take.seed}` : undefined,
                        active: realIdx === activeIdx,
                        actionId: 'select_take',
                        value: String(realIdx),
                    };
                }),
            });
        }
    } else {
        blocks.push({ type: 'notice', tone: 'info', text: '本楼尚未生成插图，可在下方直接描述画面并投入暗房显影。' });
    }

    return {
        title: '暗房精修台',
        theme: 'darkroom',
        eyebrow: '浮光 · LUMINA DARKROOM',
        subtitle: '微调银盐镜头描述与画幅比例，追加显影新帧或切换本幕舞台。',
        blocks,
        fields: [
            {
                id: 'prompt',
                label: '镜头描述',
                placeholder: '填写希望重绘或微调的画面细节；留空则由导演自动分析本楼剧情…',
                hint: '支持英文或中文分镜词条，保留角色特征并叠加光影构图指示。',
                type: 'textarea',
                initial: (activeTake?.prompt ?? '').slice(0, 4000),
            },
            {
                id: 'aspect_ratio',
                label: '画幅比例',
                type: 'select',
                variant: 'aspect',
                initial: initialRatio,
                options: aspectOptions,
            },
        ],
        actions: [
            { id: 'develop', label: '追加显影一镜', kind: 'primary', icon: 'sparkle' },
            ...(activeTake?.id ? [{ id: 'stage', label: isCurrentStage ? '重设舞台背景' : '设为本幕舞台', kind: 'secondary' as const, icon: 'stage' as const }] : []),
            ...(takes.length > 1 ? [{ id: 'prune', label: '仅保留当前帧', kind: 'danger' as const, icon: 'trash' as const }] : []),
        ],
    };
}

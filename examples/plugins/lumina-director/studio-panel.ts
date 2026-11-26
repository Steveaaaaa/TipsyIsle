import type { AspectRatio, CommandInput, Immutable, Panel, PluginApi, ReplyMediaItem, RouteAddress } from '@tipsy-isle/plugin-sdk';
import { mutate } from './continuity-ledger';
import { extractShotFromReply } from './tension-gate';

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
            label: item?.label,
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
    const refSummary = refCharacters.length
        ? [{
            type: 'text' as const,
            text: `已识别角色参考图档案（${refCharacters.length} 位）：${refCharacters.map((c) => c.name).join('、')}`.slice(0, 4000),
        }]
        : [];
    const maxMediaBlocks = 16 - refSummary.length;
    const shownImages = images.length > maxMediaBlocks ? images.slice(-maxMediaBlocks) : images;
    return {
        title: '本线胶片轨',
        blocks: [
            ...refSummary,
            ...(shownImages.length
                ? shownImages.map((page) => ({
                    type: 'media' as const,
                    id: page.mediaId!,
                    label: `第 ${page.floor} 楼 · ${page.label || '剧情插图'}`.slice(0, 100),
                }))
                : [{ type: 'text' as const, text: '本线还没有留下胶片底片。在插件权限中勾选一个生图连接后，继续对话即可自动显影。' }]),
        ],
        actions: images.length ? [{ id: 'export', label: '导出离线图文纪事', kind: 'primary' }] : [],
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
        return { title: '暗房精修台', blocks: [{ type: 'text', text: '请从一条角色回复的消息菜单打开暗房精修台。' }] };
    }

    const stored = await api.storage.readAt({ route, reply: target });
    const slots = (stored.values.replyMedia as unknown as ReplyMediaItem[] | undefined) ?? [];
    const primary = slots[0];
    const takes = primary?.takes ?? [];
    const activeIdx = takes.length ? Math.min(primary?.activeTake ?? 0, takes.length - 1) : 0;
    const activeTake = takes[activeIdx];

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

    if (actionId === 'develop') {
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
                scene: extracted.scene.slice(0, 3000) || primary?.label || '叙事瞬间',
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
        notice = '已清理本楼其余落选帧，仅保留当前选中底片。';
    }

    return {
        title: '暗房精修台',
        blocks: [
            ...(notice ? [{ type: 'text' as const, text: notice }] : []),
            ...(activeTake?.id
                ? [
                    {
                        type: 'media' as const,
                        id: activeTake.id,
                        label: `当前第 ${activeIdx + 1}/${takes.length} 帧${activeTake.seed !== undefined ? ` · Seed ${activeTake.seed}` : ''}`.slice(0, 100),
                    },
                ]
                : [{ type: 'text' as const, text: '本楼尚未生成插图，可在下方直接描述画面并显影。' }]),
        ],
        fields: [
            {
                id: 'prompt',
                label: '镜头描述（留空则由导演自动分析本楼）',
                type: 'textarea',
                initial: (activeTake?.prompt ?? '').slice(0, 4000),
            },
            {
                id: 'aspect_ratio',
                label: '画幅比例',
                type: 'select',
                initial: initialRatio,
                options: aspectOptions,
            },
        ],
        actions: [
            { id: 'develop', label: '追加显影一镜', kind: 'primary' },
            ...(activeTake?.id ? [{ id: 'stage', label: '设为本幕舞台' }] : []),
            ...(takes.length > 1 ? [{ id: 'prune', label: '仅保留当前帧' }] : []),
        ],
    };
}

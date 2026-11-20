export const areas = {
    top: '顶栏', sidebar: '馆藏底部', conversation: '会话工具栏', toolbar: '输入工具栏', more: '更多菜单',
    'input-before': '输入框左侧', 'input-after': '输入框右侧', mobile: '手机主导航',
} as const;
export type Area = keyof typeof areas;
export type Device = 'desktop' | 'mobile';
export const parts = {
    focus: ['专注阅读', 'top'], settings: ['设置', 'top'], appearance: ['外观', 'sidebar'], 'sidebar-settings': ['馆藏设置', 'sidebar'],
    routes: ['故事路线', 'conversation'], profile: ['个人资料', 'conversation'], history: ['会话与分支', 'conversation'], 'new-chat': ['新对话', 'conversation'],
    reading: ['简洁阅读', 'toolbar'], continue: ['继续故事', 'toolbar'], regenerate: ['重新生成', 'toolbar'],
    'recalculate': ['重算变量', 'more'], 'retry-analysis': ['重试额外解析', 'more'],
    'mobile-library': ['馆藏', 'mobile'], 'mobile-chat': ['对话', 'mobile'], 'mobile-appearance': ['外观', 'mobile'], 'mobile-settings': ['设置', 'mobile'],
} as const satisfies Record<string, readonly [string, Area]>;
export type Part = keyof typeof parts;
export type Layout = Partial<Record<Area, string[]>>;
export const defaultText = {
    name: '微醺屿', subtitle: 'TipsyIsle', window: '', workspace: '我的空间', location: '故事与对话', library: '故事馆藏',
    empty: '把你想体验的故事带到这里', 'empty-library': '选一个故事，继续你的旅程', 'startup-title': '留一点时间，给另一个世界。',
    'startup-status': '正在准备你的故事…', input: '写下对白或行动…', hint: '故事的下一步，由你决定。', send: '发送', stop: '停止', more: '更多', import: '导入',
} as const;
export const textLabels: Record<keyof typeof defaultText, string> = {
    name: '软件名称', subtitle: '顶栏副标题', window: '浏览器标签标题', workspace: '空间名称', location: '顶栏位置', library: '馆藏标题',
    empty: '空白页标题', 'empty-library': '有馆藏时的空白页标题', 'startup-title': '启动副标题', 'startup-status': '启动进度文案',
    input: '输入框提示', hint: '输入栏说明', send: '发送按钮', stop: '停止按钮', more: '更多按钮', import: '导入按钮',
};
export const artLabels = { logo: '顶栏标志', welcome: '空白页插画', startup: '启动画面素材', send: '发送图标', stop: '停止图标', more: '更多图标' } as const;
export const fontLabels = { ui: '界面', heading: '标题', composer: '输入框' } as const;
export type FontRole = keyof typeof fontLabels;
export type AppearanceAsset = { name: string; mime: string; data: string };
export type WidgetValue = '' | 'character' | 'messages' | 'library' | 'time';
export const widgetValues: Record<WidgetValue, string> = { '': '无', character: '当前故事', messages: '当前会话消息数', library: '馆藏故事数', time: '本地时间' };
export type Widget = { id: string; label: string; image: string; value: WidgetValue; action: '' | 'routes' | 'settings' | 'appearance' };
export interface Appearance {
    version: 1;
    name: string;
    text: Partial<Record<keyof typeof defaultText | Part, string>>;
    art: Record<string, string>;
    assets: Record<string, AppearanceAsset>;
    fonts: Partial<Record<FontRole, { family: string; asset: string; size: number }>>;
    wallpaper: { source: string; fit: 'cover' | 'contain' | 'tile'; position: string; shade: number };
    layout: Record<Device, Layout>;
    widgets: Widget[];
    css: string;
}
export const blankAppearance = (): Appearance => ({ version: 1, name: '我的外观', text: {}, art: {}, assets: {}, fonts: {},
    wallpaper: { source: '', fit: 'cover', position: 'center', shade: 0 }, layout: { desktop: {}, mobile: {} }, widgets: [], css: '' });
export const textOf = (skin: Appearance | undefined, key: keyof typeof defaultText): string => skin?.text[key] ?? defaultText[key];
export const partText = (skin: Appearance | undefined, key: Part, fallback?: string): string => skin?.text[key] ?? fallback ?? parts[key][0];
export const assetUrl = (skin: Appearance | undefined, id?: string): string | undefined => skin && id && Object.hasOwn(skin.assets, id) ? skin.assets[id].data : undefined;
export function wallpaperUrl(skin: Appearance): string | undefined {
    const source = skin.wallpaper.source;
    return assetUrl(skin, source) ?? (/^(?:https?:\/\/|data:image\/(?:png|jpeg|webp|gif|avif);base64,)/i.test(source) ? source : undefined);
}
export function placements(skin: Appearance | undefined, device: Device, local?: Layout): Record<Area, string[]> {
    const result = Object.fromEntries(Object.keys(areas).map(area => [area, []])) as unknown as Record<Area, string[]>;
    const widgets = new Set(skin?.widgets.map(widget => widget.id));
    const assigned = new Set<string>();
    const add = (area: Area, ids: string[]) => {
        for (const id of ids) {
            if (assigned.has(id)) continue;
            if (Object.hasOwn(parts, id) ? !allowedAreas(id as Part, device).includes(area) : !widgets.has(id)) continue;
            result[area].push(id); assigned.add(id);
        }
    };
    for (const layout of [local, skin?.layout[device]]) if (layout) {
        for (const area of Object.keys(areas) as Area[]) add(area, layout[area] ?? []);
    }
    for (const id of Object.keys(parts) as Part[]) {
        if (device === 'mobile' && id === 'settings') continue;
        add(parts[id][1], [id]);
    }
    if (skin) add('sidebar', skin.widgets.map(widget => widget.id));
    return result;
}
export function allowedAreas(id: Part, device: Device): Area[] {
    if (id.startsWith('mobile-')) return ['mobile'];
    if (device === 'mobile' && id === 'focus') return ['top'];
    return ['top', 'sidebar', 'conversation', 'toolbar', 'more', 'input-before', 'input-after'];
}

export const shellSurfaces = ['topbar', 'library', 'conversation', 'history', 'composer-controls', 'composer-row', 'composer-hint',
    'navigation', 'settings', 'dialog', 'empty', 'startup', 'notifications', 'wallpaper', 'reply-control'] as const;

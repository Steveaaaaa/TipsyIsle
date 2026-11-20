import type { CardScript } from './contracts';

export type ScriptScope = 'global' | 'preset' | 'character';
export type ScriptTrees = Record<ScriptScope, any[]>;
export function normalizeScriptTrees(values: any[]): any[] {
    if (!Array.isArray(values)) throw new Error('脚本树必须是数组');
    return values.map(value => {
        const base = { ...value, type: value.type ?? (Array.isArray(value.scripts) ? 'folder' : 'script'),
            id: String(value.id ?? crypto.randomUUID()), name: String(value.name ?? ''), enabled: value.enabled ?? false };
        if (base.type === 'folder') return { ...base, icon: value.icon ?? 'fa-solid fa-folder', color: value.color ?? '', scripts: normalizeScriptTrees(value.scripts ?? []) };
        if (base.type !== 'script') throw new Error(`未知脚本类型：${base.type}`);
        return { ...base, content: String(value.content ?? ''), info: String(value.info ?? ''), data: value.data ?? {},
            button: { enabled: value.button?.enabled ?? true, buttons: (value.button?.buttons ?? []).map((button: any) => ({ name: String(button.name), visible: button.visible !== false })) },
            export_with: { data: value.export_with?.data ?? true, button: value.export_with?.button ?? true } };
    });
}
export function scriptsFromTrees(trees: unknown): CardScript[] {
    const result: CardScript[] = [];
    const visit = (items: any, enabled = true) => {
        if (!Array.isArray(items)) return;
        for (const item of items) {
            if (!item || typeof item !== 'object') continue;
            const active = enabled && item.enabled !== false;
            if (Array.isArray(item.scripts)) visit(item.scripts, active);
            else if (typeof item.content === 'string') result.push({ id: String(item.id ?? result.length), name: String(item.name ?? ''), info: String(item.info ?? ''), content: item.content,
                enabled: active, data: item.data ?? {}, buttons: item.button?.enabled !== false ? item.button?.buttons ?? [] : [] });
        }
    };
    visit(trees); return result;
}

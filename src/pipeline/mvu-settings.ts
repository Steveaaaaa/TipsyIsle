import * as z from 'zod';
import type { NormalizedLorebook } from '../types';
import { mvuFields } from '../registry/mvu-fields';

const overrideSchema = z.object({
    更新方式: z.enum(['随AI输出', '额外模型解析']).optional(),
    额外模型解析配置: z.object({ 启用自动请求: z.boolean().optional(), 世界书条目白名单正则: z.string().optional(),
        世界书条目黑名单正则: z.string().optional() }).loose().optional(),
    兼容性: z.object({ 更新到聊天变量: z.boolean().optional(), sendas不视为user消息: z.boolean().optional() }).loose().optional(),
}).loose();
type CharacterOverride = z.infer<typeof overrideSchema>;
const parsedBooks = new WeakMap<NormalizedLorebook, { override: CharacterOverride; warnings: string[] }>();
const defaults = Object.fromEntries(mvuFields.map(field => [field.id, field.defaultValue]));
export function mvuCharacterConfigEntries(book: NormalizedLorebook) {
    return book.entries.filter(entry => entry.disabled && entry.comment.trim().toLowerCase() === '[config_override]')
        .sort((a, b) => Number(a.rawData?.displayIndex ?? 0) - Number(b.rawData?.displayIndex ?? 0));
}
export function parseMvuCharacterConfig(content: string): CharacterOverride {
    const { schema: _schema, ...config } = overrideSchema.parse(JSON.parse(content));
    const extra = config.额外模型解析配置;
    if (extra) {
        for (const key of ['世界书条目白名单正则', '世界书条目黑名单正则'] as const) if (extra[key]?.trim() === '') delete extra[key];
        if (!Object.keys(extra).length) delete config.额外模型解析配置;
    }
    if (config.兼容性 && !Object.keys(config.兼容性).length) delete config.兼容性;
    return config;
}
export function serializeMvuCharacterConfig(content: string): string {
    return JSON.stringify({ ...parseMvuCharacterConfig(content), schema: { ...z.toJSONSchema(overrideSchema), title: 'CharacterSettingsOverride' } }, null, 4);
}
export function clearMvuCharacterOverrides(content: string): string {
    const config = parseMvuCharacterConfig(content);
    delete config.更新方式;
    if (config.额外模型解析配置) for (const key of ['启用自动请求', '世界书条目白名单正则', '世界书条目黑名单正则'] as const) delete config.额外模型解析配置[key];
    if (config.兼容性) for (const key of ['更新到聊天变量', 'sendas不视为user消息'] as const) delete config.兼容性[key];
    return JSON.stringify(parseMvuCharacterConfig(JSON.stringify(config)), null, 4);
}

/** Disabled primary-book config entries are data, never prompt instructions. */
export function readMvuCharacterSettings(book?: NormalizedLorebook) {
    if (!book) return { override: {} as CharacterOverride, warnings: [] as string[] };
    const cached = parsedBooks.get(book); if (cached) return cached;
    const entries = mvuCharacterConfigEntries(book);
    const warnings: string[] = [];
    if (entries.length > 1) warnings.push(`世界书「${book.name}」含多个 [config_override]，使用编辑顺序中的第一个。`);
    let override: CharacterOverride = {};
    if (entries[0]) {
        try {
            override = parseMvuCharacterConfig(entries[0].content);
        } catch (error) { warnings.push(`世界书「${book.name}」的角色配置无效，使用全局设置：${error instanceof Error ? error.message : String(error)}`); }
    }
    const result = { override, warnings }; parsedBooks.set(book, result); return result;
}

export function resolveMvuSettings(global: Record<string, unknown>, book?: NormalizedLorebook) {
    const { override, warnings } = readMvuCharacterSettings(book);
    const settings: Record<string, unknown> = { ...defaults, ...global };
    if (override.更新方式 !== undefined) settings['mvu.mode'] = override.更新方式;
    if (override.额外模型解析配置?.启用自动请求 !== undefined) settings['mvu.automatic'] = override.额外模型解析配置.启用自动请求;
    if (override.兼容性?.更新到聊天变量 !== undefined) settings['mvu.update_chat'] = override.兼容性.更新到聊天变量;
    if (override.兼容性?.sendas不视为user消息 !== undefined) settings['mvu.sendas_assistant'] = override.兼容性.sendas不视为user消息;
    settings['mvu.character_whitelist'] = override.额外模型解析配置?.世界书条目白名单正则 ?? '';
    settings['mvu.character_blacklist'] = override.额外模型解析配置?.世界书条目黑名单正则 ?? '';
    return { settings, warnings };
}

export function compileMvuRegex(source: string): { regex?: RegExp; error?: string } {
    const value = source.trim(); if (!value) return {};
    try {
        if (!value.startsWith('/')) return { regex: new RegExp(value) };
        const last = value.lastIndexOf('/');
        if (last <= 0) throw new Error('正则缺少结束斜杠');
        return { regex: new RegExp(value.slice(1, last), value.slice(last + 1)) };
    } catch (error) { return { error: error instanceof Error ? error.message : String(error) }; }
}

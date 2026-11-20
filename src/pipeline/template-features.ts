import { isSpecialWorldInfo, parseWorldInfoDecorators } from './worldinfo-decorators';
import type { LorebookEntry } from '../types';

/** Public feature names and defaults at the pinned Prompt Template revision. */
export const defaultTemplateFeatures = {
    enabled: true, generate_enabled: true, generate_loader_enabled: true,
    render_enabled: true, render_loader_enabled: true, with_context_disabled: false,
    debug_enabled: false, autosave_enabled: false, preload_worldinfo_enabled: true,
    code_blocks_enabled: false, raw_message_evaluation_enabled: true, filter_message_enabled: true,
    cache_enabled: 0, cache_size: 64, cache_hasher: 'h32ToString',
    inject_loader_enabled: false, invert_enabled: true, depth_limit: -1,
    compile_workers: false, sandbox: false, code_editor: false, preload_only: true,
};
export type TemplateFeatures = typeof defaultTemplateFeatures;

export function normalizeTemplateFeatures(value: unknown = {}): TemplateFeatures {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
    const result: Record<string, unknown> = { ...defaultTemplateFeatures };
    for (const [key, fallback] of Object.entries(defaultTemplateFeatures)) {
        if (!Object.hasOwn(source, key)) continue;
        const selected = source[key];
        if (typeof selected !== typeof fallback || typeof selected === 'number' && !Number.isFinite(selected)) throw new Error(`提示词模板设置 ${key} 的类型无效`);
        result[key] = selected;
    }
    for (const key of ['cache_enabled', 'cache_size', 'depth_limit']) if (!Number.isInteger(result[key])) throw new Error(`提示词模板设置 ${key} 必须是整数`);
    if (![0, 1, 2].includes(result.cache_enabled as number) || (result.cache_size as number) < 0 || (result.cache_size as number) > 4096
        || (result.depth_limit as number) < -1 || !['h32ToString', 'h64ToString'].includes(result.cache_hasher as string)) throw new Error('提示词模板缓存或楼层深度设置超出有效范围');
    return result as TemplateFeatures;
}

export function templateEntryEnabled(entry: LorebookEntry, features: TemplateFeatures): boolean {
    if (parseWorldInfoDecorators(entry.content).has('always_enabled')) return true;
    return features.invert_enabled && isSpecialWorldInfo(entry) ? !!entry.disabled : !entry.disabled;
}

/** Older workspaces used these behaviours before a settings contract existed.
 * Make them explicit once; new workspaces use the pinned plugin's defaults. */
export const legacyTemplateFeatures: Partial<TemplateFeatures> = {
    invert_enabled: false, preload_only: false, inject_loader_enabled: true,
    raw_message_evaluation_enabled: false, code_blocks_enabled: true, filter_message_enabled: false,
};

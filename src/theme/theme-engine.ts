/**
 * TipsyIsle Three-Tier Theme & Deep Customization Engine:
 * - Layer 1: CSS Design Tokens (wallpaper, glassmorphism blur, opacity, radius, typography, portrait placement)
 * - Layer 2: Layout Mode Templates (`tipsy-bubble`, `novel-reader`, `adv-galgame`, `im-messenger`)
 * - Layer 3: Scoped Custom CSS AST Sanitizer & Injector (`#tipsy-isle-stage`)
 */

import { createReactiveStore } from '../store/reactive-store';
import { platformStorage } from '../core/platform-bridge';
import type { LayoutMode, ThemeDesignTokens, ThemePresetPackage } from '../types';

export const BUILTIN_THEME_PRESETS: ThemePresetPackage[] = [
    {
        id: 'isle-daylight',
        name: '晴昼',
        author: 'TipsyIsle',
        description: '雾白与石墨灰，清晰、舒展的日间阅读。',
        layoutMode: 'tipsy-bubble',
        tokens: {
            accentColor: '#4263a6', bgPrimary: '#f5f6f8', bgSurface: '#ffffff',
            textPrimary: '#252d3b', textMuted: '#626d7f', wallpaperUrl: '',
            backdropBlurPx: 0, cardOpacity: 1, borderRadiusPx: 14,
            fontFamilyBody: 'system-ui, -apple-system, BlinkMacSystemFont, sans-serif',
            fontFamilyMono: "'Cascadia Code', 'SFMono-Regular', Consolas, monospace",
            fontSizePx: 16, lineHeight: 1.9, chatMaxWidthPx: 820, portraitPlacement: 'left-bubble',
        },
        scopedCustomCss: '',
    },
    {
        id: 'isle-nightfall',
        name: '夜航',
        author: 'TipsyIsle',
        description: '沉静的蓝灰底色，适合夜晚的长篇对话。',
        layoutMode: 'tipsy-bubble',
        tokens: {
            accentColor: '#a5bcee', bgPrimary: '#171c26', bgSurface: '#202733',
            textPrimary: '#e5e9f0', textMuted: '#a2aec0', wallpaperUrl: '',
            backdropBlurPx: 0, cardOpacity: 1, borderRadiusPx: 14,
            fontFamilyBody: 'system-ui, -apple-system, BlinkMacSystemFont, sans-serif',
            fontFamilyMono: "'Cascadia Code', 'SFMono-Regular', Consolas, monospace",
            fontSizePx: 16, lineHeight: 1.9, chatMaxWidthPx: 820, portraitPlacement: 'left-bubble',
        },
        scopedCustomCss: '',
    },
    {
        id: 'tipsy-moonlight',
        name: '月色',
        author: 'TipsyIsle',
        description: '深蓝与琥珀的经典配色，保留熟悉的阅读氛围。',
        layoutMode: 'tipsy-bubble',
        tokens: {
            accentColor: '#e9a679',
            bgPrimary: '#0c1018',
            bgSurface: 'rgba(20, 26, 39, 0.78)',
            textPrimary: '#f3efe8',
            textMuted: '#99a4b8',
            wallpaperUrl: '',
            backdropBlurPx: 18,
            cardOpacity: 0.84,
            borderRadiusPx: 16,
            fontFamilyBody: "'Noto Serif SC', 'PingFang SC', 'Microsoft YaHei', sans-serif",
            fontFamilyMono: "'JetBrains Mono', 'Cascadia Code', monospace",
            fontSizePx: 15.5,
            lineHeight: 1.76,
            chatMaxWidthPx: 920,
            portraitPlacement: 'left-bubble',
        },
        scopedCustomCss: `/* 可在此编写针对气泡或状态栏的自定义 CSS */
.ttm-msg-card.is-assistant {
  box-shadow: 0 10px 32px -12px rgba(233, 166, 121, 0.16);
}`,
    },
    {
        id: 'ink-paper-novel',
        name: '书卷',
        author: 'TipsyIsle',
        description: '暖灰书页与衬线正文，适合连贯的小说阅读。',
        layoutMode: 'novel-reader',
        tokens: {
            accentColor: '#c98860',
            bgPrimary: '#161412',
            bgSurface: 'rgba(31, 28, 24, 0.86)',
            textPrimary: '#ebe3d5',
            textMuted: '#9e9283',
            wallpaperUrl: '',
            backdropBlurPx: 12,
            cardOpacity: 0.9,
            borderRadiusPx: 10,
            fontFamilyBody: "'Songti SC', 'Noto Serif SC', 'Source Han Serif SC', serif",
            fontFamilyMono: "'JetBrains Mono', monospace",
            fontSizePx: 16.5,
            lineHeight: 1.92,
            chatMaxWidthPx: 820,
            portraitPlacement: 'right-standing',
        },
        scopedCustomCss: `.ttm-msg-prose p { text-indent: 2em; margin-bottom: 0.85em; }`,
    },
    {
        id: 'galgame-stage',
        name: '星汐',
        author: 'TipsyIsle',
        description: '深蓝舞台与清晰台词框，让对白成为焦点。',
        layoutMode: 'adv-galgame',
        tokens: {
            accentColor: '#79b8ff',
            bgPrimary: '#090d16',
            bgSurface: 'rgba(13, 19, 34, 0.82)',
            textPrimary: '#f0f6ff',
            textMuted: '#8ba2c4',
            wallpaperUrl: '',
            backdropBlurPx: 22,
            cardOpacity: 0.78,
            borderRadiusPx: 20,
            fontFamilyBody: "'PingFang SC', 'HarmonyOS Sans SC', 'Microsoft YaHei', sans-serif",
            fontFamilyMono: "'JetBrains Mono', monospace",
            fontSizePx: 16,
            lineHeight: 1.72,
            chatMaxWidthPx: 1020,
            portraitPlacement: 'stage-backdrop',
        },
        scopedCustomCss: ``,
    },
    {
        id: 'modern-im',
        name: '私语',
        author: 'TipsyIsle',
        description: '柔紫点缀与交错气泡，适合日常聊天。',
        layoutMode: 'im-messenger',
        tokens: {
            accentColor: '#a78bfa',
            bgPrimary: '#0e1017',
            bgSurface: 'rgba(24, 27, 38, 0.88)',
            textPrimary: '#f4f4f6',
            textMuted: '#8e95ab',
            wallpaperUrl: '',
            backdropBlurPx: 16,
            cardOpacity: 0.92,
            borderRadiusPx: 18,
            fontFamilyBody: "-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Microsoft YaHei', sans-serif",
            fontFamilyMono: "'JetBrains Mono', monospace",
            fontSizePx: 15,
            lineHeight: 1.65,
            chatMaxWidthPx: 860,
            portraitPlacement: 'left-bubble',
        },
        scopedCustomCss: ``,
    },
];

export interface ThemeEngineState {
    /** Custom image data; empty uses the bundled loading mascot. */
    streamLoadingSprite: string;
    followSystemFont: boolean;
    activePresetId: string;
    layoutMode: LayoutMode;
    tokens: ThemeDesignTokens;
    scopedCustomCss: string;
    customPresets: ThemePresetPackage[];
}

const defaultPreset = BUILTIN_THEME_PRESETS[0]!;

export const themeEngineStore = createReactiveStore<ThemeEngineState>(() => ({
    streamLoadingSprite: '',
    followSystemFont: true,
    activePresetId: defaultPreset.id,
    layoutMode: defaultPreset.layoutMode,
    tokens: { ...defaultPreset.tokens },
    scopedCustomCss: defaultPreset.scopedCustomCss,
    customPresets: [],
}));

export function readingThemeTokens(state = themeEngineStore.getState()): ThemeDesignTokens {
    return state.followSystemFont ? { ...state.tokens, fontFamilyBody: 'system-ui, -apple-system, BlinkMacSystemFont, sans-serif' } : state.tokens;
}

export function readingColorScheme(bgPrimary: string): 'light' | 'dark' {
    const color = bgPrimary.replace('#', '');
    const full = color.length === 3 ? [...color].map(char => char + char).join('') : color;
    const channels = /^[0-9a-f]{6}$/i.test(full) ? [0, 2, 4].map(offset => parseInt(full.slice(offset, offset + 2), 16)) : [24, 28, 36];
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722 > 155 ? 'light' : 'dark';
}

export function setFollowSystemFont(value: boolean): void {
    themeEngineStore.setState(draft => { draft.followSystemFont = value; });
    persistThemeState();
}
export function setStreamLoadingSprite(value: string): void {
    themeEngineStore.setState(draft => { draft.streamLoadingSprite = value; }); persistThemeState();
}

/**
 * Prefixes raw user CSS rules with `#tipsy-isle-stage` unless already scoped or an @-rule,
 * ensuring custom user themes never break top-level app navigation or modal recovery controls.
 */
export function scopeUserCss(rawCss: string, scopeSelector = '#tipsy-isle-stage'): string {
    const trimmed = rawCss.trim();
    if (!trimmed) return '';
    // Strip dangerous @import or javascript: urls
    const sanitized = trimmed
        .replace(/@import\s+[^;]+;/gi, '/* @import blocked */')
        .replace(/url\(\s*['"]?javascript:[^)]+\)/gi, 'none');

    return sanitized.replace(/(^|\})\s*([^@{}]+?)\s*\{/g, (match, closeBrace: string, selectorGroup: string) => {
        const selectors = selectorGroup
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
            .map((sel) => {
                if (sel.startsWith(scopeSelector) || sel.startsWith(':root') || sel.startsWith('from') || sel.startsWith('to') || /^\d+%$/.test(sel)) {
                    return sel;
                }
                return `${scopeSelector} ${sel}`;
            })
            .join(', ');
        return `${closeBrace}
${selectors} {`;
    });
}

export function applyThemeToDocument(state: ThemeEngineState = themeEngineStore.getState()): void {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    const tokens = readingThemeTokens(state);
    root.style.setProperty('--ti-accent', tokens.accentColor);
    root.style.setProperty('--ti-bg-primary', tokens.bgPrimary);
    root.style.setProperty('--ti-bg-surface', tokens.bgSurface);
    root.style.setProperty('--ti-text-primary', tokens.textPrimary);
    root.style.setProperty('--ti-text-muted', tokens.textMuted);
    root.style.setProperty('--ti-blur', `${tokens.backdropBlurPx}px`);
    root.style.setProperty('--ti-card-opacity', String(tokens.cardOpacity));
    root.style.setProperty('--ti-radius', `${tokens.borderRadiusPx}px`);
    root.style.setProperty('--ti-font-body', tokens.fontFamilyBody);
    root.style.setProperty('--ti-font-mono', tokens.fontFamilyMono);
    root.style.setProperty('--ti-font-size', `${tokens.fontSizePx}px`);
    root.style.setProperty('--ti-line-height', String(tokens.lineHeight));
    root.style.setProperty('--ti-chat-max-width', `${tokens.chatMaxWidthPx}px`);
    // Theme only the presentation. Existing presets and user token values remain intact.
    const scheme = readingColorScheme(tokens.bgPrimary);
    root.style.colorScheme = scheme;
    root.dataset.colorScheme = scheme;
    root.dataset.portraitPlacement = tokens.portraitPlacement;
    const accent = tokens.accentColor.replace('#', '');
    const accentHex = accent.length === 3 ? [...accent].map(char => char + char).join('') : accent;
    const accentChannels = /^[0-9a-f]{6}$/i.test(accentHex) ? [0, 2, 4].map(offset => parseInt(accentHex.slice(offset, offset + 2), 16) / 255) : [0.26, 0.39, 0.65];
    const linear = accentChannels.map(channel => channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4);
    const luminance = linear[0] * .2126 + linear[1] * .7152 + linear[2] * .0722;
    root.style.setProperty('--ti-on-accent', luminance > .179 ? '#141b26' : '#ffffff');
    window.dispatchEvent(new Event('tipsy-theme-change'));

    let styleEl = document.getElementById('tipsy-isle-scoped-user-css') as HTMLStyleElement | null;
    if (!styleEl) {
        styleEl = document.createElement('style');
        styleEl.id = 'tipsy-isle-scoped-user-css';
        document.head.appendChild(styleEl);
    }
    styleEl.textContent = scopeUserCss(state.scopedCustomCss);
}

function persistThemeState(): void {
    const current = themeEngineStore.getState();
    applyThemeToDocument(current);
    void platformStorage.saveSnapshot('theme_state', current).catch(error => {
        console.error('主题保存失败', error);
        globalThis.dispatchEvent?.(new CustomEvent('tipsy-storage-error', { detail: '主题保存失败，请检查本地网关或浏览器存储空间。' }));
    });
}

export async function hydrateThemeFromPlatform(): Promise<void> {
    const saved = await platformStorage.loadSnapshot<Partial<ThemeEngineState> | null>('theme_state', null);
    if (saved && typeof saved === 'object') {
        const previousDefault = BUILTIN_THEME_PRESETS.find(preset => preset.id === 'tipsy-moonlight')!;
        const unchangedLegacyDefault = saved.activePresetId === previousDefault.id && saved.layoutMode === previousDefault.layoutMode
            && saved.scopedCustomCss === previousDefault.scopedCustomCss && saved.tokens
            && Object.entries(previousDefault.tokens).every(([key, value]) => saved.tokens?.[key as keyof ThemeDesignTokens] === value);
        themeEngineStore.setState((draft) => {
            draft.followSystemFont = saved.followSystemFont !== false;
            draft.streamLoadingSprite = saved.streamLoadingSprite ?? '';
            if (!unchangedLegacyDefault) {
                if (saved.activePresetId) draft.activePresetId = saved.activePresetId;
                if (saved.layoutMode) draft.layoutMode = saved.layoutMode;
                if (saved.tokens) draft.tokens = { ...draft.tokens, ...saved.tokens };
                if (typeof saved.scopedCustomCss === 'string') draft.scopedCustomCss = saved.scopedCustomCss;
            }
            if (Array.isArray(saved.customPresets)) draft.customPresets = saved.customPresets;
        });
    }
    applyThemeToDocument(themeEngineStore.getState());
}

export function selectThemePreset(presetId: string): void {
    const state = themeEngineStore.getState();
    const all = [...BUILTIN_THEME_PRESETS, ...state.customPresets];
    const found = all.find((p) => p.id === presetId);
    if (!found) return;
    themeEngineStore.setState((draft) => {
        draft.activePresetId = found.id;
        draft.layoutMode = found.layoutMode;
        draft.tokens = { ...found.tokens };
        draft.scopedCustomCss = found.scopedCustomCss;
    });
    persistThemeState();
}

export function updateThemeToken<K extends keyof ThemeDesignTokens>(key: K, value: ThemeDesignTokens[K]): void {
    themeEngineStore.setState((draft) => {
        draft.tokens[key] = value;
    });
    persistThemeState();
}

/** The quick switch changes colors without resetting reading preferences or custom CSS. */
export function toggleReadingColorScheme(): void {
    const scheme = readingColorScheme(themeEngineStore.getState().tokens.bgPrimary);
    const preset = BUILTIN_THEME_PRESETS.find(item => item.id === (scheme === 'light' ? 'isle-nightfall' : 'isle-daylight'))!;
    themeEngineStore.setState(draft => {
        draft.activePresetId = preset.id;
        for (const key of ['accentColor', 'bgPrimary', 'bgSurface', 'textPrimary', 'textMuted'] as const) draft.tokens[key] = preset.tokens[key];
    });
    persistThemeState();
}

export function setThemeLayoutMode(mode: LayoutMode): void {
    themeEngineStore.setState((draft) => {
        draft.layoutMode = mode;
    });
    persistThemeState();
}

export function setScopedCustomCss(cssText: string): void {
    themeEngineStore.setState((draft) => {
        draft.scopedCustomCss = cssText;
    });
    persistThemeState();
}

export function exportCurrentThemePackage(name?: string): ThemePresetPackage {
    const state = themeEngineStore.getState();
    return {
        id: `custom-${Date.now()}`,
        name: name?.trim() || '微醺屿自定义主题包',
        author: 'User',
        description: '导出自微醺屿（TipsyIsle）三层美化工作台',
        layoutMode: state.layoutMode,
        tokens: { ...state.tokens },
        scopedCustomCss: state.scopedCustomCss,
    };
}

export function importThemePackage(pkg: ThemePresetPackage): void {
    themeEngineStore.setState((draft) => {
        const existingIdx = draft.customPresets.findIndex((p) => p.id === pkg.id);
        if (existingIdx >= 0) {
            draft.customPresets[existingIdx] = pkg;
        } else {
            draft.customPresets.push(pkg);
        }
        draft.activePresetId = pkg.id;
        draft.layoutMode = pkg.layoutMode;
        draft.tokens = { ...pkg.tokens };
        draft.scopedCustomCss = pkg.scopedCustomCss || '';
    });
    persistThemeState();
}

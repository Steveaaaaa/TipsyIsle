import type { LayoutMode, ThemeDesignTokens } from '../types';

/** Presentation-only values shared with the isolated message host. */
export interface ReadingPresentation {
    streamLoadingSprite?: string;
    tokens: ThemeDesignTokens;
    layoutMode: LayoutMode;
    colorScheme: 'light' | 'dark';
}

export function applyReadingPresentation(presentation: ReadingPresentation, target: Document = document): void {
    const { tokens } = presentation;
    const values: Record<string, string> = {
        '--reader-accent': tokens.accentColor,
        '--reader-surface': tokens.bgSurface,
        '--reader-text': tokens.textPrimary,
        '--reader-muted': tokens.textMuted,
        '--reader-font': tokens.fontFamilyBody,
        '--reader-size': `${tokens.fontSizePx}px`,
        '--reader-leading': String(tokens.lineHeight),
        '--reader-indent': tokens.textIndentEm ? `${tokens.textIndentEm}em` : '0',
        '--reader-width': `${tokens.chatMaxWidthPx}px`,
        '--reader-radius': `${tokens.borderRadiusPx}px`,
    };
    for (const [property, value] of Object.entries(values)) target.documentElement.style.setProperty(property, value);
    target.documentElement.style.colorScheme = presentation.colorScheme;
    target.documentElement.dataset.colorScheme = presentation.colorScheme;
    target.documentElement.dataset.layout = presentation.layoutMode;
}

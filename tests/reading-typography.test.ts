import { describe, it, expect } from 'vitest';
import { applyReadingPresentation } from '../src/theme/reading-presentation';
import { applyThemeToDocument, themeEngineStore, updateThemeTokens } from '../src/theme/theme-engine';

function createFakeDocument() {
    const vars = new Map<string, string>();
    const styleEl = { id: 'tipsy-isle-scoped-user-css', textContent: '' };
    const doc = {
        documentElement: {
            style: {
                colorScheme: '',
                setProperty: (k: string, v: string) => { vars.set(k, v); },
            },
            dataset: {} as Record<string, string>,
        },
        head: { appendChild: () => {} },
        getElementById: (id: string) => (id === 'tipsy-isle-scoped-user-css' ? styleEl : null),
        createElement: () => ({ ...styleEl }),
    } as unknown as Document;
    return { doc, vars };
}

describe('reading typography presentation and tokens', () => {
    it('applies custom fontSizePx, lineHeight, and textIndentEm to both shell and compatibility CSS variables', () => {
        const fakeWindow = new EventTarget();
        Object.assign(globalThis, {
            window: fakeWindow,
            localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {}, clear: () => {}, key: () => null, length: 0 },
        });
        const { doc: shellDoc, vars: shellVars } = createFakeDocument();
        Object.assign(globalThis, { document: shellDoc });

        updateThemeTokens({ fontSizePx: 18.5, lineHeight: 2.05, textIndentEm: 2 });
        const state = themeEngineStore.getState();
        applyThemeToDocument(state);

        expect(shellVars.get('--ti-font-size')).toBe('18.5px');
        expect(shellVars.get('--ti-line-height')).toBe('2.05');
        expect(shellVars.get('--ti-text-indent')).toBe('2em');

        const { doc: compatDoc, vars: compatVars } = createFakeDocument();
        applyReadingPresentation({ tokens: state.tokens, layoutMode: state.layoutMode, colorScheme: 'dark' }, compatDoc);
        expect(compatVars.get('--reader-size')).toBe('18.5px');
        expect(compatVars.get('--reader-leading')).toBe('2.05');
        expect(compatVars.get('--reader-indent')).toBe('2em');

        updateThemeTokens({ textIndentEm: 0 });
        applyReadingPresentation({ tokens: themeEngineStore.getState().tokens, layoutMode: state.layoutMode, colorScheme: 'dark' }, compatDoc);
        expect(compatVars.get('--reader-indent')).toBe('0');
    });
});

import type { CSSProperties } from 'react';
import { assetUrl, wallpaperUrl, type Appearance } from './appearance-model';

const imageValue = (value: string) => `url(${JSON.stringify(value)})`;
export function wallpaperStyle(skin?: Appearance): CSSProperties | undefined {
    const image = skin && wallpaperUrl(skin);
    if (!skin || !image) return;
    const { fit, position, shade } = skin.wallpaper;
    return { backgroundImage: `linear-gradient(rgb(0 0 0 / ${shade}), rgb(0 0 0 / ${shade})), ${imageValue(image)}`,
        backgroundSize: `100% 100%, ${fit === 'tile' ? 'auto' : fit}`, backgroundPosition: `center, ${position}`,
        backgroundRepeat: `no-repeat, ${fit === 'tile' ? 'repeat' : 'no-repeat'}` };
}
const scope = '[data-ti-shell]';
const range = '[data-ti-protected]';

function localAssets(css: string, skin: Appearance) {
    return css.replace(/url\(\s*(["']?)asset:([\w-]+)\1\s*\)/gi, (_, _quote, key) => {
        const src = assetUrl(skin, key); return src ? imageValue(src) : 'none';
    });
}

/** Each shell surface is a sibling of the story surface, never its ancestor. */
export function compileAppearance(skin: Appearance): string {
    const definitions: string[] = [];
    const typography: string[] = [];
    for (const role of ['ui', 'heading', 'composer'] as const) {
        const font = skin.fonts[role]; if (!font) continue;
        const asset = font.asset && assetUrl(skin, font.asset);
        const name = `TipsyAppearance-${role}`;
        if (asset) definitions.push(`@font-face { font-family: ${name}; src: ${imageValue(asset)}; font-display: swap; }`);
        const target = role === 'ui' ? `${scope}, ${scope} :is(button, label, input, select, summary, textarea, .ttm-topbar-location, .ttm-conversation-person p)`
            : role === 'heading' ? `${scope} :is([data-ti-type="heading"], .ttm-settings-category-heading h3, .ttm-settings-section h3, .ttm-asset-dialog-heading h2)`
            : `${scope} [data-ti-type="composer"]`;
        const declarations = [asset || font.family ? `font-family: ${asset ? `${name}, ` : ''}${font.family ? `${JSON.stringify(font.family).replace(/</g, '\\3c ')}, ` : ''}system-ui, sans-serif` : '',
            font.size > 0 ? `font-size: ${font.size}px` : ''].filter(Boolean);
        if (declarations.length) typography.push(`${target} { ${declarations.join('; ')} }`);
    }
    // Parse with the browser, then only accept rules whose effect stays in the scope.
    // In particular imported packs cannot register global fonts or import a stylesheet.
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(localAssets(skin.css, skin));
    const scoped = (rules: CSSRuleList): string => Array.from(rules, rule => {
        if (rule instanceof CSSStyleRule) return `${rule.selectorText} {${rule.style.cssText}${rule.cssRules ? scoped(rule.cssRules) : ''}}`;
        if (rule instanceof CSSMediaRule || rule instanceof CSSSupportsRule || rule.constructor.name === 'CSSContainerRule' || rule.constructor.name === 'CSSLayerBlockRule') {
            const group = rule as CSSGroupingRule;
            return `${rule.cssText.split('{', 1)[0]} {${scoped(group.cssRules)}}`;
        }
        return '';
    }).join('\n');
    const animations = Array.from(sheet.cssRules).filter(rule => rule instanceof CSSKeyframesRule && rule.name.startsWith('skin-')).map(rule => rule.cssText);
    return `${definitions.join('\n')}\n${typography.join('\n')}\n${animations.join('\n')}\n@scope (${scope}) to (${range}) {\n${scoped(sheet.cssRules)}\n}`;
}

export function applyAppearanceStyle(doc: Document, css: string) {
    let style = doc.getElementById('tipsy-shell-appearance');
    if (!css) { style?.remove(); return; }
    if (!style) { style = doc.createElement('style'); style.id = 'tipsy-shell-appearance'; doc.head.append(style); }
    if (style.textContent !== css) style.textContent = css;
}

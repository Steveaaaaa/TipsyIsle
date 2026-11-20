import { blankAppearance } from './appearance-model';

const icon = (name: string, path: string) => ({ name, mime: 'image/svg+xml', data: `data:image/svg+xml;base64,${btoa(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40" rx="9" fill="#224c49"/><path d="${path}" stroke="#fff0c5" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>`)}` });
const chart = { name: 'harbor-chart.svg', mime: 'image/svg+xml', data: `data:image/svg+xml;base64,${btoa(`<svg xmlns="http://www.w3.org/2000/svg" width="220" height="220" viewBox="0 0 220 220"><rect width="220" height="220" fill="#bdcfc4"/><path d="M0 55h220M0 110h220M0 165h220M55 0v220M110 0v220M165 0v220" fill="none" stroke="#8da89e" stroke-width=".65"/><g fill="none" stroke="#638980"><circle cx="110" cy="110" r="36"/><circle cx="110" cy="110" r="28"/><path d="m110 72 8 30 30 8-30 8-8 30-8-30-30-8 30-8z"/></g></svg>`)}` };

export function fogHarborAppearance() {
    const skin = blankAppearance();
    skin.name = '雾港阅读器';
    skin.text = { name: '雾港阅读器', subtitle: 'FOG HARBOR', workspace: '港务台', location: '航行日志', library: '航线书架', empty: '从雾里选一条航线',
        'empty-library': '回到你的航线', 'startup-title': '灯塔亮起，等你靠岸。', 'startup-status': '正在打开港口…', input: '写入下一条航行记录…',
        hint: '航行记录只属于你。', send: '投递', more: '航行工具', routes: '航线图' };
    skin.assets = { lighthouse: icon('lighthouse.svg', 'M11 29h18m-15 0 2-13h8l2 13m-11-13 5-6 5 6m-5 4v4m-7-12-4-2m18 2 4-2'),
        letter: icon('letter.svg', 'M9 13h22v15H9z m0 0 11 9 11-9'), chart };
    skin.art = { logo: 'lighthouse', startup: 'lighthouse', welcome: 'lighthouse', send: 'letter' };
    skin.wallpaper = { source: 'chart', fit: 'tile', position: 'center', shade: 0 };
    skin.fonts.heading = { family: 'Georgia', size: 20, asset: '' };
    skin.layout.desktop = { top: ['settings', 'focus'], sidebar: ['widget-harbor', 'appearance', 'sidebar-settings'], conversation: ['new-chat', 'profile'],
        toolbar: ['continue', 'reading'], more: ['routes', 'history', 'regenerate', 'recalculate', 'retry-analysis'] };
    skin.layout.mobile = { mobile: ['mobile-chat', 'mobile-library', 'mobile-appearance', 'mobile-settings'], conversation: ['new-chat', 'profile'],
        toolbar: ['continue'], more: ['routes', 'history', 'reading', 'regenerate', 'recalculate', 'retry-analysis'] };
    skin.widgets = [{ id: 'widget-harbor', label: '在港故事', image: 'lighthouse', value: 'library', action: '' }];
    skin.css = `:scope[data-ti-shell="topbar"] { background: #e2eee8; color: #173c38; border-bottom-color: #a9c9be; }
[data-ti-part="brand"] { width: auto; min-width: 185px; }
.ttm-brand-name::after { background: #a7723c; }
:scope[data-ti-shell="library"] { --ti-rail: #1d3736; --ti-rail-raised: #274946; --ti-rail-text: #f1eee1; --ti-rail-muted: #c3d8cc; width: 224px; }
@media (max-width: 1024px) { :scope[data-ti-shell="library"] { width: 100%; } }
[data-ti-area="sidebar"] { flex-wrap: wrap; }
[data-ti-widget="widget-harbor"] { flex: 1 0 100%; padding: 7px 4px; justify-content: space-between; }
:scope[data-ti-shell="conversation"], :scope[data-ti-shell="navigation"] { background: #e9f0e8; }
:scope[data-ti-shell="composer-row"] { border-color: #8eaca1; border-radius: 8px; background: #f2f4eb; }
[data-ti-part="send"] { background: #224c49; color: #fff0c5; border-radius: 6px; }
[data-ti-part="more"] { border-style: dashed; }
:scope[data-ti-shell="startup"] { background: #e2eee8; color: #173c38; }`;
    return skin;
}

import { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '../shell/Icon';
import { settingsCategories } from '../shell/settings-presentation';
import shellSheet from '../reading-ui.css?url';
import welcomeSheet from '../shell/onboarding.css?url';
import workbenchSheet from './appearance-workbench.css?url';
import { areas, parts, partText, placements, textOf, type Appearance, type Area, type Device, type Layout, type Part } from './appearance-model';
import { applyAppearanceStyle, wallpaperStyle } from './appearance-style';
import { ShellArt, ShellBrand, ShellPartIcon, ShellWidget } from './appearance-shell';

export type PreviewPage = 'chat' | 'library' | 'settings' | 'empty' | 'startup';
export type PreviewReadingTypography = { fontSizePx: number; lineHeight: number; textIndentEm: number };
export function AppearancePreview({ skin, css, device, page, layout, reading, onSelect }: { skin: Appearance; css: string; device: Device;
    page: PreviewPage; layout?: Layout; reading?: PreviewReadingTypography; onSelect: (id: string) => void }) {
    const frame = useRef<HTMLIFrameElement>(null);
    const stage = useRef<HTMLDivElement>(null);
    const [target, setTarget] = useState<HTMLElement>();
    const [stageWidth, setStageWidth] = useState(590);
    const [tools, setTools] = useState(true);
    const wide = device === 'desktop';
    const width = wide ? 1200 : 390;
    const height = wide ? 740 : 715;
    const scale = Math.min(1, stageWidth / width);
    useLayoutEffect(() => {
        const el = stage.current!;
        const measure = () => setStageWidth(el.clientWidth);
        const observer = new ResizeObserver(measure); measure(); observer.observe(el);
        return () => observer.disconnect();
    }, []);
    useLayoutEffect(() => {
        if (!target) return;
        applyAppearanceStyle(target.ownerDocument, css);
        if (!reading) return;
        const root = target.ownerDocument.documentElement;
        root.style.setProperty('--ti-font-size', `${reading.fontSizePx}px`);
        root.style.setProperty('--ti-line-height', String(reading.lineHeight));
        root.style.setProperty('--ti-text-indent', reading.textIndentEm ? `${reading.textIndentEm}em` : '0');
    }, [target, css, reading]);
    const onLoad = () => { const doc = frame.current?.contentDocument; if (doc) setTarget(doc.body); };
    const placed = placements(skin, device, layout);
    const control = (area: Area) => placed[area].map(id => {
        if (Object.hasOwn(parts, id)) {
            const part = id as Part;
            const iconOnly = area === 'conversation' && ['routes', 'history', 'profile'].includes(id) || area === 'top' && id === 'focus';
            return <button type="button" key={id} data-ti-part={id} title={partText(skin, part)} aria-label={partText(skin, part)} onClick={() => onSelect(id)}
                className={area === 'mobile' ? (id === 'mobile-chat' ? 'is-active' : '') : iconOnly ? `ttm-icon-btn${area === 'top' && id === 'focus' ? ' ttm-focus-button' : ''}` : area === 'top' && id === 'settings' ? 'ttm-btn-ghost' : area === 'conversation' ? 'ttm-btn-secondary' : 'ttm-chip-btn'}>
                <ShellPartIcon skin={skin} id={part} />{!iconOnly && <span>{partText(skin, part)}</span>}
            </button>;
        }
        const widget = skin.widgets.find(item => item.id === id);
        return widget && <ShellWidget key={id} skin={skin} widget={widget} values={{ character: '长夜电台', messages: 24, library: 3 }} onSelect={() => onSelect(id)} />;
    });
    const paper = wallpaperStyle(skin);
    const tab = wide ? 'chat' : page === 'library' ? 'characters' : page === 'settings' ? 'inspector' : 'chat';
    const content = page === 'startup' ? <div className="ttm-app-root ttm-loading" data-ti-shell="startup"><main className="ttm-loading-content">
        <div className="ttm-loading-emblem" data-ti-part="startup-art" onClick={() => onSelect('startup')}><ShellArt skin={skin} id="startup" fallback={<Icon name="book" width={36} height={36} />} /></div>
        <h1 data-ti-type="heading">{textOf(skin, 'name')}</h1><p className="ttm-loading-subtitle">{textOf(skin, 'startup-title')}</p>
        <div className="ttm-loading-status"><span className="ttm-loading-spinner" />{textOf(skin, 'startup-status')}</div>
    </main></div> : <div className={`ttm-app-root${page === 'settings' ? ' has-inspector' : ''}${paper ? ' has-skin-wallpaper' : ''}`} data-mobile-tab={tab}>
        {paper && <div data-ti-shell="wallpaper" className="ttm-skin-wallpaper" style={paper} />}
        <header className="ttm-topbar" data-ti-shell="topbar" onClick={event => { if ((event.target as Element).closest('[data-ti-part="brand"]')) onSelect('brand'); }}><ShellBrand skin={skin} /><div className="ttm-topbar-location" data-ti-part="location"><span>{textOf(skin, 'workspace')}</span><Icon name="chevron" width={14} height={14} /><strong>{textOf(skin, 'location')}</strong></div>
            <div className="ttm-topbar-actions" data-ti-area="top">{control('top')}</div></header>
        <div className="ttm-workbench">
            <aside className={`ttm-sidebar${tab === 'characters' ? ' is-mobile-active' : ''}`} data-ti-shell="library"><div className="ttm-sidebar-scroll"><section className="ttm-panel-block">
                <div className="ttm-section-head-row"><h2 className="ttm-library-title" data-ti-type="heading">{textOf(skin, 'library')} <span>3</span></h2><button type="button" className="ttm-mini-btn" data-ti-part="import" onClick={() => onSelect('import')}><ShellArt skin={skin} id="import" fallback={<Icon name="plus" width={16} height={16} />} />{textOf(skin, 'import')}</button></div>
                <label className="ttm-search"><Icon name="search" width={17} height={17} /><input aria-label="预览搜索框" placeholder="搜索故事、作者或标签" readOnly /></label>
                <ul className="ttm-skin-preview-library"><li>长夜电台</li><li>雪线以北</li><li>海上来信</li></ul>
            </section></div><div className="ttm-sidebar-bottom"><div className="ttm-sidebar-bottom-actions has-custom-parts" data-ti-area="sidebar">{control('sidebar')}</div></div></aside>
            <main className={`ttm-center-stage${tab === 'chat' ? ' is-mobile-active' : ''}`}><header className="ttm-conversation-header" data-ti-shell="conversation"><div className="ttm-conversation-person" data-ti-part="conversation-title"><Icon name="book" /><div><h2 data-ti-type="heading">{page === 'empty' ? textOf(skin, 'name') : '长夜电台'}</h2><p>24 条消息</p></div></div><div className="ttm-conversation-actions" data-ti-area="conversation">{control('conversation')}</div></header>
                <div className={`ttm-reading-viewport${paper && page !== 'empty' ? ' ttm-skin-story-surface' : ''}`} data-ti-protected={page !== 'empty' ? '' : undefined}>
                    {page === 'empty' ? <section className="ttm-start-page" data-ti-shell="empty"><span className="ttm-welcome-mark" data-ti-part="welcome-art" onClick={() => onSelect('welcome')}><ShellArt skin={skin} id="welcome" fallback={<Icon name="book" width={56} height={56} />} /></span><h2 data-ti-type="heading">{textOf(skin, 'empty')}</h2><button type="button" className="ttm-btn-primary" data-ti-part="import" onClick={() => onSelect('import')}>{textOf(skin, 'import')}</button></section> :
                        <div className="ttm-chat-stream"><article className="ttm-msg-card is-user"><header className="ttm-msg-header">你 · #22</header><div className="ttm-msg-bubble ttm-msg-prose"><p>我推开电台的门，听见了海的声音。</p></div></article><article className="ttm-msg-card is-assistant"><header className="ttm-msg-header">电台守夜人 · #23</header><div className="ttm-msg-bubble ttm-msg-prose"><p>窗边的收音机还亮着。他放低音量，把那封信推到了你面前。</p></div></article></div>}
                </div>
                {page !== 'empty' && <footer className="ttm-composer"><div className="ttm-composer-quickbar" data-ti-shell="composer-controls" data-ti-area="toolbar">{control('toolbar')}<button type="button" data-ti-part="more" className="ttm-chip-btn" aria-expanded={tools} onClick={() => setTools(!tools)}><ShellArt skin={skin} id="more" fallback={<Icon name="more" />} />{textOf(skin, 'more')}</button></div>
                <div className="ttm-composer-tools" data-ti-shell="composer-controls" data-ti-part="more-panel" hidden={!tools}><div className="ttm-composer-quickbar" data-ti-area="more">{control('more')}</div></div>
                <div className="ttm-composer-row" data-ti-shell="composer-row"><div className="ttm-skin-input-tools" data-ti-area="input-before">{control('input-before')}</div><textarea className="ttm-composer-input" data-ti-part="input" data-ti-type="composer" placeholder={textOf(skin, 'input')} rows={wide ? 2 : 1} aria-label="输入框预览" readOnly /><div className="ttm-skin-input-tools" data-ti-area="input-after">{control('input-after')}</div><button type="button" className="ttm-btn-primary ttm-composer-submit" data-ti-part="send" onClick={() => onSelect('send')} aria-label={textOf(skin, 'send')}><ShellArt skin={skin} id="send" fallback={<Icon name="send" />} /><span>{textOf(skin, 'send')}</span></button></div>
                <div className="ttm-composer-hint" data-ti-shell="composer-hint"><span>{textOf(skin, 'hint')}</span><span>Ctrl / ⌘ + Enter 发送</span></div></footer>}
            </main>
            {page === 'settings' && <aside className="ttm-inspector is-mobile-active" data-ti-shell="settings">
                <div className="ttm-inspector-heading"><h2 data-ti-type="heading">设置与工具</h2><div className="ttm-inspector-heading-actions"><button type="button" className="ttm-btn-ghost ttm-inspector-guide"><Icon name="book" width={17} height={17} />使用引导</button></div></div>
                <div className="ttm-inspector-content">
                    <div className="ttm-settings-search"><Icon name="search" width={17} height={17} /><input aria-label="设置搜索预览" placeholder="搜索设置，如插件、模型连接" readOnly /></div>
                    <nav className="ttm-settings-categories" aria-label="设置分类预览">{settingsCategories.map(item => <button key={item.id} type="button" aria-current={item.id === 'connection' ? 'page' : undefined}><Icon name={item.icon} width={17} height={17} /><span>{item.label}</span></button>)}</nav>
                </div>
            </aside>}
        </div>
        <nav className="ttm-mobile-navbar" data-ti-shell="navigation" data-ti-area="mobile" aria-label={areas.mobile}>{control('mobile')}</nav>
    </div>;
    return <div ref={stage} className="ttm-skin-preview-stage"><div className="ttm-skin-preview-window" style={{ width: width * scale, height: height * scale }}>
        <iframe ref={frame} title="外观预览" sandbox="allow-same-origin" onLoad={onLoad}
            srcDoc={`<!doctype html><html lang="zh-CN" data-color-scheme="light"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="${shellSheet}"><link rel="stylesheet" href="${welcomeSheet}"><link rel="stylesheet" href="${workbenchSheet}"></head><body></body></html>`}
            style={{ width, height, transform: `scale(${scale})` }} />{target && createPortal(content, target)}
    </div></div>;
}

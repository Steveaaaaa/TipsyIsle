/// <reference types="vite/client" />
import DOMPurify from 'dompurify';
import showdown from 'showdown';
import { useMemo } from 'react';
import app from '../../package.json';
import { closeReleaseNotes, confirmAppUpdate, ignoreAppUpdate, releaseNotesView } from '../core/app-update';
import { AnchoredDialog } from './AnchoredDialog';
import './release-notes.css';

const releaseNotes = import.meta.glob<string>('../../docs/releases/v*.md', { eager: true, query: '?raw', import: 'default' });
const converter = new showdown.Converter({ tables: true, strikethrough: true, simpleLineBreaks: true });

function renderReleaseNotes(notes: string) {
    const content = DOMPurify.sanitize(converter.makeHtml(notes), {
        ALLOWED_TAGS: ['a', 'p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'strong', 'em', 'del', 'blockquote', 'code', 'pre', 'table', 'thead', 'tbody', 'tr', 'th', 'td'],
        ALLOWED_ATTR: ['href'], ALLOW_DATA_ATTR: false, ALLOW_ARIA_ATTR: false, ALLOWED_URI_REGEXP: /^https:\/\//i,
        RETURN_DOM_FRAGMENT: true,
    });
    for (const link of content.querySelectorAll<HTMLAnchorElement>('a[href]')) {
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
    }
    const container = document.createElement('div');
    container.append(content);
    return container.innerHTML;
}

function formatPublishedDate(raw?: string | null): string | undefined {
    if (!raw) return undefined;
    const timestamp = Date.parse(raw);
    if (!Number.isFinite(timestamp)) return undefined;
    const date = new Date(timestamp);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function formatInstallerSize(bytes?: number | null): string | undefined {
    if (!bytes || !Number.isFinite(bytes) || bytes <= 0) return undefined;
    const mb = bytes / (1024 * 1024);
    return mb >= 100 ? `${Math.round(mb)} MB` : `${mb.toFixed(1)} MB`;
}

export function ReleaseNotesDialog() {
    const view = releaseNotesView.useStore(state => state.open);
    const update = view?.kind === 'update' ? view.release : null;
    const version = update?.version ?? app.version;
    const source = update ? update.notes : releaseNotes[`../../docs/releases/v${version}.md`];
    const html = useMemo(() => source?.trim() ? renderReleaseNotes(source) : '', [source]);
    if (!view) return null;
    const title = update?.title?.trim();
    const showTitle = Boolean(title && title !== version && title !== `v${version}` && title !== `TipsyIsle ${version}` && title !== `微醺屿 ${version}`);
    const releaseUrl = `https://github.com/Steveaaaaa/TipsyIsle/releases/tag/v${encodeURIComponent(version)}`;
    const publishedDate = formatPublishedDate(update?.publishedAt);
    const installerSize = formatInstallerSize(update?.installerSize);

    return <AnchoredDialog title={update ? '发现新版本' : '版本更新日志'} anchor={view.kind === 'current' ? view.anchor : document.body}
        compact centered fitContent className="ttm-release-notes-dialog" onClose={closeReleaseNotes}>
        <div className="ttm-release-hero">
            <div className="ttm-release-hero-top">
                <div className="ttm-release-version-row">
                    {update ? <>
                        <span className="ttm-release-pill is-from">v{app.version}</span>
                        <span className="ttm-release-arrow" aria-hidden="true">→</span>
                        <span className="ttm-release-pill is-to">v{version}</span>
                        <span className="ttm-release-tag">可更新</span>
                    </> : <>
                        <span className="ttm-release-pill is-to">v{version}</span>
                        <span className="ttm-release-tag is-current">当前版本</span>
                    </>}
                </div>
                <a className="ttm-release-github-link" href={releaseUrl} target="_blank" rel="noopener noreferrer">GitHub ↗</a>
            </div>
            {showTitle && <h3 className="ttm-release-title">{title}</h3>}
            {(publishedDate || installerSize) && <div className="ttm-release-meta">
                {publishedDate && <span>发布于 {publishedDate}</span>}
                {installerSize && <span>安装包 {installerSize}</span>}
            </div>}
        </div>
        <div className="ttm-release-notes-scroll">
            {html ? <div className="ttm-release-notes-prose" dangerouslySetInnerHTML={{ __html: html }} />
                : <p className="ttm-release-empty">{update ? '这个版本暂未附上更新日志，可点击右上角在 GitHub Release 查看详情。' : '这个版本没有内置更新日志。'}</p>}
        </div>
        <div className={`ttm-release-notes-actions ${update ? 'is-update' : 'is-current'}`}>
            {update ? <>
                <button type="button" className="ttm-btn-secondary ttm-release-ignore-btn" onClick={ignoreAppUpdate}>忽略这次更新</button>
                <div className="ttm-release-notes-secondary-pair">
                    <button type="button" className="ttm-btn-secondary" onClick={closeReleaseNotes}>稍后提醒</button>
                    <button type="button" className="ttm-btn-primary ttm-release-install-btn" onClick={confirmAppUpdate}>下载并安装</button>
                </div>
            </> : <>
                <a href={releaseUrl} target="_blank" rel="noopener noreferrer">在 GitHub 查看</a>
                <div>
                    <button type="button" className="ttm-btn-secondary" onClick={closeReleaseNotes}>关闭</button>
                </div>
            </>}
        </div>
    </AnchoredDialog>;
}

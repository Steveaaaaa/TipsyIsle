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

export function ReleaseNotesDialog() {
    const view = releaseNotesView.useStore(state => state.open);
    const update = view?.kind === 'update' ? view.release : null;
    const version = update?.version ?? app.version;
    const source = update ? update.notes : releaseNotes[`../../docs/releases/v${version}.md`];
    const html = useMemo(() => source?.trim() ? renderReleaseNotes(source) : '', [source]);
    if (!view) return null;
    const title = update?.title?.trim();
    const releaseUrl = `https://github.com/Steveaaaaa/TipsyIsle/releases/tag/v${encodeURIComponent(version)}`;

    return <AnchoredDialog title={update ? `发现新版 · ${version}` : `更新日志 · ${version}`} anchor={view.kind === 'current' ? view.anchor : document.body}
        compact centered fitContent className="ttm-release-notes-dialog" onClose={closeReleaseNotes}>
        <div className="ttm-release-notes-scroll">
            {title && title !== version && title !== `v${version}` && <h3>{title}</h3>}
            {html ? <div className="ttm-release-notes-prose" dangerouslySetInnerHTML={{ __html: html }} />
                : <p>{update ? '这个版本暂未附上更新日志。' : '这个版本没有内置更新日志。'}</p>}
        </div>
        <div className="ttm-release-notes-actions">
            <a href={releaseUrl} target="_blank" rel="noopener noreferrer">在 GitHub 查看</a>
            <div>
                {update && <button type="button" className="ttm-btn-ghost" onClick={ignoreAppUpdate}>忽略此版本</button>}
                <button type="button" className="ttm-btn-secondary" onClick={closeReleaseNotes}>{update ? '稍后' : '关闭'}</button>
                {update && <button type="button" className="ttm-btn-primary" onClick={confirmAppUpdate}>下载并安装</button>}
            </div>
        </div>
    </AnchoredDialog>;
}

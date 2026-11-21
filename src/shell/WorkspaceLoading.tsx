import { textOf, type Appearance } from '../theme/appearance-model';
import { ShellArt } from '../theme/appearance-shell';
import { Icon } from './Icon';

export function WorkspaceLoading({ skin, appName, initializationError, onRetry }: {
    skin?: Appearance;
    appName: string;
    initializationError: string;
    onRetry: () => void;
}) {
    return <div className="ttm-app-root ttm-loading" data-ti-shell="startup" aria-busy={!initializationError}>
        <main className="ttm-loading-content">
            <div className="ttm-loading-emblem" data-ti-part="startup-art" aria-hidden="true"><ShellArt skin={skin} id="startup" fallback={<Icon name="book" width={36} height={36} />} /></div>
            <h1 data-ti-type="heading">{appName}</h1>
            <p className="ttm-loading-subtitle">{textOf(skin, 'startup-title')}</p>
            <div className="ttm-loading-status" role={initializationError ? 'alert' : 'status'}>
                {!initializationError && <span className="ttm-loading-spinner" aria-hidden="true" />}
                <span>{initializationError ? `读取失败：${initializationError}` : textOf(skin, 'startup-status')}</span>
            </div>
            {initializationError && <button type="button" className="ttm-btn-secondary" onClick={onRetry}>重新读取</button>}
        </main>
    </div>;
}

import { invoke } from '@tauri-apps/api/core';
import { nativeAppUpdates } from './native-runtime';
import { dismissNotification, showNotification } from '../store/notification-store';
import { persistWorkspaceNow, workspaceStore } from '../store/workspace-store';
import { createReactiveStore } from '../store/reactive-store';
import { diagnosticLabel, diagnosticOperation, flushDiagnostics, recordDiagnostic } from './diagnostics';

export interface UpdateDetails { version: string; title: string | null; notes: string | null; publishedAt?: string | null; installerSize?: number | null }
interface UpdateCheck { release: UpdateDetails | null; candidate: string | null; httpStatus: number | null }
interface UpdateFailure { stage?: string; code?: string; message?: string; httpStatus?: number | null; candidate?: string | null }
function updateFailure(error: unknown, stage: string) {
    const failure = error as UpdateFailure | null;
    return { stage: failure?.stage ?? stage, code: failure?.code ?? 'UPDATE_FAILED', httpStatus: failure?.httpStatus ?? undefined,
        detail: failure?.candidate ? `候选版本 ${diagnosticLabel(failure.candidate)}` : undefined };
}
type ReleaseNotesView = { kind: 'current'; anchor: HTMLElement } | { kind: 'update'; release: UpdateDetails };
export const releaseNotesView = createReactiveStore<{ open: ReleaseNotesView | null }>(() => ({ open: null }));

export function showCurrentReleaseNotes(anchor: HTMLElement) {
    releaseNotesView.setState({ open: { kind: 'current', anchor } });
}

export function closeReleaseNotes() {
    const { open } = releaseNotesView.getState();
    releaseNotesView.setState({ open: null });
    if (open?.kind === 'update') offerUpdate(open.release);
}

export function confirmAppUpdate() {
    const { open } = releaseNotesView.getState();
    if (open?.kind !== 'update') return;
    releaseNotesView.setState({ open: null });
    void installUpdate(open.release, false);
}

export function ignoreUpdateVersion(version: string) {
    ignoredVersion = version;
    recordDiagnostic('更新', '忽略版本', '跳过', { code: 'IGNORED_BY_USER', detail: diagnosticLabel(ignoredVersion) });
    try { localStorage.setItem(ignoredVersionKey, ignoredVersion); }
    catch { /* Keep the choice for this run if local storage is unavailable. */ }
    const { open } = releaseNotesView.getState();
    if (open?.kind === 'update' && open.release.version === ignoredVersion) {
        releaseNotesView.setState({ open: null });
    }
    showNotification(`已忽略 TipsyIsle ${ignoredVersion}`, { id: notice });
}

export function ignoreAppUpdate() {
    const { open } = releaseNotesView.getState();
    if (open?.kind !== 'update') return;
    ignoreUpdateVersion(open.release.version);
}

const notice = 'app-update';
const ignoredVersionKey = 'tipsy:ignored-update-version';
let ignoredVersion: string | null = null;
let checking: Promise<void> | undefined;
let checkedOnStartup = false;
let updating = false;

function isIgnoredUpdate(version: string): boolean {
    if (ignoredVersion === version) return true;
    try { return localStorage.getItem(ignoredVersionKey) === version; }
    catch { return false; }
}

function offerUpdate(release: UpdateDetails, message = `TipsyIsle ${release.version} 可更新`, ready = false) {
    showNotification(message, {
        id: notice, duration: 0,
        action: ready ? { label: '继续安装', run: () => void installUpdate(release, true) }
            : { label: '查看更新', run: () => {
                dismissNotification(notice);
                releaseNotesView.setState({ open: { kind: 'update', release } });
            } },
        ...(!ready ? { secondaryAction: { label: '忽略此版本', run: () => ignoreUpdateVersion(release.version) } } : {}),
    });
}

function storyBusy() {
    const state = workspaceStore.getState();
    return state.isGenerating || state.helperGenerationCount > 0 || state.mvuExtraAnalysisActive;
}

async function installUpdate(release: UpdateDetails, ready: boolean) {
    if (updating) return;
    if (storyBusy()) { offerUpdate(release, '故事正在续写，请等这一轮结束后安装。', ready); return; }
    const { version } = release;
    const report = diagnosticOperation('更新', ready ? '继续安装更新' : '下载并安装更新', diagnosticLabel(version));
    let stage = '下载安装包';
    updating = true;
    try {
        if (!ready) {
            report('进行中', { stage });
            showNotification(`正在下载 TipsyIsle ${version}…`, { id: notice, kind: 'progress' });
            await invoke('tipsy_update_download', { version });
            ready = true;
            report('成功', { stage });
        }
        if (storyBusy()) { report('跳过', { code: 'STORY_BUSY' }); offerUpdate(release, '更新已下载。请等这一轮故事结束后安装。', true); return; }
        stage = '保存当前故事';
        await persistWorkspaceNow();
        if (storyBusy()) { report('跳过', { code: 'STORY_BUSY' }); offerUpdate(release, '更新已下载。请等这一轮故事结束后安装。', true); return; }
        stage = '交给系统安装';
        report('进行中', { stage });
        flushDiagnostics(); // Windows exits as soon as it starts the installer.
        const result = await invoke<'opened' | 'permission'>('tipsy_update_install', { version });
        report(result === 'permission' ? '跳过' : '成功', { stage, code: result === 'permission' ? 'INSTALL_PERMISSION_REQUIRED' : 'INSTALLER_OPENED' });
        offerUpdate(release, result === 'permission'
            ? '请在系统设置允许 TipsyIsle 安装应用，返回后继续安装。'
            : '已打开系统安装界面。', true);
    } catch (error) {
        report('失败', updateFailure(error, stage));
        const message = (error as UpdateFailure | null)?.message ?? String(error);
        if (ready) {
            showNotification(message, { id: notice, duration: 0, kind: 'error', action: { label: '重试', run: () => void installUpdate(release, false) } });
        } else {
            showNotification(message, { id: notice, duration: 0, kind: 'error', action: { label: '重新检查', run: () => void checkAppUpdate(true) } });
        }
    } finally { updating = false; }
}

export function checkAppUpdate(manual = false): Promise<void> {
    if (!nativeAppUpdates || updating) return Promise.resolve();
    if (checking) return checking;
    if (!manual && checkedOnStartup) return Promise.resolve();
    checkedOnStartup = true;
    if (manual) showNotification('正在检查更新…', { id: notice, kind: 'progress' });
    const report = diagnosticOperation('更新', manual ? '手动检查更新' : '启动检查更新');
    report('进行中', { stage: '原生请求 api.github.com' });
    return checking = invoke<UpdateCheck>('tipsy_update_check').then(({ release, candidate, httpStatus }) => {
        const details = { detail: candidate ? `候选版本 ${diagnosticLabel(candidate)}` : undefined, httpStatus: httpStatus ?? undefined };
        if (release) {
            if (manual || !isIgnoredUpdate(release.version)) {
                report('成功', { ...details, code: 'UPDATE_AVAILABLE' });
                offerUpdate(release);
            } else report('跳过', { ...details, code: 'IGNORED_BY_USER' });
        } else {
            report('成功', { ...details, code: 'NO_UPDATE' });
            if (manual) showNotification('已是最新版本。', { id: notice, kind: 'success' });
        }
    }).catch(error => {
        report('失败', updateFailure(error, '调用原生更新接口'));
        if (manual) showNotification((error as UpdateFailure | null)?.message ?? String(error), { id: notice, kind: 'error' });
    }).finally(() => { checking = undefined; });
}

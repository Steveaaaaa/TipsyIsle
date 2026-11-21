import { invoke } from '@tauri-apps/api/core';
import { nativeAppUpdates } from './native-runtime';
import { dismissNotification, showNotification } from '../store/notification-store';
import { persistWorkspaceNow, workspaceStore } from '../store/workspace-store';
import { createReactiveStore } from '../store/reactive-store';

interface UpdateDetails { version: string; title: string | null; notes: string | null }
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

export function ignoreAppUpdate() {
    const { open } = releaseNotesView.getState();
    if (open?.kind !== 'update') return;
    ignoredVersion = open.release.version;
    try { localStorage.setItem(ignoredVersionKey, ignoredVersion); }
    catch { /* Keep the choice for this run if local storage is unavailable. */ }
    releaseNotesView.setState({ open: null });
    showNotification(`已忽略 TipsyIsle ${ignoredVersion}`, { id: notice });
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
    updating = true;
    try {
        if (!ready) {
            showNotification(`正在下载 TipsyIsle ${version}…`, { id: notice, kind: 'progress' });
            await invoke('tipsy_update_download', { version });
            ready = true;
        }
        if (storyBusy()) { offerUpdate(release, '更新已下载。请等这一轮故事结束后安装。', true); return; }
        await persistWorkspaceNow();
        if (storyBusy()) { offerUpdate(release, '更新已下载。请等这一轮故事结束后安装。', true); return; }
        const result = await invoke<'opened' | 'permission'>('tipsy_update_install', { version });
        offerUpdate(release, result === 'permission'
            ? '请在系统设置允许 TipsyIsle 安装应用，返回后继续安装。'
            : '已打开系统安装界面。', true);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
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
    return checking = invoke<UpdateDetails | string | null>('tipsy_update_check').then(release => {
        if (release) {
            const update = typeof release === 'string' ? { version: release, title: null, notes: null } : release;
            if (manual || !isIgnoredUpdate(update.version)) offerUpdate(update);
        } else if (manual) showNotification('已是最新版本。', { id: notice, kind: 'success' });
    }).catch(error => {
        if (manual) showNotification(error instanceof Error ? error.message : String(error), { id: notice, kind: 'error' });
    }).finally(() => { checking = undefined; });
}

import { invoke } from '@tauri-apps/api/core';
import { nativeAppUpdates } from './native-runtime';
import { showNotification } from '../store/notification-store';
import { persistWorkspaceNow, workspaceStore } from '../store/workspace-store';

const notice = 'app-update';
let checking: Promise<void> | undefined;
let checkedOnStartup = false;
let updating = false;

function offerUpdate(version: string, message = `TipsyIsle ${version} 可更新`, ready = false) {
    showNotification(message, {
        id: notice, duration: 0,
        action: { label: ready ? '继续安装' : '下载并安装', run: () => void installUpdate(version, ready) },
    });
}

function storyBusy() {
    const state = workspaceStore.getState();
    return state.isGenerating || state.helperGenerationCount > 0 || state.mvuExtraAnalysisActive;
}

async function installUpdate(version: string, ready: boolean) {
    if (updating) return;
    if (storyBusy()) { offerUpdate(version, '故事正在续写，请等这一轮结束后安装。', ready); return; }
    updating = true;
    try {
        if (!ready) {
            showNotification(`正在下载 TipsyIsle ${version}…`, { id: notice, kind: 'progress' });
            await invoke('tipsy_update_download', { version });
            ready = true;
        }
        if (storyBusy()) { offerUpdate(version, '更新已下载。请等这一轮故事结束后安装。', true); return; }
        await persistWorkspaceNow();
        if (storyBusy()) { offerUpdate(version, '更新已下载。请等这一轮故事结束后安装。', true); return; }
        const result = await invoke<'opened' | 'permission'>('tipsy_update_install', { version });
        offerUpdate(version, result === 'permission'
            ? '请在系统设置允许 TipsyIsle 安装应用，返回后继续安装。'
            : '已打开系统安装界面。', true);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (ready) {
            showNotification(message, { id: notice, duration: 0, kind: 'error', action: { label: '重试', run: () => void installUpdate(version, false) } });
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
    return checking = invoke<string | null>('tipsy_update_check').then(version => {
        if (version) offerUpdate(version);
        else if (manual) showNotification('已是最新版本。', { id: notice, kind: 'success' });
    }).catch(error => {
        if (manual) showNotification(error instanceof Error ? error.message : String(error), { id: notice, kind: 'error' });
    }).finally(() => { checking = undefined; });
}

import { setStatusBanner } from '../store/workspace-store';

export function reportActionError(label: string, error: unknown): void {
    setStatusBanner(`${label}失败：${error instanceof Error ? error.message : String(error)}`, { kind: 'error' });
}

export async function runUiAction<T>(label: string, action: () => Promise<T>, fallback: T): Promise<T> {
    try {
        return await action();
    } catch (error) {
        reportActionError(label, error);
        return fallback;
    }
}

export function runStoreAction(label: string, action: () => void): boolean {
    try {
        action();
        return true;
    } catch (error) {
        reportActionError(label, error);
        return false;
    }
}

import { useEffect, useRef } from 'react';
import { isNativeRuntime } from '../core/native-runtime';
import { topAppDialog } from './AnchoredDialog';

/** Android back closes the current app surface before leaving the activity. */
export function useNativeNavigation(consumeBack: () => boolean): void {
    const consume = useRef(consumeBack); consume.current = consumeBack;
    useEffect(() => {
        if (!isNativeRuntime()) return;
        let disposed = false;
        let unregister: (() => Promise<void>) | undefined;
        void import('@tauri-apps/api/app').then(async ({ onBackButtonPress, exit }) => {
            const listener = await onBackButtonPress(() => {
                if (!window.dispatchEvent(new Event('tipsy-menu-back', { cancelable: true }))) return;
                const dialog = topAppDialog() ?? document.querySelector<HTMLDialogElement>('dialog[open]');
                if (dialog) { const event = new Event('cancel', { cancelable: true }); if (dialog.dispatchEvent(event)) dialog.close(); return; }
                if (consume.current()) return;
                void exit(0);
            });
            if (disposed) await listener.unregister(); else unregister = () => listener.unregister();
        }).catch(error => console.error('Android 返回键注册失败', error));
        return () => { disposed = true; void unregister?.(); };
    }, []);
}

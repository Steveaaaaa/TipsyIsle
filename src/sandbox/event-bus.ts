import type { TavernEventName } from '../types';

export type TavernEventHandler = (...args: unknown[]) => void | Promise<void>;

class TypedEventBus {
    private listeners = new Map<string, Set<TavernEventHandler>>();
    private lastListeners = new Map<string, Set<TavernEventHandler>>();

    public on(event: TavernEventName | string, handler: TavernEventHandler): () => void {
        let set = this.listeners.get(event);
        if (!set) {
            set = new Set();
            this.listeners.set(event, set);
        }
        set.add(handler);
        return () => this.off(event, handler);
    }

    public makeLast(event: TavernEventName | string, handler: TavernEventHandler): () => void {
        let set = this.lastListeners.get(event);
        if (!set) {
            set = new Set();
            this.lastListeners.set(event, set);
        }
        set.add(handler);
        return () => this.off(event, handler);
    }

    public off(event: TavernEventName | string, handler: TavernEventHandler): void {
        this.listeners.get(event)?.delete(handler);
        this.lastListeners.get(event)?.delete(handler);
    }

    public async emit(event: TavernEventName | string, ...args: unknown[]): Promise<void> {
        const regular = this.listeners.get(event);
        if (regular) {
            for (const fn of [...regular]) {
                try {
                    await fn(...args);
                } catch (err) {
                    console.warn(`[ModernTavern EventBus] Listener error on ${event}:`, err);
                }
            }
        }
        const tail = this.lastListeners.get(event);
        if (tail) {
            for (const fn of [...tail]) {
                try {
                    await fn(...args);
                } catch (err) {
                    console.warn(`[ModernTavern EventBus] Tail listener error on ${event}:`, err);
                }
            }
        }
        // Broadcast to all mounted SandboxFrames
        broadcastEventToSandboxes(event, args);
    }
}

export const tavernEventBus = new TypedEventBus();

const activeSandboxWindows = new Set<Window>();

export function registerSandboxWindow(win: Window): () => void {
    activeSandboxWindows.add(win);
    return () => {
        activeSandboxWindows.delete(win);
    };
}

export function broadcastEventToSandboxes(event: string, args: unknown[]): void {
    for (const win of [...activeSandboxWindows]) {
        try {
            win.postMessage(
                {
                    __tt_sandbox_event__: true,
                    event,
                    args,
                },
                '*',
            );
        } catch {
            activeSandboxWindows.delete(win);
        }
    }
}

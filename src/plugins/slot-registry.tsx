import { type ReactNode } from 'react';
import { createReactiveStore } from '../store/reactive-store';
import type { UiSlotName } from '../types';

export interface UiSlotContribution<P = Record<string, unknown>> {
    id: string;
    slot: UiSlotName;
    order?: number;
    render: (props: P) => ReactNode;
}

interface SlotRegistryState {
    contributions: Record<UiSlotName, UiSlotContribution<any>[]>;
}

const INITIAL_SLOTS: SlotRegistryState = {
    contributions: {
        'topbar.actions': [],
        'sidebar.footer': [],
        'shell.sidebar.footer': [],
        'composer.toolbar': [],
        'inspector.extra': [],
        'chat.header.actions': [],
        'chat.input.toolbar': [],
        'message.actions': [],
        'message.footer': [],
        'inspector.tab': [],
    },
};

export const uiSlotStore = createReactiveStore<SlotRegistryState>(() => INITIAL_SLOTS);

export function registerUiSlot<P = Record<string, unknown>>(contribution: UiSlotContribution<P>): () => void {
    uiSlotStore.setState((draft) => {
        const existing = (draft.contributions[contribution.slot] || []).filter((c) => c.id !== contribution.id);
        existing.push(contribution);
        existing.sort((a, b) => (a.order ?? 50) - (b.order ?? 50));
        draft.contributions[contribution.slot] = existing;
    });

    return () => {
        uiSlotStore.setState((draft) => {
            draft.contributions[contribution.slot] = (draft.contributions[contribution.slot] || []).filter(
                (c) => c.id !== contribution.id,
            );
        });
    };
}

export function SlotMount<P extends Record<string, unknown> = Record<string, unknown>>({
    name,
    slotProps,
}: {
    name: UiSlotName;
    slotProps?: P;
}) {
    const items = uiSlotStore.useStore((s) => s.contributions[name] || []);
    if (items.length === 0) return null;
    return (
        <>
            {items.map((item) => (
                <span key={item.id} className="ttm-slot-item">
                    {item.render((slotProps || {}) as P)}
                </span>
            ))}
        </>
    );
}


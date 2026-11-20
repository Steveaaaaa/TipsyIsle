import { useState, type ReactNode } from 'react';
import { Icon } from './Icon';

export function SettingsSection({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
    return <section className="ttm-settings-section"><h3>{title}</h3>{description && <p className="ttm-settings-note">{description}</p>}{children}</section>;
}

export function SettingsDisclosure({ title, children }: { title: string; children: ReactNode }) {
    const [open, setOpen] = useState(false);
    return <details className="ttm-settings-disclosure" onToggle={event => setOpen(event.currentTarget.open)}><summary><span>{title}</span><Icon name="chevron" width={16} height={16} /></summary>{open && <div className="ttm-settings-disclosure-body">{children}</div>}</details>;
}

import { useEffect, useState, type ReactNode } from 'react';
import { Icon, type IconName } from '../shell/Icon';
import { assetUrl, defaultText, textOf, type Appearance, type Part, type Widget } from './appearance-model';

export function ShellArt({ skin, id, fallback }: { skin?: Appearance; id: string; fallback?: ReactNode }) {
    const src = assetUrl(skin, skin?.art[id]);
    return src ? <img className="ttm-skin-art" src={src} alt="" draggable={false} /> : <>{fallback}</>;
}

export function ShellBrand({ skin }: { skin?: Appearance }) {
    return <div className="ttm-brand" data-ti-part="brand">
        <span className="ttm-brand-logo" data-ti-part="logo"><ShellArt skin={skin} id="logo" fallback={<Icon name="book" width={24} height={24} />} /></span>
        <div><h1 className="ttm-brand-title" data-ti-type="heading"><span className="ttm-brand-name">{textOf(skin, 'name') || defaultText.name}</span><span className="ttm-brand-english">{textOf(skin, 'subtitle')}</span></h1></div>
    </div>;
}

export const partIcons: Partial<Record<Part, IconName>> = { focus: 'focus', settings: 'settings', appearance: 'palette', 'sidebar-settings': 'settings',
    routes: 'branch', profile: 'chat', history: 'history', 'new-chat': 'plus', reading: 'book', continue: 'arrow', regenerate: 'refresh',
    'mobile-library': 'book', 'mobile-chat': 'chat', 'mobile-appearance': 'palette', 'mobile-settings': 'settings' };

export function ShellPartIcon({ skin, id, name = partIcons[id], size = 18 }: { skin?: Appearance; id: Part; name?: IconName; size?: number }) {
    return <ShellArt skin={skin} id={id} fallback={name && <Icon name={name} width={size} height={size} />} />;
}

type WidgetContext = { character: string; messages: number; library: number };
function WidgetClock() {
    const time = () => new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(new Date());
    const [label, setLabel] = useState(time);
    useEffect(() => { const timer = setInterval(() => setLabel(time()), 15_000); return () => clearInterval(timer); }, []);
    return <time>{label}</time>;
}
export function ShellWidget({ skin, widget, values, onAction, onSelect }: { skin: Appearance; widget: Widget; values: WidgetContext;
    onAction?: (action: Widget['action'], anchor: HTMLElement) => void; onSelect?: () => void }) {
    const image = assetUrl(skin, widget.image);
    const body = <>{image && <img className="ttm-skin-art" src={image} alt="" />}<span>{widget.label}</span>
        {widget.value === 'time' ? <WidgetClock /> : widget.value && <strong>{values[widget.value]}</strong>}</>;
    return widget.action || onSelect ? <button className="ttm-chip-btn ttm-skin-widget" type="button" data-ti-part="widget" data-ti-widget={widget.id}
        onClick={event => onSelect ? onSelect() : onAction?.(widget.action, event.currentTarget)}>{body}</button> : <span className="ttm-skin-widget" data-ti-part="widget" data-ti-widget={widget.id}>{body}</span>;
}

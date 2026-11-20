import { Icon } from './Icon';

/** Text and distinct shapes keep enabled state readable without relying on hue. */
export function EntryStatus({ enabled }: { enabled: boolean }) {
    return <span className={`ttm-entry-status ${enabled ? 'is-enabled' : 'is-disabled'}`}><Icon name={enabled ? 'check' : 'close'} width={12} height={12} strokeWidth={2} /><span>{enabled ? '已启用' : '已关闭'}</span></span>;
}

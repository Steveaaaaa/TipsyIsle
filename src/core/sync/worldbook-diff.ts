import { canonical, sameRevisionValue, type SyncRevision } from './protocol';

export interface WorldbookDifference { field: string; local: string; remote: string }
function split(record: SyncRevision) {
    const value = record.value ? { ...record.value } : record.value;
    const books: Record<string, any> = {};
    const take = (owner: any, key: string, label: string) => {
        if (!owner) return;
        books[label] = owner[key]; delete owner[key];
    };
    if (record.id.startsWith('lorebooks:')) return { books: { 世界书: value }, rest: null };
    if (record.id.startsWith('characters:')) {
        take(value, 'characterBook', '角色世界书'); take(value, 'embeddedLorebook', '内嵌世界书');
    } else if (record.id.startsWith('chat:')) {
        if (value?.continuation) value.continuation = { ...value.continuation };
        take(value?.continuation, 'worldbooks', '会话世界书');
        take(value?.continuation, 'activeLorebookIds', '全局启用列表');
    }
    return { books, rest: value };
}
const labels: Record<string, string> = { disabled: '停用', content: '正文', comment: '条目名称', keys: '关键词', secondaryKeys: '辅助关键词',
    constant: '常驻', order: '顺序', position: '插入位置', depth: '深度', probability: '概率', name: '名称', entries: '条目',
    scanDepth: '扫描深度', tokenBudget: 'Token 预算', recursiveScanning: '递归扫描' };
const display = (value: any) => value === undefined ? '（无）' : value === null ? '（已删除）' : typeof value === 'boolean' ? value ? '是' : '否'
    : typeof value === 'string' ? value || '（空）' : JSON.stringify(value, null, 2);
export function worldbookDifference(local: SyncRevision, remote: SyncRevision): WorldbookDifference[] {
    const left = split(local), right = split(remote);
    // Story changes still use independent saves; only worldbook-only divergence asks for replacement.
    if (!sameRevisionValue(left.rest, right.rest) || canonical(local.links) !== canonical(remote.links)) return [];
    const result: WorldbookDifference[] = [];
    const walk = (a: any, b: any, path: string) => {
        if (canonical(a) === canonical(b)) return;
        if (a && b && typeof a === 'object' && typeof b === 'object') {
            if (Array.isArray(a) && Array.isArray(b) && [...a, ...b].every(item => item && typeof item === 'object' && ('uid' in item || 'id' in item))) {
                const map = (items: any[]) => Object.fromEntries(items.map(item => [String(item.uid ?? item.id), item]));
                const am = map(a), bm = map(b);
                for (const key of new Set([...Object.keys(am), ...Object.keys(bm)])) walk(am[key], bm[key], `${path} / ${am[key]?.comment || bm[key]?.comment || am[key]?.name || bm[key]?.name || key}`);
            } else if (!Array.isArray(a) && !Array.isArray(b)) {
                for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) walk(a[key], b[key], `${path} / ${labels[key] ?? key}`);
            } else result.push({ field: path, local: display(a), remote: display(b) });
        } else result.push({ field: path, local: display(a), remote: display(b) });
    };
    walk(left.books, right.books, '');
    return result;
}

import app from '../../package.json';
import { createReactiveStore } from '../store/reactive-store';

type Area = '启动' | '更新' | '模型' | '生成' | '导入' | '保存' | '兼容' | '插件';
type Result = '开始' | '进行中' | '成功' | '失败' | '跳过' | '取消';
interface Details {
    stage?: string; code?: string; httpStatus?: number; elapsedMs?: number;
    component?: string; componentVersion?: string; detail?: string;
}
export interface DiagnosticEntry extends Details {
    at: number; version: string; area: Area; action: string; result: Result; operation?: string;
}

const key = 'tipsy:diagnostic-log';
const encoder = new TextEncoder();
const byteLimit = 512 * 1024;
const countLimit = 500;
const entryBytes = (entry: DiagnosticEntry) => encoder.encode(JSON.stringify(entry)).byteLength + 1;
let saved: DiagnosticEntry[] = [];
let storageFailed = false;
try {
    const value = JSON.parse(localStorage.getItem(key) ?? '[]');
    if (Array.isArray(value)) saved = value.slice(-countLimit);
}
catch { storageFailed = true; }
let sizes = saved.map(entryBytes);
let logBytes = sizes.reduce((total, size) => total + size, 2);
export const diagnosticsStore = createReactiveStore(() => ({ entries: saved, storageFailed }));
let timer: ReturnType<typeof setTimeout> | undefined;
let dirty = false;

export function flushDiagnostics(): void {
    clearTimeout(timer); timer = undefined;
    if (!dirty) return;
    try {
        localStorage.setItem(key, JSON.stringify(diagnosticsStore.getState().entries));
        dirty = false;
        if (diagnosticsStore.getState().storageFailed) diagnosticsStore.setState({ storageFailed: false });
    } catch { diagnosticsStore.setState({ storageFailed: true }); }
}

if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', flushDiagnostics);
    document.addEventListener('visibilitychange', () => { if (document.hidden) flushDiagnostics(); });
}

export function clearDiagnostics(): boolean {
    sizes = []; logBytes = 2;
    diagnosticsStore.setState({ entries: [] });
    dirty = true;
    flushDiagnostics();
    return !diagnosticsStore.getState().storageFailed;
}

export function diagnosticLabel(text: string): string {
    return text.replace(/\b(?:https?|file):\/\/\S+|\b(?:sk|AIza)[-\w]{12,}/gi, '[已省略]').replace(/[\r\n\t]+/g, ' ').slice(0, 160);
}

// Pass known fields, never request bodies or raw exceptions from providers/scripts.
export function recordDiagnostic(area: Area, action: string, result: Result, details: Details = {}, operation?: string): void {
    const entry: DiagnosticEntry = { ...details, at: Date.now(), version: app.version, area, action, result, operation };
    const size = entryBytes(entry);
    if (size + 2 > byteLimit) return;
    sizes.push(size); logBytes += size;
    let from = 0;
    while (sizes.length - from > countLimit || logBytes > byteLimit) {
        logBytes -= sizes[from++];
    }
    if (from) sizes.splice(0, from);
    diagnosticsStore.setState({ entries: [...diagnosticsStore.getState().entries.slice(from), entry] });
    dirty = true;
    if (result === '失败') {
        clearTimeout(timer);
        timer = setTimeout(flushDiagnostics, 0);
    } else timer ??= setTimeout(flushDiagnostics, 750);
}

export function diagnosticOperation(area: Area, action: string, detail?: string) {
    const id = crypto.getRandomValues(new Uint32Array(1))[0].toString(16).padStart(8, '0');
    const start = performance.now();
    recordDiagnostic(area, action, '开始', { detail }, id);
    return (result: Result, details: Details = {}) => recordDiagnostic(area, action, result,
        { ...details, elapsedMs: details.elapsedMs ?? Math.round(performance.now() - start) }, id);
}

export function diagnosticTransport(flavor: string, url: string): string {
    const protocol = /^https?:/i.exec(url.trim())?.[0].toUpperCase().slice(0, -1);
    return `${flavor}${protocol ? ` / ${protocol}` : ''}`;
}

export const compatibilityDiagnosticStates = { extension: new Map<string, 'ready' | 'failed'>(), script: new Map<string, 'ready' | 'failed'>() };

export function diagnosticErrorKind(error: unknown): string {
    const name = (error as { name?: string } | null)?.name;
    return ['AbortError', 'TimeoutError', 'TypeError', 'SyntaxError', 'ReferenceError', 'RangeError', 'QuotaExceededError'].includes(name ?? '') ? name! : 'ERROR';
}

export function formatDiagnostic(entry: DiagnosticEntry): string {
    return [new Date(entry.at).toLocaleString('zh-CN', { hour12: false }), `v${entry.version}`, entry.operation && `#${entry.operation}`,
        entry.area, entry.action, entry.result, entry.stage, entry.component && `${entry.component}${entry.componentVersion ? ` v${entry.componentVersion}` : ''}`,
        entry.code, entry.httpStatus !== undefined && `HTTP ${entry.httpStatus}`, entry.elapsedMs !== undefined && `${entry.elapsedMs} ms`, entry.detail].filter(Boolean).join(' · ');
}

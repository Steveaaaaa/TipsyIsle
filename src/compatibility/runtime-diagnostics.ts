import './runtime-status.css';

type DiagnosticState = 'error' | 'warning' | 'entry';
const statusLabels: Record<DiagnosticState, string> = { error: '错误', warning: '提醒', entry: '入口已执行' };
const icons = {
    panel: 'M9 4H5a2 2 0 0 0-2 2v14h18V6a2 2 0 0 0-2-2h-4M9 2h6v5H9V2Zm-2 9h10M7 15h6',
    entry: 'm5 12 4 4L19 6', error: 'M12 8v5m0 3h.01M12 3 2 21h20L12 3Z', warning: 'M12 8v5m0 3h.01M12 3 2 21h20L12 3Z',
    chevron: 'm9 5 7 7-7 7',
};
function icon(path: string): SVGSVGElement {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.6'); svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round'); svg.setAttribute('aria-hidden', 'true');
    const line = document.createElementNS(svg.namespaceURI, 'path'); line.setAttribute('d', path); svg.append(line);
    return svg;
}
function panel(root: HTMLElement): HTMLDetailsElement {
    let element = document.getElementById('compat-diagnostics') as HTMLDetailsElement | null;
    if (element) return element;
    element = document.createElement('details'); element.id = 'compat-diagnostics'; element.className = 'tipsy-runtime-ui tipsy-runtime-diagnostics';
    const summary = document.createElement('summary');
    const mark = document.createElement('span'); mark.className = 'tipsy-runtime-diagnostic-mark'; mark.append(icon(icons.panel));
    const copy = document.createElement('span'); copy.className = 'tipsy-runtime-diagnostic-heading';
    const title = document.createElement('strong'); title.textContent = '脚本运行诊断';
    const count = document.createElement('small'); count.className = 'tipsy-runtime-diagnostic-count';
    copy.append(title, count);
    const badge = document.createElement('span'); badge.className = 'tipsy-runtime-diagnostic-total';
    const arrow = icon(icons.chevron); arrow.classList.add('tipsy-runtime-disclosure');
    summary.append(mark, copy, badge, arrow); element.append(summary);
    const note = document.createElement('p'); note.className = 'tipsy-runtime-diagnostic-note'; note.textContent = '记录初始化入口与后续运行信息；入口执行完成不代表所有异步任务已经结束。';
    const list = document.createElement('ul'); list.className = 'compat-diagnostic-items'; element.append(note, list); root.before(element);
    return element;
}
function updateSummary(element: HTMLDetailsElement): void {
    const list = element.querySelector('.compat-diagnostic-items')!;
    const scripts = list.querySelectorAll('[data-state=entry]').length;
    const errors = list.querySelectorAll('[data-state=error]').length;
    const warnings = list.querySelectorAll('[data-state=warning]').length;
    element.dataset.state = errors ? 'error' : warnings ? 'warning' : 'entry';
    element.querySelector('.tipsy-runtime-diagnostic-count')!.textContent = scripts ? `${scripts} 个脚本已执行入口` : '查看故事脚本的运行信息';
    element.querySelector('.tipsy-runtime-diagnostic-total')!.textContent = errors ? `${errors} 条错误${warnings ? ` · ${warnings} 条提醒` : ''}` : warnings ? `${warnings} 条提醒` : '启动记录';
}
export function appendRuntimeDiagnostic(root: HTMLElement, name: string, message: string, state: DiagnosticState, scriptId = ''): void {
    const element = panel(root), list = element.querySelector('.compat-diagnostic-items')!;
    if (state === 'entry' && [...list.children].some(row => (row as HTMLElement).dataset.scriptId === scriptId && (row as HTMLElement).dataset.state === 'entry')) return;
    const row = document.createElement('li'); row.className = 'tipsy-runtime-diagnostic-row'; row.dataset.state = state; row.dataset.scriptId = scriptId;
    const mark = icon(icons[state]); mark.classList.add('tipsy-runtime-row-icon');
    const content = document.createElement('div'); content.className = 'tipsy-runtime-diagnostic-content';
    const heading = document.createElement('div'); heading.className = 'tipsy-runtime-row-heading';
    const title = document.createElement('strong'); title.textContent = name;
    const label = document.createElement('span'); label.textContent = statusLabels[state]; label.className = 'tipsy-runtime-row-label';
    heading.append(title, label); content.append(heading);
    if (state !== 'entry') {
        const preview = document.createElement('p'); preview.className = 'tipsy-runtime-error-preview'; preview.textContent = message.split(/\r?\n/, 1)[0].slice(0, 240); content.append(preview);
        const detail = document.createElement('details'); detail.className = 'tipsy-runtime-error-details';
        const summary = document.createElement('summary'); summary.textContent = '查看错误详情';
        const text = document.createElement('pre'); text.textContent = message; detail.append(summary, text); content.append(detail);
    }
    row.append(mark, content); list.append(row);
    while (list.children.length > 100) list.firstElementChild!.remove();
    updateSummary(element);
}

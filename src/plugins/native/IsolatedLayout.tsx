import { useEffect, useRef, useState } from 'react';
import DOMPurify from 'dompurify';
import type { Panel } from '../../../packages/plugin-sdk/index.js';

const fieldId = /^[a-z][a-z0-9_-]{0,63}$/;
const tags = ['div', 'span', 'section', 'article', 'header', 'footer', 'main', 'aside', 'h1', 'h2', 'h3', 'h4', 'p', 'strong', 'em', 'small', 'br', 'hr',
    'ol', 'ul', 'li', 'dl', 'dt', 'dd', 'pre', 'code', 'blockquote', 'table', 'caption', 'thead', 'tbody', 'tr', 'th', 'td', 'details', 'summary',
    'form', 'label', 'fieldset', 'legend', 'button', 'input', 'textarea', 'select', 'option', 'optgroup', 'progress', 'meter'];
const attrs = ['id', 'class', 'name', 'type', 'value', 'checked', 'selected', 'disabled', 'required', 'for', 'placeholder', 'maxlength', 'rows', 'cols',
    'min', 'max', 'step', 'pattern', 'colspan', 'rowspan', 'scope', 'open', 'title', 'role', 'data-action'];
const themeProperties = ['--ti-bg-surface', '--ti-bg-base', '--ti-text-primary', '--ti-text-muted', '--ti-border', '--ti-accent', '--ti-danger'];

function documentFor(layout: NonNullable<Panel['layout']>, token: string) {
    const root = getComputedStyle(document.documentElement);
    const variables = themeProperties.map(name => `${name}:${root.getPropertyValue(name)};`).join('').replace(/</g, '');
    const content = DOMPurify.sanitize(layout.html, { ALLOWED_TAGS: tags, ALLOWED_ATTR: attrs, ALLOW_DATA_ATTR: false, ALLOW_ARIA_ATTR: true });
    const css = (layout.css ?? '').replace(/<\/style/gi, '\\3C /style');
    // No plugin scripts. Only the host-owned form bridge runs in this opaque origin.
    return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${token}'; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'">
<style>:root{${variables}color-scheme:light dark;font:15px/1.55 system-ui;color:var(--ti-text-primary);background:var(--ti-bg-surface)}*{box-sizing:border-box}body{margin:0;padding:12px;overflow-wrap:anywhere}input,textarea,select,button{font:inherit;max-width:100%}button{cursor:pointer}table{border-collapse:collapse}th,td{padding:4px 8px;text-align:start}</style><style>${css}</style></head>
<body><main id="tipsy-panel">${content}</main><script nonce="${token}">
(() => {
    const root = document.body.firstElementChild;
    const token = ${JSON.stringify(token)}, valid = /^[a-z][a-z0-9_-]{0,63}$/;
    const post = data => parent.postMessage({ ...data, token }, '*');
    const send = (button, form) => {
        const action = button?.getAttribute('data-action') ?? form?.getAttribute('data-action');
        if (!action || !valid.test(action) || form && !form.reportValidity()) return;
        const values = Object.create(null);
        for (const field of (form ?? root).querySelectorAll('input[name],textarea[name],select[name]')) {
            const name = field.getAttribute('name');
            if (!valid.test(name) || field.matches(':disabled') || ['file','button','submit','reset','image'].includes(field.type) || field.type === 'radio' && !field.checked) continue;
            values[name] = field.type === 'checkbox' ? field.checked : field.value.slice(0, 4000);
            if (Object.keys(values).length >= 32) break;
        }
        post({ type: 'action', id: action, values });
    };
    root.addEventListener('submit', event => { event.preventDefault(); send(event.submitter, event.target); });
    root.addEventListener('click', event => {
        const button = event.target.closest('button[data-action]');
        if (!button || button.form && button.type === 'submit') return;
        event.preventDefault(); send(button, button.form);
    });
    const resize = () => post({ type: 'size', height: document.body.offsetHeight });
    new ResizeObserver(resize).observe(document.body); resize();
})();</script></body></html>`;
}

export default function IsolatedLayout({ layout, title, disabled, onAction }: { layout: NonNullable<Panel['layout']>; title: string; disabled: boolean;
    onAction(id: string, values: Record<string, string | boolean>): void }) {
    const frame = useRef<HTMLIFrameElement>(null);
    const [token] = useState(() => crypto.randomUUID().replace(/-/g, ''));
    const [document] = useState(() => documentFor(layout, token));
    const [height, setHeight] = useState(160);
    const apply = useRef(onAction); apply.current = onAction;
    const blocked = useRef(disabled); blocked.current = disabled;
    useEffect(() => {
        const receive = (event: MessageEvent) => {
            const data = event.data;
            if (event.source !== frame.current?.contentWindow || data?.token !== token) return;
            if (data.type === 'size' && Number.isFinite(data.height)) setHeight(Math.max(48, Math.min(760, data.height + 2)));
            if (data.type === 'action' && !blocked.current && typeof data.id === 'string' && fieldId.test(data.id) && data.values && typeof data.values === 'object') {
                apply.current(data.id, Object.fromEntries(Object.entries(data.values).slice(0, 32).filter(([key, value]) => fieldId.test(key)
                    && (typeof value === 'boolean' || typeof value === 'string' && value.length <= 4000))) as Record<string, string | boolean>);
            }
        };
        window.addEventListener('message', receive);
        return () => window.removeEventListener('message', receive);
    }, [token]);
    return <iframe ref={frame} className="ttm-native-layout" sandbox="allow-scripts allow-forms" referrerPolicy="no-referrer" title={title}
        srcDoc={document} style={{ height, pointerEvents: disabled ? 'none' : undefined }} tabIndex={disabled ? -1 : 0} />;
}

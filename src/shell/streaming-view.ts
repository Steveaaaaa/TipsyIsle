import DOMPurify from 'dompurify';
import { renderMessageMarkdown } from '../pipeline/message-markdown';
import type { MessageStreamPreview, StreamPart } from '../pipeline/streaming-message';
import { componentHeight, rememberComponentSize, preserveReadingAnchor } from './stream-layout';
import { resolveStreamLoadingSprite } from '../theme/loading-sprite';
import { generationPresentation } from '../theme/generation-presentation';
import './generation-activity.css';
import './streaming-view.css';

/** Both readers use the same keyed DOM view. Completed widgets never remount
 * when later prose arrives; static previews have no author API or script access. */
export class StreamingView {
    private nodes = new Map<string, { element: HTMLElement; signature: string; dispose?: () => void }>();
    private status = document.createElement('div');
    private statusText = document.createElement('span');
    private statusDetail = document.createElement('small');
    private errorDetails = document.createElement('details');
    private errorText = document.createElement('pre');
    private statusSprite = document.createElement('img');
    private statusMark = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    private observer: IntersectionObserver;
    private resize: ResizeObserver;
    private scheduled = 0;
    private latest?: MessageStreamPreview;
    private currentSprite = '';
    constructor(private root: HTMLElement, private sprite: () => string = () => '', private renderComponents = true) {
        root.classList.add('tipsy-stream-parts');
        this.status.className = 'tipsy-stream-status tipsy-generation-activity'; this.status.setAttribute('role', 'status');
        const art = document.createElement('span'); art.className = 'tipsy-generation-art'; art.setAttribute('aria-hidden', 'true');
        this.statusSprite.className = 'tipsy-generation-sprite'; this.statusSprite.alt = ''; this.statusSprite.src = resolveStreamLoadingSprite(this.sprite());
        const mark = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        mark.setAttribute('viewBox', '0 0 24 24'); mark.setAttribute('fill', 'none'); mark.setAttribute('stroke', 'currentColor'); mark.setAttribute('stroke-width', '1.6'); mark.setAttribute('stroke-linecap', 'round'); mark.setAttribute('stroke-linejoin', 'round'); mark.append(this.statusMark);
        art.append(this.statusSprite, mark); this.statusText.className = 'tipsy-generation-copy';
        const copy = document.createElement('div'); copy.className = 'tipsy-generation-description';
        const errorSummary = document.createElement('summary'); errorSummary.textContent = '查看错误详情';
        this.errorDetails.append(errorSummary, this.errorText); this.errorDetails.hidden = true; this.statusDetail.hidden = true;
        copy.append(this.statusText, this.statusDetail, this.errorDetails); this.status.append(art, copy);
        this.observer = new IntersectionObserver(entries => entries.forEach(entry => entry.target.classList.toggle('is-visible', entry.isIntersecting)));
        this.resize = new ResizeObserver(() => {
            for (const part of this.latest?.parts ?? []) {
                const element = this.nodes.get(part.id)?.element;
                if (part.type === 'waiting' && element) element.style.height = `${componentHeight(part, root.clientWidth)}px`;
            }
        });
        this.resize.observe(root);
        root.append(this.status);
        this.observer.observe(this.status);
    }
    private loading(element: HTMLElement, part: StreamPart) {
        const terminal = this.latest?.phase === 'error' || this.latest?.phase === 'stopped';
        element.className = `tipsy-stream-slot${element.classList.contains('is-visible') ? ' is-visible' : ''}`;
        element.classList.toggle('is-terminal', terminal);
        element.style.height = `${componentHeight(part, this.root.clientWidth)}px`;
        const wait = document.createElement('div'); wait.className = 'tipsy-stream-wait';
        const track = document.createElement('div'); track.className = 'tipsy-stream-track'; track.setAttribute('aria-hidden', 'true');
        const traveler = document.createElement('div'); traveler.className = 'tipsy-stream-traveler';
        const art = resolveStreamLoadingSprite(this.sprite(), terminal ? this.latest!.phase : 'layout');
        traveler.classList.add('has-art'); traveler.style.setProperty('--tipsy-stream-sprite', `url(${JSON.stringify(art)})`);
        track.append(traveler);
        const label = document.createElement('p'); label.className = 'tipsy-stream-label';
        label.textContent = terminal ? `${part.label ?? '互动内容'} · 回复已停止，未能完成显示` : part.complete ? `${part.label ?? '互动内容'} · 静待这一页落定` : `${part.label ?? '互动内容'} · 细节正慢慢浮现`;
        wait.append(track, label); element.replaceChildren(wait); this.observer.observe(element);
    }
    private component(element: HTMLElement, part: StreamPart): () => void {
        this.loading(element, part);
        const frame = document.createElement('iframe'); frame.className = 'tipsy-stream-static'; frame.title = part.label ?? '互动内容预览'; frame.setAttribute('sandbox', 'allow-scripts');
        frame.style.visibility = 'hidden'; frame.style.position = 'absolute';
        const nonce = crypto.randomUUID().replace(/-/g, '');
        const html = DOMPurify.sanitize(`<div>${part.content}</div>`, { ADD_TAGS: ['style'], FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'select', 'textarea', 'base', 'meta', 'link'] });
        const style = getComputedStyle(this.root);
        const color = style.color || '#252d3b', font = style.getPropertyValue('--reader-font') || style.getPropertyValue('--ti-font-body') || style.fontFamily || 'system-ui';
        const size = style.getPropertyValue('--reader-size') || style.getPropertyValue('--ti-font-size') || '16px';
        const leading = style.getPropertyValue('--reader-leading') || style.getPropertyValue('--ti-line-height') || '1.9';
        const cssValues = `color:${color};font-family:${font};font-size:${size};line-height:${leading}`.replace(/<\/style/gi, '');
        frame.srcdoc = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https: http: data: blob:; style-src 'unsafe-inline'; font-src https: http: data:; script-src 'nonce-${nonce}'"><style>:where(html,body){margin:0;background:transparent;${cssValues};overflow-wrap:anywhere}body{overflow:hidden}</style>${html}<script nonce="${nonce}">let pending=0;const report=()=>{if(pending)return;pending=requestAnimationFrame(()=>{pending=0;parent.postMessage({streamSize:'${nonce}',height:Math.ceil(document.body.getBoundingClientRect().height)},'*')})};new ResizeObserver(report).observe(document.body);addEventListener('load',report);document.fonts.ready.then(report);report();</script>`;
        const receive = (event: MessageEvent) => {
            if (event.source !== frame.contentWindow || event.data?.streamSize !== nonce || !Number.isFinite(event.data.height)) return;
            const height = Math.max(32, event.data.height);
            const restore = preserveReadingAnchor(element);
            element.querySelector('.tipsy-stream-wait')?.remove();
            frame.style.height = `${height}px`; frame.style.visibility = ''; frame.style.position = '';
            element.style.height = ''; element.classList.add('is-ready');
            rememberComponentSize(part.key!, this.root.clientWidth, height);
            restore();
        };
        window.addEventListener('message', receive); element.append(frame);
        return () => window.removeEventListener('message', receive);
    }
    refreshSprite() {
        const art = resolveStreamLoadingSprite(this.sprite(), this.latest?.phase ?? 'waiting');
        if (art === this.currentSprite) return;
        this.currentSprite = art;
        this.statusSprite.src = art;
        for (const traveler of this.root.querySelectorAll<HTMLElement>('.tipsy-stream-traveler')) {
            traveler.classList.add('has-art');
            const phase = this.latest?.phase;
            traveler.style.setProperty('--tipsy-stream-sprite', `url(${JSON.stringify(resolveStreamLoadingSprite(this.sprite(), phase === 'error' || phase === 'stopped' ? phase : 'layout'))})`);
        }
    }
    update(view: MessageStreamPreview, renderComponents = this.renderComponents) {
        this.renderComponents = renderComponents;
        this.latest = view;
        this.refreshSprite();
        if (!this.root.isConnected) {
            if (!this.scheduled) this.scheduled = requestAnimationFrame(() => { this.scheduled = 0; if (this.root.isConnected && this.latest) this.update(this.latest); });
            return;
        }
        const parts = view.document ? [] : view.parts;
        const terminal = view.phase === 'error' || view.phase === 'stopped';
        const live = new Set(parts.map(part => part.id));
        for (const [id, old] of this.nodes) if (!live.has(id)) { old.dispose?.(); this.observer.unobserve(old.element); old.element.remove(); this.nodes.delete(id); }
        if (this.status.parentNode !== this.root) this.root.append(this.status);
        let cursor = this.root.firstElementChild;
        for (const part of parts) {
            let node = this.nodes.get(part.id);
            const signature = `${part.type}:${part.content}:${part.complete}:${part.label}:${this.renderComponents}:${terminal}`;
            if (!node) { node = { element: document.createElement('div'), signature: '' }; node.element.dataset.streamPart = part.id; this.nodes.set(part.id, node); }
            const element = node.element;
            if (node.signature !== signature) {
                const sameProse = element.classList.contains('tipsy-reader-prose') && part.type === 'prose';
                const existingReasoning = element.querySelector('details');
                node.dispose?.(); node.dispose = undefined;
                if (part.type === 'prose') {
                    element.className = 'tipsy-reader-prose message-markdown'; element.style.height = '';
                    element.innerHTML = renderMessageMarkdown(part.content);
                } else if (part.type === 'reasoning') {
                    element.className = 'tipsy-stream-reasoning'; element.style.height = '';
                    const details = existingReasoning ?? document.createElement('details');
                    if (!existingReasoning) { details.append(document.createElement('summary'), document.createElement('pre')); element.replaceChildren(details); }
                    details.querySelector('summary')!.textContent = part.label ?? (part.complete || terminal ? '思考过程' : '正在思考…');
                    details.querySelector('pre')!.textContent = part.content;
                } else if (part.type === 'component' && this.renderComponents && !terminal) node.dispose = this.component(element, part);
                else this.loading(element, part);
                if (!sameProse) this.observer.observe(element);
                node.signature = signature;
            }
            if (element === cursor) cursor = cursor.nextElementSibling;
            else {
                const anchor = cursor && cursor.parentNode === this.root ? cursor : this.status;
                this.root.insertBefore(element, anchor);
            }
        }
        if (this.status.dataset.phase !== view.phase) {
            const presentation = generationPresentation[view.phase];
            this.status.dataset.phase = view.phase; this.statusText.textContent = view.status;
            this.status.title = presentation.detail; this.status.setAttribute('aria-label', `${view.status} · ${presentation.detail}`);
            this.statusMark.setAttribute('d', presentation.mark);
        }
        this.statusText.textContent = view.status;
        this.statusDetail.hidden = !terminal;
        this.statusDetail.textContent = terminal ? generationPresentation[view.phase].detail : '';
        this.errorDetails.hidden = !view.errorDetail;
        this.errorText.textContent = view.errorDetail ?? '';
        this.status.setAttribute('role', view.phase === 'error' ? 'alert' : 'status');
        // Whole-message author pages retain their own visual identity.
        this.status.classList.toggle('is-author-page', view.document);
        this.status.hidden = !view.status;
    }
    dispose() { cancelAnimationFrame(this.scheduled); this.resize.disconnect(); this.observer.disconnect(); for (const node of this.nodes.values()) node.dispose?.(); this.nodes.clear(); this.root.replaceChildren(); }
}

/** Keep a measured placeholder while the final author document loads in its own runtime. */
export function mountAuthorLoading(
    frame: HTMLIFrameElement,
    targets: Array<{ key: string; selector: string }> = [],
    sprite: () => string = () => '',
    onReady?: () => void,
) {
    const wrapper = document.createElement('div');
    const placeholder = document.createElement('div');
    wrapper.style.position = 'relative'; wrapper.style.overflow = 'hidden';
    // Author startup may await animation frames; keep its document rendering
    // behind the opaque loading surface until it can be used.
    frame.style.position = 'absolute'; frame.style.inset = '0 auto auto 0';
    frame.inert = true;
    placeholder.style.position = 'relative'; placeholder.style.zIndex = '1';
    placeholder.style.background = 'var(--reader-surface, var(--ti-bg-primary, #f5f6f8))';
    wrapper.append(placeholder, frame);
    const view = new StreamingView(placeholder, sprite);
    view.update({ source: '', status: '', phase: 'layout', document: false, scope: 'author-load',
        parts: [{ id: 'author-load', type: 'waiting', content: '', complete: true, key: targets[0]?.key, label: '互动内容' }] });
    let disposed = false;
    const dispose = () => {
        if (disposed) return;
        disposed = true;
        frame.removeEventListener('load', ready);
        view.dispose(); placeholder.remove();
        wrapper.style.overflow = '';
        frame.style.position = ''; frame.style.inset = ''; frame.inert = false;
    };
    const ready = () => {
        if (!frame.getAttribute('srcdoc') && !frame.getAttribute('src')) return;
        frame.removeEventListener('load', ready);
        requestAnimationFrame(() => requestAnimationFrame(() => {
            const restore = preserveReadingAnchor(wrapper); dispose(); restore();
            onReady?.();
        }));
    };
    frame.addEventListener('load', ready);
    return { wrapper, dispose };
}

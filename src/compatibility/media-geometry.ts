import type { ProseAnchorSpec } from '../../packages/plugin-sdk/index.js';
import { hasSubstantialOuterProse, mountMediaSlot } from '../plugins/native/prose-anchor';
import { findSandboxParagraphAnchor, isInteractiveWidgetDocument } from '../sandbox/sandbox-media-shim';

export interface FilmSpace { key:string; message:string; swipe:string; anchor?:ProseAnchorSpec; ratio:string; folded:boolean }

interface MountedFilmSlot {
    element: HTMLElement;
    signature: string;
    hostFrame?: HTMLIFrameElement;
}

export function filmGeometry(row:(id:string)=>HTMLElement|undefined, publish:(rects:unknown[], visible:string|undefined)=>void) {
    const slots=new Map<string, MountedFilmSlot>();
    const observedDocs = new WeakSet<Document>();
    let spaces:FilmSpace[]=[],queued=0,syncQueued=0,previous='';

    const measure=()=>{queued=0;const rects:unknown[]=[];let needsResync=false;
        for(const [key,entry] of slots){
            const {element, hostFrame} = entry;
            if(!element.isConnected || (hostFrame && !hostFrame.isConnected)){needsResync=true;continue;}
            const inner = element.getBoundingClientRect();
            let top = inner.top, left = inner.left, width = inner.width, height = inner.height;
            if (hostFrame) {
                const fr = hostFrame.getBoundingClientRect();
                top = fr.top + inner.top;
                left = Math.max(0, fr.left + inner.left);
            }
            if(width>0&&top<innerHeight&&top+Math.max(32,height)>0)rects.push({key,top,left,width,height});
        }
        let visible:string|undefined;const probe=document.elementFromPoint(innerWidth*.5,innerHeight*.35);visible=probe?.closest<HTMLElement>('[data-message-id]')?.dataset.messageId;
        const signature=JSON.stringify([rects,visible]);if(previous!==signature){previous=signature;publish(rects,visible);}
        if(needsResync)scheduleSync();
    };
    const schedule=()=>{if(!queued&&spaces.length)queued=requestAnimationFrame(measure);};
    const scheduleSync=()=>{if(!syncQueued&&spaces.length)syncQueued=requestAnimationFrame(()=>{syncQueued=0;sync();});};
    const observer=new ResizeObserver(schedule);observer.observe(document.documentElement);
    window.addEventListener('scroll',schedule,{passive:true});window.addEventListener('resize',schedule);

    const slotCss = (spec: FilmSpace) => spec.folded
        ? 'display:block;width:100%;height:0;min-height:0;margin:0;padding:0;border:0;position:relative;'
        : 'display:block;width:100%;max-width:100%;min-height:0;margin:.75em 0;padding:0;border:0;background:transparent;text-indent:0;box-sizing:border-box;aspect-ratio:' + spec.ratio.replace(':', ' / ');

    const watchChildDoc = (doc: Document) => {
        if (observedDocs.has(doc) || !doc.body || typeof MutationObserver === 'undefined') return;
        observedDocs.add(doc);
        new MutationObserver((records) => {
            if (!spaces.length) return;
            const relevant = records.some((r) => {
                const target = r.target as HTMLElement | null;
                return target && !target.closest?.('.compat-native-media-slot');
            });
            if (relevant) scheduleSync();
        }).observe(doc.body, { childList: true, subtree: true });
    };

    const findBestChildFrameMatch = (
        body: HTMLElement,
        spec: FilmSpace,
    ): { frame: HTMLIFrameElement; doc: Document; after: Element } | null => {
        if (hasSubstantialOuterProse(body, spec.anchor)) return null;
        const allFrames = Array.from(body.querySelectorAll<HTMLIFrameElement>('iframe.compat-message-frame'));
        if (!allFrames.length) return null;
        let allLoaded = true;
        const hasAnyMixedFrame = allFrames.some((f) => f.dataset?.blockType === 'mixed');
        const mixedFrames: { frame: HTMLIFrameElement; doc: Document }[] = [];
        const htmlFrames: { frame: HTMLIFrameElement; doc: Document }[] = [];
        for (const frame of allFrames) {
            let doc: Document | null = null;
            try { doc = frame.contentDocument; } catch { doc = null; }
            const awaitingSrcdoc =
                typeof frame.getAttribute === 'function' &&
                frame.getAttribute('srcdoc') === null &&
                frame.getAttribute('src') === null &&
                !(doc?.body?.textContent ?? '').trim();
            if (awaitingSrcdoc || !doc?.body || (doc.readyState && doc.readyState !== 'complete')) {
                allLoaded = false;
            }
            if (awaitingSrcdoc || !doc?.body) continue;
            watchChildDoc(doc);
            if (!isInteractiveWidgetDocument(doc)) {
                if (frame.dataset?.blockType === 'mixed') mixedFrames.push({ frame, doc });
                else htmlFrames.push({ frame, doc });
            }
        }
        if (!mixedFrames.length && !htmlFrames.length) return null;

        // Pass 1: strict text / excerpt / marker match across eligible mixed prose frames first.
        for (const { frame, doc } of mixedFrames) {
            const after = findSandboxParagraphAnchor(doc, spec.anchor, { allowIndexFallback: false });
            if (after && after.parentNode) return { frame, doc, after };
        }
        if (!hasAnyMixedFrame) {
            for (const { frame, doc } of htmlFrames) {
                const after = findSandboxParagraphAnchor(doc, spec.anchor, { allowIndexFallback: false });
                if (after && after.parentNode) return { frame, doc, after };
            }
        }

        if (!allLoaded) return null;

        const sortByHeight = (list: { frame: HTMLIFrameElement; doc: Document }[]) =>
            [...list].sort((a, b) => {
                const ha = typeof a.frame.getBoundingClientRect === 'function' ? a.frame.getBoundingClientRect().height : 0;
                const hb = typeof b.frame.getBoundingClientRect === 'function' ? b.frame.getBoundingClientRect().height : 0;
                return hb - ha;
            });

        // Pass 2: index fallback only after all sibling frames loaded, on the tallest eligible prose frame.
        for (const { frame, doc } of sortByHeight(mixedFrames)) {
            const after = findSandboxParagraphAnchor(doc, spec.anchor, { allowIndexFallback: true });
            if (after && after.parentNode) return { frame, doc, after };
        }
        if (!hasAnyMixedFrame) {
            for (const { frame, doc } of sortByHeight(htmlFrames)) {
                const after = findSandboxParagraphAnchor(doc, spec.anchor, { allowIndexFallback: true });
                if (after && after.parentNode) return { frame, doc, after };
            }
        }
        return null;
    };

    const mountInMatchedFrame = (
        match: { frame: HTMLIFrameElement; doc: Document; after: Element },
        spec: FilmSpace,
        old?: MountedFilmSlot,
    ): { element: HTMLElement; hostFrame: HTMLIFrameElement } => {
        const reuse = old?.hostFrame === match.frame && old.element.ownerDocument === match.doc;
        if (!reuse && old?.element.isConnected) old.element.remove();
        const element = reuse ? old!.element : match.doc.createElement('div');
        element.className = 'compat-native-media-slot';
        element.setAttribute('aria-hidden', 'true');
        element.style.cssText = slotCss(spec);
        if (!element.isConnected || match.after.nextElementSibling !== element) match.after.after(element);
        return { element, hostFrame: match.frame };
    };

    function sync(next=spaces){spaces=next;const keep=new Set<string>();
        for(const spec of next){const article=row(spec.message);if(!article||article.dataset.readingSwipe!==spec.swipe)continue;const body=article.querySelector<HTMLElement>(':scope > .mes_text,:scope > .compat-stream-body');if(!body)continue;
            keep.add(spec.key);const old=slots.get(spec.key),signature=JSON.stringify(spec);
            const bestMatch = findBestChildFrameMatch(body, spec);
            if (old?.signature === signature) {
                if (old.hostFrame && bestMatch && bestMatch.frame === old.hostFrame && old.element.isConnected && old.hostFrame.contentDocument?.contains(old.element)) continue;
                if (!old.hostFrame && body.contains(old.element) && !bestMatch) continue;
            }
            if (bestMatch) {
                const mountedChild = mountInMatchedFrame(bestMatch, spec, old);
                if (old?.element && old.element !== mountedChild.element) { observer.unobserve(old.element); old.element.remove(); }
                if (old?.hostFrame && old.hostFrame !== mountedChild.hostFrame) observer.unobserve(old.hostFrame);
                slots.set(spec.key, Object.assign(mountedChild, { signature }));
                observer.observe(mountedChild.hostFrame);
                continue;
            }
            if (old?.hostFrame) { observer.unobserve(old.hostFrame); if (old.element.isConnected) old.element.remove(); }
            const reuseOuter = old && !old.hostFrame && old.element.ownerDocument === document;
            const element=reuseOuter?old.element:document.createElement('div');element.className='compat-native-media-slot';element.setAttribute('aria-hidden','true');element.style.cssText=slotCss(spec);
            mountMediaSlot(body,element,spec.anchor);slots.set(spec.key,{element,signature});observer.observe(element);
        }
        for(const [key,entry] of slots)if(!keep.has(key)){observer.unobserve(entry.hostFrame??entry.element);entry.element.remove();slots.delete(key);}
        measure();
    }
    return {sync,schedule};
}

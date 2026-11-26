import type { ReplySaved } from '../../../packages/plugin-sdk/index.js';
import { PluginApiError } from './errors';
const IGNORED_CHECKPOINT_BLOCK = /<(think|thinking|reasoning|draft|cot|thought|analysis|scratchpad|reflection|logic_check|dice_calculation|review|plan|planning|script|style|details|pre|html|div|section|aside|table|svg|iframe|UpdateVariable|UpdateVariableVariable|jsonpatch|scene_time|scene_cover|status|status_bar|statusplaceholderimpl|summary|action|suggested_questions|nsfw_illust|dream_after_format)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi;
const TRANSPARENT_PROSE_WRAPPER = /<\/?(?:now_plot|dream_plot|dream_body|story|content|text|plot|narrative|maintext|main_text|response|message|body|prose|chapter|scene|main|output|[a-z][a-z0-9]*_[a-z0-9_]+)\b[^>]*>/gi;

export function closedParagraphs(source: string, maxParagraphs = 4) {
    const prose = source
        .replace(/<!doctype\s+html\b[\s\S]*?(?:<\/html\s*>|$)/gi, '')
        .replace(/<!--[\s\S]*?(?:-->|$)/g, '')
        .replace(/```[\s\S]*?(?:```|$)/g, '')
        .replace(/<pic\b(?![^>]*\bprompt\s*=)[^>]*>[\s\S]{0,160}?(?:<\/pic\s*>|$)/gi, '')
        .replace(IGNORED_CHECKPOINT_BLOCK, '')
        .replace(TRANSPARENT_PROSE_WRAPPER, '');
    const stable: string[] = [];
    const stack: string[] = [];
    for (const part of prose.split(/\r?\n[ \t]*\r?\n/).slice(0, -1)) {
        let safe = true;
        for (const tag of part.matchAll(/<(\/?)([\w-]+)\b[^>]*(>|$)/g)) {
            const name = tag[2].toLowerCase();
            if (!tag[0].endsWith('>')) { safe = false; break; }
            if (['img', 'br', 'hr', 'pic'].includes(name) || tag[0].endsWith('/>')) continue;
            if (tag[1]) {
                if (stack.length && stack.at(-1) === name) stack.pop();
                else if (!stack.length) continue;
                else safe = false;
            } else {
                stack.push(name);
            }
        }
        const trimmed = part.trim();
        if (safe && !stack.length && trimmed) stable.push(trimmed);
        if (stable.length === maxParagraphs) break;
    }
    return stable;
}
interface Generation { signal:AbortSignal; completion:Promise<ReplySaved>; save(event:ReplySaved):void; fail():void }
const generations=new Map<string,Generation>();
export function startGeneration(id:string,signal:AbortSignal) {
    let save!:(value:ReplySaved)=>void, fail!:()=>void;
    const controller=new AbortController();const completion=new Promise<ReplySaved>((resolve,reject)=>{save=resolve;fail=()=>{const fault=new PluginApiError('CANCELLED','生成已中止或未能保存');controller.abort(fault);reject(fault);};});
    const entry={signal:controller.signal,completion,save,fail};generations.set(id,entry);signal.addEventListener('abort',fail,{once:true});if(signal.aborted)fail();
    void completion.finally(()=>{signal.removeEventListener('abort',fail);setTimeout(()=>{if(generations.get(id)===entry)generations.delete(id);},360000);}).catch(()=>{});
    return entry;
}
export function generationState(id:string){return generations.get(id);}

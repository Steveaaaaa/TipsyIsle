import { z } from 'zod';
import { Inflate } from 'fflate';
import type { ImageModelRequest } from '../../../packages/plugin-sdk/index.js';

const id = z.string().min(1).max(480), prompt = z.string().max(16000), unit = z.number().min(0).max(1);
export const ratio = z.enum(['1:1','3:2','2:3','4:3','3:4','16:9','9:16','21:9']);
const ref = z.discriminatedUnion('source', [z.strictObject({source:z.literal('media'), id}), z.strictObject({source:z.literal('character.avatar'), characterId:id}), z.strictObject({source:z.literal('persona.avatar'), route:z.strictObject({chatId:id,routeId:id})}), z.strictObject({source:z.literal('story.gallery'), characterId:id, path:id}), z.strictObject({source:z.literal('card.asset'), characterId:id, assetId:id})]);
export const imageRequest = z.strictObject({kind:z.literal('image'), connection:id, prompt:prompt.min(1), size:z.string().regex(/^\d{2,4}x\d{2,4}$|^auto$/).optional(), negativePrompt:prompt.optional(), aspectRatio:ratio.optional(), seed:z.number().int().min(0).max(0xffffffff).optional(), references:z.array(z.strictObject({image:ref,role:z.enum(['character','style','composition']),subject:id.optional(),weight:unit.optional()})).max(8).optional(), actors:z.array(z.strictObject({name:id.optional(),prompt,negativePrompt:prompt.optional(),center:z.strictObject({x:unit,y:unit}).optional(),reference:ref.optional()})).max(8).optional(),workflow:z.strictObject({profile:id, params:z.record(id,z.union([id,z.boolean(),z.number().finite()])).optional()}).optional()});
export function dimensions(data: ImageModelRequest) {
    if (data.size && data.size !== 'auto') { const [width,height] = data.size.split('x').map(Number); if(width*height>16777216 || !width || !height) throw new Error('图片尺寸超出限制'); return { width,height }; }
    const [width,height] = (data.aspectRatio ?? '1:1').split(':').map(Number); return { width:Math.round(16*Math.sqrt(width/height))*64, height:Math.round(16*Math.sqrt(height/width))*64 };
}
export function novelDimensions(data: ImageModelRequest) {
    if (data.size && data.size !== 'auto') return dimensions(data);
    switch (data.aspectRatio) {
        case '3:2':
        case '4:3':
        case '16:9':
            return { width: 1216, height: 832 };
        case '2:3':
        case '3:4':
        case '9:16':
            return { width: 832, height: 1216 };
        case '21:9':
            return { width: 1472, height: 704 };
        default:
            return { width: 1024, height: 1024 };
    }
}
export function composition(data: ImageModelRequest) { return [data.prompt,...(data.actors ?? []).map(actor => `${actor.name ?? 'Subject'}${actor.center ? ` at (${actor.center.x}, ${actor.center.y})` : ''}: ${actor.prompt}`)].join('\n'); }
const UNSAFE_AVOID_TERM = /(?:breast|busty|chest|cleavage|curv|boob|巨乳|胸)/i;
export function safeAvoidClause(negativePrompt?: string): string {
    if (!negativePrompt) return '';
    return negativePrompt
        .split(/[,;]+/)
        .map((part) => part.trim())
        .filter((part) => part.length > 0 && !UNSAFE_AVOID_TERM.test(part))
        .join(', ')
        .slice(0, 220)
        .replace(/[,\s]+$/, '');
}
export function novelRequest(model: string, data: ImageModelRequest, refs: {role:string; data:string; weight:number}[], seed: number) {
    const character = refs.filter(item=>item.role==='character'), style = refs.filter(item=>item.role!=='character');
    const captions = (negative:boolean) => (data.actors ?? []).map(actor=>({char_caption:negative ? actor.negativePrompt ?? '' : actor.prompt, centers:[actor.center ?? {x:.5,y:.5}]}));
    const v4 = /nai-diffusion-4/i.test(model), negative = data.negativePrompt ?? '';
    return { model, action:'generate', input:v4 ? data.prompt : composition(data), parameters:{params_version:3,...novelDimensions(data),seed,steps:28,scale:5,sampler:'k_euler_ancestral',noise_schedule:'karras',n_samples:1,negative_prompt:negative,
        ...(v4 && {use_coords:!!data.actors?.length,v4_prompt:{caption:{base_caption:data.prompt,char_captions:captions(false)},use_coords:!!data.actors?.length,use_order:true},v4_negative_prompt:{caption:{base_caption:negative,char_captions:captions(true)}}}),
        ...(character.length && {director_reference_images:character.map(item=>item.data),director_reference_strength_values:character.map(item=>item.weight),director_reference_secondary_strength_values:character.map(()=>0.2),director_reference_information_extracted:character.map(()=>1),director_reference_descriptions:character.map(()=>({caption:{base_caption:'character',char_captions:[]},legacy_uc:false}))}),
        ...(style.length && {reference_image_multiple:style.map(item=>item.data),reference_strength_multiple:style.map(item=>item.weight),reference_information_extracted_multiple:style.map(()=>1)})} };
}
export function novelImage(bytes: Uint8Array, limit = 20*1024*1024) {
    const view = new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength), u16=(at:number)=>view.getUint16(at,true), u32=(at:number)=>view.getUint32(at,true);
    let end=bytes.length-22; for(;end>=Math.max(0,bytes.length-65557);end--) if(u32(end)===0x06054b50 && end+22+u16(end+20)===bytes.length) break;
    if(end<0 || u32(end)!==0x06054b50 || u16(end+4) || u16(end+6) || u16(end+10)>128) throw new Error('无效的生图 ZIP');
    for(let index=0,at=u32(end+16); index<u16(end+10);index++) {
        if(u32(at)!==0x02014b50) throw new Error('无效的 ZIP 目录');
        const name=new TextDecoder().decode(bytes.subarray(at+46,at+46+u16(at+28))), size=u32(at+24), compressed=u32(at+20), local=u32(at+42), method=u16(at+10);
        if(/\.(?:png|webp|jpe?g)$/i.test(name)) {
            if(!size || size>limit || u16(at+8)&1 || u32(local)!==0x04034b50 || ![0,8].includes(method)) throw new Error('不支持的 ZIP 图像');
            const start=local+30+u16(local+26)+u16(local+28); if(start+compressed>at) throw new Error('ZIP 图像不完整');
            const parts:ArrayBuffer[]=[]; let total=0;
            const add=(part:Uint8Array)=>{total+=part.length;if(total>size)throw new Error('ZIP 解包超过限制');parts.push(new Uint8Array(part).buffer);};
            const raw=bytes.subarray(start,start+compressed); if(method===0) add(raw); else { const inflate=new Inflate(add); for(let offset=0;offset<raw.length;offset+=4096) inflate.push(raw.subarray(offset,offset+4096),offset+4096>=raw.length); }
            if(total!==size)throw new Error('ZIP 图像长度不符'); return new Blob(parts,{type:/\.png$/i.test(name)?'image/png':/\.webp$/i.test(name)?'image/webp':'image/jpeg'});
        }
        at+=46+u16(at+28)+u16(at+30)+u16(at+32);
    }
    throw new Error('ZIP 中没有图像');
}
const graphSchema=z.record(z.string().regex(/^[\w-]{1,80}$/),z.object({class_type:id,inputs:z.record(z.string(),z.json()),_meta:z.object({title:z.string()}).optional()}));
export type Graph=z.infer<typeof graphSchema>;
export type Slots=Record<string,[string,string]>;
export function workflow(text:string) {
    if(text.length>512000)throw new Error('工作流过大');const graph=graphSchema.parse(JSON.parse(text)), slots:Slots={};
    if(Object.keys(graph).length>2048)throw new Error('工作流节点过多');
    function walk(value:unknown,match:(node:Graph[string])=>string|undefined,seen=new Set<string>()):[string,string]|undefined {
        if(!Array.isArray(value))return; const key=String(value[0]),node=graph[key]; if(!node || seen.has(key))return;seen.add(key);
        const input=match(node);if(input)return [key,input];for(const edge of Object.values(node.inputs)){ const found=walk(edge,match,seen);if(found)return found; }
    }
    for(const [key,node] of Object.entries(graph)) {
        if(/^(KSampler|SamplerCustom)/.test(node.class_type)) {
            const seed='noise_seed' in node.inputs?'noise_seed':'seed'; if(seed in node.inputs)slots.seed=[key,seed];else {const noise=walk(node.inputs.noise,other=> 'noise_seed' in other.inputs?'noise_seed':undefined);if(noise)slots.seed=noise;}
            for(const [edge,slot] of [['positive','prompt'],['negative','negativePrompt']]) {const found=walk(node.inputs[edge],other=>/^CLIPTextEncode/.test(other.class_type)?'text':undefined);if(found)slots[slot]=found;}
        }
        if(/^Empty(?:SD3)?LatentImage$/.test(node.class_type)){slots.width=[key,'width'];slots.height=[key,'height'];}
        if(node.class_type==='LoadImage'){const consumer=Object.values(graph).find(other=>Object.values(other.inputs).some(edge=>Array.isArray(edge)&&edge[0]===key));slots[/style|风格/i.test(`${node._meta?.title} ${consumer?.class_type}`)?'styleRef':'charRef']=[key,'image'];}
    }
    return {graph,slots};
}

import { z } from 'zod';
import type { ArchivedChat } from '../store/chat-archives';
import type { PluginBucket,PluginBuckets } from '../plugins/native/storage';
import { validateJson } from '../plugins/native/storage';
const pluginId=z.string().regex(/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/),fingerprint=z.string().regex(/^[a-f0-9]{64}$/),uuid=z.string().uuid();
const bucketSchema=z.object({owner:fingerprint,version:z.number().int().nonnegative(),schemaVersion:z.number().int().nonnegative(),values:z.record(z.string(),z.json())});
const mediaKey=(owner:string,id:string)=>`${owner}/${id}`;
export type PackedImage={owner:string;id:string;mime:string;bytes:Uint8Array<ArrayBuffer>};
export function visitBuckets(chat:ArchivedChat,visit:(plugin:string,bucket:PluginBucket)=>void){
    const seen=new Set<PluginBucket>();function group(buckets?:PluginBuckets){for(const [plugin,bucket] of Object.entries(buckets??{})){if(seen.has(bucket))continue;seen.add(bucket);if(!pluginId.safeParse(plugin).success||!bucketSchema.safeParse(bucket).success)throw new Error('无效的插件存档数据');validateJson(bucket.values);visit(plugin,bucket);}}
    group(chat.continuation?.nativePluginRoute);for(const node of chat.messages){for(const buckets of Object.values(node.nativePluginOpeningRoutes??{}))group(buckets);for(const buckets of Object.values(node.nativePluginReplies??{}))group(buckets);for(const point of [...Object.values(node.branchStates??{}),...Object.values(node.branchBases??{})])group(point.continuation.nativePluginRoute);}
}
function mapImages(value:any,transform:(id:string)=>string|undefined):any {
    if(Array.isArray(value))return value.map(item=>mapImages(item,transform));if(!value||typeof value!=='object')return value;
    const next={...value};for(const [key,entry] of Object.entries(next)){
        if(key==='takes'&&Array.isArray(entry)){const active=entry[value.activeTake??0]?.id;next.takes=entry.filter(take=>take&&uuid.safeParse(take.id).success).flatMap(take=>{const id=transform(take.id);return id?[{...take,id}]:[];});next.activeTake=Math.max(0,next.takes.findIndex(take=>take.id===(active&&transform(active))));}
        else if(key==='activeTake'&&Array.isArray(value.takes))continue;
        else if(['canonicalMediaId','backdropMediaId','mediaId'].includes(key)||key==='id'&&value.source==='media'){const mapped=uuid.safeParse(entry).success?transform(String(entry)):undefined;if(mapped)next[key]=mapped;else delete next[key];}
        else next[key]=mapImages(entry,transform);
    }return next;
}
export async function archiveImages(chat:ArchivedChat){const keys=new Map<string,{owner:string;id:string}>();visitBuckets(chat,(plugin,bucket)=>{const owner=`${plugin}:${bucket.owner}`;mapImages(bucket.values,id=>{keys.set(mediaKey(owner,id),{owner,id});return id;});});const images:PackedImage[]=[];let total=0;
    if(!keys.size)return images;const {loadMedia}=await import('../plugins/native/media');for(const {owner,id} of keys.values()){const {blob}=await loadMedia(owner,id);if(!/^image\/(png|jpeg|webp)$/.test(blob.type))throw new Error('存档引用不支持的图片格式');if((total+=blob.size)>96*1024*1024)throw new Error('携图存档超过 96 MiB，可以关闭携图后导出');images.push({owner,id,mime:blob.type,bytes:new Uint8Array(await blob.arrayBuffer())});}return images;
}
export async function restoreImages(source:ArchivedChat,images:PackedImage[],save:(owner:string,blob:Blob)=>Promise<string>){const chat=structuredClone(source),map=new Map<string,string>(),wanted=new Set<string>();visitBuckets(chat,(plugin,bucket)=>{mapImages(bucket.values,id=>{wanted.add(mediaKey(`${plugin}:${bucket.owner}`,id));return id;});});
    for(const image of images){const key=mediaKey(image.owner,image.id);if(!wanted.has(key)||map.has(key)||!/^image\/(png|webp|jpeg)$/.test(image.mime))throw new Error('图片与插件归属不符');map.set(key,await save(image.owner,new Blob([image.bytes],{type:image.mime})));}
    visitBuckets(chat,(plugin,bucket)=>{bucket.values=mapImages(bucket.values,id=>map.get(mediaKey(`${plugin}:${bucket.owner}`,id)));delete bucket.operations;});return chat;
}

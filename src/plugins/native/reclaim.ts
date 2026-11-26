import type { ReplyMediaItem } from '../../../packages/plugin-sdk/index.js';
import { enqueuePersistentOperation } from '../../store/persistence';
import { workspaceStore } from '../../store/workspace-store';
import { listChatArchives } from '../../store/chat-archives';
import { storyBucketsForPlugin } from './story-port';
import { editStory } from './transactions';
import { mediaIdentity } from './media';
import { backgroundDb,requestResult,transactionDone,type StoredMedia } from './background-store';
import type { InstalledPlugin } from './catalog';
import { readChat } from './story-data';

export function considerTakes(value:unknown,pinned:Set<string>,candidates:Map<string,number>){
    if(!value||typeof value!=='object')return;
    for(const [key,child] of Object.entries(value)){
        if(key==='replyMedia'&&Array.isArray(child)){for(const item of child as ReplyMediaItem[]){if(!Array.isArray(item?.takes))continue;for(const [index,take] of item.takes.entries())if(take&&typeof take.id==='string'){if(index===(item.activeTake??0))pinned.add(take.id);else candidates.set(take.id,take.createdAt);}}}
        else if(typeof child==='string')pinned.add(child);else considerTakes(child,pinned,candidates);
    }
}
export async function reclaimTakes(plugin:InstalledPlugin,signal:AbortSignal,check:()=>void){return enqueuePersistentOperation(async()=>{
    const owner=mediaIdentity(plugin),id=plugin.manifest.id,db=await backgroundDb();const rows:StoredMedia[]=await requestResult(db.transaction('media').objectStore('media').index('owner').getAll(owner));
    let bytes=rows.reduce((sum,row)=>sum+row.size,0),count=rows.length;if(bytes<.8*2**30&&count<.8*2048)return {removed:0};
    const pinned=new Set<string>(),candidates=new Map<string,number>();for await(const {bucket} of storyBucketsForPlugin(id)){signal.throwIfAborted();if(bucket.owner===plugin.fingerprint)considerTakes(bucket.values,pinned,candidates);}
    const drop=new Set<string>();for(const row of rows.filter(row=>!row.readers.length&&!pinned.has(row.id)&&candidates.has(row.id)).sort((left,right)=>candidates.get(left.id)!-candidates.get(right.id)!)){drop.add(row.id);bytes-=row.size;count--;if(bytes<.75*2**30&&count<.75*2048)break;}
    if(!drop.size)return {removed:0};const {activeChatId}=workspaceStore.getState();const chats=new Set([activeChatId,...(await listChatArchives()).map(chat=>chat.id)]);
    for(const chatId of chats){if(!chatId)continue;signal.throwIfAborted();const current=await readChat(chatId).catch(()=>null);if(!current?.messages.some(node=>Object.values(node.nativePluginReplies??{}).some(group=>group[id]?.owner===plugin.fingerprint&&Array.isArray(group[id].values.replyMedia))))continue;
        await editStory({chatId,routeId:''},{check},async chat=>{const messages=chat.messages.map(node=>{let replies=node.nativePluginReplies;for(const [key,group] of Object.entries(replies??{})){const bucket=group[id];if(bucket?.owner!==plugin.fingerprint||!Array.isArray(bucket.values.replyMedia))continue;let changed=false;
            const slots=(bucket.values.replyMedia as unknown as ReplyMediaItem[]).map(slot=>{if(!Array.isArray(slot.takes))return slot;const active=slot.takes[slot.activeTake??0]?.id;if(active)drop.delete(active);const takes=slot.takes.filter(take=>!drop.has(take.id));if(takes.length===slot.takes.length)return slot;changed=true;return {...slot,takes,activeTake:Math.max(0,takes.findIndex(take=>take.id===active))};});
            if(changed)replies={...replies,[key]:{...group,[id]:{...bucket,version:bucket.version+1,values:{...bucket.values,replyMedia:JSON.parse(JSON.stringify(slots))}}}};
        }return replies===node.nativePluginReplies?node:{...node,nativePluginReplies:replies};});return {chat:{...chat,messages},activate:false,pluginOnly:true,extras:{},result:null};});}
    check();const tx=db.transaction(['blobs','media'],'readwrite'),done=transactionDone(tx);let removed=0;for(const key of drop){const row:StoredMedia|undefined=await requestResult(tx.objectStore('media').get(key));if(row?.owner===owner&&!row.readers.length){tx.objectStore('blobs').delete(key);tx.objectStore('media').delete(key);removed++;}}await done;return {removed};
});}

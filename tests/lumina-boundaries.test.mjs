import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { zipSync } from 'fflate';

async function fixture(contents, replacements={}) {
    const result=await build({stdin:{contents,resolveDir:process.cwd()},bundle:true,platform:'node',format:'esm',write:false,plugins:[{name:'io-fixtures',setup(builder){builder.onResolve({filter:/.*/},args=>Object.hasOwn(replacements,args.path)?{path:args.path,namespace:'io-fixtures'}:null);builder.onLoad({filter:/.*/,namespace:'io-fixtures'},args=>({contents:replacements[args.path],resolveDir:process.cwd()}));}}]});
    return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString('base64')}`);
}
const {generateImage}=await fixture(`export {generateImage} from './src/plugins/native/image-adapter'`,{
    '../../core/platform-bridge':`export const detectRuntimeFlavor=async()=>'browser-offline'`,
    '../../core/native-runtime':`export const platformFetch=(...args)=>globalThis.fetch(...args);export const isNativeRuntime=()=>false`,
    './connections':`export const httpEndpoint=value=>new URL(value)`, './media-ref':`export const resolveReference=async()=>new Blob(['reference'],{type:'image/png'})`, './media':`export const mediaLimit=20*1024*1024`,
});
test('all image adapters perform their expected HTTP exchange and preserve the WebUI seed',async t=>{
    const image='aW1hZ2U=',zip=zipSync({'frame.png':Buffer.from('image')});
    const routes=[];t.mock.method(globalThis,'fetch',async(url,init)=>{const path=new URL(url).pathname;const data=init.body instanceof FormData?init.body:init.body&&JSON.parse(init.body);routes.push(path);
        if(path.endsWith('edits')){assert.ok(data.get('image[]') instanceof Blob);return Response.json({data:[{b64_json:image}]});}
        if(path.endsWith('generations'))return Response.json({data:[{b64_json:image}]});
        if(path.endsWith(':generateContent')){assert.ok(data.contents[0].parts[1].inlineData.data);assert.equal(init.headers['x-goog-api-key'],'host-key');return Response.json({candidates:[{content:{parts:[{inlineData:{data:image,mimeType:'image/png'}}]}}]});}
        if(path.endsWith('/txt2img')){assert.equal(data.alwayson_scripts.controlnet.args.length,1);return Response.json({images:[image],info:'{"seed":7}'});}
        if(path.endsWith('/generate-image')){assert.equal(data.parameters.director_reference_images.length,1);return new Response(zip);}
        if(path.endsWith('/upload/image')){assert.ok(data.get('image') instanceof Blob);return Response.json({name:'ref.png'});}
        if(path.endsWith('/prompt')){assert.equal(data.prompt.node.inputs.image,'ref.png');return Response.json({prompt_id:'job'});}
        if(path.endsWith('/history/job'))return Response.json({job:{outputs:{out:{images:[{filename:'result.png',subfolder:'',type:'output'}]}}}});
        if(path.endsWith('/view'))return new Response('image',{headers:{'Content-Type':'image/png'}});throw Error(path);
    });
    const args={kind:'image',prompt:'Rain',connection:'local',references:[{role:'character',image:{source:'media',id:'test'}}]};
    for(const kind of ['openai','gemini','webui','novelai','comfyui','openai']){const conn={baseUrl:'https://image.example',providerKind:kind,apiKey:'host-key',model:kind==='novelai'?'nai-diffusion-4-5-full':'model',workflowText:'{"node":{"class_type":"LoadImage","inputs":{"image":"initial"}}}'};const result=await generateImage(conn,routes.length===0?{...args,references:[]}:args,'owner',['media.manage'],new AbortController().signal);assert.equal(await result.blob.text(),'image');if(kind==='webui')assert.equal(result.seed,7);}
    assert.deepEqual(routes,['/images/generations','/models/model:generateContent','/sdapi/v1/txt2img','/ai/generate-image','/upload/image','/prompt','/history/job','/view','/images/edits']);
});
test('moss protocol handles SiliconFlow image_size, async task_id polling, and openai edits->generations fallback', async (t) => {
    let poll = 0;
    t.mock.method(globalThis, 'fetch', async (url, init) => {
        const parsed = new URL(url);
        const path = parsed.pathname;
        if (parsed.hostname === 'api.siliconflow.cn' && path.endsWith('/images/generations')) {
            const body = JSON.parse(init.body);
            assert.equal(body.image_size, '1024x1024');
            return Response.json({ images: [{ url: 'https://cdn.siliconflow.cn/out.png' }], seed: 99 });
        }
        if (parsed.hostname === 'cdn.siliconflow.cn') {
            return new Response('sf-img', { headers: { 'Content-Type': 'image/png' } });
        }
        if (parsed.hostname === 'platform.mosi.cn' && path.endsWith('/images/generations')) {
            return Response.json({ task_id: 'moss_t1', status: 'pending' });
        }
        if (parsed.hostname === 'platform.mosi.cn' && path.endsWith('/tasks/moss_t1')) {
            poll++;
            return Response.json(poll === 1 ? { status: 'running' } : { status: 'success', output: { images: [{ url: 'https://cdn.mosi.cn/out.png' }] } });
        }
        if (parsed.hostname === 'cdn.mosi.cn') {
            return new Response('mosi-img', { headers: { 'Content-Type': 'image/png' } });
        }
        if (parsed.hostname === 'openai.example' && path.endsWith('/images/edits')) {
            return new Response('not supported', { status: 404 });
        }
        if (parsed.hostname === 'openai.example' && path.endsWith('/images/generations')) {
            return Response.json({ data: [{ b64_json: 'b2s=' }] });
        }
        throw Error(url);
    });
    const args = { kind: 'image', prompt: 'Night harbor', connection: 'c', references: [{ role: 'character', image: { source: 'media', id: 'x' } }] };
    const sf = await generateImage({ baseUrl: 'https://api.siliconflow.cn/v1', providerKind: 'moss', apiKey: 'k', model: 'OpenMOSS-Team/MOSS-Image-SFT' }, args, 'owner', ['media.manage'], new AbortController().signal);
    assert.equal(await sf.blob.text(), 'sf-img');
    assert.equal(sf.seed, 99);
    const mosi = await generateImage({ baseUrl: 'https://platform.mosi.cn/v1', providerKind: 'moss', apiKey: 'k', model: 'moss-image-sft-1.0' }, args, 'owner', ['media.manage'], new AbortController().signal);
    assert.equal(await mosi.blob.text(), 'mosi-img');
    const fb = await generateImage({ baseUrl: 'https://openai.example/v1', providerKind: 'openai', apiKey: 'k', model: 'flux' }, args, 'owner', ['media.manage'], new AbortController().signal);
    assert.equal(await fb.blob.text(), 'ok');
    let sentPrompt = '';
    t.mock.method(globalThis, 'fetch', async (_url, init) => {
        sentPrompt = JSON.parse(init.body).prompt;
        return Response.json({ data: [{ b64_json: 'b2s=' }] });
    });
    await generateImage(
        { baseUrl: 'https://openai.example/v1', providerKind: 'openai', apiKey: 'k', model: 'gpt-image-2.6-flare' },
        { kind: 'image', prompt: 'Portrait in sunlight', negativePrompt: 'blurry, lowres, huge breasts, overly busty, extra fingers', connection: 'c' },
        'owner',
        ['media.manage'],
        new AbortController().signal,
    );
    assert.match(sentPrompt, /Avoid: blurry, lowres, extra fingers/);
    assert.ok(!/huge breasts|overly busty/i.test(sentPrompt));
});
test('generateImage skips dead remote references while propagating permission errors', async (t) => {
    const resilient = await fixture(`export {generateImage} from './src/plugins/native/image-adapter'`, {
        '../../core/platform-bridge': `export const detectRuntimeFlavor=async()=>'browser-offline'`,
        '../../core/native-runtime': `export const platformFetch=(...args)=>globalThis.fetch(...args);export const isNativeRuntime=()=>false`,
        './connections': `export const httpEndpoint=value=>new URL(value)`,
        './media-ref': `
            import { PluginApiError } from './src/plugins/native/errors';
            export const resolveReference = async (_owner, ref) => {
                if (ref.assetId === 'forbidden') throw new PluginApiError('PERMISSION_DENIED', 'no');
                throw new Error('远程参考图加载失败');
            };
        `,
        './media': `export const mediaLimit=20*1024*1024`,
    });
    t.mock.method(globalThis, 'fetch', async () => Response.json({ data: [{ b64_json: 'b2s=' }] }));
    const conn = { baseUrl: 'https://openai.example/v1', providerKind: 'openai', apiKey: 'k', model: 'flux' };
    const ok = await resilient.generateImage(
        conn,
        { kind: 'image', prompt: 'Summer shrine', connection: 'c', references: [{ role: 'character', image: { source: 'card.asset', characterId: 'card', assetId: 'dead' } }] },
        'owner',
        ['assets.read'],
        new AbortController().signal,
    );
    assert.equal(await ok.blob.text(), 'ok');
    await assert.rejects(
        resilient.generateImage(
            conn,
            { kind: 'image', prompt: 'Summer shrine', connection: 'c', references: [{ role: 'character', image: { source: 'card.asset', characterId: 'card', assetId: 'forbidden' } }] },
            'owner',
            ['assets.read'],
            new AbortController().signal,
        ),
        { code: 'PERMISSION_DENIED' },
    );
});

const {encodeStoryFile,decodeStoryFile,restoreImages}=await fixture(`export * from './src/core/story-save-format';export {restoreImages} from './src/core/story-plugin-archive'`,{'../plugins/native/media':`export const loadMedia=()=>{throw new Error('unexpected I/O')}`});
test('portable archive opts out cleanly and remaps repeated image handles only once per publisher',async()=>{
    const plugin='dev.tipsy-isle.lumina-director',finger='a'.repeat(64),id=crypto.randomUUID(),newId=crypto.randomUUID(),owner=`${plugin}:${finger}`;
    const bucket={owner:finger,schemaVersion:1,version:1,values:{replyMedia:[{slotId:'one',takes:[{id}],activeTake:0}],stage:{backdropMediaId:id}}};
    const character={id:'card',name:'School',regexScripts:[],alternateGreetings:[]};
    const chat={id:'chat',characterId:'card',activeLeafId:'reply',messages:[{id:'reply',floor:0,role:'assistant',content:'hello',swipes:['hello'],activeSwipeIndex:0,swipeIds:['one'],nativePluginReplies:{one:{[plugin]:bucket}}}],continuation:{variables:{chat:{},global:{}},activeLorebookIds:[],nativePluginRoute:{[plugin]:{...bucket,values:{castRegistry:{Lin:{canonicalMediaId:id}}}}}}};
    const decode=async files=>decodeStoryFile(new File([await encodeStoryFile(chat,character,files)],'fixture.tipsy-story'));
    const absent=await decode(undefined);assert.equal(absent.chat.messages[0].nativePluginReplies,undefined);
    const saved=await decode([{owner,id,mime:'image/png',bytes:new Uint8Array([1,2,3])}]);let count=0;
    const imported=await restoreImages(saved.chat,saved.images,async(key,blob)=>{assert.equal(key,owner);assert.equal(blob.size,3);count++;return newId;});assert.equal(count,1);
    assert.equal(imported.messages[0].nativePluginReplies.one[plugin].values.replyMedia[0].takes[0].id,newId);assert.equal(imported.continuation.nativePluginRoute[plugin].values.castRegistry.Lin.canonicalMediaId,newId);
    await assert.rejects(restoreImages(saved.chat,[{...saved.images[0],owner:'other'}],async()=>newId));
});
const {scheduleJob}=await fixture(`export {scheduleJob} from './src/plugins/native/jobs'`);
test('route-bound jobs deduplicate concurrent and recently completed arrivals and propagate cancellation',async()=>{
    const controller=new AbortController(),route={chatId:'story',routeId:'one'},cycle={id:'gen',signal:controller.signal};let started=0,aborted=0;
    const work=async(_,signal)=>{started++;await new Promise(resolve=>signal.addEventListener('abort',()=>{aborted++;resolve();},{once:true}));};const job={key:'reply:1',payload:{},generationId:'gen'};
    assert.equal(scheduleJob('owner',job,route,cycle,work),scheduleJob('owner',{key:job.key,payload:{}},route,undefined,work));await Promise.resolve();assert.equal(started,1);controller.abort();await Promise.resolve();assert.equal(aborted,1);assert.throws(()=>scheduleJob('owner',job,route,undefined,work));

    let completedRuns=0;
    const fastWork=async()=>{completedRuns++;};
    const firstId=scheduleJob('owner',{key:'reply:fast-checkpoint',payload:{}},route,undefined,fastWork);
    await new Promise(resolve=>setTimeout(resolve,20));
    const secondId=scheduleJob('owner',{key:'reply:fast-checkpoint',payload:{}},route,undefined,fastWork);
    assert.equal(firstId, secondId);
    assert.equal(completedRuns, 1);
});
const storageFixture = await fixture(`
    export { addressedStorage } from './src/plugins/native/addressed-storage';
    export { setStoryBusy } from './story-port';
    export { enqueuePersistentOperation } from '../../store/persistence';
`, {
    './story-port': `
        let busy = false;
        const listeners = new Set();
        export const setStoryBusy = (value, notify = true) => { busy = value; if (notify) for (const listener of listeners) listener(); };
        export const nativeStoryBusy = () => busy;
        export const liveStory = () => ({ ref: { chatId: 'story' } });
        export const watchStory = listener => { listeners.add(listener); return () => listeners.delete(listener); };
        export const settled = () => true;
        export const messageRef = () => ({ messageId: 'reply', swipeId: 'one', revision: 'current' });
        export const sameMessageRef = (left, right) => left.revision === right.revision;
    `,
    './transactions': `
        import { PluginApiError } from './src/plugins/native/errors';
        import { nativeStoryBusy } from './story-port';
        const chat = { messages: [{ id: 'reply', swipes: ['Scene'], activeSwipeIndex: 0, swipeIds: ['one'] }] };
        export async function editStory(route, access, build) {
            if (nativeStoryBusy()) throw new PluginApiError('STORY_BUSY', 'story is settling');
            const output = await build(chat);
            access.check();
            return output.result;
        }
    `,
    './story-data': `export const readChat = async () => {}; export const resolveRoute = async chat => ({ path: chat.messages, active: true });`,
    './catalog': `export const readPluginBucket = async () => ({ version: 0, values: {} });`,
    '../../store/persistence': `
        let pending = Promise.resolve();
        export function enqueuePersistentOperation(run) {
            const task = pending.then(run);
            pending = task.catch(() => {});
            return task;
        }
    `,
});

test('background reply mark waits for settlement without blocking storage or retrying cancelled jobs', async t => {
    const { addressedStorage, setStoryBusy, enqueuePersistentOperation } = storageFixture;
    const events = new EventTarget();
    t.mock.method(events, 'removeEventListener');
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    Object.defineProperty(globalThis, 'window', { configurable: true, value: events });
    t.after(() => {
        setStoryBusy(false);
        if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
        else delete globalThis.window;
    });
    const input = { route: { chatId: 'story', routeId: 'one' }, reply: { messageId: 'reply', swipeId: 'one', revision: 'current' },
        expectedVersion: 0, patch: { set: { status: 'developing' } } };
    const patch = (waitForIdle, signal = new AbortController().signal, args = input) =>
        addressedStorage({ manifest: { id: 'lumina' } }, 'patchAt', args, () => {}, () => {}, signal, waitForIdle);
    setStoryBusy(true);
    await assert.rejects(patch(false), { code: 'STORY_BUSY' });
    let written = false;
    const background = patch(true).then(result => { written = true; return result; });
    await enqueuePersistentOperation(async () => {});
    assert.equal(written, false);
    setStoryBusy(false, false);
    events.dispatchEvent(new Event('tipsy-branch-operations-idle'));
    assert.deepEqual(await background, { version: 1, values: { status: 'developing' } });

    setStoryBusy(true);
    const cancelled = new AbortController();
    const waiting = assert.rejects(patch(true, cancelled.signal), { name: 'AbortError' });
    await enqueuePersistentOperation(async () => {});
    cancelled.abort();
    await waiting;
    assert.equal(events.removeEventListener.mock.callCount(), 4);
    setStoryBusy(false);
    await assert.rejects(patch(true, undefined, { ...input, reply: { ...input.reply, revision: 'stale' } }), { code: 'STALE_REPLY' });
});

const {resolveActiveStage}=await fixture(`export {resolveActiveStage} from './src/plugins/native/reply-media'`,{
    './catalog':`export const activePlugins=()=>[{manifest:{id:'lumina',storageVersion:1},fingerprint:'fp',digest:'dg',grants:['media.manage','ui.surface','ui.stage'],settings:{}}]`,
    './host':`export const invokeNativePlugin=async()=>{}`
});
test('resolveActiveStage carries stage cues forward across unillustrated floors and reverts on scroll-up',()=>{
    const id=crypto.randomUUID();
    const makeNode=(floor,cue)=>({id:`m${floor}`,floor,role:'assistant',content:'...',swipes:['...'],activeSwipeIndex:0,swipeIds:[`s${floor}`],nativePluginReplies:{[`s${floor}`]:{lumina:{owner:'fp',schemaVersion:1,version:1,values:{replyMedia:[{slotId:'shot-0',status:'ready',label:'scene'}],...(cue&&{stage:{revision:`r${floor}`,backdropMediaId:cue}})}}}}});
    const nodes=[makeNode(0,undefined),makeNode(1,id),makeNode(2,undefined),makeNode(3,undefined)];
    assert.equal(resolveActiveStage(nodes,0),undefined);
    assert.equal(resolveActiveStage(nodes,1)?.cue?.backdropMediaId,id);
    assert.equal(resolveActiveStage(nodes,3)?.cue?.backdropMediaId,id);
});

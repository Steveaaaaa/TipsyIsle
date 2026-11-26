import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { zipSync } from 'fflate';
import { supportedHostApi } from '../packages/plugin-sdk/package-format.mjs';

const bundle=await build({stdin:{contents:`export * from './src/plugins/native/vm-protocol';export * from './src/plugins/native/image-protocol';export * from './src/plugins/native/checkpoints';export * from './src/plugins/native/card-visual-index';export * from './src/plugins/native/latent-film';export * from './src/plugins/native/reply-media-schema';export * from './src/plugins/native/sandbox-media-bridge';export * from './src/sandbox/sandbox-media-shim';export * from './src/compatibility/media-geometry';export * from './src/compatibility/film-surface';export * from './src/pipeline/streaming-message';export * from './src/pipeline/macro-regex-engine';export * from './examples/plugins/lumina-director/tension-gate';export * from './examples/plugins/lumina-director/visual-bible';export * from './examples/plugins/lumina-director/continuity-ledger';export * from './examples/plugins/lumina-director/shot-director';export * from './src/core/claude-completion';`,resolveDir:process.cwd()},bundle:true,platform:'node',format:'esm',write:false,banner:{js:`import { createRequire as __cr } from 'node:module'; const require = __cr(${JSON.stringify(process.cwd() + '/package.json')});`}});
const {vmLimits,workflow,novelRequest,novelImage,imageRequest,buildCardVisualIndex,latentFilm,developPreview,updateJobPreview,clearLatentForGeneration,replyMediaItemSchema,sandboxMediaStore,setSandboxMountedMedia,clearSandboxMountedMedia,getSandboxMountedKeys,findSandboxParagraphAnchor,filmGeometry,createFilmSurface,createStreamPlan,StreamProjector,extractHtmlSandboxBlocks,isEmptySlotPlaceholder,shots,extractExplicitPrompt,extractShotFromReply,closedParagraphs,visualBible,isAbsentOrMentionOnly,extractVisualTraits,continuity,extractDeceasedFromText,extractDeceasedFromMvu,filterLedgerForShot,mergeLedger,pruneLedgerForFloor,direct,claudeReplyAdapter}=await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`);
test('1.2 negotiates all three generations without lending new permissions to old manifests',()=>{
    for(const api of ['1.0.0','1.1.0','1.2.0'])assert.equal(supportedHostApi({hostApi:api,permissions:[]}),api);
    assert.equal(supportedHostApi({hostApi:'1.1.0',permissions:['jobs.run']}),null);
});
test('NovelAI coordinates, negatives, Vibe and director references survive request compilation',()=>{
    const actors=[{prompt:'Lin',negativePrompt:'hat',center:{x:.2,y:.6}},{prompt:'Ren',center:{x:.8,y:.3}}];
    const data=imageRequest.parse({kind:'image',connection:'test',prompt:'snow',actors});const {parameters}=novelRequest('nai-diffusion-4-5-full',data,[{role:'character',data:'left',weight:.8},{role:'style',data:'vibe',weight:.5}],42);
    assert.deepEqual(parameters.v4_prompt.caption.char_captions.map(item=>item.centers[0]),actors.map(actor=>actor.center));assert.equal(parameters.v4_negative_prompt.caption.char_captions[0].char_caption,'hat');assert.deepEqual(parameters.director_reference_images,['left']);assert.deepEqual(parameters.reference_image_multiple,['vibe']);assert.equal(parameters.seed,42);
    assert.throws(()=>imageRequest.parse({...data,apiKey:'not-allowed'}));assert.throws(()=>imageRequest.parse({...data,actors:[{prompt:'bad',center:{x:4,y:0}}]}));
});
test('NovelAI ZIP selects a bounded image from the central directory (stored and deflated)',async()=>{
    const bytes=Uint8Array.from({length:24000},(_,index)=>index%7);
    for(const level of [0,6]){const zip=zipSync({'notes.txt':new Uint8Array(3),'nested/frame.png':bytes},{level});assert.deepEqual(new Uint8Array(await novelImage(zip).arrayBuffer()),bytes);assert.throws(()=>novelImage(zip,100));assert.throws(()=>novelImage(zip.slice(0,-6)));}
});
test('Comfy resolves text conditioning through intermediate nodes, not node order',()=>{
    const graph={negative:{class_type:'CLIPTextEncode',inputs:{text:'bad'}},positive:{class_type:'CLIPTextEncode',inputs:{text:'good'}},cond:{class_type:'ConditioningSetArea',inputs:{conditioning:['positive',0]}},sample:{class_type:'KSampler',inputs:{positive:['cond',0],negative:['negative',0],seed:7}},latent:{class_type:'EmptySD3LatentImage',inputs:{width:512,height:512}},ref:{class_type:'LoadImage',_meta:{title:'style reference'},inputs:{image:''}}};
    assert.deepEqual(workflow(JSON.stringify(graph)).slots,{prompt:['positive','text'],negativePrompt:['negative','text'],seed:['sample','seed'],width:['latent','width'],height:['latent','height'],styleRef:['ref','image']});
});
test('only closed narrative is checkpointed; quiet beginnings wait for the climax',()=>{
    assert.deepEqual(closedParagraphs('<think>推开门\n\n藏起</think>闲谈。\n\n未写完'),['闲谈。']);assert.equal(shots('闲谈。\n\n继续聊天。',true).length,0);assert.equal(shots('闲谈。\n\n继续聊天。\n\n天空骤然闪电。')[0].index,2);assert.equal(shots('推开门。\n\n继续',true)[0].index,0);
    assert.equal(shots('闪电。'+ '夜'.repeat(1850)+'\n\n翌日，推开门。').length,2);
});
test('ensemble rejects the crest and uses the NPC canonical portrait next time',()=>{
    const cast=[{role:'character',id:'school',name:'圣樱学院',description:'群像',avatar:{source:'character.avatar',characterId:'school'}}];
    assert.equal(visualBible(cast,'白石凛推开门',{},['白石凛']).actors[0].reference,undefined);
    assert.deepEqual(visualBible(cast,'白石凛推开门',{白石凛:{canonicalMediaId:'first'}},['白石凛']).actors[0].reference,{source:'media',id:'first'});
});
test('native Claude streams text and fragmented tool arguments through the shared reader',()=>{
    const adapt=claudeReplyAdapter();assert.equal(adapt({delta:{type:'text_delta',text:'hello'}},true).choices[0].delta.content,'hello');assert.equal(adapt({content_block:{type:'tool_use',id:'one',name:'lookup'}},true).choices[0].delta.tool_calls[0].index,0);assert.equal(adapt({delta:{type:'input_json_delta',partial_json:'{}'}},true).choices[0].delta.tool_calls[0].function.arguments,'{}');
});
test('tension-gate extracts explicit <pic>/[IMG:GEN] prompts and avoids mundane single-word spam',()=>{
    assert.equal(extractExplicitPrompt('<pic prompt="rainy harbor at dusk">'), 'rainy harbor at dusk');
    assert.equal(extractExplicitPrompt('[IMG:GEN:{"prompt":"moonlit rooftop"}]'), 'moonlit rooftop');
    assert.equal(shots('她转身看着窗外。').length, 0);
    const picShots = shots('闲谈。\n\n<pic prompt="lantern in fog">林汐停下脚步。');
    assert.equal(picShots.length, 1);
    assert.equal(picShots[0].explicitPrompt, 'lantern in fog');
    assert.equal(shots('她转身看着窗外。\n\n<pic prompt="lantern">', false, { markersOnly: true }).length, 1);
});
test('visualBible enriches traits from profiles and continuity handles garment removal/negation',()=>{
    const cast=[{role:'character',id:'lin',name:'林汐',description:'银色长发，琥珀瞳，身穿黑色风衣。',avatar:null}];
    const res = visualBible(cast, '林汐走进雨夜。', {}, ['林汐', '白石凛'], { 白石凛: '黑发红瞳，学院制服' });
    assert.match(res.actors[0].prompt, /银色长发/);
    const summer = visualBible([], '水瀬汐系着右侧发带站在神社。', {}, ['水瀬汐'], { 水瀬汐: '蓝色长发，发带系在右侧，灰色的眼睛' });
    assert.match(summer.actors[0].prompt, /发带系在右侧/);
    const state1 = continuity('林汐换上黑色风衣，手持怀表。', {}, undefined, ['林汐']);
    assert.equal(state1.cast.林汐.outfit, '黑色风衣');
    assert.equal(state1.cast.林汐.prop, '怀表');
    const state2 = continuity('林汐没穿着外套，脱下黑色风衣。', state1, undefined, ['林汐']);
    assert.equal(state2.cast.林汐.outfit, undefined);
});

test('Lumina archives the entire submitted main prompt on the new take', async () => {
    const bundle = await build({ entryPoints: ['examples/plugins/lumina-director/main.ts'], bundle: true, platform: 'node', format: 'esm', write: false });
    const { default: plugin } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`);
    const prompt = 'warm late-afternoon light, fine linework, '.repeat(20) + '最后一段色调';
    const route = { chatId: 'story', routeId: 'route' };
    const reply = { messageId: 'reply', swipeId: 'swipe', revision: 'revision' };
    let submitted;
    let replyValues = {};
    const api = {
        settings: {},
        story: { participants: async () => [], visualSources: async () => ({ people: [], profiles: {}, gallery: [] }),
            state: async () => ({}), getMessage: async () => ({ floor: 2 }) },
        models: { connections: async () => [{ id: 'nai', kinds: ['image'] }],
            start: async request => { submitted = request; return 'task'; } },
        tasks: { await: async () => ({ result: { kind: 'image', media: { id: 'generated-image' }, seed: 42 } }) },
        storage: { read: async () => ({ values: {} }), readAt: async ({ reply }) => ({ version: 0, values: reply ? replyValues : {} }),
            patchAt: async ({ reply, patch }) => { if (reply) replyValues = { ...replyValues, ...patch.set }; } },
        index: { search: async () => [], put: async () => {} },
    };
    await plugin.onJob(api, { id: 'job', key: 'refine', route, target: reply,
        payload: { scene: '走廊尽头的午后斜阳', slot: 'shot-0', index: 0, custom: prompt } });
    assert.equal(submitted.prompt, prompt);
    assert.equal(replyValues.replyMedia[0].takes[0].prompt, submitted.prompt);
});

test('card-visual-index extracts remote card galleries, bridges local gallery, and guards against NSFW/chibi/prefix collisions', () => {
    const summerCard = {
        id: 'card-summer',
        name: '何人驻足的夏天',
        description: '海边小镇群像故事',
        firstMessage: '',
        alternateGreetings: [],
        characterVersion: '1.0',
        avatar: '',
        personality: '',
        scenario: '',
        mesExample: '',
        systemPrompt: '',
        postHistoryInstructions: '',
        creatorNotes: '',
        tags: [],
        regexScripts: [
            {
                id: 'r0',
                scriptName: 'nsfw插入',
                findRegex: '<nsfw>',
                replaceString: `var url = 'https://cdn.jsdelivr.net/gh/qinjingyue/zhuzudexiari@main/inari_kj_1.jpg';`,
                placement: [],
            },
            {
                id: 'r1',
                scriptName: '前端',
                findRegex: '<scene_cover>',
                replaceString: `<script>
                    var baseUrl = 'https://cdn.jsdelivr.net/gh/qinjingyue/zhuzudexiari@main/';
                    var chibi = baseUrl + 'inari_kx_q.png';
                    window.ACG_ROLE_PROFILES = {
                        'shio': { aliases: ['水瀬汐', '水瀬 汐', '汐'], name: '水瀬 汐', count: 3 },
                        'shion': { aliases: ['月城紫苑', '月城 紫苑', '紫苑'], name: '月城 紫苑', count: 2 },
                        'inari': { aliases: ['稻荷灵铃', '稻荷 灵铃', '灵铃'], name: '稻荷 灵铃', count: 4 },
                        'chiya': { aliases: ['松原千夜', '松原 千夜', '千夜'], name: '松原 千夜', count: 0 }
                    };
                    var p = baseUrl + role + '_' + num + '.jpg';
                    var b = baseUrl + role + '_' + num + '.png';
                </script>`,
                placement: [],
            },
        ],
    };
    const books = [{
        id: 'b1',
        name: 'Summer',
        entries: [{
            id: 'e1',
            uid: 1,
            keys: ['稻荷灵铃，灵铃'],
            comment: '稻荷 灵铃',
            content: 'character: 稻荷 灵铃\n' + '背景'.repeat(1400) + '\n外貌: |\n  一头明亮的黄发，深红色的眼睛。\n角色核心:\n  等待。',
            enabled: true,
            disabled: false,
            constant: false,
            selective: false,
            order: 1,
            position: 'before_char',
        }],
    }];
    const gallery = { version: 'v1', name: 'summer.zip', bytes: 100, files: ['sub/inari_1.jpg'] };
    const idx = buildCardVisualIndex(summerCard, books, gallery);

    const inari = idx.characters.find((c) => c.name === '稻荷 灵铃');
    const shio = idx.characters.find((c) => c.name === '水瀬 汐');
    const shion = idx.characters.find((c) => c.name === '月城 紫苑');
    const chiya = idx.characters.find((c) => c.name === '松原 千夜');

    assert.ok(inari && inari.references.length === 4);
    assert.match(inari.traits, /一头明亮的黄发/);
    assert.equal(inari.references[0].origin, 'local-gallery');
    assert.equal(inari.references[0].ref.source, 'card.asset');
    assert.equal(idx.assetsById.get(inari.references[0].ref.assetId)?.localGalleryPath, 'sub/inari_1.jpg');
    assert.ok(shio && shio.references.every((r) => idx.assetsById.get(r.ref.assetId)?.url.includes('/shio_')));
    assert.ok(shion && shion.references.every((r) => idx.assetsById.get(r.ref.assetId)?.url.includes('/shion_')));
    assert.ok(chiya && chiya.references.length === 0);
    for (const asset of idx.assetsById.values()) {
        assert.ok(!/inari_kj_1|_q\.png/.test(asset.url ?? ''));
    }

    // Shen Yi'an wardrobe + Chisa encoded Markdown & phone_data + TMLXC alt slug
    const multiCard = {
        id: 'card-multi',
        name: '综合测试',
        description: '',
        firstMessage: '[千纱（高中篇）](https://raw.githubusercontent.com/patricksoi1/chisa/main/public/charimg/%E5%8D%83%E7%BA%B1%EF%BC%88%E9%AB%98%E4%B8%AD%E7%AF%87%EF%BC%89.png)',
        alternateGreetings: [],
        characterVersion: '1.0',
        avatar: '',
        personality: '',
        scenario: '',
        mesExample: '',
        systemPrompt: '',
        postHistoryInstructions: '',
        creatorNotes: '',
        tags: [],
        extensions: {
            tavern_helper: {
                variables: {
                    phone_data: {
                        user: { name: '主角', avatar: 'https://files.catbox.moe/user99.jpg' },
                        characters: [{ name: '染川千纱', nickname: '千纱', avatar: 'https://files.catbox.moe/arh2ub.JPG', chatBg: 'https://files.catbox.moe/bg1.jpg' }],
                    },
                },
            },
        },
        regexScripts: [
            {
                id: 'sya',
                scriptName: '沈以安立绘',
                findRegex: '<status>',
                replaceString: `var PORTRAIT_BASE='https://raw.githubusercontent.com/AliceNekoqqq/Pic/master/img/';
                var WARDROBE={ highschool:{ '日常':'沈以安-立绘-高中-日常.png', '制服':'沈以安-立绘-高中-制服.png', '赤裸':'沈以安-立绘-高中-赤裸.png' } };`,
                placement: [],
            },
            {
                id: 'tmlxc',
                scriptName: '卷宗',
                findRegex: '<ruby>',
                replaceString: `var REPO="https://raw.githubusercontent.com/vmkudz-sys/TMLXC/main/";
                var CHARS=[{id:'huo_ling',cn:'霍翎',aliases:['霍翎','翎姐']}];
                var u = REPO + (w.id==='huo_ling'?'NEWhuo_ling':w.id)+'_daily.png';`,
                placement: [],
            },
        ],
    };
    const multiIdx = buildCardVisualIndex(multiCard, [{
        id: 'b-sya',
        name: 'SYA',
        entries: [{ id: 'e-sya', uid: 1, keys: ['沈以安'], comment: '沈以安', content: 'character: 沈以安\n外貌: 黑发', enabled: true, disabled: false, constant: false, selective: false, order: 1, position: 'before_char' }],
    }], null);
    const chisa = multiIdx.characters.find((c) => c.name === '染川千纱');
    const huo = multiIdx.characters.find((c) => c.name === '霍翎');
    const sya = multiIdx.characters.find((c) => c.name === '沈以安');
    assert.ok(chisa && chisa.references.some((r) => multiIdx.assetsById.get(r.ref.assetId)?.url === 'https://files.catbox.moe/arh2ub.JPG'));
    assert.ok(chisa.references.some((r) => multiIdx.assetsById.get(r.ref.assetId)?.url?.includes('%E5%8D%83%E7%BA%B1')));
    assert.ok(!chisa.references.some((r) => multiIdx.assetsById.get(r.ref.assetId)?.url?.includes('bg1.jpg')));
    assert.ok(huo && huo.references.some((r) => multiIdx.assetsById.get(r.ref.assetId)?.url?.endsWith('NEWhuo_ling_daily.png')));
    assert.ok(sya && sya.references.some((r) => r.tags?.includes('制服')));
    assert.ok(!([...multiIdx.assetsById.values()].some((a) => /赤裸|user99/.test(a.url ?? ''))));
});

test('visualBible deduplicates aliases, guards 1-char CJK compounds, and picks scene-matching outfit references', () => {
    const characters = [
        {
            name: '稻荷 灵铃',
            aliases: ['稻荷灵铃', '灵铃'],
            traits: '明亮黄发，深红瞳',
            references: [{ ref: { source: 'card.asset', characterId: 'c1', assetId: 'ca_inari_1' }, confidence: 0.94, origin: 'remote-card' }],
        },
        {
            name: '水瀬 汐',
            aliases: ['水瀬汐', '汐'],
            traits: '蓝色长发，灰色眼睛',
            references: [{ ref: { source: 'card.asset', characterId: 'c1', assetId: 'ca_shio_1' }, confidence: 0.94, origin: 'remote-card' }],
        },
        {
            name: '神代 蛍',
            aliases: ['神代蛍', '蛍'],
            traits: '黑发',
            references: [{ ref: { source: 'card.asset', characterId: 'c1', assetId: 'ca_hotaru_1' }, confidence: 0.94, origin: 'remote-card' }],
        },
        {
            name: '沈以安',
            aliases: ['以安'],
            traits: '黑发',
            references: [
                { ref: { source: 'card.asset', characterId: 'c1', assetId: 'ca_daily' }, tags: ['highschool', '日常'], confidence: 0.94, origin: 'remote-card' },
                { ref: { source: 'card.asset', characterId: 'c1', assetId: 'ca_uniform' }, tags: ['highschool', '制服'], confidence: 0.94, origin: 'remote-card' },
            ],
        },
    ];

    const dedup = visualBible([], '稻荷灵铃站在走廊，灵铃轻轻叹了口气。', {}, [], {}, characters);
    assert.equal(dedup.actors.length, 1);
    assert.equal(dedup.actors[0].name, '稻荷 灵铃');
    assert.deepEqual(dedup.actors[0].reference, { source: 'card.asset', characterId: 'c1', assetId: 'ca_inari_1' });

    const compoundGuard = visualBible([], '夏夜的潮汐拍打海岸，远处的萤火微弱。', {}, [], {}, characters);
    assert.equal(compoundGuard.actors.length, 0);

    const singleBoundary = visualBible([], '汐轻声说：跟我来神社。', {}, [], {}, characters);
    assert.equal(singleBoundary.actors.length, 1);
    assert.equal(singleBoundary.actors[0].name, '水瀬 汐');

    const outfitPick = visualBible([], '沈以安穿着校服走进教室。', {}, [], {}, characters);
    assert.equal(outfitPick.actors.length, 1);
    assert.deepEqual(outfitPick.actors[0].reference, { source: 'card.asset', characterId: 'c1', assetId: 'ca_uniform' });
});

test('universal streaming plan, widget splitting, closedParagraphs, and attire extraction handle CoT & narrative wrappers', () => {
    // 1. Escaped-bracket alternation CoT regex & trailing scene_cover keep plan.whole = false and stream <now_plot> live
    const cotRule = {
        id: 'cot',
        scriptName: '思维链查看',
        findRegex: String.raw`^(?:(?:(?:(?!\</(?:think(?:ing)?|draft)\s*>)[\s\S])*?\<(?:think(?:ing)?|draft)\b[^>]*>)|(?!(?:(?!\</(?:think(?:ing)?|draft)\s*>)[\s\S])*\<(?:think(?:ing)?|draft)\b[^>]*>))([\s\S]*?)\<\/(?:think(?:ing)?|draft)\s*>`,
        replaceString: '<div class="stthink-root"><style>.stthink{color:blue}</style><div class="stthink">$1</div><script>document.querySelectorAll(".stthink")</script></div>',
        placement: ['ai_output'],
        disabled: false,
    };
    const coverRule = {
        id: 'cover',
        scriptName: '前端',
        findRegex: '<scene_cover>([\\s\\S]*?)</scene_cover>',
        replaceString: '<!doctype html><html><body><div>$1</div></body></html>',
        placement: ['ai_output'],
        disabled: false,
    };
    const plan = createStreamPlan([cotRule, coverRule], 's:p', '你', '夏', 'auto');
    assert.equal(plan.whole, false);
    const projector = new StreamProjector(plan);
    const preview = projector.update('<draft>构思中\n\n第2点</draft>\n<now_plot>\n午后的日头斜斜切过屋檐。\n\n水瀬澪坐在木廊上');
    assert.equal(preview.document, false);
    assert.notEqual(preview.phase, 'page');
    assert.ok(preview.parts.some((p) => p.type === 'reasoning'));
    assert.ok(preview.source.includes('午后的日头斜斜切过屋檐。'));

    // 2. extractHtmlSandboxBlocks separates scoped header widgets from <now_plot> narrative prose while keeping standalone widgets intact
    const settled = `${cotRule.replaceString}\n<span hidden></span><style>.stw2{color:red}</style><div class="stw2">2024-07-16</div>\n<now_plot>\n第一段足够长的正文描写海风与木廊。\n\n第二段描写少女的笑容。\n</now_plot>\n<!doctype html><html><body>cover</body></html>`;
    const blocks = extractHtmlSandboxBlocks(settled);
    assert.deepEqual(blocks.map((b) => b.type), ['mixed', 'markdown', 'html']);
    assert.match(blocks[1].content, /第一段足够长的正文/);

    // Existing slot-compat assertions remain intact
    assert.equal(isEmptySlotPlaceholder('<div data-dl-content="1"></div>\n<div data-dl-upd="1"></div>'), true);
    assert.deepEqual(extractHtmlSandboxBlocks('<div>实际文本</div>').map((b) => b.type), ['mixed']);
    assert.deepEqual(extractHtmlSandboxBlocks('<div id="app"></div><script>document.getElementById("app").textContent="ok"</script>').map((b) => b.type), ['mixed']);
    assert.deepEqual(extractHtmlSandboxBlocks('<div></div><script>document.querySelector("div").textContent="ok"</script>').map((b) => b.type), ['mixed']);
    assert.deepEqual(extractHtmlSandboxBlocks('<div class="card"><div class="empty"></div>body</div>').map((b) => b.type), ['mixed']);

    // 3. closedParagraphs strips <draft>/<scene_time>, unwraps unclosed <now_plot>, and fires up to 4 paragraphs
    const cp = closedParagraphs('<draft>草稿\n\n草稿2</draft>\n<scene_time>2024-07-16</scene_time>\n<now_plot>\n石阶最后几级被老樟树的浓荫盖住。\n\n水瀬澪坐在光影交界处，风从海湾吹过来。\n\n未写完的段落');
    assert.deepEqual(cp, ['石阶最后几级被老樟树的浓荫盖住。', '水瀬澪坐在光影交界处，风从海湾吹过来。']);

    // 4. shots(early) captures visual scene within first 4 paragraphs while quiet 2-paragraph banter waits
    assert.equal(shots('闲谈。\n\n继续聊天。', true).length, 0);
    const early4 = shots('第一段。\n\n第二段。\n\n水瀬澪正坐在光影交界处，海湾的阳光与阴影分界线清晰可见，微风拂过发梢与木廊。', true);
    assert.equal(early4.length, 1);
    assert.equal(early4[0].index, 2);

    // 5. buildCardVisualIndex extracts attire rules (巫女服) from background section
    const attireIdx = buildCardVisualIndex({
        id: 'c-attire',
        name: '水瀬 汐',
        description: '',
        firstMessage: '',
        alternateGreetings: [],
        characterVersion: '1.0',
        avatar: '',
        personality: '',
        scenario: '',
        mesExample: '',
        systemPrompt: '',
        postHistoryInstructions: '',
        creatorNotes: '',
        tags: [],
        regexScripts: [],
    }, [{
        id: 'b-attire',
        name: 'B',
        entries: [{
            id: 'e1',
            uid: 1,
            keys: ['水瀬汐'],
            comment: '水瀬 汐',
            content: 'character: 水瀬 汐\n背景:\n  出身: |\n    课余和假期穿巫女服在神社帮忙。\n外貌: |\n  蓝色长发，灰色的眼睛。',
            enabled: true,
            disabled: false,
            constant: false,
            selective: false,
            order: 1,
            position: 'before_char',
        }],
    }], null);
    assert.match(attireIdx.characters[0].traits, /巫女服/);
});

test('extracts age & physique traits and enforces proportion guardrails without mid-word truncation', async () => {
    const idx = buildCardVisualIndex({
        id: 'card-physique',
        name: '何人驻足的夏天',
        description: '海边小镇群像',
        firstMessage: '',
        alternateGreetings: [],
        characterVersion: '1.0',
        avatar: '',
        personality: '',
        scenario: '',
        mesExample: '',
        systemPrompt: '',
        postHistoryInstructions: '',
        creatorNotes: '',
        tags: [],
        regexScripts: [],
    }, [{
        id: 'b-phy',
        name: 'Summer',
        entries: [
            {
                id: 'e-shion',
                uid: 1,
                keys: ['月城紫苑'],
                comment: '月城 紫苑',
                content: 'character: 月城 紫苑\n核心身份:\n  年龄: 19岁，大一\n外貌: |\n  白色长发，像月光一样。' + '描写'.repeat(110) + '\n  居家常穿吊带背心，中等身材，有曲线。',
                enabled: true,
                disabled: false,
                constant: false,
                selective: false,
                order: 1,
                position: 'before_char',
            },
            {
                id: 'e-wakaba',
                uid: 2,
                keys: ['水无月若叶'],
                comment: '水无月 若叶',
                content: 'character: 水无月 若叶\n核心身份:\n  年龄: 13\n外貌: |\n  个子小小的，骨架也纤细，乌黑中长发。',
                enabled: true,
                disabled: false,
                constant: false,
                selective: false,
                order: 2,
                position: 'before_char',
            },
            {
                id: 'e-inari',
                uid: 3,
                keys: ['稻荷灵铃'],
                comment: '稻荷 灵铃',
                content: 'character: 稻荷 灵铃\n核心身份:\n  年龄: 两百岁以上，外表约二十岁\n外貌: |\n  一头明亮黄发，有着一对傲人的巨乳。',
                enabled: true,
                disabled: false,
                constant: false,
                selective: false,
                order: 3,
                position: 'before_char',
            },
        ],
    }], null);

    const shion = idx.characters.find((c) => c.name === '月城 紫苑');
    const wakaba = idx.characters.find((c) => c.name === '水无月 若叶');
    const inari = idx.characters.find((c) => c.name === '稻荷 灵铃');
    assert.match(shion.traits, /年龄：19岁/);
    assert.match(shion.traits, /体型：.*中等身材/);
    assert.match(wakaba.traits, /骨架也纤细/);
    assert.match(inari.traits, /傲人的巨乳/);

    const extractedShion = extractVisualTraits(shion.traits);
    assert.match(extractedShion, /19岁/);
    assert.match(extractedShion, /中等身材/);

    const fakeChatApi = (longActorPrompt) => ({
        models: {
            start: async () => 't1',
        },
        tasks: {
            await: async () => ({
                result: {
                    kind: 'chat',
                    text: JSON.stringify({
                        caption: '夜色微光',
                        prompt: 'Cozy dimly lit living room',
                        negativePrompt: 'blurry, lowres',
                        aspectRatio: '3:2',
                        palette: ['#1e2630', '#7ca1c4'],
                        actors: [{ name: '月城 紫苑', prompt: longActorPrompt, x: 0.5, y: 0.48 }],
                    }),
                },
            }),
        },
    });

    const longWordy = 'slim average-build young woman, moonlight-white long hair, aster-violet eyes, camisole, ' + 'gentle soft lighting, '.repeat(28) + 'holding controller while leaning forward';
    const shionPlan = await direct(
        fakeChatApi(longWordy),
        [{ id: 'chat-1', kinds: ['chat'] }],
        {
            scene: '月城紫苑在空调房里打游戏。',
            layoutMode: 'novel-reader',
            actors: [{ name: '月城 紫苑', prompt: `月城 紫苑, ${extractedShion}` }],
            ledger: {},
            prior: '',
            framing: 'solo portrait',
        },
    );
    assert.match(shionPlan.negativePrompt, /huge breasts/);
    assert.ok(!shionPlan.actors[0].prompt.endsWith('gentle so'));
    assert.ok(shionPlan.actors[0].prompt.length <= 560);

    const inariPlan = await direct(
        {
            models: { start: async () => 't2' },
            tasks: {
                await: async () => ({
                    result: {
                        kind: 'chat',
                        text: JSON.stringify({
                            caption: '稻荷祈愿',
                            prompt: 'Sunny wooden veranda',
                            negativePrompt: 'blurry',
                            aspectRatio: '3:2',
                            palette: ['#272420', '#c9a66b'],
                            actors: [{ name: '稻荷 灵铃', prompt: 'voluptuous woman, blonde hair, crimson eyes', x: 0.5, y: 0.48 }],
                        }),
                    },
                }),
            },
        },
        [{ id: 'chat-1', kinds: ['chat'] }],
        {
            scene: '稻荷灵铃坐在廊下晒太阳。',
            layoutMode: 'novel-reader',
            actors: [{ name: '稻荷 灵铃', prompt: `稻荷 灵铃, ${extractVisualTraits(inari.traits)}` }],
            ledger: {},
            prior: '',
            framing: 'solo portrait',
        },
    );
    assert.equal(inariPlan.negativePrompt, 'blurry');
});

test('user-intent shot selection & pronoun coreference pick Emma profile over unrelated later TV owl broadcast', () => {
    const story = `<draft>构思中</draft>\n<now_plot>\n隔着冰冷的铁栅栏和幽暗的过道，你的视线停在对面牢房里的银白发少女身上。\n\n微弱的晨光从走廊高处的通风口斜斜切进来，正好落在她半边脸颊上。那是一张还带着稚气的脸庞，巴掌大小，樱粉色的挑染发丝顺着耳廓垂落，眼角泛着淡红。\n\n<pic>SFW/艾玛/慌乱2</pic>\n\n就在这时，墙上的电视屏幕“滋啦”一声亮起雪花，刺眼的白光瞬间照亮了整间牢房。一只戴着兜帽的白猫头鹰出现在画面里，歪着脑袋打哈欠。\n</now_plot>`;
    const options = { userPrompt: '盯着艾玛精致的侧脸', targetAliases: ['樱羽艾玛', '艾玛'] };

    // Bare <pic>path</pic> is stripped in closedParagraphs and narrative
    const cp = closedParagraphs(story + '\n\n未完');
    assert.ok(!cp.some((p) => p.includes('SFW/艾玛')));

    // Early checkpoint AND settled shots both choose Paragraph 1 (Emma's sunlit side profile) over Paragraph 2 (TV owl)
    const early = shots(story, true, options);
    assert.equal(early.length, 1);
    assert.equal(early[0].index, 1);
    assert.match(early[0].part, /落在她半边脸颊上/);

    const settled = shots(story, false, options);
    assert.equal(settled[0].index, 1);
    assert.match(settled[0].part, /落在她半边脸颊上/);

    // Pronoun coreference resolves Emma + her reference from userPrompt + surrounding context
    const bible = visualBible(
        [],
        early[0].part,
        {},
        ['樱羽艾玛', '艾玛', '典狱长'],
        {},
        [
            {
                name: '樱羽艾玛',
                aliases: ['艾玛'],
                traits: '银白发，樱粉色挑染，樱粉色眼睛',
                references: [{ ref: { source: 'card.asset', characterId: 'maho', assetId: 'ca_emma' }, confidence: 0.94, origin: 'remote-card' }],
            },
            {
                name: '典狱长',
                aliases: [],
                traits: '兜帽白猫头鹰',
                references: [{ ref: { source: 'card.asset', characterId: 'maho', assetId: 'ca_owl' }, confidence: 0.94, origin: 'remote-card' }],
            },
        ],
        '',
        '盯着艾玛精致的侧脸\n隔着冰冷的铁栅栏和幽暗的过道，你的视线停在对面牢房里的银白发少女身上。',
    );
    assert.equal(bible.actors.length, 1);
    assert.equal(bible.actors[0].name, '樱羽艾玛');
    assert.deepEqual(bible.actors[0].reference, { source: 'card.asset', characterId: 'maho', assetId: 'ca_emma' });
});

test('prevents cross-character alias/trait/ref leakage on duplicate worldbooks, expands <pic> SFW templates, and forwards priorReplyActors', async () => {
    const sharedBookEntries = [
        {
            id: 'e-emma',
            uid: 1,
            keys: ['樱羽', '艾玛'],
            comment: '1️⃣角色详情 - 艾玛',
            content: [
                '---',
                '角色详情:',
                '  樱羽艾玛:',
                '    chinese_name: 樱羽艾玛',
                '    age: 15岁',
                '    appearance:',
                '      basic_info: 身高: 156cm 体重: 48kg',
                '      hair: 银白色为基底，带有樱粉色挑染',
                '      eyes: 明亮的樱粉色',
                '      outfit: 上装: 白色灯笼袖衬衫外罩黑色无袖长马甲 下装: 白色褶边短裙',
                '    social_connections:',
                '      二阶堂希罗: 童年好友',
            ].join('\n'),
            enabled: true,
            disabled: false,
            constant: false,
            selective: false,
            order: 1,
            position: 'before_char',
        },
        {
            id: 'e-hiro',
            uid: 2,
            keys: ['二阶堂', '希罗'],
            comment: '1️⃣角色详情 - 希罗',
            content: [
                '---',
                '角色详情:',
                '  二阶堂希罗:',
                '    chinese_name: 二阶堂希罗',
                '    age: 15岁',
                '    appearance:',
                '      basic_info: 身高: 157cm 体重: 50kg',
                '      hair: 乌黑亮泽的长发，左侧红色大丽花头饰',
                '      eyes: 深红色',
                '      outfit: 上装: 黑底红边的制服风长外套，白衬衫配红黑格纹领带',
            ].join('\n'),
            enabled: true,
            disabled: false,
            constant: false,
            selective: false,
            order: 2,
            position: 'before_char',
        },
        {
            id: 'e-rule',
            uid: 3,
            keys: ['樱羽', '艾玛', '二阶堂', '希罗', '雪莉', '夏目', '安安'],
            comment: '⚙插画插入[mvu_plot]',
            content: '<插图插入任务规则>\nrule: 根据出场角色从列表选择插图\n</插图插入任务规则>',
            enabled: true,
            disabled: false,
            constant: false,
            selective: false,
            order: 3,
            position: 'before_char',
        },
        {
            id: 'e-pic-emma',
            uid: 4,
            keys: ['樱羽', '艾玛'],
            comment: '插画 - 艾玛[mvu_plot]',
            content: JSON.stringify({
                '艾玛_SFW场景才能用的图片，色情场景不可使用': [
                    '艾玛/不好意思{{roll: d3}}',
                    '艾玛/通常{{roll: d5}}',
                    '艾玛/高兴{{roll: d3}}',
                ],
                '艾玛_只在色情场景时可用的图片': [
                    '艾玛/口交{{roll: d4}}',
                    '艾玛/自慰{{roll: d3}}',
                ],
            }),
            enabled: true,
            disabled: false,
            constant: false,
            selective: false,
            order: 4,
            position: 'before_char',
        },
        {
            id: 'e-pic-hiro',
            uid: 5,
            keys: ['二阶堂', '希罗'],
            comment: '插画 - 希罗[mvu_plot]',
            content: JSON.stringify({
                '希罗_SFW场景才能用的图片，色情场景不可使用': [
                    '希罗/不好意思{{roll: d3}}',
                    '希罗/通常{{roll: d5}}',
                ],
                '希罗_只在色情场景时可用的图片': [
                    '希罗/口交{{roll: d5}}',
                ],
            }),
            enabled: true,
            disabled: false,
            constant: false,
            selective: false,
            order: 5,
            position: 'before_char',
        },
        {
            id: 'e-map',
            uid: 6,
            keys: ['B1F'],
            comment: '地图 - B1F',
            content: '![](https://r2-proxy.saugrodep.workers.dev/b/moshen/profile/Map_B1F.png)',
            enabled: true,
            disabled: false,
            constant: false,
            selective: false,
            order: 6,
            position: 'before_char',
        },
    ];

    const mahoCard = {
        id: 'card-maho',
        name: '魔法少女的扣扣审判1.11',
        description: '群像悬疑推理故事',
        firstMessage: '![wallpaper](https://r2-proxy.saugrodep.workers.dev/b/moshen/%E5%A3%81%E7%BA%B8/%E5%B8%8C%E7%BD%976.webp)\n<pic>SFW/艾玛/害怕3</pic>',
        alternateGreetings: [],
        characterVersion: '1.1',
        avatar: '',
        personality: '',
        scenario: '',
        mesExample: '',
        systemPrompt: '',
        postHistoryInstructions: '',
        creatorNotes: '',
        tags: [],
        regexScripts: [
            {
                id: 'cg',
                scriptName: '[CG渲染]',
                findRegex: '/<pic>(.*?)<\\/pic>/gi',
                replaceString: '<div class="cg-container"><img class="cg-image" src="https://r2-proxy.saugrodep.workers.dev/b/moshen/$1.webp" alt="$1" /></div>',
                placement: ['ai_output'],
            },
        ],
    };

    // Pass duplicate worldbooks (mimicking embeddedLorebook + linked worldbook)
    const idx = buildCardVisualIndex(
        mahoCard,
        [{ id: 'wb1', name: '扣扣审判1.1', entries: sharedBookEntries }, { id: 'wb2', name: '扣扣审判1.1', entries: sharedBookEntries }],
        null,
    );

    const emma = idx.characters.find((c) => c.name === '樱羽艾玛');
    const hiro = idx.characters.find((c) => c.name === '二阶堂希罗');
    assert.ok(emma && hiro, 'clean canonical character names extracted');
    assert.ok(!emma.aliases.includes('希罗') && !emma.aliases.includes('二阶堂'));
    assert.match(emma.traits, /白色灯笼袖衬衫/);
    assert.doesNotMatch(emma.traits, /红黑格纹领带|黑底红边/);
    assert.match(hiro.traits, /红黑格纹领带/);
    assert.ok(!idx.characters.some((c) => c.name === 'B1F'));

    const emmaUrls = emma.references.map((r) => decodeURIComponent(idx.assetsById.get(r.ref.assetId)?.url ?? ''));
    const hiroUrls = hiro.references.map((r) => decodeURIComponent(idx.assetsById.get(r.ref.assetId)?.url ?? ''));
    assert.equal(emmaUrls[0], 'https://r2-proxy.saugrodep.workers.dev/b/moshen/SFW/艾玛/通常1.webp');
    assert.equal(hiroUrls[0], 'https://r2-proxy.saugrodep.workers.dev/b/moshen/SFW/希罗/通常1.webp');
    assert.ok(emmaUrls.every((u) => !u.includes('希罗')));
    assert.ok(hiroUrls.some((u) => u.includes('壁纸/希罗6.webp')));

    for (const asset of idx.assetsById.values()) {
        const decoded = decodeURIComponent(asset.url ?? '');
        assert.ok(!/NSFW|口交|自慰|只在色情|Map_B1F/i.test(decoded), `unexpected asset: ${decoded}`);
    }

    let capturedBrief = '';
    const plan = await direct(
        {
            models: {
                start: async (req) => {
                    capturedBrief = req.messages.find((m) => m.role === 'user')?.content ?? '';
                    return 't-cons';
                },
            },
            tasks: {
                await: async () => ({
                    result: {
                        kind: 'chat',
                        text: JSON.stringify({
                            caption: '暗廊微光',
                            prompt: 'Prison corridor scene',
                            aspectRatio: '3:2',
                            palette: ['#1a1d24', '#e89bb0'],
                            actors: [{ name: '樱羽艾玛', prompt: 'white puff-sleeve blouse, black vest', x: 0.5, y: 0.48 }],
                        }),
                    },
                }),
            },
        },
        [{ id: 'chat-1', kinds: ['chat'] }],
        {
            scene: '艾玛小跑着穿过走廊。',
            layoutMode: 'tipsy-bubble',
            actors: [{ name: '樱羽艾玛', prompt: '樱羽艾玛' }],
            ledger: {},
            prior: '',
            framing: 'solo portrait',
            priorReplyActors: { '樱羽艾玛': 'white puff-sleeve blouse, black sleeveless long vest' },
        },
    );
    assert.match(capturedBrief, /"priorReplyActors":\{"樱羽艾玛":"white puff-sleeve blouse/);
    assert.equal(plan.actors[0].name, '樱羽艾玛');
});

test('in-sandbox anchor finder locates full-HTML narrative blocks and rejects small widgets; latentFilm supports live multi-slot reveals', () => {
    const makeEl = (id, text, children = []) => {
        const el = {
            id,
            hidden: false,
            textContent: text,
            children,
            parentElement: null,
            closest: () => null,
            contains: (other) => other === el || children.some((c) => c.contains(other)),
        };
        for (const c of children) c.parentElement = el;
        return el;
    };

    const p0 = makeEl('p0', '铁门解锁的轻响在石砌过道里散开。');
    const p1 = makeEl('p1', '清晨微弱的光线斜斜切进牢房，恰好落在银白发少女的侧脸上。黑色贝雷帽上的白色樱花轻轻颤动。');
    const p2 = makeEl('p2', '**{艾玛}**「啊、那个……早、早安！」');
    const readingContent = makeEl('readingContent', `${p0.textContent}\n${p1.textContent}\n${p2.textContent}`, [p0, p1, p2]);
    const container = makeEl('grimoire', readingContent.textContent, [readingContent]);

    const proseDoc = {
        body: {
            textContent: container.textContent,
            querySelectorAll: () => [container, readingContent, p0, p1, p2],
        },
    };
    const hit1 = findSandboxParagraphAnchor(proseDoc, { kind: 'paragraph', index: 1, excerpt: '清晨微弱的光线斜斜切进牢房' });
    assert.equal(hit1?.id, 'p1');
    const hit2 = findSandboxParagraphAnchor(proseDoc, { kind: 'paragraph', index: 2, excerpt: '那个……早、早安' });
    assert.equal(hit2?.id, 'p2');

    // Non-prose widget (status bar) returns null so footer fallback stays outside
    const widgetBox = makeEl('status', '2026-04-01 08:05');
    const widgetDoc = {
        body: {
            textContent: widgetBox.textContent,
            querySelectorAll: () => [widgetBox],
        },
    };
    assert.equal(findSandboxParagraphAnchor(widgetDoc, { kind: 'paragraph', index: 1, excerpt: '清晨微弱的光线斜斜切进牢房' }), null);

    // Sandbox mounted store tracking
    setSandboxMountedMedia('m1', 'frame-a', ['k1', 'k2']);
    assert.equal(getSandboxMountedKeys(sandboxMediaStore.getState().byFrame, 'm1').has('k1'), true);
    clearSandboxMountedMedia('frame-a');
    assert.equal(getSandboxMountedKeys(sandboxMediaStore.getState().byFrame, 'm1').size, 0);

    // Multi-slot latentFilm + live streaming ready update
    const controller = new AbortController();
    const completion = new Promise(() => {});
    const draft = { messageId: 'draft-1', swipeId: 'draft-1:0', floor: 2 };
    developPreview(
        { id: 'cp1', generationId: 'draft-1', route: { chatId: 'c', routeId: 'r' }, draft, settledText: 'p1', paragraphCount: 1, kind: 'normal' },
        'dev.tipsy-isle.lumina-director',
        'digest-1',
        { slotId: 'shot-0', label: 'p1', aspectRatio: '3:2', anchor: { kind: 'paragraph', index: 1, excerpt: 'p1' } },
        completion,
        controller.signal,
    );
    developPreview(
        { id: 'cp2', generationId: 'draft-1', route: { chatId: 'c', routeId: 'r' }, draft, settledText: 'p1\n\np8', paragraphCount: 8, kind: 'normal' },
        'dev.tipsy-isle.lumina-director',
        'digest-1',
        { slotId: 'shot-1', label: 'p8', aspectRatio: '3:2', anchor: { kind: 'paragraph', index: 8, excerpt: 'p8' } },
        completion,
        controller.signal,
    );
    assert.equal(latentFilm.getState().items.length, 2);

    const readyMediaId = crypto.randomUUID();
    updateJobPreview(
        'draft-1',
        'dev.tipsy-isle.lumina-director',
        'digest-1',
        {
            slotId: 'shot-0',
            status: 'ready',
            label: '晨光侧颜',
            aspectRatio: '3:2',
            anchor: { kind: 'paragraph', index: 1, excerpt: 'p1' },
            takes: [{ id: readyMediaId, createdAt: 1000, prompt: 'portrait' }],
            activeTake: 0,
        },
        completion,
        controller.signal,
        draft,
    );
    const items = latentFilm.getState().items;
    assert.equal(items.length, 2);
    const s0 = items.find((i) => i.item.slotId === 'shot-0');
    const s1 = items.find((i) => i.item.slotId === 'shot-1');
    assert.equal(s0?.item.status, 'ready');
    assert.equal(s0?.item.takes?.[0]?.id, readyMediaId);
    assert.equal(s1?.item.status, 'developing');
    controller.abort();
});

test('filmGeometry skips CoT/header frames, anchors inside matching story iframe, and translates coordinates', (t) => {
    const prevDoc = globalThis.document;
    const prevWin = globalThis.window;
    const prevRO = globalThis.ResizeObserver;
    const prevInnerH = globalThis.innerHeight;
    const prevInnerW = globalThis.innerWidth;
    t.after(() => {
        globalThis.document = prevDoc;
        globalThis.window = prevWin;
        globalThis.ResizeObserver = prevRO;
        globalThis.innerHeight = prevInnerH;
        globalThis.innerWidth = prevInnerW;
    });

    const childNodes = [];
    const makeChildEl = (text, rect, ignored = false) => {
        const el = {
            hidden: false,
            isConnected: true,
            className: '',
            style: { cssText: '' },
            textContent: text,
            nextElementSibling: null,
            parentElement: null,
            parentNode: { nodeType: 1 },
            ownerDocument: null,
            closest: () => (ignored ? {} : null),
            contains: (o) => o === el,
            setAttribute: () => {},
            remove: () => { el.isConnected = false; },
            getBoundingClientRect: () => rect,
            after: (inserted) => {
                inserted.isConnected = true;
                el.nextElementSibling = inserted;
            },
        };
        return el;
    };

    // Frame 0: CoT/draft/clock header frame (3+ paragraphs, >200 chars, loaded BEFORE story frame)
    const d0 = makeChildEl('思维链 / THOUGHT PROCESS：距离上次正文的时空间变化与评分规则对齐说明文本超过二十个字。', { top: 10, left: 10, width: 700, height: 30 });
    const d1 = makeChildEl('本轮地点一楼会客厅，时间为08:50，安排人物出场与氛围营造。', { top: 50, left: 10, width: 700, height: 30 });
    const d2 = makeChildEl('保持第二人称日轻风格输出，并避免多余心理评价或设定剧透。', { top: 90, left: 10, width: 700, height: 30 });
    const draftDoc = {
        body: {
            textContent: `${d0.textContent}\n${d1.textContent}\n${d2.textContent}`,
            querySelector: (sel) => (sel.includes('.stthink') ? d0 : null),
            querySelectorAll: () => [d0, d1, d2],
            getBoundingClientRect: () => ({ height: 220 }),
        },
        createElement: () => makeChildEl('', { top: 0, left: 0, width: 0, height: 0 }),
        contains: (el) => el === d0 || el === d1 || el === d2,
    };
    const draftFrame = {
        isConnected: true,
        contentDocument: draftDoc,
        getBoundingClientRect: () => ({ top: 40, left: 24, width: 740, height: 220 }),
    };

    // Frame 1: Story frame with 正文美化 content and collapsed hidden node containing substring
    const hiddenSpoiler = makeChildEl('白猫头鹰在长桌沿上抖了抖圆滚滚的身子', { top: 0, left: 0, width: 0, height: 0 }, true);
    const p0 = makeChildEl('第一段开场描写。', { top: 20, left: 10, width: 700, height: 40 });
    const p1 = makeChildEl('白猫头鹰在长桌沿上抖了抖圆滚滚的身子，几片细小的绒羽顺着灯光飘落。', { top: 80, left: 10, width: 700, height: 48 });
    const p2 = makeChildEl('众人都停下交谈望过去。', { top: 150, left: 10, width: 700, height: 32 });
    const childDoc = {
        body: {
            textContent: `${p0.textContent}\n${p1.textContent}\n${p2.textContent}`,
            querySelector: () => null,
            querySelectorAll: () => [hiddenSpoiler, p0, p1, p2],
            getBoundingClientRect: () => ({ height: 900 }),
        },
        createElement: () => {
            const slotEl = makeChildEl('', { top: 136, left: 16, width: 680, height: 453 });
            slotEl.ownerDocument = childDoc;
            childNodes.push(slotEl);
            return slotEl;
        },
        contains: (el) => el === p0 || el === p1 || el === p2 || childNodes.includes(el),
    };
    p0.ownerDocument = childDoc;
    p1.ownerDocument = childDoc;
    p2.ownerDocument = childDoc;

    const childFrame = {
        isConnected: true,
        contentDocument: childDoc,
        getBoundingClientRect: () => ({ top: 120, left: 24, width: 740, height: 900 }),
    };
    const mesBody = {
        querySelector: () => null,
        querySelectorAll: (sel) => (sel === 'iframe.compat-message-frame' ? [draftFrame, childFrame] : []),
        contains: () => false,
    };
    const article = {
        dataset: { readingSwipe: 's6' },
        querySelector: () => mesBody,
    };

    globalThis.innerWidth = 900;
    globalThis.innerHeight = 800;
    globalThis.ResizeObserver = class { observe() {} unobserve() {} };
    globalThis.window = { addEventListener() {} };
    globalThis.document = {
        documentElement: {},
        elementFromPoint: () => null,
        createElement: () => makeChildEl('', { top: 0, left: 0, width: 0, height: 0 }),
    };

    let emitted = [];
    const films = filmGeometry((id) => (id === 'msg6' ? article : undefined), (rects) => { emitted = rects; });
    films.sync([
        {
            key: 'slot6-0',
            message: 'msg6',
            swipe: 's6',
            anchor: { kind: 'paragraph', index: 0, excerpt: '白猫头鹰在长桌沿上抖了抖圆滚滚的身子' },
            ratio: '3:2',
            folded: false,
        },
    ]);

    assert.equal(d0.nextElementSibling, null);
    assert.equal(hiddenSpoiler.nextElementSibling, null);
    assert.ok(p1.nextElementSibling, 'placeholder inserted immediately after matching paragraph inside story child iframe');
    assert.equal(p1.nextElementSibling.className, 'compat-native-media-slot');
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].key, 'slot6-0');
    assert.equal(emitted[0].top, 256); // 120 (story frame.top) + 136 (inner.top)
    assert.equal(emitted[0].left, 40); // 24 (story frame.left) + 16 (inner.left)
    assert.equal(emitted[0].width, 680);
    assert.equal(emitted[0].height, 453);
});

test('浮光 manifest rename and strict pacing & daily_limit enforcement across checkpoint, replySaved, and job', async () => {
    const { readFileSync } = await import('node:fs');
    const manifest = JSON.parse(readFileSync('examples/plugins/lumina-director/manifest.json', 'utf8'));
    assert.equal(manifest.name, '浮光');
    assert.equal(manifest.publisher, '微醺屿');
    assert.ok(!manifest.publisher.includes('示例'));

    const bundle = await build({
        entryPoints: ['examples/plugins/lumina-director/main.ts'],
        bundle: true,
        platform: 'node',
        format: 'esm',
        write: false,
    });
    const { default: plugin } = await import(
        `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`
    );

    const route = { chatId: 'story-pacing', routeId: 'route-1' };
    const localDay = () => {
        const d = new Date();
        return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
    };

    function createHarness({
        pacing = 'balanced',
        dailyLimit = 24,
        usedToday = 0,
        lastIllustratedFloor,
        pendingIllustratedFloor,
        history = [],
        replyValuesByMsg = {},
    }) {
        const scheduled = [];
        const developing = [];
        const startedModels = [];
        const routeValues = {
            ...(lastIllustratedFloor !== undefined ? { lastIllustratedFloor } : {}),
            ...(pendingIllustratedFloor !== undefined ? { pendingIllustratedFloor } : {}),
        };
        const deviceValues = usedToday > 0 ? { dailyUsage: { day: localDay(), count: usedToday } } : {};

        const api = {
            context: { route },
            settings: {
                enabled: true,
                saved_only: false,
                pacing,
                daily_limit: dailyLimit,
                presentation_mode: 'auto',
            },
            story: {
                participants: async () => [],
                visualSources: async () => ({
                    characterId: 'c1',
                    layoutMode: 'novel-reader',
                    people: [],
                    profiles: {},
                    gallery: [],
                    characters: [],
                }),
                readMessages: async () => ({ messages: history, nextBefore: null }),
                getMessage: async (ref) => {
                    const hit = history.find((m) => m.ref.messageId === ref.messageId);
                    return hit ?? null;
                },
                state: async () => ({ value: null }),
            },
            media: {
                stats: async () => ({ bytes: 0, items: 0, totalLimit: 1e9, maxItems: 2048 }),
            },
            jobs: {
                schedule: async (input) => {
                    scheduled.push(input);
                    return `job-${scheduled.length}`;
                },
            },
            replyMedia: {
                developing: async (item) => {
                    developing.push(item);
                },
            },
            models: {
                connections: async () => [{ id: 'img-1', kinds: ['image'] }],
                start: async (req) => {
                    startedModels.push(req);
                    return `task-${startedModels.length}`;
                },
            },
            tasks: {
                await: async () => ({
                    result: { kind: 'image', media: { id: crypto.randomUUID() }, seed: 11 },
                }),
            },
            storage: {
                read: async (scope) => ({
                    version: 1,
                    values: scope === 'device' ? deviceValues : routeValues,
                }),
                patch: async (scope, patch) => {
                    const target = scope === 'device' ? deviceValues : routeValues;
                    Object.assign(target, patch.set ?? {});
                },
                readAt: async ({ reply }) => ({
                    version: 0,
                    values: reply ? (replyValuesByMsg[reply.messageId] ?? {}) : routeValues,
                }),
                patchAt: async ({ reply, patch }) => {
                    if (reply) {
                        replyValuesByMsg[reply.messageId] = {
                            ...(replyValuesByMsg[reply.messageId] ?? {}),
                            ...patch.set,
                        };
                    } else {
                        Object.assign(routeValues, patch.set ?? {});
                    }
                },
            },
            index: { search: async () => [], put: async () => {} },
        };
        return { api, scheduled, developing, startedModels, routeValues, replyValuesByMsg };
    }

    const mkMsg = (floor, role, text) => ({
        ref: { messageId: `m${floor}`, swipeId: `s${floor}`, revision: `r${floor}` },
        floor,
        role,
        speaker: role === 'user' ? '你' : '林汐',
        text,
        truncated: false,
        createdAt: floor,
        hidden: false,
        settled: true,
    });

    const dramaticText = '林汐推开木门，暴雨骤至，闪电划破夜空。';
    const longDramaticText =
        '林汐推开木门，暴雨骤至。\n\n' +
        '雨声敲打着长廊的瓦片。'.repeat(120) +
        '\n\n翌日清晨，她再次推开木门，微光落在窗台上。';

    // 1. balanced: floor 2 illustrated -> floor 4 blocked in BOTH early checkpoint & replySaved; floor 6 allowed
    {
        const h4 = createHarness({
            pacing: 'balanced',
            lastIllustratedFloor: 2,
            history: [mkMsg(0, 'assistant', '开场'), mkMsg(1, 'user', '走吧'), mkMsg(2, 'assistant', dramaticText), mkMsg(3, 'user', '继续')],
        });
        await plugin.onReplyCheckpoint(h4.api, {
            id: 'cp-4',
            generationId: 'm4',
            route,
            draft: { messageId: 'm4', swipeId: 's4', floor: 4 },
            settledText: `${dramaticText}\n\n`,
            paragraphCount: 1,
            kind: 'normal',
        });
        assert.equal(h4.scheduled.length, 0);
        assert.equal(h4.developing.length, 0);

        const h4Saved = createHarness({
            pacing: 'balanced',
            lastIllustratedFloor: 2,
            history: [
                mkMsg(0, 'assistant', '开场'),
                mkMsg(1, 'user', '走吧'),
                mkMsg(2, 'assistant', dramaticText),
                mkMsg(3, 'user', '继续'),
                mkMsg(4, 'assistant', dramaticText),
            ],
        });
        await plugin.onReplySaved(h4Saved.api, { id: 'rs-4', reply: mkMsg(4, 'assistant', dramaticText).ref, kind: 'normal' });
        assert.equal(h4Saved.scheduled.length, 0);

        const h6 = createHarness({
            pacing: 'balanced',
            lastIllustratedFloor: 2,
            history: [
                mkMsg(0, 'assistant', '开场'),
                mkMsg(1, 'user', '走吧'),
                mkMsg(2, 'assistant', dramaticText),
                mkMsg(3, 'user', '继续'),
                mkMsg(4, 'assistant', '平淡过渡'),
                mkMsg(5, 'user', '接着呢'),
            ],
        });
        await plugin.onReplyCheckpoint(h6.api, {
            id: 'cp-6',
            generationId: 'm6',
            route,
            draft: { messageId: 'm6', swipeId: 's6', floor: 6 },
            settledText: `${dramaticText}\n\n`,
            paragraphCount: 1,
            kind: 'normal',
        });
        assert.equal(h6.scheduled.length, 1);
        assert.equal(h6.developing.length, 1);
    }

    // 2. restrained: skips 3 assistant replies (4, 6, 8 blocked; 10 allowed) and caps to 1 auto-shot on >1800-char replies
    {
        const baseHistory = [
            mkMsg(0, 'assistant', '开场'),
            mkMsg(1, 'user', 'u1'),
            mkMsg(2, 'assistant', dramaticText),
            mkMsg(3, 'user', 'u3'),
            mkMsg(4, 'assistant', 'a4'),
            mkMsg(5, 'user', 'u5'),
            mkMsg(6, 'assistant', 'a6'),
            mkMsg(7, 'user', 'u7'),
            mkMsg(8, 'assistant', 'a8'),
            mkMsg(9, 'user', 'u9'),
        ];
        for (const floor of [4, 6, 8]) {
            const blocked = createHarness({
                pacing: 'restrained',
                lastIllustratedFloor: 2,
                history: baseHistory.filter((m) => m.floor < floor),
            });
            await plugin.onReplyCheckpoint(blocked.api, {
                id: `cp-${floor}`,
                generationId: `m${floor}`,
                route,
                draft: { messageId: `m${floor}`, swipeId: `s${floor}`, floor },
                settledText: `${dramaticText}\n\n`,
                paragraphCount: 1,
                kind: 'normal',
            });
            assert.equal(blocked.scheduled.length, 0, `restrained must block floor ${floor}`);
        }

        const allowed10 = createHarness({
            pacing: 'restrained',
            lastIllustratedFloor: 2,
            history: [...baseHistory, mkMsg(10, 'assistant', longDramaticText)],
        });
        await plugin.onReplyCheckpoint(allowed10.api, {
            id: 'cp-10-mid',
            generationId: 'm10',
            route,
            draft: { messageId: 'm10', swipeId: 's10', floor: 10 },
            settledText: longDramaticText,
            paragraphCount: 8,
            kind: 'normal',
        });
        assert.equal(allowed10.scheduled.length, 0, 'restrained must not schedule second mid-stream shot');

        await plugin.onReplySaved(allowed10.api, { id: 'rs-10', reply: mkMsg(10, 'assistant', longDramaticText).ref, kind: 'normal' });
        assert.equal(allowed10.scheduled.length, 1, 'restrained caps long replies to 1 auto-shot');
    }

    // 3. dense: floor 2 illustrated -> floor 4 allowed
    {
        const hDense = createHarness({
            pacing: 'dense',
            lastIllustratedFloor: 2,
            history: [mkMsg(0, 'assistant', '开场'), mkMsg(1, 'user', 'u1'), mkMsg(2, 'assistant', dramaticText), mkMsg(3, 'user', 'u3')],
        });
        await plugin.onReplyCheckpoint(hDense.api, {
            id: 'cp-dense-4',
            generationId: 'm4',
            route,
            draft: { messageId: 'm4', swipeId: 's4', floor: 4 },
            settledText: `${dramaticText}\n\n`,
            paragraphCount: 1,
            kind: 'normal',
        });
        assert.equal(hDense.scheduled.length, 1);
    }

    // 4. markers_only: prose blocked, explicit <pic prompt="..."> allowed
    {
        const hMarkers = createHarness({ pacing: 'markers_only', history: [] });
        await plugin.onReplyCheckpoint(hMarkers.api, {
            id: 'cp-m1',
            generationId: 'm2',
            route,
            draft: { messageId: 'm2', swipeId: 's2', floor: 2 },
            settledText: `${dramaticText}\n\n`,
            paragraphCount: 1,
            kind: 'normal',
        });
        assert.equal(hMarkers.scheduled.length, 0);

        await plugin.onReplyCheckpoint(hMarkers.api, {
            id: 'cp-m2',
            generationId: 'm2',
            route,
            draft: { messageId: 'm2', swipeId: 's2', floor: 2 },
            settledText: '<pic prompt="rainy shrine lantern">\n\n',
            paragraphCount: 1,
            kind: 'normal',
        });
        assert.equal(hMarkers.scheduled.length, 1);
    }

    // 5. daily_limit blocks early checkpoint; in-flight pendingIllustratedFloor blocks next reply; manual reroll/custom bypasses pacing
    {
        const hDaily = createHarness({ pacing: 'dense', dailyLimit: 2, usedToday: 2, history: [] });
        await plugin.onReplyCheckpoint(hDaily.api, {
            id: 'cp-daily',
            generationId: 'm2',
            route,
            draft: { messageId: 'm2', swipeId: 's2', floor: 2 },
            settledText: `${dramaticText}\n\n`,
            paragraphCount: 1,
            kind: 'normal',
        });
        assert.equal(hDaily.scheduled.length, 0);

        const hPending = createHarness({
            pacing: 'balanced',
            pendingIllustratedFloor: { floor: 2, at: Date.now() },
            history: [mkMsg(0, 'assistant', '开场'), mkMsg(1, 'user', 'u1'), mkMsg(2, 'assistant', dramaticText), mkMsg(3, 'user', 'u3')],
        });
        await plugin.onReplyCheckpoint(hPending.api, {
            id: 'cp-pending',
            generationId: 'm4',
            route,
            draft: { messageId: 'm4', swipeId: 's4', floor: 4 },
            settledText: `${dramaticText}\n\n`,
            paragraphCount: 1,
            kind: 'normal',
        });
        assert.equal(hPending.scheduled.length, 0);

        const hManual = createHarness({
            pacing: 'restrained',
            lastIllustratedFloor: 2,
            history: [mkMsg(2, 'assistant', dramaticText), mkMsg(4, 'assistant', dramaticText)],
        });
        await plugin.onJob(hManual.api, {
            id: 'job-reroll',
            key: 'reroll',
            route,
            target: mkMsg(4, 'assistant', dramaticText).ref,
            payload: { scene: dramaticText, slot: 'shot-0', index: 0, floor: 4, isReroll: true },
        });
        assert.equal(hManual.startedModels.length, 1);
    }
});

test('visualBible, shot-director, continuity-ledger, and onJob exclude absent and deceased characters end-to-end', async () => {
    const characters = [
        { name: '樱羽艾玛', aliases: ['艾玛'], traits: '银白发，樱粉色挑染', references: [{ ref: { source: 'card.asset', characterId: 'maho', assetId: 'emma' }, confidence: 0.94, origin: 'remote-card' }] },
        { name: '二阶堂希罗', aliases: ['希罗'], traits: '黑长直发，红瞳', references: [{ ref: { source: 'card.asset', characterId: 'maho', assetId: 'hiro' }, confidence: 0.94, origin: 'remote-card' }] },
        { name: '夏目杏子', aliases: ['杏子'], traits: '金发马尾', references: [{ ref: { source: 'card.asset', characterId: 'maho', assetId: 'anko' }, confidence: 0.94, origin: 'remote-card' }] },
        { name: '橘雪莉', aliases: ['雪莉'], traits: '灰白色短发，蓝瞳', references: [{ ref: { source: 'card.asset', characterId: 'maho', assetId: 'sherry' }, confidence: 0.94, origin: 'remote-card' }] },
    ];

    // 1. Off-screen, remembered, departed, and quote-only mentions are excluded while present actors remain
    assert.equal(isAbsentOrMentionOnly('艾玛一边潜行，一边想起了留在家里的雪莉。', ['雪莉', '橘雪莉']), true);
    assert.equal(isAbsentOrMentionOnly('艾玛说道：「希罗刚才去医务室了。」', ['希罗', '二阶堂希罗']), true);
    assert.equal(isAbsentOrMentionOnly('雪莉不在场，希罗独自守在走廊尽头。', ['雪莉', '橘雪莉']), true);
    assert.equal(isAbsentOrMentionOnly('艾玛独自潜行，雪莉留在了医务室。', ['雪莉'], '雪莉留在了医务室，艾玛独自走向石廊。'), true);
    assert.equal(isAbsentOrMentionOnly('艾玛站在幽暗石廊里，希罗紧跟在她身旁警戒着。', ['希罗']), false);

    const presentBible = visualBible(
        [],
        '艾玛沿着石廊潜行，心想「真希望希罗和雪莉能没事」，唯独杏子并不在这里。',
        { 橘雪莉: { canonicalMediaId: 'm-sherry' } },
        ['樱羽艾玛', '二阶堂希罗', '夏目杏子', '橘雪莉'],
        {},
        characters,
        '',
        '',
        { deceased: ['夏目杏子'] },
    );
    assert.deepEqual(presentBible.actors.map((a) => a.name), ['樱羽艾玛']);

    // 2. direct() trusts parsed.actors omissions & [] rather than re-adding visualBible candidates, and records ledger.deceased
    const directOmit = await direct(
        {
            models: { start: async () => 't-omit' },
            tasks: {
                await: async () => ({
                    result: {
                        kind: 'chat',
                        text: JSON.stringify({
                            caption: '独行石廊',
                            prompt: 'Dim stone corridor, silver-haired girl sneaking alone',
                            aspectRatio: '3:2',
                            palette: ['#181c24', '#c9a66b'],
                            actors: [{ name: '樱羽艾玛', prompt: 'petite, silver hair, walking carefully', x: 0.5, y: 0.5 }],
                            ledger: { location: '地下石廊', deceased: ['夏目杏子'] },
                        }),
                    },
                }),
            },
        },
        [{ id: 'chat-1', kinds: ['chat'] }],
        {
            scene: '艾玛走在石廊里。',
            layoutMode: 'tipsy-bubble',
            actors: [
                { name: '樱羽艾玛', prompt: '樱羽艾玛' },
                { name: '橘雪莉', prompt: '橘雪莉' },
            ],
            ledger: {},
            prior: '',
            framing: 'wide establishing shot',
            replyContext: '艾玛独自离开牢房，橘雪莉被锁在楼上。',
        },
    );
    assert.deepEqual(directOmit.actors.map((a) => a.name), ['樱羽艾玛']);
    assert.ok(directOmit.ledgerPatch?.deceased?.['夏目杏子']);

    const directEmpty = await direct(
        {
            models: { start: async () => 't-empty' },
            tasks: {
                await: async () => ({
                    result: {
                        kind: 'chat',
                        text: JSON.stringify({
                            caption: '空荡牢房',
                            prompt: 'Empty stone prison cell illuminated by a torch',
                            aspectRatio: '3:2',
                            palette: ['#181c24', '#c9a66b'],
                            actors: [],
                        }),
                    },
                }),
            },
        },
        [{ id: 'chat-1', kinds: ['chat'] }],
        {
            scene: '空无一人的牢房里只有火把摇曳。',
            layoutMode: 'tipsy-bubble',
            actors: [{ name: '樱羽艾玛', prompt: '樱羽艾玛' }],
            ledger: {},
            prior: '',
            framing: 'wide establishing shot',
        },
    );
    assert.equal(directEmpty.actors.length, 0);

    // 3. Death tracking, negation guards, revival, floor rewind pruning, MVU, and filterLedgerForShot
    const negRes = extractDeceasedFromText('艾玛差点死了，但其实没有死，假死的杏子也还活着；雪莉被处刑了。', characters);
    assert.deepEqual(negRes.deceased, ['橘雪莉']);
    assert.ok(negRes.revived.includes('夏目杏子'));

    const mvuRes = extractDeceasedFromMvu({ 角色状态: { 希罗: { 存活: false }, 艾玛: { status: 'alive' } }, 死亡名单: ['夏目杏子'] }, characters);
    assert.deepEqual(mvuRes.deceased.sort(), ['二阶堂希罗', '夏目杏子'].sort());
    assert.deepEqual(mvuRes.revived, ['樱羽艾玛']);

    const prevWithCast = {
        location: '大厅',
        cast: {
            '樱羽艾玛': { outfit: '学院制服' },
            '夏目杏子': { outfit: '红色披风' },
            '橘雪莉': { outfit: '白大褂' },
        },
        deceased: { '夏目杏子': { floor: 4, reason: 'story' } },
    };
    const rewound = pruneLedgerForFloor(prevWithCast, 2);
    assert.equal(rewound.deceased['夏目杏子'], undefined);

    const updatedLedger = continuity('艾玛推开门。', prevWithCast, undefined, ['樱羽艾玛'], {
        floor: 6,
        knownCharacters: characters,
        recentTexts: [{ floor: 5, text: '橘雪莉已经在上一层遇害身亡。' }],
    });
    assert.equal(updatedLedger.cast['夏目杏子'], undefined);
    assert.equal(updatedLedger.cast['橘雪莉'], undefined);
    assert.ok(updatedLedger.deceased['橘雪莉']);
    const shotLedger = filterLedgerForShot(
        { ...updatedLedger, cast: { '樱羽艾玛': { outfit: '制服' }, '二阶堂希罗': { outfit: '大衣' } }, variables: 'secret' },
        ['樱羽艾玛'],
    );
    assert.deepEqual(Object.keys(shotLedger.cast), ['樱羽艾玛']);
    assert.equal(shotLedger.variables, undefined);
    assert.equal(shotLedger.deceased, undefined);

    // 4. extractShotFromReply strips <details> and <UpdateVariable> metadata
    const noisyReply = `<details><summary>摘要</summary>雪莉、希罗、杏子都在状态栏</details>\n<UpdateVariable>{"希罗":"在隔壁"}</UpdateVariable>\n\n<now_plot>\n艾玛推开沉重的铁门，月光洒在她银白色的发梢上。\n</now_plot>`;
    const cleanShot = extractShotFromReply(noisyReply);
    assert.ok(!cleanShot.scene.includes('摘要'));
    assert.ok(!cleanShot.scene.includes('UpdateVariable'));
    assert.match(cleanShot.scene, /艾玛推开沉重的铁门/);

    // 5. End-to-end plugin onJob test: character killed in an un-illustrated turn is purged from castRegistry & omitted
    const bundle = await build({
        entryPoints: ['examples/plugins/lumina-director/main.ts'],
        bundle: true,
        platform: 'node',
        format: 'esm',
        write: false,
    });
    const { default: plugin } = await import(
        `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`
    );

    const route = { chatId: 'story-death-e2e', routeId: 'route-1' };
    const imageJobs = [];
    const indexedDocs = [];
    const routeValues = {
        castRegistry: { '樱羽艾玛': { canonicalMediaId: 'img-emma' }, '夏目杏子': { canonicalMediaId: 'img-anko' } },
        ledger: {
            location: '审判庭',
            cast: { '樱羽艾玛': { outfit: '制服' }, '夏目杏子': { outfit: '披风' } },
        },
    };
    const msg4 = {
        ref: { chatId: 'story-death-e2e', routeId: 'route-1', messageId: 'm4', swipeId: 's4', revision: 'r4' },
        floor: 4,
        role: 'assistant',
        hidden: false,
        settled: true,
        text: '上一轮中，夏目杏子已经被处刑，彻底死去了。',
        truncated: false,
    };
    const msg6 = {
        ref: { chatId: 'story-death-e2e', routeId: 'route-1', messageId: 'm6', swipeId: 's6', revision: 'r6' },
        floor: 6,
        role: 'assistant',
        hidden: false,
        settled: true,
        text: '艾玛站在石廊中，脑海中浮现出夏目杏子与橘雪莉的名字，而橘雪莉其实还在楼上休息。',
        truncated: false,
    };

    const e2eApi = {
        context: { route },
        settings: { enabled: true, pacing: 'dense' },
        story: {
            participants: async () => [],
            visualSources: async () => ({
                characterId: 'maho',
                layoutMode: 'novel-reader',
                people: ['樱羽艾玛', '夏目杏子', '橘雪莉'],
                profiles: {},
                gallery: [],
                characters,
            }),
            readMessages: async () => ({ messages: [msg4, msg6], nextBefore: null }),
            getMessage: async () => msg6,
            state: async () => ({ value: null }),
        },
        media: { stats: async () => ({ bytes: 0, items: 0, totalLimit: 1e9, maxItems: 2048 }) },
        jobs: { schedule: async () => 'j1' },
        replyMedia: { developing: async () => {} },
        models: {
            connections: async () => [{ id: 'img-1', kinds: ['image'] }],
            start: async (req) => {
                imageJobs.push(req);
                return 'img-task-1';
            },
        },
        tasks: {
            await: async () => ({ result: { kind: 'image', media: { id: 'img-out-1' }, seed: 42 } }),
        },
        storage: {
            read: async () => ({ version: 1, values: routeValues }),
            patch: async (_scope, p) => Object.assign(routeValues, p.set ?? {}),
            readAt: async ({ reply }) => ({ version: 0, values: reply ? {} : routeValues }),
            patchAt: async ({ reply, patch }) => { if (!reply) Object.assign(routeValues, patch.set ?? {}); },
        },
        index: {
            search: async () => [{
                id: 'old-scene',
                excerpt: '此前夏目杏子还在走廊',
                value: { mediaId: 'old-anko-scene', route: `${route.chatId}/${route.routeId}`, actors: ['夏目杏子'] },
            }],
            put: async ({ documents }) => { indexedDocs.push(...documents); },
        },
    };

    await plugin.onJob(e2eApi, {
        id: 'job-e2e-death',
        key: 'k1',
        route,
        target: msg6.ref,
        payload: {
            scene: msg6.text,
            replyText: msg6.text,
            index: 0,
            slot: 'shot-0',
            floor: 6,
        },
    });

    assert.equal(imageJobs.length, 1);
    assert.deepEqual(imageJobs[0].actors.map((a) => a.name), ['樱羽艾玛']);
    assert.equal(imageJobs[0].references, undefined, 'recalled scene depicting deceased actor must not be reused');
    assert.equal(routeValues.castRegistry['夏目杏子'], undefined, 'deceased actor must be removed from castRegistry');
    assert.equal(routeValues.ledger.cast['夏目杏子'], undefined, 'deceased actor must be removed from ledger.cast');
    assert.ok(routeValues.ledger.deceased['夏目杏子'], 'deceased actor recorded in ledger.deceased');
    assert.deepEqual(indexedDocs[0].value.actors, ['樱羽艾玛']);

    // 6. studio & darkroom panels conform to host panelSchema rules (lowercase field IDs, <=16 blocks, valid select initial)
    const smallIdRe = /^[a-z][a-z0-9_-]{0,63}$/;
    const reply6Media = [
        {
            slotId: 'shot-0',
            status: 'ready',
            aspectRatio: '4:3',
            takes: [{ id: 'media-1', seed: 123, createdAt: 1, prompt: 'x'.repeat(4500) }],
            activeTake: 0,
        },
    ];
    const scheduledPanelJobs = [];
    const manyMessages = Array.from({ length: 16 }, (_, idx) => ({
        ref: { chatId: route.chatId, routeId: route.routeId, messageId: `m-${idx}`, swipeId: 's0', revision: 'r0' },
        floor: idx,
        role: 'assistant',
        hidden: false,
        settled: true,
        text: `第 ${idx} 楼剧情`,
        truncated: false,
    }));
    const panelApi = {
        ...e2eApi,
        story: {
            ...e2eApi.story,
            readMessages: async () => ({ messages: manyMessages, nextBefore: null }),
            getMessage: async () => msg6,
        },
        jobs: {
            schedule: async (input) => {
                scheduledPanelJobs.push(input);
                return 'j-panel';
            },
        },
        storage: {
            ...e2eApi.storage,
            readAt: async ({ reply }) => ({
                version: 0,
                values: reply ? { replyMedia: reply.messageId === msg6.ref.messageId ? reply6Media : [{ slotId: 'shot-0', status: 'ready', takes: [{ id: `media-${reply.messageId}` }], activeTake: 0 }] } : routeValues,
            }),
        },
    };

    const darkroom = await plugin.commands.darkroom(panelApi, { target: msg6.ref });
    for (const field of darkroom.fields ?? []) assert.match(field.id, smallIdRe);
    for (const act of darkroom.actions ?? []) assert.match(act.id, smallIdRe);
    const ratioField = darkroom.fields.find((f) => f.id === 'aspect_ratio');
    assert.ok(ratioField && ratioField.initial === '4:3');
    assert.ok(ratioField.options.some((o) => o.value === ratioField.initial));
    assert.equal(darkroom.fields.find((f) => f.id === 'prompt').initial.length, 4000);

    await plugin.commands.darkroom(panelApi, {
        target: msg6.ref,
        action: { id: 'develop', values: { prompt: 'close-up portrait', aspect_ratio: '4:3' } },
    });
    assert.equal(scheduledPanelJobs[0].payload.aspectRatio, '4:3');
    assert.equal(scheduledPanelJobs[0].payload.custom, 'close-up portrait');

    const studioPanel = await plugin.commands.studio(panelApi, {});
    assert.ok(studioPanel.blocks.length <= 16, `studio blocks (${studioPanel.blocks.length}) must not exceed 16`);
});

test('createFilmSurface mounts closed Shadow DOM inside child iframe, enforces trusted clicks, and garbage-collects ObjectURLs', (t) => {
    const prevDoc = globalThis.document;
    const prevWin = globalThis.window;
    const prevRAF = globalThis.requestAnimationFrame;
    const prevCAF = globalThis.cancelAnimationFrame;
    const prevCreateUrl = URL.createObjectURL;
    const prevRevokeUrl = URL.revokeObjectURL;
    t.after(() => {
        globalThis.document = prevDoc;
        globalThis.window = prevWin;
        globalThis.requestAnimationFrame = prevRAF;
        globalThis.cancelAnimationFrame = prevCAF;
        URL.createObjectURL = prevCreateUrl;
        URL.revokeObjectURL = prevRevokeUrl;
    });

    const createdUrls = [];
    const revokedUrls = [];
    let urlSeq = 0;
    URL.createObjectURL = () => {
        const u = `blob:compat/${++urlSeq}`;
        createdUrls.push(u);
        return u;
    };
    URL.revokeObjectURL = (u) => {
        revokedUrls.push(u);
    };

    const makeMockNode = (tag = 'div', text = '') => {
        const listeners = new Map();
        const classSet = new Set();
        const attrs = new Map();
        const node = {
            tagName: tag.toUpperCase(),
            hidden: false,
            isConnected: false,
            children: [],
            childNodes: [],
            style: {},
            textContent: text,
            nextElementSibling: null,
            parentElement: null,
            parentNode: { nodeType: 1 },
            ownerDocument: null,
            shadowRoot: null,
            _closedShadow: null,
            classList: {
                add: (c) => classSet.add(c),
                remove: (c) => classSet.delete(c),
                contains: (c) => classSet.has(c),
            },
            set className(val) {
                classSet.clear();
                for (const p of String(val).split(/\s+/).filter(Boolean)) classSet.add(p);
                node._className = val;
            },
            get className() {
                return node._className ?? '';
            },
            setAttribute: (k, v) => attrs.set(k, String(v)),
            removeAttribute: (k) => attrs.delete(k),
            getAttribute: (k) => attrs.get(k) ?? null,
            hasAttribute: (k) => attrs.has(k),
            closest: () => null,
            contains: (o) => o === node || node.children.some((c) => c.contains?.(o)),
            getBoundingClientRect: () => ({ top: 10, left: 10, width: 680, height: 48 }),
            attachShadow: ({ mode }) => {
                assert.equal(mode, 'closed');
                const shadow = {
                    mode,
                    children: [],
                    appendChild: (c) => { shadow.children.push(c); return c; },
                };
                node._closedShadow = shadow;
                return shadow;
            },
            appendChild: (c) => {
                c.parentNode = node;
                c.parentElement = node;
                c.isConnected = node.isConnected;
                node.children.push(c);
                node.childNodes.push(c);
                return c;
            },
            insertBefore: (c, ref) => {
                c.parentNode = node;
                c.parentElement = node;
                c.isConnected = node.isConnected;
                const idx = ref ? node.children.indexOf(ref) : -1;
                if (idx >= 0) node.children.splice(idx, 0, c);
                else node.children.push(c);
                node.childNodes = [...node.children];
                return c;
            },
            removeChild: (c) => {
                const idx = node.children.indexOf(c);
                if (idx >= 0) node.children.splice(idx, 1);
                node.childNodes = [...node.children];
                return c;
            },
            get firstChild() { return node.children[0] ?? null; },
            after: (inserted) => {
                inserted.isConnected = true;
                node.nextElementSibling = inserted;
            },
            remove: () => { node.isConnected = false; },
            addEventListener: (type, fn) => {
                const arr = listeners.get(type) ?? [];
                arr.push(fn);
                listeners.set(type, arr);
            },
            dispatchEvent: (evt) => {
                for (const fn of listeners.get(evt.type) ?? []) fn(evt);
            },
            querySelectorAll: (sel) => {
                const out = [];
                const walk = (n) => {
                    for (const ch of n.children ?? []) {
                        if (ch.tagName?.toLowerCase() === sel.toLowerCase()) out.push(ch);
                        walk(ch);
                    }
                };
                walk(node);
                return out;
            },
        };
        return node;
    };

    const p0 = makeMockNode('p', '开场石廊描写一段。');
    const p1 = makeMockNode('p', '银白发少女推开沉重的铁门，月光洒落在她的肩头。');
    const p2 = makeMockNode('p', '四周一片寂静，只有脚步声回荡。');
    p0.isConnected = p1.isConnected = p2.isConnected = true;

    const childDoc = {
        body: {
            textContent: `${p0.textContent}\n${p1.textContent}\n${p2.textContent}`,
            querySelector: () => null,
            querySelectorAll: () => [p0, p1, p2],
            getBoundingClientRect: () => ({ height: 600 }),
        },
        createElement: (tag) => {
            const el = makeMockNode(tag);
            el.ownerDocument = childDoc;
            return el;
        },
    };
    p0.ownerDocument = p1.ownerDocument = p2.ownerDocument = childDoc;

    const childFrame = {
        isConnected: true,
        contentDocument: childDoc,
        getBoundingClientRect: () => ({ top: 40, left: 20, width: 700, height: 600 }),
    };
    const mesBody = {
        querySelector: () => null,
        querySelectorAll: (sel) => (sel === 'iframe.compat-message-frame' ? [childFrame] : []),
    };
    const article = {
        dataset: { readingSwipe: 'sw-1' },
        querySelector: () => mesBody,
    };

    globalThis.requestAnimationFrame = () => 1;
    globalThis.cancelAnimationFrame = () => {};
    globalThis.window = { addEventListener() {}, removeEventListener() {} };
    globalThis.document = {
        elementFromPoint: () => null,
        createElement: (tag) => makeMockNode(tag),
    };

    const emittedActions = [];
    const surface = createFilmSurface({
        row: (id) => (id === 'msg-1' ? article : undefined),
        onAction: (req, token) => emittedActions.push({ req, token }),
    });

    const slot = {
        key: 'k-1',
        message: 'msg-1',
        swipe: 'sw-1',
        anchor: { kind: 'paragraph', index: 1, excerpt: '推开沉重的铁门' },
        status: 'ready',
        label: '月夜铁门',
        subtitle: '樱羽艾玛 · Seed 42',
        ratio: '16:9',
        presentation: 'editorial',
        takeIndex: 0,
        takeCount: 2,
        canStage: true,
        mediaId: '11111111-1111-4111-8111-111111111111',
        commandId: 'darkroom',
        actions: [{ id: 'focus', label: '特写', title: '聚焦主角', kind: 'action' }],
    };

    surface.sync([slot], 'tok-abc');
    const host = p1.nextElementSibling;
    assert.ok(host, 'host element mounted directly after matching paragraph inside child iframe');
    assert.equal(host.className, 'compat-native-media-slot');
    assert.equal(host.shadowRoot, null, 'author scripts cannot access closed shadowRoot');
    assert.ok(host._closedShadow, 'closed shadow root created');
    assert.match(host._closedShadow.children[0].textContent, /all:\s*initial\s*!important/);

    const shadowRoot = host._closedShadow.children[1];
    surface.receiveMedia('11111111-1111-4111-8111-111111111111', new Blob(['img'], { type: 'image/webp' }), 'gate.webp');
    assert.equal(createdUrls.length, 1);

    const imgs = shadowRoot.querySelectorAll('img');
    assert.equal(imgs.length, 1);
    assert.equal(imgs[0].src, createdUrls[0]);

    // Incremental update preserves existing <img> element without flicker
    surface.sync([{ ...slot, busy: true }], 'tok-abc');
    assert.equal(shadowRoot.querySelectorAll('img')[0], imgs[0]);

    // Author synthetic untrusted clicks must be rejected; trusted clicks dispatch properly
    const buttons = shadowRoot.querySelectorAll('button');
    const darkroomBtn = buttons.find((b) => b.textContent === '精修');
    const customBtn = buttons.find((b) => b.textContent === '特写');
    const zoomBtn = buttons.find((b) => b.textContent === '放大');
    assert.ok(darkroomBtn && customBtn && zoomBtn);

    // Re-sync un-busy so buttons are enabled, then fire untrusted & trusted events
    surface.sync([slot], 'tok-abc');
    const freshBtns = shadowRoot.querySelectorAll('button');
    const fDarkroom = freshBtns.find((b) => b.textContent === '精修');
    const fCustom = freshBtns.find((b) => b.textContent === '特写');
    const fSave = freshBtns.find((b) => b.textContent === '保存');

    fDarkroom.dispatchEvent({ type: 'click', isTrusted: false, stopImmediatePropagation() {} });
    assert.equal(emittedActions.length, 0, 'untrusted script click must be blocked');

    fDarkroom.dispatchEvent({ type: 'click', isTrusted: true });
    fCustom.dispatchEvent({ type: 'click', isTrusted: true });
    fSave.dispatchEvent({ type: 'click', isTrusted: true });
    assert.deepEqual(
        emittedActions.map((e) => [e.token, e.req.action, e.req.commandId ?? e.req.customId ?? null]),
        [
            ['tok-abc', 'command', 'darkroom'],
            ['tok-abc', 'custom', 'focus'],
            ['tok-abc', 'save', null],
        ],
    );

    // Removing slot revokes cached ObjectURL cleanly
    surface.sync([], 'tok-abc');
    assert.equal(host.isConnected, false);
    assert.deepEqual(revokedUrls, createdUrls);
    surface.dispose();

    // replyMediaItemSchema validates subtitle, commandId, actions and rejects invalid action IDs or >4 actions
    assert.equal(replyMediaItemSchema.safeParse({
        slotId: 'shot-0',
        status: 'ready',
        label: '月夜',
        subtitle: '艾玛 · Seed 12',
        commandId: 'darkroom',
        actions: [{ id: 'focus', label: '特写', kind: 'action' }],
    }).success, true);
    assert.equal(replyMediaItemSchema.safeParse({
        slotId: 'shot-0',
        status: 'ready',
        label: '月夜',
        actions: [{ id: 'BadId', label: '非法ID' }],
    }).success, false);
    assert.equal(replyMediaItemSchema.safeParse({
        slotId: 'shot-0',
        status: 'ready',
        label: '月夜',
        actions: Array.from({ length: 5 }, (_, i) => ({ id: `act_${i}`, label: `操作${i}` })),
    }).success, false);
});

test('latent-film survives past 12s after reply save, cleans up per-slot on generation end, and film-surface requests missing media', async (t) => {
    const prevSetTimeout = globalThis.setTimeout;
    const prevClearTimeout = globalThis.clearTimeout;
    const scheduledTimers = [];
    let nextTimerId = 100;
    t.after(() => {
        globalThis.setTimeout = prevSetTimeout;
        globalThis.clearTimeout = prevClearTimeout;
    });

    globalThis.setTimeout = (fn, ms) => {
        const entry = { id: ++nextTimerId, fn, ms, cleared: false };
        scheduledTimers.push(entry);
        return entry.id;
    };
    globalThis.clearTimeout = (id) => {
        const entry = scheduledTimers.find((item) => item.id === id);
        if (entry) entry.cleared = true;
    };

    const controller = new AbortController();
    let resolveReply;
    const completion = new Promise((r) => { resolveReply = r; });
    const draft = { messageId: 'draft-long', swipeId: 'draft-long:0', floor: 4 };
    developPreview(
        { id: 'cp-a', generationId: 'draft-long', route: { chatId: 'c', routeId: 'r' }, draft, settledText: 'p1', paragraphCount: 1, kind: 'normal' },
        'dev.tipsy-isle.lumina-director',
        'digest-long',
        { slotId: 'shot-0', label: '长时生图', aspectRatio: '3:2', anchor: { kind: 'paragraph', index: 0, excerpt: 'p1' } },
        completion,
        controller.signal,
    );
    developPreview(
        { id: 'cp-b', generationId: 'draft-long', route: { chatId: 'c', routeId: 'r' }, draft, settledText: 'p1\n\np2', paragraphCount: 2, kind: 'normal' },
        'dev.tipsy-isle.lumina-director',
        'digest-long',
        { slotId: 'shot-1', label: '第二镜', aspectRatio: '3:2', anchor: { kind: 'paragraph', index: 1, excerpt: 'p2' } },
        completion,
        controller.signal,
    );

    resolveReply({ id: 'ev-1' });
    await Promise.resolve();
    await Promise.resolve();

    // Post-reply latent safety TTL must exceed 12s (360s) so slow image generation never vanishes mid-flight
    assert.ok(scheduledTimers.length >= 2);
    assert.ok(scheduledTimers.every((timer) => timer.ms >= 300_000), 'post-reply latent TTL must be >= 300s');

    // Clearing slot-0 keeps slot-1 intact
    clearLatentForGeneration('draft-long', 'dev.tipsy-isle.lumina-director', 'digest-long', 0, 'shot-0');
    assert.equal(latentFilm.getState().items.some((i) => i.message === 'draft-long' && i.item.slotId === 'shot-0'), false);
    assert.equal(latentFilm.getState().items.some((i) => i.message === 'draft-long' && i.item.slotId === 'shot-1'), true);
    clearLatentForGeneration('draft-long', 'dev.tipsy-isle.lumina-director', 'digest-long', 0);
    assert.equal(latentFilm.getState().items.some((i) => i.message === 'draft-long'), false);
    controller.abort();

    // Film surface self-healing: onMediaNeed & already-complete img immediate reveal
    const prevDoc = globalThis.document;
    const prevWin = globalThis.window;
    const prevRAF = globalThis.requestAnimationFrame;
    const prevCAF = globalThis.cancelAnimationFrame;
    const prevCreateUrl = URL.createObjectURL;
    const prevRevokeUrl = URL.revokeObjectURL;
    t.after(() => {
        globalThis.document = prevDoc;
        globalThis.window = prevWin;
        globalThis.requestAnimationFrame = prevRAF;
        globalThis.cancelAnimationFrame = prevCAF;
        URL.createObjectURL = prevCreateUrl;
        URL.revokeObjectURL = prevRevokeUrl;
    });

    URL.createObjectURL = () => 'blob:compat/cached-sync';
    URL.revokeObjectURL = () => {};
    const makeEl = (tag = 'div', text = '') => {
        const classSet = new Set();
        const el = {
            tagName: tag.toUpperCase(),
            isConnected: false,
            children: [],
            childNodes: [],
            style: {},
            textContent: text,
            nextElementSibling: null,
            parentElement: null,
            parentNode: { nodeType: 1 },
            complete: tag === 'img',
            naturalWidth: tag === 'img' ? 512 : 0,
            _closedShadow: null,
            classList: { add: (c) => classSet.add(c), remove: (c) => classSet.delete(c), contains: (c) => classSet.has(c) },
            set className(v) { classSet.clear(); for (const p of String(v).split(/\s+/).filter(Boolean)) classSet.add(p); },
            get className() { return [...classSet].join(' '); },
            setAttribute() {},
            removeAttribute() {},
            hasAttribute: () => false,
            attachShadow: () => {
                const shadow = { children: [], appendChild: (c) => { shadow.children.push(c); return c; } };
                el._closedShadow = shadow;
                return shadow;
            },
            appendChild: (c) => { el.children.push(c); return c; },
            insertBefore: (c) => { el.children.push(c); return c; },
            removeChild: (c) => { el.children = el.children.filter((x) => x !== c); return c; },
            get firstChild() { return el.children[0] ?? null; },
            after: (ins) => { ins.isConnected = true; el.nextElementSibling = ins; },
            remove: () => { el.isConnected = false; },
            addEventListener() {},
            querySelectorAll: () => [],
        };
        return el;
    };
    const body = makeEl('div');
    const lastBlock = makeEl('div', '末段正文');
    lastBlock.className = 'message-markdown';
    body.querySelector = () => null;
    body.querySelectorAll = (sel) => (sel.includes('.message-markdown') ? [lastBlock] : []);
    body.append = (ins) => { ins.isConnected = true; body.children.push(ins); };
    const article = { dataset: { readingSwipe: 'sw-heal' }, querySelector: () => body };
    globalThis.requestAnimationFrame = () => 1;
    globalThis.cancelAnimationFrame = () => {};
    globalThis.window = { addEventListener() {}, removeEventListener() {} };
    globalThis.document = { elementFromPoint: () => null, createElement: (tag) => makeEl(tag) };

    const requestedMedia = [];
    const surface = createFilmSurface({
        row: (id) => (id === 'msg-heal' ? article : undefined),
        onAction: () => {},
        onMediaNeed: (ids) => requestedMedia.push(...ids),
    });
    const mediaId = '22222222-2222-4222-8222-222222222222';
    surface.sync([{
        key: 'k-heal',
        message: 'msg-heal',
        swipe: 'sw-heal',
        status: 'ready',
        label: '修复测试',
        ratio: '3:2',
        takeIndex: 0,
        takeCount: 1,
        canStage: false,
        mediaId,
    }], 'tok-heal');
    assert.deepEqual(requestedMedia, [mediaId]);

    surface.receiveMedia(mediaId, new Blob(['ok'], { type: 'image/webp' }), 'ok.webp');
    const mountedHost = lastBlock.nextElementSibling;
    assert.ok(mountedHost && mountedHost._closedShadow);
    const createdImg = mountedHost._closedShadow.children[1].children[0].children.find((c) => c.tagName === 'IMG');
    assert.ok(createdImg, 'IMG element must be mounted inside closed Shadow DOM');
    assert.equal(createdImg.classList.contains('is-loaded'), true, 'already-complete image must immediately get is-loaded');
    surface.dispose();
});

test('QuickJS VM allocates mobile-safe CPU quotas for background jobs and extractDeceasedFromText skips benign prose fast', () => {
    assert.ok(vmLimits.cpu >= 500, 'interactive plugin tasks need >= 500ms QuickJS-WASM CPU budget');
    assert.ok(vmLimits.jobCpu >= 2000, 'background jobs need >= 2000ms QuickJS-WASM CPU budget');
    assert.ok(vmLimits.contributionCpu <= 80, 'synchronous prompt contribution stays tightly bounded');

    const known = [
        { name: '樱羽艾玛', aliases: ['艾玛'] },
        { name: '二阶堂希罗', aliases: ['希罗'] },
        { name: '夏目安安', aliases: ['安安'] },
    ];
    const benign = '艾玛和希罗在石廊里走了一整天，安安一直在后面记录线索。'.repeat(200);
    assert.deepEqual(extractDeceasedFromText(benign, known), { deceased: [], revived: [] });
    assert.deepEqual(extractDeceasedFromText('夏目安安已经被处刑，二阶堂希罗并没有死，其实还活着。', known), {
        deceased: ['夏目安安'],
        revived: ['二阶堂希罗'],
    });
});

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AnchoredDialog } from './AnchoredDialog';
import { Icon } from './Icon';
import './onboarding.css';

const DEVICE_GUIDE_KEY = 'tipsy:onboarding:seen:v1';
export function needsFirstRunGuide() { return localStorage.getItem(DEVICE_GUIDE_KEY) !== 'seen'; }
export function rememberFirstRunGuide() { localStorage.setItem(DEVICE_GUIDE_KEY, 'seen'); }
export type GuideStep = 'import' | 'profile' | 'connection' | 'resources' | 'play' | 'history' | 'routes' | 'plugins' | 'sync';
function useMobileGuide() {
    const [mobile, setMobile] = useState(() => matchMedia('(max-width: 699px)').matches);
    useEffect(() => {
        const media = matchMedia('(max-width: 699px)');
        const update = () => setMobile(media.matches);
        media.addEventListener('change', update);
        return () => media.removeEventListener('change', update);
    }, []);
    return mobile;
}
const mobileSteps: Record<GuideStep, { title: string; paragraphs: string[] }> = {
    import: { title: '把故事收入馆藏', paragraphs: ['点“导入”，选择 PNG／JSON 角色卡。世界书和预设 JSON 也从这里导入。', '卡片自带的世界书会随故事启用。还没准备文件，可以先看下一步。'] },
    profile: { title: '给自己一个故事身份', paragraphs: ['在“设置 → 个人资料”填写头像、称呼与人设，顶部头像也能打开。', '全局资料通用于各个故事；设置故事专属身份后，会优先使用它。'] },
    connection: { title: '让故事有了回应', paragraphs: ['在“模型连接”填写协议、API 地址和密钥，获取列表后选模型，再按模型能力调整长度。', '点击底部“保存设置”。密钥不会同步，另一台设备需单独填写。'] },
    resources: { title: '备好世界与叙事方式', paragraphs: ['馆藏下方可打开“世界书”和“预设明细”，调整启用词条、选用预设。', '按角色作者的说明搭配即可；变量解析等选项在“设置 → 故事运行”。'] },
    play: { title: '把下一句交给你', paragraphs: ['选一个开场，写下对白或行动。也可以点“继续故事”，让模型接着写。', '“重新生成”会替换最后一条回复。滑动时操作栏会收起，轻点空白处即可展开。'] },
    history: { title: '留住走过的剧情', paragraphs: ['点对话顶部的历史图标，进入“会话与分支”，找回之前的存档。', '消息和变量会一起恢复。“新对话”会保留旧存档。'] },
    routes: { title: '保留这条路，试另一个选择', paragraphs: ['在开场后的模型回复旁，点“⋯ → 从这里重新选择”，原路线会保留。', '在“会话与分支 → 故事路线”里，可切换路线或查看整张卡的总览。'] },
    plugins: { title: '管理你装的插件', paragraphs: ['在“设置 → 插件”导入 .tipsy-plugin 文件。点插件名称，即可启停、查看权限和运行日志。', '酒馆兼容扩展在同一页单独管理。'] },
    sync: { title: '换块屏幕，接着读', paragraphs: ['两端连接同一局域网，在“双端互通”开启发现，首次输入配对码，以后自动重连。', '换设备前可点“立即同步”。离线续写会保留，重新连接后补同步；两端分开续写也会保留两条进度。'] },
};
const mobileActions: Record<GuideStep, string> = { import: '导入内容', profile: '编辑资料', connection: '连接模型', resources: '查看资源', play: '前往对话', history: '查看存档', routes: '打开路线图', plugins: '管理插件', sync: '设置互通' };
const steps: Array<{ id: GuideStep; title: string; paragraphs: string[]; target: string; action: string }> = [
    { id: 'import', title: '把喜欢的故事，收入馆藏', target: 'import', action: '导入角色卡与资源',
        paragraphs: [
            '角色卡是走进故事的第一页，里面装着人物的性格、背景与开场。点击馆藏中的“导入”，选择你准备好的 PNG 或 JSON 角色卡，之后就能在馆藏里找到它。',
            '世界书和预设的 JSON 文件也从这里导入。角色卡自带的世界书会随故事启用，无需再导入一份；作者另附的文件，可以按说明一并准备。',
            '导入后，点击角色卡即可进入故事。手边还没有文件，也可以先点“下一步”，熟悉操作后再回来挑选。',
        ] },
    { id: 'profile', title: '给故事里的自己，一个名字', target: 'profile', action: '编辑个人资料',
        paragraphs: [
            '你可以以自己的模样出场，也可以成为另一个人。在“设置 → 个人资料”中选择头像、填写称呼，再用几句话写下身份、性格或外貌，让模型了解故事中的你。',
            '角色卡中出现的 {{user}} 会使用这里的称呼。全局资料可以用于不同故事；进入某个故事后，还能为它设置专属资料，此时会优先使用专属资料，两份内容不会叠加。',
            '想在途中换个形象，点击对话顶部的头像也能打开个人资料。具体的背景可以慢慢补充，先有一个喜欢的名字就很好。',
        ] },
    { id: 'connection', title: '连接模型，让故事有了回应', target: 'connection', action: '设置模型连接',
        paragraphs: [
            '模型会根据角色设定和已有对话续写剧情。在“设置 → 模型连接”中，按照服务商提供的信息选择协议，填写 API 地址与密钥，再获取模型列表，选择想使用的模型。',
            '上下文长度决定一次能交给模型多少故事内容，回复长度决定一次最多生成多少内容。请结合所选模型的能力调整；更换模型时，也可以顺手确认这两项是否合适。',
            '填写完成后，点击底部浮出的“保存设置”使修改生效。API 密钥不参与局域网同步，换一台设备时，需要在那台设备上单独配置连接。',
        ] },
    { id: 'resources', title: '为故事备好世界与叙事方式', target: 'resources', action: '查看世界书与预设入口',
        paragraphs: [
            '世界书记着故事里的地点、人物关系和规则；预设则会影响模型收到的指令与叙事方式。馆藏下方的“世界书”和“预设明细”，就是整理这些内容的入口。',
            '在世界书里，可以查看和编辑词条、调整启用状态，并确认它与故事的绑定关系。预设导入后还需要选用；如果作者没有要求，也可以选择“不使用预设”。',
            '开始前，值得读一读角色卡作者的使用说明。需要搭配的世界书、预设，以及变量解析等要求，都可能影响游玩效果；故事运行相关选项在“设置 → 故事运行”中。',
        ] },
    { id: 'play', title: '选一个开场，把下一句交给你', target: 'play', action: '前往对话',
        paragraphs: [
            '从馆藏打开角色卡，等作者页面与故事状态准备完成，就可以开始游玩。有些角色准备了多个开场，可以在首条消息切换候选，选择最想走进去的那一个。',
            '在输入框写下你的台词、动作或决定，然后发送；想先看看接下来发生什么，也可以点击“继续故事”。电脑端支持 Ctrl／⌘ + Enter 发送。',
            '“重新生成”会替换最后一条模型回复。想把原来的走向也留下，可以用稍后介绍的“从这里重新选择”。生成途中也可以停止。',
        ] },
    { id: 'history', title: '把走过的剧情，留在书页之间', target: 'history', action: '查看会话与分支入口',
        paragraphs: [
            '想找回一段以前的对话，点击顶部的历史图标，打开“会话与分支”。从“已保存会话”里选择一段对话，再点击“恢复”。',
            '存档里不仅有聊天文字，也有候选回复、变量和相关故事状态。恢复时，它们会一起回到对应的进度，让角色的经历与手中的物品接得上这一页故事。',
            '想从头再体验一次，可以使用“新对话”，原来的历史会保留。即使还没打开角色卡，也能先从这里寻找已有的存档。',
        ] },
    { id: 'routes', title: '同一段故事，也可以有两个走向', target: 'routes', action: '打开故事路线图',
        paragraphs: [
            '比如第 2 楼写到你抵达港口，你选了留在码头。想试试登船？点第 2 楼模型回复旁的“⋯ → 从这里重新选择”，就能从港口另走一条路，原来的路线会保留。开场的第 0 楼不分支。',
            '到“会话与分支 → 故事路线”，可以沿着分叉读剧情摘要，再点“继续这条路线”。选“整张角色卡总览”，还能看到这张卡不同会话里的路线。',
        ] },
    { id: 'plugins', title: '把常用的工具装进故事里', target: 'plugins', action: '前往插件管理',
        paragraphs: [
            '在“设置 → 插件”导入社区作者提供的 .tipsy-plugin 文件。安装时先看发布者和它申请的权限，可以选择仅安装，之后再启用。',
            '在已安装列表里选中一个插件。“概览”可以启停或修改它自己的设置，“权限”可以查看授权，“运行日志”可以帮你找到本次打开应用后的失败原因。',
            '如果你装的是旧酒馆的扩展，请在同一页的“酒馆兼容扩展”中管理。',
        ] },
    { id: 'sync', title: '换一块屏幕，接着读这一页', target: 'sync', action: '设置双端互通',
        paragraphs: [
            '让电脑和手机连接同一局域网，再在两端的“设置 → 双端互通”中开启设备发现。首次连接时按提示输入配对码；已经配对的设备，下次发现后会自动重连。',
            '游玩进度先保存在当前设备，同步会在空闲时进行。准备换设备时，可以点击“立即同步”，查看状态，等同步完成后再到另一端继续。离线时仍可游玩，恢复连接后再补同步；如果两端分别续写，两条进度都会保留。',
            '常用入口就介绍到这里。主导航的“外观”可以调整阅读界面；以后想再走一遍，也能从“设置 → 使用引导”重新开始。愿下一次翻页，恰好遇见你期待的故事。',
        ] },
];

function GuideRouteExample() {
    return <figure className="ttm-guide-route-example" aria-label="分支示例：从第 2 楼港口出发，原路线留在码头，新路线登船出发">
        <div aria-hidden="true" className="ttm-guide-route-origin">第 2 楼 · 抵达港口</div>
        <div aria-hidden="true" className="ttm-guide-route-fork"><span>原路线 · 留在码头</span><span>新路线 · 登船出发</span></div>
    </figure>;
}

export function GuideWelcome({ appName = '微醺屿', art, onStart, onSkip }: { appName?: string; art?: ReactNode; onStart(): void; onSkip(): void }) {
    const mobile = useMobileGuide();
    return <AnchoredDialog title={`欢迎来到${appName}`} anchor={document.body} compact fitContent welcome onClose={onSkip}>
        <div className="ttm-guide-welcome"><span className="ttm-welcome-mark">{art ?? <Icon name="book" width={56} height={56} />}</span>
            <h3>下一段故事，从这里开始</h3>
            {mobile ? <>
                <p>带上喜欢的角色，以自己的方式走进故事。给自己一个名字与形象，导入角色卡、连接模型，就能开始。</p>
                <p>接下来陪你认识常用入口。可以边看边试，也可以随时跳过。</p>
            </> : <>
            <p>一场相遇，一段远行，或是某个平凡日子里的小小心动。在{appName}，你可以带上喜欢的角色，以自己的方式走进故事，让一次次对话与选择，写下只属于你的经历。</p>
            <p>出发前，先给故事里的自己一个名字与形象，再导入角色卡、连接模型。角色卡带来人物与开场，模型回应你的言行，而故事会沿着你们的对话慢慢展开。</p>
            <p>接下来，我们会陪你认识角色扮演（RP）常用的操作：整理馆藏、配置模型、保存剧情与探索分支，也会告诉你去哪里管理插件。你可以边看边试；暂时没有角色卡或密钥，也可以稍后再准备。</p>
            </>}
            <div className="ttm-guide-buttons"><button type="button" className="ttm-btn-primary" onClick={onStart}>带我熟悉一下</button>
                <button type="button" className="ttm-btn-secondary" onClick={onSkip}>我先自己探索</button></div>
            <small>{mobile ? '首次自动展示，可在设置标题旁点“使用引导”重看。' : '这份欢迎只在当前设备首次使用时自动出现。引导可以随时暂停或跳过，也能从设置标题旁的“使用引导”重新开始。'}</small>
        </div>
    </AnchoredDialog>;
}

export function OnboardingTour({ hasStory, onNavigate, onAction, onFinish }: { hasStory: boolean; onNavigate(step: GuideStep): void; onAction(step: GuideStep, target?: HTMLElement): void; onFinish(): void }) {
    const [index, setIndex] = useState(0), [paused, setPaused] = useState(false), [dialogOpen, setDialogOpen] = useState(false);
    const step = steps[index];
    const mobile = useMobileGuide();
    const copy = mobile ? mobileSteps[step.id] : step;
    const actionLabel = step.id === 'routes' && !hasStory ? '前往馆藏' : mobile ? mobileActions[step.id] : step.action;
    const navigate = useRef(onNavigate); navigate.current = onNavigate;
    const panel = useRef<HTMLElement>(null), target = useRef<HTMLElement>();
    const motion = useRef<Animation>();
    const leaving = useRef(false);
    const placement = useRef<{ node: HTMLElement; left: number; top: number; step: GuideStep }>();
    const leave = (complete: () => void) => {
        if (leaving.current) return;
        leaving.current = true;
        const node = panel.current!;
        const current = getComputedStyle(node);
        const from = { opacity: current.opacity, transform: current.transform, filter: current.filter };
        motion.current?.cancel();
        const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
        motion.current = node.animate([from, { opacity: 0, transform: reduced ? 'none' : 'translateY(8px)', filter: 'none' }], { duration: reduced ? 100 : 140, easing: 'ease-in', fill: 'forwards' });
        motion.current.onfinish = () => { leaving.current = false; complete(); };
    };
    useEffect(() => { setPaused(false); navigate.current(step.id); }, [step.id]);
    useEffect(() => {
        const update = () => setDialogOpen(!!document.querySelector('dialog[open]'));
        update(); window.addEventListener('tipsy-dialog-change', update);
        return () => window.removeEventListener('tipsy-dialog-change', update);
    }, []);
    useLayoutEffect(() => {
        if (paused || dialogOpen) return;
        const node = panel.current!; let frame = 0, scrolled = false;
        const update = () => {
            frame = 0;
            if (leaving.current) return;
            const next = [...document.querySelectorAll<HTMLElement>(`[data-guide~="${step.target}"]`)].find(item => item.getClientRects().length && item.getBoundingClientRect().width > 0);
            if (target.current !== next) { target.current?.removeAttribute('data-guide-active'); target.current = next; next?.setAttribute('data-guide-active', 'true'); }
            const mobile = window.innerWidth < 700, height = node.offsetHeight;
            document.documentElement.style.setProperty('--guide-reserve', mobile ? `${height + 18}px` : '0px');
            if (next && !scrolled) { scrolled = true; next.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }
            const rect = next?.getBoundingClientRect();
            const width = node.offsetWidth;
            const left = rect ? rect.right + width + 28 < innerWidth ? rect.right + 14 : Math.max(16, rect.left - width - 14) : innerWidth - width - 24;
            const top = Math.max(16, Math.min(rect?.top ?? 90, innerHeight - height - 16));
            const visible = node.getBoundingClientRect();
            const appearance = getComputedStyle(node);
            const currentOpacity = appearance.opacity, currentFilter = appearance.filter;
            node.style.left = mobile ? '' : `${left}px`;
            node.style.top = mobile ? '' : `${top}px`;
            const prior = placement.current, nextLeft = node.offsetLeft, nextTop = node.offsetTop;
            const entering = prior?.node !== node;
            const changingStep = prior?.step !== step.id;
            if (entering || changingStep || prior?.left !== nextLeft || prior?.top !== nextTop) {
                motion.current?.cancel();
                const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
                const x = entering ? 0 : visible.left - nextLeft;
                const y = entering ? 18 : visible.top - nextTop;
                motion.current = node.animate(reduced ? [{ opacity: .65 }, { opacity: 1 }] : [
                    { opacity: entering ? 0 : currentOpacity, transform: `translate(${x}px, ${y}px) scale(${entering ? .975 : 1})`, filter: entering ? 'blur(3px)' : currentFilter },
                    { opacity: 1, transform: 'none', filter: 'none' },
                ], { duration: reduced ? 100 : entering ? 440 : 320, easing: 'cubic-bezier(.16,1,.3,1)' });
                placement.current = { node, left: nextLeft, top: nextTop, step: step.id };
            }
        };
        const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
        const resize = new ResizeObserver(schedule); resize.observe(node);
        const mutations = new MutationObserver(schedule); mutations.observe(document.getElementById('tipsy-isle-root') ?? document.body, { childList: true, subtree: true, attributeFilter: ['hidden', 'data-guide', 'data-mobile-tab'] });
        window.addEventListener('resize', schedule); window.addEventListener('scroll', schedule, true);
        const onPanelAnimationEnd = (event: AnimationEvent) => { if ((event.target as HTMLElement).matches('.ttm-inspector, .ttm-inspector-content, .ttm-settings-category')) schedule(); };
        window.addEventListener('animationend', onPanelAnimationEnd);
        document.documentElement.classList.add('has-onboarding-tour'); update(); node.focus({ preventScroll: true });
        return () => { cancelAnimationFrame(frame); resize.disconnect(); mutations.disconnect(); window.removeEventListener('resize', schedule); window.removeEventListener('scroll', schedule, true); window.removeEventListener('animationend', onPanelAnimationEnd); target.current?.removeAttribute('data-guide-active'); target.current = undefined; document.documentElement.classList.remove('has-onboarding-tour'); document.documentElement.style.removeProperty('--guide-reserve'); };
    }, [step, paused, dialogOpen]);
    useEffect(() => () => { motion.current?.cancel(); }, []);
    useEffect(() => {
        if (paused || dialogOpen) return;
        const escape = (event: KeyboardEvent) => { if (event.key === 'Escape' && !document.querySelector('dialog[open]')) { event.preventDefault(); event.stopImmediatePropagation(); leave(() => setPaused(true)); } };
        const back = (event: Event) => { if (!document.querySelector('dialog[open]')) { event.preventDefault(); leave(() => setPaused(true)); } };
        window.addEventListener('keydown', escape, true);
        window.addEventListener('tipsy-menu-back', back);
        return () => { window.removeEventListener('keydown', escape, true); window.removeEventListener('tipsy-menu-back', back); };
    }, [paused, dialogOpen]);
    if (dialogOpen) return null;
    if (paused) return createPortal(<div className="ttm-guide-paused"><button type="button" className="ttm-btn-primary" onClick={() => { navigate.current(step.id); setPaused(false); }}>继续使用引导 · {index + 1}/{steps.length}</button><button type="button" className="ttm-btn-secondary" onClick={onFinish}>结束引导</button></div>, document.body);
    const tryStep = () => leave(() => { const anchor = target.current; setPaused(true); onAction(step.id, anchor); });
    return createPortal(<aside className="ttm-guide-tip" ref={panel} tabIndex={-1} role="region" aria-label="使用引导">
        <header><span>{index + 1} / {steps.length}</span><button type="button" className="ttm-btn-ghost" onClick={() => leave(onFinish)}>跳过引导</button></header>
        <div className="ttm-guide-step-copy" key={step.id} aria-live="polite"><h2>{copy.title}</h2>{copy.paragraphs.map(paragraph => <p key={paragraph}>{paragraph}</p>)}{step.id === 'routes' && <GuideRouteExample />}</div>
        {!mobile && <button type="button" className="ttm-guide-action ttm-btn-secondary" onClick={tryStep}>{actionLabel}</button>}
        <footer><button type="button" className="ttm-btn-ghost" disabled={!index} onClick={() => setIndex(index - 1)}>上一步</button>
            {mobile && <button type="button" className="ttm-btn-secondary" onClick={tryStep}>{actionLabel}</button>}
            <button type="button" className="ttm-btn-primary" onClick={() => index === steps.length - 1 ? leave(onFinish) : setIndex(index + 1)}>{index === steps.length - 1 ? '完成引导' : '下一步'}</button></footer>
    </aside>, document.body);
}

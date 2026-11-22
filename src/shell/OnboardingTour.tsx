import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AnchoredDialog } from './AnchoredDialog';
import { Icon } from './Icon';
import { freeChatName } from '../store/chat-archives';
import './onboarding.css';

const DEVICE_GUIDE_KEY = 'tipsy:onboarding:seen:v1';
export function needsFirstRunGuide() { return localStorage.getItem(DEVICE_GUIDE_KEY) !== 'seen'; }
export function rememberFirstRunGuide() { localStorage.setItem(DEVICE_GUIDE_KEY, 'seen'); }
export type GuideStep = 'import' | 'connection' | 'play' | 'home' | 'reading-colors' | 'history' | 'story-save' | 'model-chat';
const compactGuideQuery = '(max-width: 1024px)';
function useMobileGuide() {
    const [mobile, setMobile] = useState(() => matchMedia(compactGuideQuery).matches);
    useEffect(() => {
        const media = matchMedia(compactGuideQuery);
        const update = () => setMobile(media.matches);
        media.addEventListener('change', update);
        return () => media.removeEventListener('change', update);
    }, []);
    return mobile;
}
type GuideCue = { selector: string; title: string; paragraphs: string[]; action: string; interaction?: 'focus' | 'click'; pause?: boolean };
const steps: Array<GuideCue & { id: GuideStep }> = [
    { id: 'import', selector: '[data-guide="import"]', title: '把角色带进馆藏', action: '导入素材', pause: true, paragraphs: [
        '在「馆藏 → 导入素材」选择 PNG 或 JSON 角色卡。导入后，从馆藏点开角色。',
        '随卡世界书会跟着故事启用。作者另附的世界书和预设也从这里导入，按说明选用即可。',
    ] },
    { id: 'connection', selector: '[id="ttm-field-api.chat_completion_source"]', title: '让角色有了回应', action: '前往接口选项', interaction: 'focus', pause: true, paragraphs: [
        '从高亮的接口选项开始，按服务商说明选协议，再填 API 地址、密钥和模型名称。',
        '填好后点「保存设置」。换设备时，记得在新设备上配置连接。',
    ] },
    { id: 'play', selector: '[data-guide="play"]', title: '把下一句交给你', action: '前往输入框', interaction: 'focus', pause: true, paragraphs: [
        '打开角色卡。有多个开场时，在第一条消息里选一个。接下来，写一句对白或一个动作，发送后等角色回应。',
        '想给自己换个称呼或身份，点对话顶部的头像，或到「设置 → 个人资料」。',
    ] },
    { id: 'home', selector: '[data-guide="home"]', title: '离开一会儿，故事还在', action: '返回首页', paragraphs: [
        '点顶栏的小房子返回首页。已有的角色会话和输入草稿会留着，点「继续故事」就能接着写。',
    ] },
    { id: 'reading-colors', selector: '[data-guide="reading-colors"]', title: '换一种阅读配色', action: '切换阅读配色', paragraphs: [
        '点顶栏的太阳或月亮，就能在日间和夜间配色之间切换。现在就可以试一次。',
    ] },
    { id: 'history', selector: '[aria-controls="ttm-story-conversations"]', title: '找回以前的会话', action: '打开故事会话', paragraphs: [
        '点顶部的「会话」，搜索角色或会话名称。点一段就能直接接着聊。',
        '要整理旧会话，可以点「多选」逐一勾选。要换同一段故事的分支，点「故事路线」。',
    ] },
    { id: 'story-save', selector: '[data-guide="story-save"]', title: '把走过的故事带过来', action: '导入存档', pause: true, paragraphs: [
        '已有酒馆或 TauriTavern 的聊天记录，可以从「馆藏 → 导入存档」选择 .jsonl，并关联对应的角色卡。',
        'TipsyIsle 的 .tipsy-story 也从这里导入。想备份角色会话，打开会话列表，点「故事存档 → 导出故事存档」。',
    ] },
    { id: 'model-chat', selector: '[data-guide="model-chat"]', title: `${freeChatName} · 和模型对话`, action: `打开${freeChatName}`, paragraphs: [
        `只想问个问题、写点东西？首页和顶栏都有「${freeChatName}」，不用选角色卡、世界书或预设。`,
        '从夜灯会话列表打开以前的聊天，或点「新建对话」开始。默认沿用已配置的模型，也可以点对话顶部的模型名，只给这段对话换模型。',
    ] },
];
const emptyPlay: GuideCue = { selector: '[data-guide="import"]', title: '先带一位角色来', action: '导入素材', pause: true, paragraphs: [
    '馆藏还是空的。点高亮的「导入素材」，选一张 PNG 或 JSON 角色卡。',
    '手边没有卡也可以先点「下一步」，等导入后再回来试。',
] };
const choosePlay: GuideCue = { selector: '.ttm-char-list .ttm-char-item:not([role="checkbox"])', title: '打开一张角色卡', action: '打开高亮角色', paragraphs: [
    '点馆藏里的高亮角色，也可以挑另一张。打开后就能看到开场，再从输入框接上你的第一句。',
] };

function tipPosition(rect: DOMRect | undefined, width: number, height: number) {
    const edge = 12, gap = 16;
    const right = innerWidth - edge, bottom = innerHeight - edge;
    const x = (value: number) => Math.max(edge, Math.min(value, right - width));
    const y = (value: number) => Math.max(edge, Math.min(value, bottom - height));
    if (!rect) return { left: right - width, top: y(72) };
    if (rect.right + gap + width <= right) return { left: rect.right + gap, top: y(rect.top) };
    if (rect.left - gap - width >= edge) return { left: rect.left - gap - width, top: y(rect.top) };
    const left = x(rect.left + (rect.width - width) / 2);
    if (rect.bottom + gap + height <= bottom) return { left, top: rect.bottom + gap };
    if (rect.top - gap - height >= edge) return { left, top: rect.top - gap - height };
    return { left, top: rect.top > innerHeight - rect.bottom ? edge : bottom - height };
}

export function GuideWelcome({ appName = '微醺屿', art, onStart, onSkip }: { appName?: string; art?: ReactNode; onStart(): void; onSkip(): void }) {
    return <AnchoredDialog title={`欢迎来到${appName}`} anchor={document.body} compact centered fitContent welcome onClose={onSkip}>
        <div className="ttm-guide-welcome"><span className="ttm-welcome-mark">{art ?? <Icon name="book" width={56} height={56} />}</span>
            <h3>下一段故事，从这里开始</h3>
            <p>带上喜欢的角色卡，连好模型，写下你的第一句。随后再看看怎么找回故事、带走存档。</p>
            <div className="ttm-guide-buttons"><button type="button" className="ttm-btn-primary" onClick={onStart}>开始新手引导</button>
                <button type="button" className="ttm-btn-secondary" onClick={onSkip}>先自己逛逛</button></div>
            <small>可以随时暂停，也能从首页或设置里的「使用引导」重看。</small>
        </div>
    </AnchoredDialog>;
}

export function OnboardingTour({ hasStory, hasCards, onNavigate, onFinish }: { hasStory: boolean; hasCards: boolean; onNavigate(step: GuideStep): void; onFinish(): void }) {
    const [index, setIndex] = useState(0), [paused, setPaused] = useState(false), [dialogOpen, setDialogOpen] = useState(false);
    const [actionReady, setActionReady] = useState(false), [historyOpen, setHistoryOpen] = useState(false);
    const step = steps[index];
    const mobile = useMobileGuide();
    const cue = step.id === 'play' && !hasStory ? hasCards ? choosePlay : emptyPlay : step;
    const navigate = useRef(onNavigate); navigate.current = onNavigate;
    const panel = useRef<HTMLElement>(null), target = useRef<HTMLElement>();
    const motion = useRef<Animation>();
    const leaving = useRef(false);
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
    useLayoutEffect(() => { navigate.current(step.id); }, [step.id]);
    useEffect(() => {
        const update = () => setDialogOpen(!!document.querySelector('dialog[open]'));
        update(); window.addEventListener('tipsy-dialog-change', update);
        return () => window.removeEventListener('tipsy-dialog-change', update);
    }, []);
    useLayoutEffect(() => {
        if (paused || dialogOpen) return;
        const node = panel.current!; let frame = 0;
        const update = () => {
            frame = 0;
            if (leaving.current) return;
            const next = [...document.querySelectorAll<HTMLElement>(cue.selector)].find(item => item.offsetWidth && item.offsetHeight && getComputedStyle(item).visibility === 'visible');
            if (target.current !== next) {
                target.current?.removeAttribute('data-guide-active');
                target.current = next;
                next?.setAttribute('data-guide-active', 'true');
                next?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
            }
            setActionReady(!!next && !next.matches(':disabled'));
            if (step.id === 'history') setHistoryOpen(next?.getAttribute('aria-expanded') === 'true');
            if (!mobile) {
                const { left, top } = tipPosition(next?.getBoundingClientRect(), node.offsetWidth, node.offsetHeight);
                node.style.left = `${left}px`;
                node.style.top = `${top}px`;
            }
        };
        const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
        const resize = new ResizeObserver(schedule); resize.observe(node);
        const mutations = new MutationObserver(schedule); mutations.observe(document.getElementById('tipsy-isle-root') ?? document.body, { childList: true, subtree: true, attributeFilter: ['hidden', 'class', 'disabled', 'aria-expanded', 'data-mobile-tab'] });
        window.addEventListener('resize', schedule); window.addEventListener('scroll', schedule, true);
        const onPanelAnimationEnd = (event: AnimationEvent) => { if ((event.target as HTMLElement).matches('.ttm-inspector, .ttm-inspector-content, .ttm-settings-category')) schedule(); };
        window.addEventListener('animationend', onPanelAnimationEnd);
        update(); node.focus({ preventScroll: true });
        return () => { cancelAnimationFrame(frame); resize.disconnect(); mutations.disconnect(); window.removeEventListener('resize', schedule); window.removeEventListener('scroll', schedule, true); window.removeEventListener('animationend', onPanelAnimationEnd); target.current?.removeAttribute('data-guide-active'); target.current = undefined; };
    }, [step, cue, paused, dialogOpen, mobile]);
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
    if (paused) return <div className="ttm-guide-paused"><button type="button" className="ttm-btn-primary" onClick={() => { navigate.current(step.id); setPaused(false); }}>继续引导 · {index + 1}/{steps.length}</button><button type="button" className="ttm-btn-secondary" onClick={onFinish}>结束引导</button></div>;
    const tryStep = () => {
        const anchor = target.current;
        if (!anchor || anchor.matches(':disabled')) return;
        if (cue.pause) setPaused(true);
        if (cue.interaction === 'focus') anchor.focus();
        else anchor.click();
    };
    const actionLabel = step.id === 'history' && !mobile && historyOpen ? '收起故事会话' : cue.action;
    const tip = <aside className="ttm-guide-tip" data-step={step.id} ref={panel} tabIndex={-1} role="region" aria-label="使用引导">
        <header><span>{index + 1} / {steps.length}</span><button type="button" className="ttm-btn-ghost" onClick={() => leave(onFinish)}>跳过引导</button></header>
        <div className="ttm-guide-step-copy" key={cue.title} aria-live="polite"><h2>{cue.title}</h2>{cue.paragraphs.map(paragraph => <p key={paragraph}>{paragraph}</p>)}</div>
        {!mobile && <button type="button" className="ttm-guide-action ttm-btn-secondary" disabled={!actionReady} onClick={tryStep}>{actionLabel}</button>}
        <footer><button type="button" className="ttm-btn-ghost" disabled={!index} onClick={() => setIndex(index - 1)}>上一步</button>
            {mobile && <button type="button" className="ttm-btn-secondary" disabled={!actionReady} onClick={tryStep}>{actionLabel}</button>}
            <button type="button" className="ttm-btn-primary" onClick={() => index === steps.length - 1 ? leave(onFinish) : setIndex(index + 1)}>{index === steps.length - 1 ? '完成引导' : '下一步'}</button></footer>
    </aside>;
    return mobile ? tip : createPortal(tip, document.body);
}

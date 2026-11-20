import { useEffect, useState } from 'react';
import { themeEngineStore } from '../theme/theme-engine';
import { resolveStreamLoadingSprite } from '../theme/loading-sprite';
import type { GenerationPhase } from '../theme/generation-presentation';
import { Icon } from '../shell/Icon';
import './runtime-status.css';

function stagePresentation(stage: string): { text: string; phase: GenerationPhase } | undefined {
    if (/连接/.test(stage)) return { text: '正在连接故事运行环境', phase: 'waiting' };
    if (/读取角色状态/.test(stage)) return { text: '正在读取故事与会话', phase: 'waiting' };
    if (/加载扩展|加载作者脚本|执行脚本回调|作者脚本入口/.test(stage)) return { text: '正在加载故事中的互动内容', phase: 'thinking' };
    if (/初始化 MVU/.test(stage)) return { text: '正在准备故事变量', phase: 'writing' };
    if (/生成角色消息界面|等待角色页面载入|准备故事事件|runtime.startup|确认故事状态/.test(stage)) return { text: '正在整理故事页面', phase: 'layout' };
}

export function CompatibilityLoading({ stage }: { stage: string }) {
    const sprite = themeEngineStore.useStore(state => state.streamLoadingSprite);
    const [presentation, setPresentation] = useState(() => stagePresentation(stage) ?? { text: '正在准备故事运行环境', phase: 'waiting' as GenerationPhase });
    useEffect(() => {
        const next = stagePresentation(stage);
        if (next) setPresentation(current => current.text === next.text ? current : next);
    }, [stage]);
    return <section className="tipsy-runtime-ui tipsy-runtime-loading" aria-label="故事加载状态" aria-busy="true">
        <div className="tipsy-runtime-loading-main">
            <div className="tipsy-runtime-loading-art" aria-hidden="true"><img src={resolveStreamLoadingSprite(sprite, presentation.phase)} alt="" width="80" height="80" /><span /></div>
            <div className="tipsy-runtime-loading-copy"><h3>正在准备故事内容</h3><p role="status" aria-live="polite">{presentation.text}</p></div>
        </div>
        <details className="tipsy-runtime-loading-details"><summary><Icon name="chevron" width={14} height={14} /><span>加载详情</span></summary><p>{stage || '等待兼容服务连接'}</p></details>
    </section>;
}

import defaultLoadingSprite from '../assets/loading-mascot.png?url';
import waitingSprite from '../assets/loading-waiting.png?url';
import thinkingSprite from '../assets/loading-thinking.png?url';
import writingSprite from '../assets/loading-writing.png?url';
import layoutSprite from '../assets/loading-layout.png?url';
import errorSprite from '../assets/loading-error.png?url';
import type { GenerationPhase } from './generation-presentation';

export const loadingCharacters: Record<GenerationPhase, { image: string; name: string }> = {
    error: { image: errorSprite, name: '回复失败 · 抹泪少女' },
    stopped: { image: defaultLoadingSprite, name: '回复停止' },
    waiting: { image: waitingSprite, name: '等待 · 送信少女' },
    thinking: { image: thinkingSprite, name: '构思 · 星灯魔女' },
    writing: { image: writingSprite, name: '书写 · 羽笔作家' },
    layout: { image: layoutSprite, name: '排版 · 画稿少女' },
    page: { image: defaultLoadingSprite, name: '页面 · 捧书少女' },
};

/** An empty setting follows the bundled default, without persisting a build URL. */
export function resolveStreamLoadingSprite(custom?: string, phase: GenerationPhase = 'waiting'): string {
    return phase === 'error' || phase === 'stopped' ? loadingCharacters[phase].image : custom || loadingCharacters[phase].image;
}

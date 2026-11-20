import { generationPresentation, type GenerationPhase } from '../theme/generation-presentation';
import { resolveStreamLoadingSprite } from '../theme/loading-sprite';
import { themeEngineStore } from '../theme/theme-engine';
import './generation-activity.css';

export function GenerationActivity({ phase = 'waiting' }: { phase?: GenerationPhase }) {
    const sprite = themeEngineStore.useStore(state => state.streamLoadingSprite);
    const presentation = generationPresentation[phase];
    return <div className="tipsy-generation-activity is-visible" data-phase={phase} role="status" aria-label={`${presentation.text} · ${presentation.detail}`} title={presentation.detail}>
        <span className="tipsy-generation-art" aria-hidden="true"><img className="tipsy-generation-sprite" src={resolveStreamLoadingSprite(sprite, phase)} alt="" /><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d={presentation.mark} /></svg></span>
        <span className="tipsy-generation-copy">{presentation.text}</span>
    </div>;
}

import { useLayoutEffect, useRef } from 'react';
import type { MessageStreamPreview } from '../pipeline/streaming-message';
import { StreamingView } from './streaming-view';
import { themeEngineStore } from '../theme/theme-engine';
import { preserveReadingAnchor } from './stream-layout';

export function StreamingMessage({ preview, renderComponents = true }: { preview: MessageStreamPreview; renderComponents?: boolean }) {
    const root = useRef<HTMLDivElement>(null);
    const view = useRef<StreamingView>();
    useLayoutEffect(() => {
        view.current = new StreamingView(root.current!, () => themeEngineStore.getState().streamLoadingSprite, renderComponents);
        const refreshSprite = () => view.current?.refreshSprite();
        window.addEventListener('tipsy-theme-change', refreshSprite);
        return () => { window.removeEventListener('tipsy-theme-change', refreshSprite); const restore = root.current ? preserveReadingAnchor(root.current) : () => {}; view.current?.dispose(); view.current = undefined; requestAnimationFrame(restore); };
    }, [renderComponents]);
    useLayoutEffect(() => { view.current?.update(preview); }, [preview, renderComponents]);
    return <div ref={root} />;
}

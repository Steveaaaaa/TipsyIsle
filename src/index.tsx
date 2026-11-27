import { StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { AdaptiveWorkspaceApp } from './shell/AdaptiveWorkspaceApp';
import './reading-ui.css';

export * from './types';
export * from './core/png-chunk-codec';
export * from './core/platform-bridge';
export * from './registry/schema-registry';
export * from './store/scoped-variable-store';
export * from './store/workspace-store';
export * from './theme/theme-engine';
export * from './pipeline/normalizer';
export * from './pipeline/asset-serializer';
export * from './pipeline/card-compatibility';
export * from './pipeline/lorebook-scanner';
export * from './pipeline/macro-regex-engine';
export * from './pipeline/prompt-assembler';
export * from './pipeline/pipeline-worker-client';
export * from './sandbox/event-bus';
export * from './sandbox/slash-interpreter';
export * from './sandbox/SandboxFrame';

let mountedRoot: Root | null = null;

export function mountTipsyIsleApp(containerId = 'tipsy-isle-root'): void {
    if (typeof document === 'undefined') return;
    let container = document.getElementById(containerId);
    if (!container) {
        container = document.createElement('div');
        container.id = containerId;
        document.body.appendChild(container);
    }
    if (!mountedRoot) {
        mountedRoot = createRoot(container);
    }
    mountedRoot.render(
        <StrictMode>
            <AdaptiveWorkspaceApp />
        </StrictMode>,
    );
}

if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => mountTipsyIsleApp(), { once: true });
    } else {
        mountTipsyIsleApp();
    }
}

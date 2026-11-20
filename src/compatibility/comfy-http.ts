import { platformFetch } from '../core/native-runtime';
import { detectRuntimeFlavor } from '../core/platform-bridge';

export async function requestComfy(path: string, body: { url: string; prompt?: string }, signal: AbortSignal) {
    if (await detectRuntimeFlavor() === 'local-gateway') {
        const response = await fetch(`/api/tipsy-isle/extensions/comfy/${path.endsWith('/ping') ? 'ping' : 'generate'}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal,
        });
        const json = await response.json();
        if (!response.ok) throw new Error(json.error ?? `ComfyUI HTTP ${response.status}`);
        return json;
    }
    // Installed clients use the local platform HTTP transport.
    const { requestComfyEndpoint } = await import('../../server/comfy-transport.mjs');
    return requestComfyEndpoint(path.endsWith('/ping'), body, signal, platformFetch);
}

import { isNativeRuntime, platformFetch } from '../native-runtime';
import { detectRuntimeFlavor } from '../platform-bridge';
import { authToken, type LanStatus, type SealedPacket, type SyncPeer } from './protocol';

export async function lanControl(action: string, payload: Record<string, unknown> = {}): Promise<LanStatus> {
    if (isNativeRuntime()) return window.__TAURI_INTERNALS__!.invoke('tipsy_lan_control', { action, payload });
    if (await detectRuntimeFlavor() === 'browser-offline') throw new Error('局域网连接需要安装版，或通过 npm start 启动的网页版。');
    const response = await fetch('/api/tipsy-isle/lan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, payload }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? '局域网服务未启动，请重启本地网关');
    return result;
}
export async function requestPeer<T>(peer: Pick<SyncPeer, 'address' | 'secret'>, route: 'hello' | 'exchange', packet?: SealedPacket): Promise<T> {
    const token = await authToken(peer.secret);
    const response = isNativeRuntime()
        ? await platformFetch(`${peer.address}/${route}`, { method: route === 'hello' ? 'GET' : 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: packet ? JSON.stringify(packet) : undefined, signal: AbortSignal.timeout(20000) })
        : await fetch('/api/tipsy-isle/lan-request', { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ address: peer.address, secret: token, route, packet }), signal: AbortSignal.timeout(25000) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? '无法连接另一台设备，请检查地址、配对码和局域网连接');
    return result;
}

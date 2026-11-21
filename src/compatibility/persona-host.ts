import { workspaceStore, persistWorkspaceNow, selectPersona, worldbooksChanged, removeHelperPersona, saveHelperPersona } from '../store/workspace-store';
import type { UserPersona } from '../types';

export async function requestPersona(operation: string, params: Record<string, any>) {
    const state = workspaceStore.getState(); const name = String(params.name ?? 'current');
    const matches = name === 'current' ? state.personas.filter(item => item.avatar_id === state.activePersonaId)
        : state.personas.filter(item => item.avatar_id === name || item.name.toLowerCase() === name.toLowerCase());
    const previous = matches.length === 1 ? matches[0] : undefined;
    if (operation === 'select') return previous ? selectPersona(previous.avatar_id) : false;
    if (operation === 'delete') {
        if (!previous) return false;
        removeHelperPersona(previous.avatar_id);
    } else {
        const patch = params.value ?? {};
        if (operation === 'create' && (name === 'current' || matches.length || state.personas.some(item => item.avatar_id === patch.avatar_id))) return false;
        if (operation === 'replace' && !previous || matches.length > 1) throw new Error(`persona 不存在或名称不唯一：${name}`);
        const id = previous?.avatar_id ?? patch.avatar_id ?? `persona_${crypto.randomUUID()}.png`;
        const next: UserPersona = { avatar_id: id, avatar: id, image: '', name, title: '', description: '', position: 0, depth: 2, role: 0,
            lorebook: '', connections: [], is_default: false, ...previous, ...patch };
        next.avatar_id = id; next.avatar = id;
        if (patch.avatar instanceof Blob) next.image = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error); reader.readAsDataURL(patch.avatar);
        });
        else if (typeof patch.avatar === 'string') next.image = state.personas.find(item => item.avatar_id === patch.avatar)?.image ?? next.image;
        saveHelperPersona(next, !!previous);
    }
    await persistWorkspaceNow(); worldbooksChanged();
    return operation === 'replace' ? undefined : operation === 'delete' ? true : !previous;
}

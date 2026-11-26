import type { PluginApi } from '@tipsy-isle/plugin-sdk';

export async function bindings(api: Pick<PluginApi, 'models'>) {
    const all = await api.models.connections();
    const chats = all.filter((item) => item.kinds.includes('chat'));
    return {
        image: all.find((item) => item.kinds.includes('image')),
        chats: [...chats].sort((left, right) => rank(left.id) - rank(right.id)),
        embedding: all.find((item) => item.kinds.includes('embedding')),
    };
}

function rank(id: string) {
    if (id === 'current-mvu' || id.startsWith('mvu:')) return 0;
    if (id === 'current-chat') return 2;
    return 1;
}

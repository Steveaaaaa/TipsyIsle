import type { PluginApi, RouteAddress } from '@tipsy-isle/plugin-sdk';

type Api = Pick<PluginApi, 'index' | 'models' | 'tasks'>;

export const collection = 'scene-masters';

export function sceneKey(route: RouteAddress) {
    return `${route.chatId}/${route.routeId}`;
}

export async function recall(api: Api, route: RouteAddress, text: string, embedding?: string) {
    let vector: number[] | undefined;
    if (embedding) {
        try {
            const taskId = await api.models.start({
                kind: 'embedding',
                connection: embedding,
                texts: [text.slice(0, 2000)],
            });
            const task = await api.tasks.await(taskId);
            if (task.result?.kind === 'embedding' && task.result.vectors?.length) {
                vector = [...task.result.vectors[0]];
            }
        } catch {
            // Fall back to full-text index search when embedding fails or is unavailable.
        }
    }
    const hits = await api.index.search({
        collection,
        text: text.slice(0, 240),
        vector,
        limit: 6,
    });
    const hit = hits.find((item) => (item.value as { route?: string } | undefined)?.route === sceneKey(route));
    const value = hit?.value as { mediaId?: string; actors?: unknown } | undefined;
    const actors = Array.isArray(value?.actors)
        ? value.actors.filter((name): name is string => typeof name === 'string' && name.trim().length > 0)
        : undefined;
    return {
        prior: hit?.excerpt ?? '',
        vector,
        mediaId: value?.mediaId,
        actors,
    };
}

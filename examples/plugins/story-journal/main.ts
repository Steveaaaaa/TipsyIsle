import { definePlugin, type Json, type PluginApi } from '@tipsy-isle/plugin-sdk';

type Note = { key: string; text: string; floor: number | null };
const excerpt = (text: string) => text.replace(/<(script|style|think|thinking|UpdateVariable)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/```[\s\S]*?```/g, '').replace(/<%[\s\S]*?%>|<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

async function readNotes(api: Pick<PluginApi, 'storage'> | { storage: Pick<PluginApi['storage'], 'read'> }) {
    const value = (await api.storage.read('route')).values.notes;
    if (!Array.isArray(value)) return [];
    return value.flatMap(item => {
        if (!item || typeof item !== 'object' || Array.isArray(item) || !('key' in item) || !('text' in item) || !('floor' in item)
            || typeof item.key !== 'string' || typeof item.text !== 'string') return [];
        return [{ key: item.key, text: item.text, floor: typeof item.floor === 'number' ? item.floor : null }] satisfies Note[];
    });
}
const recent = (api: Pick<PluginApi, 'settings'>, notes: Note[]) => notes.slice(-Math.floor(Number(api.settings.remember) || 12));

export default definePlugin({
    async onReplySaved(api, event) {
        const reply = await api.story.getMessage(event.reply);
        if (!reply || reply.hidden) return;
        const text = excerpt(reply.summary ?? reply.text).slice(0, 175);
        if (!text) return;
        const notes = (await readNotes(api)).filter(note => note.key !== event.reply.swipeId);
        notes.push({ key: event.reply.swipeId, floor: reply.floor, text });
        await api.storage.patch('route', { set: { notes: recent(api, notes) as Json[] }, operationId: event.id });
    },
    async contribute(api) {
        if (!api.settings.contribute) return;
        const notes = await readNotes(api);
        if (!notes.length) return;
        const heading = (await api.resources.readText('prompt-title.txt')).trim();
        const recentText = notes.slice(-3).map(note => `· ${note.text}`).join('\n').slice(-112);
        return { text: `${heading}\n${recentText}` };
    },
    commands: {
        async journal(api, input) {
            let notes = await readNotes(api);
            if (input.action?.id === 'save' && typeof input.action.values.note === 'string' && input.action.values.note.trim()) {
                notes = recent(api, [...notes, { key: `manual:${Date.now()}:${Math.random().toString(36).slice(2)}`, floor: null, text: input.action.values.note.trim().slice(0, 240) }]);
                await api.storage.patch('route', { set: { notes: notes as Json[] } });
            }
            return { title: '剧情手记', blocks: notes.length ? [{ type: 'list', items: notes.map(note => `${note.floor === null ? '手写' : `第 ${note.floor} 楼`} · ${note.text}`) }]
                : [{ type: 'text', text: '这条路线还没有手记。' }],
                fields: [{ id: 'note', label: '补一条手记', type: 'textarea', required: true }],
                actions: [{ id: 'save', label: '保存手记', kind: 'primary' }],
            };
        },
    },
});

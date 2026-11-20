import { definePlugin, type Panel } from '@tipsy-isle/plugin-sdk';

const plain = (text: string) => text.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<[^>]+>/g, '').replace(/^[\s*>#]+/, '').trim();
function optionsFrom(text: string) {
    const tagged = [...text.matchAll(/<(?:options|choices|action[-_]options)\b[^>]*>([\s\S]*?)<\/(?:options|choices|action[-_]options)>/gi)].at(-1)?.[1];
    const heading = /(?:^|\n)\s*(?:#{1,6}\s*)?(?:\*\*)?(?:行动选项|可选行动|选择你的行动|接下来你想|选项|Your choices|Options)[^\n]*\n/gi;
    const header = [...text.matchAll(heading)].at(-1);
    const region = tagged ?? (header ? text.slice(header.index! + header[0].length) : text);
    const html = [...region.matchAll(/<(?:li|option)\b[^>]*>([\s\S]*?)<\/(?:li|option)>/gi)].map(match => plain(match[1]));
    const lines = region.split('\n').map(line => plain(line));
    let matches = html.length > 1 && (tagged || header) ? html : lines.flatMap(line => {
        const numbered = /^(?:\*\*)?(?:[A-HＡ-Ｈ]|[1-9１-９])\s*[.．、)）：:]\s*(.+)$/i.exec(line);
        const bullet = (tagged || header) && /^[-•]\s+(.+)$/.exec(line);
        return numbered || bullet ? [(numbered || bullet)![1].replace(/^\*\*|\*\*$/g, '').trim()] : [];
    });
    matches = [...new Set(matches.filter(value => value.length > 0 && value.length <= 240))];
    return matches.length >= 2 ? matches.slice(0, 8) : [];
}

export default definePlugin({ commands: {
    async choose(api, input) {
        const message = input.target && await api.story.getMessage(input.target);
        if (!message) return { title: '行动选项', blocks: [{ type: 'text', text: '这条回复暂时不可读取。' }] };
        const options = optionsFrom(message.text);
        const previous = (await api.storage.read('reply')).values.selected;
        let selected = typeof previous === 'string' ? previous : '';
        if (input.action) {
            const option = /^choose_([0-7])$/.exec(input.action.id);
            const value = option ? options[Number(option[1])] : input.action.id === 'custom' ? input.action.values.action : '';
            if (typeof value === 'string' && value.trim()) {
                selected = value.trim().slice(0, 240);
                await api.storage.patch('reply', { set: { selected } });
                await api.ui.replaceDraft(selected);
            }
        }
        const panel: Panel = { title: '行动选项', blocks: [{ type: 'text', text: selected ? `已填入草稿：${selected}`
            : options.length ? '选择下一步行动。草稿可以随时改选。' : '这条回复没有可识别的选项。' }] };
        if (options.length) panel.actions = options.map((option, index) => ({ id: `choose_${index}`, label: `${String.fromCharCode(65 + index)} · ${option.slice(0, 84)}`,
            kind: option === selected ? 'primary' : 'secondary' }));
        else {
            panel.fields = [{ id: 'action', label: '自己的行动', type: 'textarea', initial: selected, required: true }];
            panel.actions = [{ id: 'custom', label: '填入草稿', kind: 'primary' }];
        }
        return panel;
    },
} });

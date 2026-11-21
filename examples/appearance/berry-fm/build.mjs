import { readFile, writeFile } from 'node:fs/promises';

const local = name => new URL(name, import.meta.url);
const files = {
    day: ['day.webp', 'image/webp'],
    night: ['night.webp', 'image/webp'],
    tuning: ['tuning.svg', 'image/svg+xml'],
    mark: ['mark.svg', 'image/svg+xml'],
    signal: ['signal.svg', 'image/svg+xml'],
};
const assets = Object.fromEntries(await Promise.all(Object.entries(files).map(async ([id, [name, mime]]) => {
    const contents = await readFile(local(name));
    return [id, { name, mime, data: `data:${mime};base64,${contents.toString('base64')}` }];
})));

const pack = {
    version: 1,
    name: '草莓电台 · Berry FM',
    text: {
        subtitle: 'BERRY FM',
        workspace: '草莓电台',
        location: '故事频道',
        library: '故事馆藏',
        empty: '今天想听哪段故事？',
        'empty-library': '故事频道等你回来',
        'startup-title': '找一个喜欢的频道',
        'startup-status': '正在接收信号…',
        input: '写一句对白，或一个动作…',
    },
    art: { logo: 'mark', welcome: 'day', startup: 'day' },
    assets,
    fonts: {},
    wallpaper: { source: '', fit: 'cover', position: 'center', shade: 0 },
    layout: { desktop: { sidebar: ['widget-berry-clock', 'appearance', 'sidebar-settings'] }, mobile: {} },
    widgets: [{ id: 'widget-berry-clock', label: '本地时间', value: 'time', image: 'signal', action: '' }],
    css: await readFile(local('skin.css'), 'utf8'),
};

await writeFile(local('草莓电台.tipsy-appearance.json'), `${JSON.stringify(pack, null, 2)}\n`);

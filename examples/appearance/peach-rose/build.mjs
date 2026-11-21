import { readFile, writeFile } from 'node:fs/promises';

const local = name => new URL(name, import.meta.url);
const images = {
    folio: ['folio.webp', 'image/webp'],
    'mobile-folio': ['mobile-folio.webp', 'image/webp'],
    seal: ['seal.webp', 'image/webp'],
    ornament: ['ornament.svg', 'image/svg+xml'],
    mark: ['mark.svg', 'image/svg+xml'],
    send: ['send.svg', 'image/svg+xml'],
};
const assets = Object.fromEntries(await Promise.all(Object.entries(images).map(async ([id, [name, mime]]) => {
    const bytes = await readFile(local(name));
    return [id, { name, mime, data: `data:${mime};base64,${bytes.toString('base64')}` }];
})));

const pack = {
    version: 1,
    name: '蜜桃蔷薇',
    text: {
        subtitle: 'PÊCHE & ROSE',
        workspace: '蜜桃蔷薇',
        location: '故事与来信',
        library: '蔷薇书架',
        empty: '一封故事，等你开笔',
        'empty-library': '蔷薇书笺',
        'startup-title': '把故事写进柔软的花色里。',
        'startup-status': '正在展开书笺…',
        input: '写下一句对白，或一个动作…',
    },
    art: { logo: 'mark', welcome: 'seal', startup: 'seal', send: 'send' },
    assets,
    fonts: {},
    wallpaper: { source: 'folio', fit: 'cover', position: 'center', shade: 0 },
    layout: { desktop: {}, mobile: {} },
    widgets: [],
    css: await readFile(local('skin.css'), 'utf8'),
};

await writeFile(local('蜜桃蔷薇.tipsy-appearance.json'), `${JSON.stringify(pack, null, 2)}\n`);

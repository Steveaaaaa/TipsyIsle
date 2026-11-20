import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../data/extension-media/', import.meta.url));
const imageTypes = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp' };
function name(value) {
    const text = String(value ?? '');
    if (!text || /[<>:"/\\|?*\x00-\x1f]/.test(text) || text.startsWith('.') || /[ .]$/.test(text)) throw new Error('文件名无效');
    return text;
}
function mediaPath(url) {
    const [prefix, kind, ...parts] = url.replace(/^\//, '').split('/').map(decodeURIComponent);
    if (prefix !== 'user' || !(kind === 'images' && (parts.length === 1 || parts.length === 2) || kind === 'files' && parts.length === 1)) throw new Error('扩展媒体路径无效');
    return path.join(root, kind, ...parts.map(name));
}
const urlFor = (kind, ...parts) => `/user/${kind}/${parts.map(encodeURIComponent).join('/')}`;
const entries = (folder) => fs.readdir(folder, { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error; });

export async function extensionMediaRequest(route, body) {
    if (route === '/api/images/folders') return (await entries(path.join(root, 'images'))).filter(entry => entry.isDirectory()).map(entry => entry.name);
    if (route === '/api/images/list' || route.startsWith('/api/images/list/')) {
        const folder = body.folder ?? (route.startsWith('/api/images/list/') ? decodeURIComponent(route.slice('/api/images/list/'.length)) : '');
        const directory = path.join(root, 'images', folder ? name(folder) : '');
        const files = (await entries(directory)).filter(entry => entry.isFile()).map(entry => entry.name);
        if (body.sortField === 'name') files.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
        else {
            const times = new Map(await Promise.all(files.map(async file => [file, (await fs.stat(path.join(directory, file))).mtimeMs])));
            files.sort((a, b) => times.get(a) - times.get(b));
        }
        return body.sortOrder === 'desc' ? files.reverse() : files;
    }
    if (route === '/api/files/verify') {
        return Object.fromEntries(await Promise.all(body.urls.map(async url => [url, await fs.stat(mediaPath(url)).then(stat => stat.isFile(), () => false)])));
    }
    if (route.endsWith('/delete')) {
        await fs.unlink(mediaPath(body.path)).catch(error => { if (error.code === 'ENOENT') error.status = 404; throw error; });
        return { ok: true };
    }
    const image = route === '/api/images/upload';
    const format = String(body.format ?? '').toLowerCase();
    if (image && !Object.hasOwn(imageTypes, format)) throw new Error('图片格式不支持');
    const filename = image ? `${path.parse(name(body.filename || Date.now())).name}.${format}` : name(body.name);
    const url = urlFor(image ? 'images' : 'files', ...(image && body.ch_name ? [name(body.ch_name)] : []), filename);
    const file = mediaPath(url);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, Buffer.from(String(image ? body.image : body.data).replace(/^data:[^,]*,/, ''), 'base64'));
    return { path: url };
}

export async function openExtensionMedia(url) {
    const file = mediaPath(url);
    const stat = await fs.stat(file);
    if (!stat.isFile()) throw new Error('Not found');
    const extension = path.extname(file).slice(1).toLowerCase();
    return { file, size: stat.size, type: imageTypes[extension] ?? (extension === 'json' ? 'application/json' : 'application/octet-stream') };
}

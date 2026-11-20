import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../data/galleries');
export function galleryFile(story, relative = '') {
    if (!/^[\w~-]+$/.test(story)) throw new Error('无效的故事标识');
    const directory = path.join(root, story);
    const file = path.resolve(directory, relative);
    if (file !== directory && !file.startsWith(directory + path.sep)) throw new Error('无效的图库路径');
    return file;
}
export async function writeGallery(story, relative, data) {
    if (relative !== 'manifest.json' && !/\.(png|jpe?g|webp|gif|avif|svg|bmp)$/i.test(relative)) throw new Error('图库仅接受图片');
    const file = galleryFile(story, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, data);
    if (relative === 'manifest.json') {
        const manifest = JSON.parse(data.toString('utf8'));
        const directory = galleryFile(story);
        for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
            if (entry.isDirectory() && entry.name !== manifest.version) await fs.rm(path.join(directory, entry.name), { recursive: true });
        }
    }
}
export async function removeGallery(story) { await fs.rm(galleryFile(story), { recursive: true, force: true }); }

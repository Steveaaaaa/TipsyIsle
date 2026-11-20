export interface StoryGallery { version: string; name: string; files: string[]; bytes: number }
export interface GalleryImage { path: string; data: ArrayBuffer }
export const galleryImagePattern = /\.(?:png|jpe?g|webp|gif|avif|svg|bmp)$/i;
export function galleryPath(value: string): string {
    const path = value.replace(/\\/g, '/').replace(/^\.\//, '');
    if (!path || path.startsWith('/') || path.split('/').some(part => part === '..' || part.includes(':'))) throw new Error('图库中含有无效路径');
    return path;
}

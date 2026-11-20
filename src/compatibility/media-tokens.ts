/** Historical Helper estimates, independent of provider billing/tokenization. */
export async function getImageTokenCost(dataUrl: string, quality: 'low' | 'auto' | 'high'): Promise<number> {
    if (quality === 'low') return 85;
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve(); image.onerror = () => reject(new Error('无法读取图片尺寸'));
        image.src = dataUrl;
    });
    const width = image.naturalWidth, height = image.naturalHeight;
    if (quality === 'auto' && width <= 512 && height <= 512) return 85;
    const firstScale = 2048 / Math.min(width, height);
    const scaled = [Math.round(width * firstScale), Math.round(height * firstScale)];
    const scale = 768 / Math.min(...scaled);
    return 85 + 170 * scaled.reduce((tiles, side) => tiles * Math.ceil(Math.round(side * scale) / 512), 1);
}
// The pinned Helper API itself uses a constant estimate; this does not decode video.
export async function getVideoTokenCost(_dataUrl: string): Promise<number> { return 1000; }

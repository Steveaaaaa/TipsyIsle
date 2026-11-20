import { unzipSync } from 'fflate';
import { createExtractorFromData } from 'node-unrar-js';
import wasmUrl from 'node-unrar-js/esm/js/unrar.wasm?url';
import { galleryPath, galleryImagePattern, type GalleryImage } from './gallery-types';

self.onmessage = async (event: MessageEvent<{ data: ArrayBuffer; password?: string }>) => {
    try {
        const bytes = new Uint8Array(event.data.data);
        const files: GalleryImage[] = [];
        const add = (name: string, data: Uint8Array) => files.push({ path: galleryPath(name), data: new Uint8Array(data).buffer });
        if (bytes[0] === 0x52 && bytes[1] === 0x61 && bytes[2] === 0x72) {
            const wasmBinary = await (await fetch(wasmUrl)).arrayBuffer();
            const extractor = await createExtractorFromData({ data: event.data.data, wasmBinary, password: event.data.password });
            for (const file of extractor.extract({ files: header => !header.flags.directory && galleryImagePattern.test(header.name) }).files) {
                if (file.extraction) add(file.fileHeader.name, file.extraction);
            }
        } else if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
            for (const [name, data] of Object.entries(unzipSync(bytes, { filter: entry => galleryImagePattern.test(entry.name) }))) add(name, data);
        } else throw new Error('请选择 RAR 或 ZIP 格式的图库压缩包');
        if (!files.length) throw new Error('压缩包内没有支持的图片文件');
        (self as unknown as Worker).postMessage({ files }, files.map(file => file.data));
    } catch (error) { self.postMessage({ error: error instanceof Error ? error.message : String(error) }); }
};

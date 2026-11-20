import { characterPngAvatar, extractCharacterCardFromPngAsync } from './png-chunk-codec';
import { normalizeCharacterCard } from '../pipeline/normalizer';

self.onmessage = async (event: MessageEvent<{ file: Blob; png: boolean }>) => {
    try {
        const { file, png } = event.data;
        const bytes = png ? new Uint8Array(await file.arrayBuffer()) : undefined;
        const document = bytes ? (await extractCharacterCardFromPngAsync(bytes))?.parsed : JSON.parse(await file.text());
        if (!document) throw new Error('PNG 文件中未检测到 chara 或 ccv3 角色卡数据块');
        const card = normalizeCharacterCard(document);
        if (bytes) card.avatar = await characterPngAvatar(bytes);
        self.postMessage({ card });
    } catch (error) { self.postMessage({ error: error instanceof Error ? error.message : String(error) }); }
};

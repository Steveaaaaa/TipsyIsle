const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) {
            c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        }
        table[n] = c >>> 0;
    }
    return table;
})();

export function crc32(bytes: Uint8Array): number {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) {
        c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
}

function readUint32BE(buf: Uint8Array, offset: number): number {
    return (
        ((buf[offset]! << 24) >>> 0) +
        ((buf[offset + 1]! << 16) >>> 0) +
        ((buf[offset + 2]! << 8) >>> 0) +
        (buf[offset + 3]! >>> 0)
    );
}

function writeUint32BE(buf: Uint8Array, offset: number, value: number): void {
    buf[offset] = (value >>> 24) & 0xff;
    buf[offset + 1] = (value >>> 16) & 0xff;
    buf[offset + 2] = (value >>> 8) & 0xff;
    buf[offset + 3] = value & 0xff;
}

function bytesToBase64(bytes: Uint8Array): string {
    let binary = '';
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
        const sub = bytes.subarray(i, i + chunkSize);
        binary += String.fromCharCode(...sub);
    }
    return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
    const clean = base64.replace(/[\r\n\s]/g, '');
    const binary = atob(clean);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        out[i] = binary.charCodeAt(i);
    }
    return out;
}

export interface ExtractedPngCardPayload {
    specVersion: 'v3' | 'v2';
    keyword: 'ccv3' | 'chara';
    rawJson: string;
    parsed: Record<string, unknown>;
}

interface PngChunk { type: string; data: Uint8Array; raw: Uint8Array }
function readChunks(bytes: Uint8Array): PngChunk[] {
    if (bytes.length < 8 || !PNG_SIGNATURE.every((value, index) => bytes[index] === value)) throw new Error('无效的 PNG 签名');
    const chunks: PngChunk[] = [];
    for (let offset = 8; offset + 12 <= bytes.length;) {
        const length = readUint32BE(bytes, offset);
        const end = offset + 12 + length;
        if (end > bytes.length) throw new Error('PNG 数据块已截断');
        const type = new TextDecoder().decode(bytes.subarray(offset + 4, offset + 8));
        if (crc32(bytes.subarray(offset + 4, end - 4)) !== readUint32BE(bytes, end - 4)) throw new Error(`PNG ${type} 数据块 CRC 校验失败`);
        chunks.push({ type, data: bytes.subarray(offset + 8, end - 4), raw: bytes.subarray(offset, end) });
        if (type === 'IEND') return chunks;
        offset = end;
    }
    throw new Error('PNG 缺少完整 IEND 数据块');
}

function textChunk(chunk: PngChunk): { keyword: string; bytes: Uint8Array; compressed: boolean } | null {
    if (!['tEXt', 'iTXt', 'zTXt'].includes(chunk.type)) return null;
    const data = chunk.data;
    const nul = data.indexOf(0);
    if (nul < 1) return null;
    const keyword = new TextDecoder().decode(data.subarray(0, nul)).toLowerCase();
    if (keyword !== 'chara' && keyword !== 'ccv3') return null;
    if (chunk.type === 'tEXt') return { keyword, bytes: data.subarray(nul + 1), compressed: false };
    if (chunk.type === 'zTXt') {
        if (data[nul + 1] !== 0) throw new Error('PNG zTXt 压缩方法不受支持');
        return { keyword, bytes: data.subarray(nul + 2), compressed: true };
    }
    if (![0, 1].includes(data[nul + 1]!) || data[nul + 2] !== 0) throw new Error('PNG iTXt 压缩头无效');
    const languageEnd = data.indexOf(0, nul + 3);
    const translatedEnd = data.indexOf(0, languageEnd + 1);
    if (languageEnd < 0 || translatedEnd < 0) throw new Error('PNG iTXt 文本头已截断');
    return { keyword, bytes: data.subarray(translatedEnd + 1), compressed: data[nul + 1] === 1 };
}

function parsePayload(keyword: string, bytes: Uint8Array): ExtractedPngCardPayload | null {
    try {
        const rawJson = new TextDecoder('utf-8', { fatal: true }).decode(base64ToBytes(new TextDecoder().decode(bytes)));
        const parsed = JSON.parse(rawJson);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
        return { keyword: keyword as 'chara' | 'ccv3', specVersion: keyword === 'ccv3' ? 'v3' : 'v2', rawJson, parsed };
    } catch { return null; }
}

/** Async path additionally supports PNG zTXt and compressed iTXt, without canvas decoding. */
export async function extractCharacterCardFromPngAsync(bytes: Uint8Array): Promise<ExtractedPngCardPayload | null> {
    const candidates = readChunks(bytes).map(textChunk).filter(item => item !== null);
    for (const keyword of ['ccv3', 'chara']) {
        for (const candidate of candidates.slice().reverse()) {
            if (candidate.keyword !== keyword) continue;
            let text = candidate.bytes;
            if (candidate.compressed) {
                const decompressed = new Blob([new Uint8Array(text).buffer]).stream().pipeThrough(new DecompressionStream('deflate'));
                const reader = decompressed.getReader();
                const parts: Uint8Array[] = [];
                let length = 0;
                try {
                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        length += value.length;
                        if (length > 32 * 1024 * 1024) throw new Error('PNG 角色卡元数据超过 32 MiB 限制');
                        parts.push(value);
                    }
                } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
                text = new Uint8Array(length);
                let offset = 0;
                for (const part of parts) { text.set(part, offset); offset += part.length; }
            }
            const parsed = parsePayload(keyword, text);
            if (parsed) return parsed;
        }
    }
    return null;
}

/** Keep original image chunks, but do not store a second copy of the card JSON in its avatar. */
export function characterPngAvatar(bytes: Uint8Array): Promise<string> {
    const parts = [PNG_SIGNATURE, ...readChunks(bytes).filter(chunk => !textChunk(chunk)).map(chunk => chunk.raw)];
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(new Blob(parts.map(part => new Uint8Array(part).buffer), { type: 'image/png' }));
    });
}

function createTextChunk(keyword: string, base64Text: string): Uint8Array {
    const encoder = new TextEncoder();
    const keyBytes = encoder.encode(keyword);
    const valBytes = encoder.encode(base64Text);
    const dataLength = keyBytes.length + 1 + valBytes.length;
    const chunk = new Uint8Array(12 + dataLength);

    writeUint32BE(chunk, 0, dataLength);
    chunk[4] = 0x74; // t
    chunk[5] = 0x45; // E
    chunk[6] = 0x58; // X
    chunk[7] = 0x74; // t
    chunk.set(keyBytes, 8);
    chunk[8 + keyBytes.length] = 0;
    chunk.set(valBytes, 8 + keyBytes.length + 1);

    const crcVal = crc32(chunk.subarray(4, 8 + dataLength));
    writeUint32BE(chunk, 8 + dataLength, crcVal);
    return chunk;
}

export function embedCharacterCardIntoPng(
    sourcePngBytes: Uint8Array,
    cardPayload: Record<string, unknown>,
): Uint8Array {
    const encoder = new TextEncoder();
    const jsonBytes = encoder.encode(JSON.stringify(cardPayload));
    const base64Str = bytesToBase64(jsonBytes);

    const v2 = cardPayload.spec === 'chara_card_v3'
        ? { ...cardPayload, spec: 'chara_card_v2', spec_version: '2.0' } : cardPayload;
    const charaChunk = createTextChunk('chara', bytesToBase64(encoder.encode(JSON.stringify(v2))));
    const ccv3Chunk = cardPayload.spec === 'chara_card_v3' ? createTextChunk('ccv3', base64Str) : null;

    const keptChunks: Uint8Array[] = [PNG_SIGNATURE];
    for (const chunk of readChunks(sourcePngBytes)) {
        if (textChunk(chunk)) continue;
        if (chunk.type === 'IEND') {
            keptChunks.push(charaChunk, ...(ccv3Chunk ? [ccv3Chunk] : []), chunk.raw);
            break;
        }
        keptChunks.push(chunk.raw);
    }

    const totalLength = keptChunks.reduce((acc, part) => acc + part.length, 0);
    const output = new Uint8Array(totalLength);
    let cursor = 0;
    for (const part of keptChunks) {
        output.set(part, cursor);
        cursor += part.length;
    }
    return output;
}

import { decodeStoryFile, encodeStoryFile } from './story-save-format';
import type { ArchivedChat } from '../store/chat-archives';
import type { NormalizedCharacterCard } from '../types';

self.onmessage = async (event: MessageEvent<{ file: File } | { chat: ArchivedChat; character: NormalizedCharacterCard; images?:import('./story-plugin-archive').PackedImage[] }>) => {
    const request = event.data;
    try {
        if ('file' in request) self.postMessage({ result: await decodeStoryFile(request.file) });
        else {
            const result = await encodeStoryFile(request.chat, request.character,request.images);
            self.postMessage({ result }, { transfer: [result.buffer] });
        }
    } catch (error) { self.postMessage({ error: error instanceof Error ? error.message : String(error) }); }
};

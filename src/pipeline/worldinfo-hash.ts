import type { LorebookEntry } from '../types';
import { contentHash } from './content-hash';
import { parseWorldInfoDecorators } from './worldinfo-decorators';

/** Capture before request-only macro/preprocessing changes. No hash field hashes itself. */
export function worldinfoHash(entry: LorebookEntry): number {
    const { hash: _hash, entry: _entry, reason: _reason, matchedKeys: _matches, estimatedTokens: _tokens, ...source } = entry;
    const parsed = parseWorldInfoDecorators(entry.content);
    return contentHash(JSON.stringify({ ...source, content: parsed.content, decorators: parsed.decorators.map(item => item.source) }));
}

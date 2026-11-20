export type TokenizerSelection = 'auto' | 'cl100k_base' | 'o200k_base' | 'estimate';
type Counter = (text: string) => number;
const counters = new Map<string, Promise<Counter>>();

export function estimateTokenCount(text: string): number {
    let cjk = 0;
    for (let index = 0; index < text.length; index++) if (text.charCodeAt(index) >= 0x2e80 && text.charCodeAt(index) <= 0x9fff) cjk++;
    return Math.ceil(cjk * 1.4 + (text.length - cjk) / 3.8);
}

/** Dictionary imports are lazy; unchanged prompt fragments share a bounded count cache. */
export async function prepareTokenCounter(model = '', selection: TokenizerSelection = 'auto'): Promise<Counter> {
    if (selection === 'estimate') return estimateTokenCount;
    const encoding = selection === 'auto' ? /^(?:gpt-(?:4o|4\.1|5|6)|o[1-9])(?:[-.]|$)/i.test(model) ? 'o200k_base' : 'cl100k_base' : selection;
    if (!counters.has(encoding)) counters.set(encoding, (async () => {
        const tokenizer = encoding === 'o200k_base' ? await import('gpt-tokenizer/encoding/o200k_base') : await import('gpt-tokenizer/encoding/cl100k_base');
        const counts = new Map<string, number>();
        let cachedCharacters = 0;
        const options = { disallowedSpecial: new Set<string>() };
        return (text: string) => {
            if (!text) return 0;
            const cached = counts.get(text); if (cached !== undefined) return cached;
            const count = tokenizer.countTokens(text, options);
            if (text.length < 250000) {
                while (counts.size >= 2048 || cachedCharacters + text.length > 2000000) {
                    const first = counts.keys().next().value!; counts.delete(first); cachedCharacters -= first.length;
                }
                counts.set(text, count); cachedCharacters += text.length;
            }
            return count;
        };
    })());
    return counters.get(encoding)!;
}

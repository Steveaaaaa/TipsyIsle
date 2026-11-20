// cyrb53 (c) 2018 bryc, public domain. Same algorithm as the pinned host.
export function contentHash(text: string, seed = 0): number {
    let a = 0xdeadbeef ^ seed, b = 0x41c6ce57 ^ seed;
    for (let index = 0; index < text.length; index++) {
        const char = text.charCodeAt(index);
        a = Math.imul(a ^ char, 2654435761); b = Math.imul(b ^ char, 1597334677);
    }
    a = Math.imul(a ^ (a >>> 16), 2246822507) ^ Math.imul(b ^ (b >>> 13), 3266489909);
    b = Math.imul(b ^ (b >>> 16), 2246822507) ^ Math.imul(a ^ (a >>> 13), 3266489909);
    return 4294967296 * (2097151 & b) + (a >>> 0);
}

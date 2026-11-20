type StoryIdentitySource = { name: string; characterVersion?: string };

// Only a trailing release label is presentation metadata. Bare integers and
// ordinary parenthesized title text remain part of the author's title.
const number = String.raw`\d+(?:[.．]\d+){0,3}(?:[-._]?(?:alpha|beta|rc|preview|test)\d*)?(?:\+[A-Za-z0-9.-]+)?`;
const marker = String.raw`(?:v(?:er(?:sion)?)?\.?|版本(?:号)?\s*[:：]?)`;
const release = String.raw`(?:${marker}\s*${number}|\d+(?:[.．]\d+){1,3}(?:[-._]?(?:alpha|beta|rc|preview|test)\d*)?(?:\+[A-Za-z0-9.-]+)?)`;
const bracketed = new RegExp(String.raw`\s*[（(【\[]\s*(${release})\s*(?:版)?\s*[）)】\]]\s*$`, 'i');
const marked = new RegExp(String.raw`\s*(?:[-_—·]\s*)?(?<![A-Za-z])${marker}\s*(${number})\s*(?:版)?\s*$`, 'i');
const dotted = new RegExp(String.raw`\s*(?:[-_—·]\s*)?(\d+(?:[.．]\d+){1,3}(?:[-._]?(?:alpha|beta|rc|preview|test)\d*)?(?:\+[A-Za-z0-9.-]+)?)\s*(?:版)?\s*$`, 'i');

export function storyIdentity(card: StoryIdentitySource): { name: string; version: string; metadataVersion?: string } {
    const original = card.name.trim();
    const declared = card.characterVersion?.trim() ?? '';
    const match = bracketed.exec(original) ?? marked.exec(original) ?? dotted.exec(original);
    const name = match ? original.slice(0, match.index).trim() : original;
    const cutsNumber = match && /^\d/.test(match[0].trimStart()) && /[\d.．]$/.test(name);
    if (!match || !name || cutsNumber) return { name: original, version: declared };
    const normalizeVersion = (value: string) => value.replace(/^(?:version|ver\.?|v|版本(?:号)?\s*[:：]?)\s*/i, '').replace(/版$/, '').trim().replaceAll('．', '.');
    const version = normalizeVersion(match[1]);
    const declaredNumber = normalizeVersion(declared);
    return { name, version, ...(declared && declaredNumber.toLowerCase() !== version.toLowerCase() ? { metadataVersion: declared } : {}) };
}

/** Do not strip numbers from user names or separately named story characters. */
export function storySpeakerName(speaker: string, storyName: string): string {
    return speaker.trim() === storyName.trim() ? storyIdentity({ name: storyName }).name : speaker;
}

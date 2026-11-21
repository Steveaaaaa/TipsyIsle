export function formatCompatibilityWorldbooks(entries: Record<string, any>[]) {
    const before: string[] = [], after: string[] = [], ANBeforeEntries: string[] = [], ANAfterEntries: string[] = [];
    const EMEntries: Array<{ position: number; content: string }> = [];
    const depthBuckets = new Map<string, { depth: number; role: number; entries: string[] }>();
    const outletEntries: Record<string, string[]> = Object.create(null);
    for (const entry of [...entries].sort((a, b) => a.order - b.order)) {
        const { content, position } = entry;
        if (!content) continue;
        if (position === 0) before.push(content);
        else if (position === 1) after.push(content);
        else if (position === 2) ANBeforeEntries.push(content);
        else if (position === 3) ANAfterEntries.push(content);
        else if (position === 4) {
            const depth = entry.depth ?? 4, role = entry.role ?? 0, key = `${depth}:${role}`;
            if (!depthBuckets.has(key)) depthBuckets.set(key, { depth, role, entries: [] });
            depthBuckets.get(key)!.entries.push(content);
        } else if (position === 5 || position === 6) EMEntries.push({ position: position - 5, content });
        else if (position === 7 && entry.outletName) (outletEntries[entry.outletName] ??= []).push(content);
    }
    return { worldInfoBefore: before.join('\n'), worldInfoAfter: after.join('\n'), ANBeforeEntries, ANAfterEntries, EMEntries,
        WIDepthEntries: [...depthBuckets.values()], outletEntries, allActivatedEntries: new Set(entries) };
}

export function helperRenderDepth(value: unknown): number {
    const depth = Number(value);
    return Number.isFinite(depth) ? Math.max(0, Math.floor(depth)) : 0;
}
/** Keep the opening page running; other floors can also load as the reader approaches. */
export function preloadsMessageHtml(index: number, total: number, depth: number): boolean {
    return index === 0 || index >= total - (depth || 4);
}

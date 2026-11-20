export function helperRenderDepth(value: unknown): number {
    const depth = Number(value);
    return Number.isFinite(depth) ? Math.max(0, Math.floor(depth)) : 0;
}
/** TavernHelper counts from the newest message; zero renders every floor. */
export function rendersMessageHtml(index: number, total: number, depth: number): boolean {
    return depth === 0 || index >= total - depth;
}

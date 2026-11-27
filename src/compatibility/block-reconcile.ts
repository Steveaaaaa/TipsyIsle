import { contentHash } from '../pipeline/content-hash';

export type ReconcilableBlockType = 'markdown' | 'html' | 'mixed';

export function blockContentKey(
    type: ReconcilableBlockType,
    content: string,
    occurrence: number,
): string {
    return `${type}:${content.length}:${contentHash(content).toString(36)}#${occurrence}`;
}

/** Compute Longest Common Subsequence matches between old and new block key lists so
 * kept DOM elements remain in strictly increasing order and never need to be moved. */
export function computeKeptBlockIndices(
    oldKeys: readonly string[],
    newKeys: readonly string[],
): { keepOld: Set<number>; keepNew: Map<number, number> } {
    const m = oldKeys.length;
    const n = newKeys.length;
    const keepOld = new Set<number>();
    const keepNew = new Map<number, number>();
    if (!m || !n) return { keepOld, keepNew };

    const stride = n + 1;
    const dp = new Uint16Array((m + 1) * stride);
    for (let i = m - 1; i >= 0; i--) {
        const a = oldKeys[i];
        const row = i * stride;
        const nextRow = (i + 1) * stride;
        for (let j = n - 1; j >= 0; j--) {
            dp[row + j] = a === newKeys[j]
                ? dp[nextRow + j + 1] + 1
                : Math.max(dp[nextRow + j], dp[row + j + 1]);
        }
    }

    let i = 0;
    let j = 0;
    while (i < m && j < n) {
        if (oldKeys[i] === newKeys[j]) {
            keepOld.add(i);
            keepNew.set(j, i);
            i++;
            j++;
        } else if (dp[(i + 1) * stride + j] >= dp[i * stride + j + 1]) {
            i++;
        } else {
            j++;
        }
    }

    return { keepOld, keepNew };
}

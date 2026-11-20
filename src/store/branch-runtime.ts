let pending = 0;
export const pendingBranchOperations = () => pending;
export function beginBranchOperation(): () => void {
    pending++;
    return () => {
        if (--pending === 0) globalThis.window?.dispatchEvent(new Event('tipsy-branch-operations-idle'));
    };
}
export async function runBranchOperation<T>(operation: () => T | Promise<T>): Promise<T> {
    const done = beginBranchOperation();
    try { return await operation(); } finally { done(); }
}
export const mutatesStory = (method: string) => /^(variables\.(replace|insert|delete)|chat\.(set|create|delete|rotate)|worldbook\.|legacy\.save|scripts\.replace|extensions\.settings|slash\.|composer\.send|generation\.|mvu\.|template\.commit|story\.retry)/.test(method)
    && !/\.(get|read|load|list|models)$/.test(method);

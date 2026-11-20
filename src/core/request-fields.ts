/** Shared body exclusions follow the author's dotted JSON paths. */
export function excludeRequestFields(body: Record<string, unknown>, paths: string[] = []): void {
    for (const path of paths) {
        const keys = path.split('.');
        if (keys.some(key => ['__proto__', 'constructor', 'prototype'].includes(key))) continue;
        let target: any = body;
        for (const key of keys.slice(0, -1)) target = target?.[key];
        if (target && typeof target === 'object') delete target[keys.at(-1)!];
    }
}

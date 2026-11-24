const INTERACTIVE_MENU_SELECTOR = '.list-group-item, [role="button"], button, a';

/**
 * SillyTavern extensions typically mount `<div class="extension_container">`
 * wrapping an interactive `.list-group-item[role="button"]` that owns `onclick`.
 * Clicking the interactive descendant triggers both its direct handler and any
 * delegated listener attached to the outer container.
 */
export function resolveExtensionMenuActionTarget<T extends {
    matches(selector: string): boolean;
    querySelector(selector: string): T | null;
}>(child: T): T {
    if (child.matches(INTERACTIVE_MENU_SELECTOR)) return child;
    return child.querySelector(INTERACTIVE_MENU_SELECTOR) ?? child;
}

export function collectExtensionActionTargets<T extends {
    matches(selector: string): boolean;
    querySelector(selector: string): T | null;
}>(
    extensionMenu: { children: Iterable<T> },
    extensionTopBar: { querySelectorAll(selector: string): Iterable<T> },
    composerMount: { querySelectorAll(selector: string): Iterable<T> },
): T[] {
    const targets: T[] = [];
    const seen = new Set<T>();
    const add = (item: T) => {
        if (seen.has(item)) return;
        seen.add(item);
        targets.push(item);
    };
    for (const child of extensionMenu.children) add(resolveExtensionMenuActionTarget(child));
    for (const item of extensionTopBar.querySelectorAll('.drawer-toggle')) add(item);
    for (const item of composerMount.querySelectorAll('.qr--button, button')) add(item);
    return targets;
}

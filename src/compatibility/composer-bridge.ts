let value = '';
let update: ((text: string) => void) | undefined;
let submit: ((text: string) => Promise<void>) | undefined;
let choice: { start: number; end: number } | undefined;
function publish(text: string): void {
    window.dispatchEvent(new CustomEvent('tipsy-composer-value', { detail: text }));
}
export function connectCompatibilityComposer(current: string, listener: (text: string) => void): () => void {
    const changed = value !== current;
    value = current; update = listener;
    if (changed) { choice = undefined; publish(current); }
    return () => { if (update === listener) update = undefined; };
}
function setDraft(text: string) {
    if (value === text) return value;
    value = text; update?.(text); publish(text);
    return value;
}
export function compatibilityComposer(text?: string): string {
    if (text === undefined) return value;
    choice = undefined;
    return setDraft(text);
}
export function editCompatibilityComposer(text: string) {
    if (choice && text !== value) {
        let prefix = 0, suffix = 0;
        while (prefix < value.length && prefix < text.length && value[prefix] === text[prefix]) prefix++;
        while (suffix < value.length - prefix && suffix < text.length - prefix && value.at(-1 - suffix) === text.at(-1 - suffix)) suffix++;
        if (prefix < choice.end) {
            if (value.length - suffix <= choice.start) {
                const shift = text.length - value.length;
                choice = { start: choice.start + shift, end: choice.end + shift };
            } else choice = undefined;
        }
    }
    return setDraft(text);
}
export function stageCompatibilityChoice(text: string, placement: 'replace' | 'before' | 'after' = 'replace', separator = '') {
    const draft = choice ? value.slice(0, choice.start) + value.slice(choice.end) : value;
    if (placement === 'replace' || !draft) {
        choice = text ? { start: 0, end: text.length } : undefined;
        return setDraft(text);
    }
    const inserted = placement === 'before' ? text + separator : separator + text;
    choice = placement === 'before' ? { start: 0, end: inserted.length } : { start: draft.length, end: draft.length + inserted.length };
    return setDraft(placement === 'before' ? inserted + draft : draft + inserted);
}
export function applyCompatibilityComposerWrite(text: string, previous: string) {
    if (previous && text.length > previous.length) {
        if (text.startsWith(previous)) {
            const addition = text.slice(previous.length);
            return stageCompatibilityChoice(addition.trimStart(), 'after', addition.match(/^\s*/)?.[0]);
        }
        if (text.endsWith(previous)) {
            const addition = text.slice(0, -previous.length);
            return stageCompatibilityChoice(addition.trimEnd(), 'before', addition.match(/\s*$/)?.[0]);
        }
    }
    return stageCompatibilityChoice(text);
}
export function connectCompatibilityComposerSubmit(listener: (text: string) => Promise<void>): () => void {
    submit = listener;
    return () => { if (submit === listener) submit = undefined; };
}
export function submitCompatibilityComposer(text: string): Promise<void> {
    if (!submit) return Promise.reject(new Error('对话发送入口尚未挂载'));
    return submit(text);
}

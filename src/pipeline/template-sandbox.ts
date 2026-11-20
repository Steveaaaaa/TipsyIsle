// Template host views keep data reads while restricting the documented command/writer members.
const restrictedMembers: Record<string, (name: string) => boolean> = {
    SillyTavern: name => ['executeSlashCommands', 'executeSlashCommandsWithOptions', 'registerSlashCommand', 'ConnectionManagerRequestService',
        'generate', 'generateRaw', 'generateQuietPrompt', 'generateRawData', 'sendGenerationRequest', 'sendStreamingRequest',
        'importFromExternalUrl', 'importTags', 'getRequestHeaders'].includes(name) || name.startsWith('SlashCommand') || /^(save|write|delete|update|register|unregister)[A-Z]/.test(name),
    quickReplyApi: name => /^(execute|create|update|delete|toggle|add|remove|clear)/.test(name),
};
function templateHostView(name: string, host: any): any {
    const denied = restrictedMembers[name];
    if (!denied || !host) return host;
    const bound = new Map<PropertyKey, { source: Function; value: Function }>();
    return new Proxy({}, {
        get: (_target, key) => {
            if (typeof key === 'string' && denied(key)) return undefined;
            const value = Reflect.get(host, key, host);
            if (typeof value !== 'function') return value;
            const cached = bound.get(key); if (cached && cached.source === value) return cached.value;
            const fn = name === 'SillyTavern' && key === 'getContext'
                ? (...args: any[]) => templateHostView(name, value.apply(host, args)) : value.bind(host);
            bound.set(key, { source: value, value: fn }); return fn;
        },
        has: (_target, key) => !(typeof key === 'string' && denied(key)) && key in host,
        ownKeys: () => Reflect.ownKeys(host).filter(key => !(typeof key === 'string' && denied(key))),
        getOwnPropertyDescriptor: (_target, key) => typeof key === 'string' && denied(key) || !(key in host) ? undefined : { enumerable: true, configurable: true },
    });
}

/** Template-local realm inside the existing author origin, not a process boundary. */
export class TemplateSandbox {
    private readonly frame: HTMLIFrameElement;
    private readonly win: Window & typeof globalThis;
    private readonly functions = new WeakMap<Function, Function>();
    private destroyed = false;
    constructor() {
        this.frame = document.createElement('iframe');
        this.frame.hidden = true;
        this.frame.setAttribute('sandbox', 'allow-scripts allow-same-origin');
        document.body.append(this.frame);
        this.win = this.frame.contentWindow as Window & typeof globalThis;
        const doc = this.win.document;
        doc.open();
        doc.write(`<!doctype html><meta http-equiv="Content-Security-Policy" content="connect-src 'none'; img-src 'none'; form-action 'none'; frame-src 'none'">`);
        doc.close();
        const native = new Set(Reflect.ownKeys(this.win));
        for (const key of Reflect.ownKeys(window)) {
            if (native.has(key) || typeof key === 'string' && (/^\d+$/.test(key) || /^(?:\$|jQuery\d*|localforage)$/.test(key))) continue;
            try { Reflect.set(this.win, key, templateHostView(String(key), Reflect.get(window, key))); } catch { /* read-only browser globals */ }
        }
        for (const key of ['parent', 'top', 'frameElement']) {
            try { Object.defineProperty(this.win, key, { get: () => null }); } catch { /* browser may reserve the property */ }
        }
        Object.assign(this.win, { fetch: undefined, XMLHttpRequest: undefined });
    }
    async run<T>(fn: (...args: any[]) => T, args: any[], context: object, thisData: any): Promise<Awaited<T>> {
        if (this.destroyed) throw new Error('模板沙盒已关闭');
        Object.assign(this.win, context);
        let executable = this.functions.get(fn);
        if (!executable) { executable = this.win.eval(`(${fn.toString()})`); this.functions.set(fn, executable!); }
        return await executable!.apply(thisData, args);
    }
    destroy(immediately = false): void {
        if (this.destroyed && !immediately) return;
        this.destroyed = true;
        if (immediately) this.frame.remove(); else setTimeout(() => this.frame.remove(), 100);
    }
    destroyIframe(): void { this.destroy(true); }
}

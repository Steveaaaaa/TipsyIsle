import ejs from 'ejs';

// Compilation only. Author callbacks and variables never leave their runtime.
self.onmessage = (event: MessageEvent<{ id: number; source: string; options: Record<string, unknown> }>) => {
    const { id, source, options } = event.data;
    try { self.postMessage({ id, code: ejs.compile(source, { ...options, client: true, cache: false }).toString() }); }
    catch (error) { self.postMessage({ id, error: error instanceof Error ? error.message : String(error) }); }
};

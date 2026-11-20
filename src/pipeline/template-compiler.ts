import ejs from 'ejs';

const raw = (value: unknown) => value == null ? '' : String(value);
let compilerWorker: Worker | undefined;
let compilerSequence = 0;
const compilations = new Map<number, { resolve(code: string): void; reject(error: Error): void }>();
function workerCompile(source: string, options: Record<string, unknown>): Promise<string> {
    if (!compilerWorker) {
        compilerWorker = new Worker(new URL('./template-compile.worker.ts', import.meta.url), { type: 'module' });
        compilerWorker.onmessage = ({ data }) => {
            const task = compilations.get(data.id); if (!task) return; compilations.delete(data.id);
            if (data.error) task.reject(new Error(data.error)); else task.resolve(data.code);
        };
        compilerWorker.onerror = event => {
            for (const task of compilations.values()) task.reject(new Error(event.message || '模板编译 Worker 已停止'));
            compilations.clear(); compilerWorker?.terminate(); compilerWorker = undefined;
        };
    }
    return new Promise((resolve, reject) => {
        const id = ++compilerSequence; compilations.set(id, { resolve, reject });
        try { compilerWorker!.postMessage({ id, source, options }); }
        catch (error) { compilations.delete(id); reject(error); }
    });
}
export interface TemplateCompileOptions {
    options?: Record<string, any>;
    escaper?: (value: unknown) => string;
    includer?: (path: string, parsedPath?: string) => { filename?: string; template?: string };
    sandbox?: { run(fn: (...args: any[]) => any, args: any[], options: object, context: any): unknown } | null;
}

/** Compile code in a same-origin Worker; hydrate and execute only in the author realm. */
export async function compileAuthorTemplate(source: string, options: TemplateCompileOptions = {}, thisData?: Record<string, any>, background = false) {
    if (typeof source !== 'string') throw new Error('模板源码必须为字符串');
    const settings = { async: true, compileDebug: true, outputFunctionName: 'print', ...options.options,
        client: true, cache: false };
    const { escape: _escape, escapeFunction: _escapeFunction, includer: _includer, ...workerSettings } = settings as Record<string, any>;
    const fn = background ? new Function(`return (${await workerCompile(source, workerSettings)})`)() : ejs.compile(source, settings);
    return function(this: unknown, data: Record<string, any> = {}, sandbox = options.sandbox) {
        // In client mode the pinned plugin passes this callback directly; it is
        // not EJS renderFile's filesystem includer or an implicit nested render.
        const args = [data, options.escaper ?? raw, options.includer ?? ((path: string) => ({ filename: path, template: '' }))];
        return sandbox ? sandbox.run(fn, args, {}, thisData ?? this) : (fn as (...args: any[]) => any).apply(this, args);
    };
}

/** Compilation only; neither template nor author callbacks run here. */
export function templateSyntaxError(source: string, count = 4): string {
    try { ejs.compile(source, { async: true, compileDebug: true, client: true, outputFunctionName: 'print' }); return ''; }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const line = /(?:line|ejs:)\s*(\d+)/i.exec(message);
        if (!line) return message;
        const index = Number(line[1]) - 1; const radius = Math.max(0, Math.min(100, Number(count) || 0));
        return `${source.split('\n').slice(Math.max(0, index - radius), index + radius + 1).join('\n')}\n${message}`;
    }
}

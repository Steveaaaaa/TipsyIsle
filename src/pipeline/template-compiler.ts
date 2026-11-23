import ejs from 'ejs';

const raw = (value: unknown) => value == null ? '' : String(value);

export function safeRethrow(err: unknown, str: string, flnm: string | undefined, lineno: number, esc: (value: unknown) => string): never {
    const lines = str.split('\n');
    const start = Math.max(lineno - 3, 0);
    const end = Math.min(lines.length, lineno + 3);
    const filename = esc(flnm);
    const context = lines.slice(start, end).map((line, i) => {
        const curr = i + start + 1;
        return `${curr === lineno ? ' >> ' : '    '}${curr}| ${line}`;
    }).join('\n');
    const rawMessage = err instanceof Error || (err && typeof err === 'object' && 'message' in err)
        ? String((err as { message?: unknown }).message ?? '')
        : String(err);
    const errorName = err && typeof err === 'object' && 'name' in err ? String((err as { name?: unknown }).name ?? '') : '';
    const detail = errorName && rawMessage && !rawMessage.startsWith(errorName) ? `${errorName}: ${rawMessage}` : (rawMessage || errorName || String(err));
    const wrapped = new Error(`${filename || 'ejs'}:${lineno}\n${context}\n\n${detail}`, { cause: err });
    (wrapped as Error & { path?: string }).path = filename;
    throw wrapped;
}
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

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as FunctionConstructor;
const JS_IDENTIFIER = /^[a-zA-Z_$][0-9a-zA-Z_$]*$/;

export function compileStandaloneEjs(source: string, options: Record<string, any> = {}): (...args: any[]) => any {
    const templ = new (ejs as any).Template(source, options);
    const opts = templ.opts;
    templ.generateSource();
    let prepended = '  let __output = "";\n  function __append(s) { if (s !== undefined && s !== null) __output += s }\n';
    let appended = '';
    if (opts.outputFunctionName) {
        if (!JS_IDENTIFIER.test(opts.outputFunctionName)) throw new Error('outputFunctionName is not a valid JS identifier.');
        prepended += `  let ${opts.outputFunctionName} = __append;\n`;
    }
    const localsName = opts.localsName || 'locals';
    if (!JS_IDENTIFIER.test(localsName)) throw new Error('localsName is not a valid JS identifier.');
    if (opts.destructuredLocals?.length) {
        const parts = opts.destructuredLocals.map((name: string) => {
            if (!JS_IDENTIFIER.test(name)) throw new Error(`destructuredLocals contains invalid identifier: ${name}`);
            return `${name} = __locals.${name}`;
        });
        prepended += `  let __locals = (${localsName} || {}),\n  ${parts.join(',\n  ')};\n`;
    }
    if (opts._with !== false) {
        prepended += `  with (${localsName} || {}) {\n`;
        appended += '  }\n';
    }
    appended += '  return __output;\n';
    const body = prepended + templ.source + appended;
    const sanitizedFilename = opts.filename ? JSON.stringify(opts.filename) : 'undefined';
    let src = opts.compileDebug
        ? `let __line = 1, __lines = ${JSON.stringify(templ.templateText)}, __filename = ${sanitizedFilename};\ntry {\n${body}} catch (e) {\n  rethrow(e, __lines, __filename, __line, escapeFn);\n}\n`
        : body;
    if (opts.strict) src = `"use strict";\n${src}`;
    const ctor = opts.async ? AsyncFunction : Function;
    return new ctor(`${localsName}, escapeFn, include, rethrow`, src) as (...args: any[]) => any;
}

/** Compile code in a same-origin Worker; hydrate and execute only in the author realm. */
export async function compileAuthorTemplate(source: string, options: TemplateCompileOptions = {}, thisData?: Record<string, any>, background = false) {
    if (typeof source !== 'string') throw new Error('模板源码必须为字符串');
    const settings = { async: true, compileDebug: true, outputFunctionName: 'print', ...options.options, cache: false };
    const { escape: _escape, escapeFunction: _escapeFunction, includer: _includer, ...workerSettings } = settings as Record<string, any>;
    const fn = background ? new Function(`return (${await workerCompile(source, workerSettings)})`)() : compileStandaloneEjs(source, settings);
    return function(this: unknown, data: Record<string, any> = {}, sandbox = options.sandbox) {
        // In client mode the pinned plugin passes this callback directly; it is
        // not EJS renderFile's filesystem includer or an implicit nested render.
        const args = [data, options.escaper ?? raw, options.includer ?? ((path: string) => ({ filename: path, template: '' })), safeRethrow];
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

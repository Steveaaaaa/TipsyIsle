import { parseSlashArguments, splitSlashPipeline, takeSlashToken, unquoteSlash } from './slash-syntax';
import { compareSlash, SlashClosure, SlashScope, slashAssignIndex, slashIndexed, slashKey, slashOutput, slashTruthy } from './slash-scope';
import type { ExecutableQuickReply } from './quick-reply';
import { SlashCommandAbortController, SlashCommandBreakController, SlashCommandClosureResult } from './slash-control';
export { splitSlashPipeline } from './slash-syntax';
export { SlashClosure, SlashScope } from './slash-scope';

/** Host-independent execution shared by the UI, Helper and template realm. */
export interface SlashVariableAccess {
    get(key: string, global: boolean): unknown;
    set(key: string, value: unknown, global: boolean): void;
    delete(key: string, global: boolean): void;
}
export interface SlashExecutionHost {
    variables: SlashVariableAccess;
    expand?(text: string): string;
    echo?(text: string): void;
    send?(text: string): void | Promise<void>;
    system?(text: string): void | Promise<void>;
    generate?(text?: string): void | Promise<void | string>;
    command?(name: string, named: Record<string, unknown>, value: unknown, scope: SlashScope): Promise<unknown>;
    hasCommand?(name: string): boolean;
    quickReply?(name: string): ExecutableQuickReply | undefined;
    executeQuickReply?(reply: ExecutableQuickReply, args: Record<string, unknown>, scope: SlashScope): Promise<unknown>;
    signal?: AbortSignal;
}
export interface SlashExecutionOptions { scope?: SlashScope; signal?: AbortSignal; abortController?: SlashCommandAbortController;
    breakController?: SlashCommandBreakController; handleExecutionErrors?: boolean; pipe?: unknown; result?: SlashCommandClosureResult }
interface ExecutionResult { pipe: unknown; stop?: 'return' | 'break' | 'abort' }
const aliases: Record<string, string> = { setchatvar: 'setvar', getchatvar: 'getvar', addchatvar: 'addvar', incchatvar: 'incvar', decchatvar: 'decvar', flushchatvar: 'flushvar', delvar: 'flushvar', length: 'len' };
const arithmetic = new Set(['add', 'mul', 'sub', 'div', 'mod', 'pow', 'min', 'max', 'sin', 'cos', 'log', 'round', 'abs', 'sqrt']);
const parsedCache = new Map<string, string[]>();
function stagesFor(source: string): string[] {
    let stages = parsedCache.get(source);
    if (!stages) {
        stages = splitSlashPipeline(source);
        if (parsedCache.size >= 128) parsedCache.delete(parsedCache.keys().next().value!);
        parsedCache.set(source, stages);
    }
    return stages;
}

export async function executeSlashPipeline(source: string, host: SlashExecutionHost, options: SlashExecutionOptions = {}): Promise<string> {
    let ticks = 0;
    const abortController = options.abortController ?? new SlashCommandAbortController();
    const breakController = options.breakController ?? new SlashCommandBreakController();
    const interrupted = new Error('Slash execution aborted');
    const root = options.scope ?? new SlashScope();
    if (options.pipe !== undefined) root.pipe = options.pipe;
    const checkpoint = async () => {
        host.signal?.throwIfAborted();
        options.signal?.throwIfAborted();
        if (abortController.signal.paused && !abortController.signal.aborted) await new Promise<void>(resolve => {
            const resume = () => { abortController.removeEventListener('continue', resume); abortController.removeEventListener('abort', resume); resolve(); };
            abortController.addEventListener('continue', resume, { once: true }); abortController.addEventListener('abort', resume, { once: true });
        });
        if (abortController.signal.aborted) throw interrupted;
        // Yield long author loops without delaying ordinary command chains.
        if (++ticks % 64 === 0) await new Promise<void>(resolve => setTimeout(resolve, 0));
    };
    const numeric = (value: unknown): unknown => typeof value === 'string' && value.trim() && !Number.isNaN(Number(value)) ? Number(value) : value;
    const resolve = (value: unknown, scope: SlashScope): unknown => {
        if (typeof value !== 'string' || value === '') return value;
        if (!Number.isNaN(Number(value))) return Number(value);
        if (scope.owner(value)) return numeric(scope.get(value));
        return numeric(host.variables.get(value, false) ?? host.variables.get(value, true) ?? value);
    };
    const expand = (raw: string, scope: SlashScope): unknown => {
        const quoted = (raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"));
        const source = quoted ? raw.slice(1, -1) : raw;
        const macroValue = (body: string): unknown => {
            const [name, key, index] = body.split('::');
            if (name.toLowerCase() === 'pipe') return scope.pipe;
            if (name.toLowerCase() === 'var' && key) return slashIndexed(scope.get(key), index);
            if (name.toLowerCase() === 'getvar' && key) return slashIndexed(host.variables.get(key, false), index) ?? '';
            if (name.toLowerCase() === 'getglobalvar' && key) return slashIndexed(host.variables.get(key, true), index) ?? '';
            return scope.macro(body) ?? (name.toLowerCase() === 'arg' ? scope.macro('arg::*') : undefined);
        };
        const sole = /^\{\{([^{}]+)\}\}$/.exec(source);
        if (sole) { const value = macroValue(sole[1]); if (value instanceof SlashClosure) return value; }
        const escaped: string[] = [];
        let value = source.replace(/\\([\\|"'{}])/g, (_match, char) => `\u0000${escaped.push(char) - 1}\u0000`);
        value = value.replace(/\{\{([^{}]+)\}\}/g, (match, body) => {
            const value = macroValue(body); return value === undefined ? match : slashOutput(value);
        });
        value = host.expand?.(value) ?? value;
        return value.replace(/\u0000(\d+)\u0000/g, (_match, index) => escaped[Number(index)]);
    };
    const evaluate = async (raw: string, scope: SlashScope): Promise<unknown> => {
        const value = raw.trim();
        const closure = /^\{:([\s\S]*):\}(\(\))?$/.exec(value);
        if (!closure) return expand(raw, scope);
        const fn = new SlashClosure(closure[1], scope);
        fn.execute = () => invoke(fn, scope);
        return closure[2] ? (await invoke(fn, scope)).pipe : fn;
    };
    const invoke = async (value: unknown, caller: SlashScope, args: Record<string, unknown> = {}, macro?: [string, unknown]): Promise<ExecutionResult> => {
        const closure = value instanceof SlashClosure ? value : new SlashClosure(unquoteSlash(slashOutput(value)), caller);
        const child = new SlashScope(closure.scope);
        child.pipe = caller.pipe;
        if (macro) child.macros.set(...macro);
        const header = parseSlashArguments(closure.source);
        for (const [key, raw] of Object.entries(header.named)) child.declare(key, Object.hasOwn(args, key) ? args[key] : await evaluate(raw, caller));
        for (const [key, value] of Object.entries(args)) if (!child.values.has(key)) child.declare(key, value);
        for (const [key, value] of Object.entries(args)) child.macros.set(`arg::${key}`, value);
        return execute(header.text, child);
    };
    const execute = async (script: string, scope: SlashScope): Promise<ExecutionResult> => {
        let hasPipe = scope.pipe !== undefined && scope.pipe !== '';
        for (const stage of stagesFor(script)) {
            await checkpoint();
            if (breakController.isBreak) return { pipe: scope.pipe, stop: 'break' };
            if (stage.startsWith('//') || stage.startsWith('/#')) continue;
            const match = /^\/([\w-]+|:[^\s]+)(?:\s+([\s\S]*))?$/.exec(stage);
            let command = match ? match[1].toLowerCase() : 'pass';
            const argument = match ? match[2] ?? '' : stage;
            let closureName: string | undefined;
            if (command.startsWith(':')) { closureName = match![1].slice(1); command = 'run'; }
            command = aliases[command] ?? command;
            const parsed = command === 'pass' || command === 'return' ? { named: {} as Record<string, string>, text: argument, hasText: !!argument } : parseSlashArguments(argument);
            const named: Record<string, unknown> = Object.create(null);
            for (const [key, raw] of Object.entries(parsed.named)) named[key] = await evaluate(raw, scope);
            // These commands split an argument prefix from a deferred closure.
            // Expanding the whole string now would execute its macros too early.
            const deferred = command === 'let' || command === 'var' || command === 'times' || command === 'qr-create' || command === 'qr-update'
                || /^(set|add)(global)?var$/.test(command) && named.key === undefined;
            const value = parsed.hasText ? deferred ? parsed.text : await evaluate(parsed.text, scope) : hasPipe ? scope.pipe : '';
            const text = () => slashOutput(value);
            const finish = (next: unknown) => { scope.pipe = next ?? ''; hasPipe = true; };
            const commandArguments = () => ({ ...named, _abortController: abortController, _breakController: breakController });
            if (host.hasCommand?.(command) && host.command) { finish(await host.command(command, commandArguments(), value, scope)); continue; }
            if (command === 'pass' || command === 'echo') { if (command === 'echo') host.echo?.(text()); finish(value); continue; }
            if (command === 'abort') { abortController.abort(text(), slashTruthy(named.quiet)); return { pipe: scope.pipe, stop: 'abort' }; }
            if (command === 'return' || command === 'break') return { pipe: value, stop: command };
            if (command === 'delay') {
                await new Promise<void>(resolve => {
                    const done = () => { clearTimeout(timer); abortController.removeEventListener('abort', done); resolve(); };
                    const timer = setTimeout(done, Math.max(0, Number(value) || 0)); abortController.addEventListener('abort', done, { once: true });
                });
                await checkpoint(); continue;
            }
            if (command === 'sys' || command === 'send') {
                const send = command === 'sys' ? host.system : host.send;
                if (!send) throw new Error('当前模板阶段不能修改消息结构');
                await send(text()); finish(value); continue;
            }
            if (command === 'gen' || command === 'trigger') {
                if (!host.generate) throw new Error('当前模板阶段不能递归发起生成');
                const result = await host.generate(text() || undefined); if (typeof result === 'string') finish(result); continue;
            }
            if (command === 'let' || command === 'var') {
                const head = takeSlashToken(parsed.text);
                const key = slashKey(slashOutput(named.key ?? await evaluate(head.token, scope)));
                const hasValue = named.key !== undefined ? parsed.hasText || hasPipe : !!head.rest;
                const next = named.key !== undefined ? parsed.hasText ? await evaluate(parsed.text, scope) : scope.pipe : hasValue ? await evaluate(head.rest, scope) : undefined;
                if (command === 'let') { scope.declare(key, next); finish(next); }
                else if (hasValue) { scope.set(key, named.index === undefined ? next : slashAssignIndex(scope.get(key), String(named.index), next, named.as as string)); finish(next); }
                else finish(slashIndexed(scope.get(key), named.index as string | undefined));
                continue;
            }
            if (command === 'if' || command === 'while' || command === 'times' || command === 'run') {
                let result: ExecutionResult = { pipe: '' };
                const condition = () => compareSlash(named.rule as string | undefined,
                    resolve(named.a ?? named.left ?? named.first ?? named.x, scope), resolve(named.b ?? named.right ?? named.second ?? named.y, scope));
                if (command === 'if') {
                    const branch = condition() ? value : named.else;
                    if (branch !== undefined && branch !== '') result = await invoke(branch, scope);
                } else if (command === 'run') {
                    let fn: unknown = closureName ?? value;
                    if (typeof fn === 'string' && scope.owner(fn)) fn = scope.get(fn);
                    if (fn instanceof SlashClosure || typeof fn === 'string' && fn.trimStart().startsWith('/')) result = await invoke(fn, scope, named);
                    else {
                        const qr = host.quickReply?.(slashOutput(fn));
                        if (qr === undefined) throw new Error(`Slash 闭包或快捷回复不存在：${slashOutput(fn)}`);
                        if (host.executeQuickReply) result = { pipe: await host.executeQuickReply(qr, named, scope) };
                        else if (qr.disableSend) throw new Error('当前模板阶段不能修改快捷回复输入框');
                        else if (qr.message.startsWith('/')) result = await invoke(qr.message, scope, named);
                        else {
                            const qrScope = new SlashScope(scope);
                            for (const [key, value] of Object.entries(named)) qrScope.macros.set(`arg::${key}`, value);
                            const content = slashOutput(expand(qr.message, qrScope));
                            if (!qr.disableSend) {
                                if (!host.send) throw new Error('当前模板阶段不能发送快捷回复消息');
                                await host.send(content);
                            }
                            result = { pipe: content };
                        }
                    }
                } else {
                    let count = Number.MAX_SAFE_INTEGER, body = value;
                    if (command === 'times') {
                        const head = takeSlashToken(parsed.text); count = Number(resolve(await evaluate(head.token, scope), scope));
                        body = await evaluate(head.rest, scope);
                    }
                    const limit = Math.min(count, named.guard !== undefined && !slashTruthy(named.guard) ? Number.MAX_SAFE_INTEGER : 100);
                    for (let index = 0; index < limit && (command !== 'while' || condition()); index++) {
                        await checkpoint(); result = await invoke(body, scope, {}, ['timesIndex', index]);
                        if (result.stop === 'abort' || result.stop === 'break') break;
                    }
                }
                finish(result.pipe);
                if (result.stop === 'abort') return result;
                if (command === 'if' && result.stop === 'break') return result;
                continue;
            }
            if (command === 'closure-serialize') { if (!(value instanceof SlashClosure)) throw new Error('closure-serialize 需要闭包'); finish(slashOutput(value)); continue; }
            if (command === 'closure-deserialize') { finish(await evaluate(text(), scope)); continue; }
            if (arithmetic.has(command)) {
                const raw = text().trim(); const parts: unknown[] = raw.startsWith('[') ? JSON.parse(raw) : raw.split(/\s+/);
                const values = parts.filter(x => x !== '').map(x => Number(resolve(x, scope))).filter(x => !Number.isNaN(x));
                const [a = 0, b = 0] = values;
                const unary: Record<string, (value: number) => number> = { sin: Math.sin, cos: Math.cos, log: Math.log, round: Math.round, abs: Math.abs, sqrt: Math.sqrt };
                const result = !values.length ? 0 : unary[command] ? unary[command](a)
                    : command === 'add' ? values.reduce((x, y) => x + y, 0) : command === 'mul' ? values.reduce((x, y) => x * y, 1)
                    : command === 'sub' ? values.slice(1).reduce((x, y) => x - y, a) : command === 'min' ? Math.min(...values)
                    : command === 'max' ? Math.max(...values) : command === 'pow' ? Math.pow(a, b) : b === 0 ? 0 : command === 'div' ? a / b : a % b;
                finish(Number.isNaN(result) ? 0 : result); continue;
            }
            if (command === 'len' || command === 'sort') {
                let parsed: any = value; try { parsed = JSON.parse(text()); } catch { /* plain string */ }
                if (command === 'len') finish(parsed == null ? 0 : Array.isArray(parsed) || typeof parsed === 'string' ? parsed.length : typeof parsed === 'object' ? Object.keys(parsed).length : text().length);
                else {
                    const compare = (a: any, b: any) => { if (typeof a !== typeof b) { a = typeof a; b = typeof b; } return a > b ? 1 : a < b ? -1 : 0; };
                    finish(Array.isArray(parsed) ? parsed.sort(compare) : parsed && typeof parsed === 'object' ? Object.keys(parsed).sort((a, b) => named.keysort !== undefined && !slashTruthy(named.keysort) ? compare(parsed[a], parsed[b]) : compare(a, b)) : value);
                }
                continue;
            }
            if (command === 'rand') {
                const parts = text().split(/\s+/).filter(Boolean).map(Number);
                const from = Number(named.from ?? parts[0] ?? 0), to = Number(named.to ?? parts[1] ?? 1);
                const result = from + Math.random() * (to - from);
                finish(named.round === 'floor' ? Math.floor(result) : named.round === 'ceil' ? Math.ceil(result) : named.round === 'round' ? Math.round(result) : result); continue;
            }
            if (/^(set|get|add|inc|dec|flush)(global)?var$/.test(command)) {
                const global = command.includes('global'), setting = command.startsWith('set') || command.startsWith('add');
                let key = named.key === undefined ? undefined : String(named.key), next = value;
                if (!key && setting) {
                    const pair = takeSlashToken(parsed.text); key = slashOutput(await evaluate(pair.token, scope));
                    next = pair.rest ? await evaluate(pair.rest, scope) : hasPipe ? scope.pipe : '';
                    if (Object.keys(named).length === 1 && !Object.hasOwn(named, 'index') && !Object.hasOwn(named, 'as')) {
                        const shorthand = Object.entries(named)[0]; key = shorthand[0]; next = [shorthand[1], await evaluate(parsed.text, scope)].filter(Boolean).join(' ');
                    }
                } else if (!key) key = text();
                slashKey(key!);
                const current = host.variables.get(key!, global);
                if (command.startsWith('get')) finish(slashIndexed(current, named.index as string | undefined));
                else if (command.startsWith('set')) { host.variables.set(key!, named.index === undefined ? next : slashAssignIndex(current, String(named.index), next, named.as as string), global); finish(next); }
                else if (command.startsWith('flush')) { host.variables.delete(key!, global); finish(''); }
                else {
                    const delta = command.startsWith('dec') ? -1 : command.startsWith('inc') ? 1 : next;
                    let array: unknown; try { array = typeof current === 'string' ? JSON.parse(current) : current; } catch { /* plain value */ }
                    const updated = Array.isArray(array) ? [...array, delta] : !Number.isNaN(Number(current ?? 0)) && !Number.isNaN(Number(delta)) ? Number(current ?? 0) + Number(delta) : slashOutput(current) + slashOutput(delta);
                    host.variables.set(key!, Array.isArray(updated) ? JSON.stringify(updated) : updated, global); finish(updated);
                }
                continue;
            }
            if (host.command) { finish(await host.command(command, commandArguments(), value, scope)); continue; }
            throw new Error(`尚未接入 Slash 命令 /${command}`);
        }
        return { pipe: hasPipe ? scope.pipe : '' };
    };
    const result = options.result ?? new SlashCommandClosureResult();
    try {
        const output = await execute(source, root);
        result.pipe = slashOutput(output.pipe); result.isBreak = output.stop === 'break';
        result.isAborted = output.stop === 'abort' || abortController.signal.aborted;
    } catch (error) {
        result.pipe = slashOutput(root.pipe);
        if (error === interrupted || options.signal?.aborted || host.signal?.aborted) result.isAborted = true;
        else { result.isError = true; result.errorMessage = error instanceof Error ? error.message : String(error);
            if (options.handleExecutionErrors !== true) throw error; }
    }
    result.interrupt = result.isBreak || result.isAborted || result.isError;
    result.isQuietlyAborted = result.isAborted && abortController.signal.isQuiet;
    result.abortReason = result.isAborted ? abortController.signal.reason ?? String(options.signal?.reason ?? host.signal?.reason ?? '') : '';
    return result.pipe;
}

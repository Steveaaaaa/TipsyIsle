import variant from '@jitl/quickjs-wasmfile-release-sync';
import wasmUrl from '@jitl/quickjs-wasmfile-release-sync/wasm?url';
import { newQuickJSWASMModuleFromVariant, newVariant, type QuickJSDeferredPromise, type QuickJSHandle } from 'quickjs-emscripten-core';
import { guestExports } from '../../../packages/plugin-sdk/package-format.mjs';
import { isPromptMode, vmLimits, type VmJob, type VmRequest, type VmResponse } from './vm-protocol';

const host = self as unknown as DedicatedWorkerGlobalScope;
const post = (data: VmResponse) => host.postMessage(data);
let module: ReturnType<typeof newQuickJSWASMModuleFromVariant> | undefined;
let answer: ((data: Extract<VmRequest, { kind: 'answer' }>) => void) | undefined;

// Prepare the only guest-to-host reference before loading any plugin source.
const prepare = `((bridge) => {
    delete globalThis.__tipsy_bridge__;
    const parse = JSON.parse, serialize = JSON.stringify, freeze = Object.freeze, values = Object.values, isFrozen = Object.isFrozen, GuestError = Error;
    const immutable = value => {
        if (value && typeof value === 'object' && !isFrozen(value)) { freeze(value); for (const child of values(value)) immutable(child); }
        return value;
    };
    const call = async (method, args) => {
        const encoded = serialize(args ?? null);
        let result;
        try { result = await bridge(method, encoded); }
        catch (reason) {
            if (typeof reason !== 'string') throw reason;
            const fault = parse(reason), error = new GuestError(fault.message);
            error.name = 'PluginApiError'; error.code = fault.code; throw error;
        }
        return immutable(parse(result));
    };
    const ns = (name, methods, returnsVoid = []) => Object.fromEntries(methods.map(method => [method, args => {
        const result = call(name + '.' + method, args);
        return returnsVoid.includes(method) ? result.then(() => undefined) : result;
    }]));
    return async (exports, mode, inputText, apiText) => {
        const input = immutable(parse(inputText));
        const definition = exports?.default;
        if (mode === 'migrate' || mode === 'verify' && input.migration) {
            if (typeof definition !== 'function') throw new Error('迁移入口必须默认导出函数');
            return mode === 'verify' ? 'null' : serialize(await definition(input));
        }
        if (!definition || typeof definition !== 'object') throw new Error('插件入口必须默认导出插件定义');
        const callable = (value, name) => { if (typeof value !== 'function') throw new Error('缺少插件入口：' + name); return value; };
        if (mode === 'verify') {
            for (const id of input.commands) callable(definition.commands?.[id], id);
            if (input.events.includes('story.replySaved')) callable(definition.onReplySaved, 'onReplySaved');
            if (input.events.includes('story.replyCheckpoint')) callable(definition.onReplyCheckpoint, 'onReplyCheckpoint');
            if (input.events.includes('story.routeChanged')) callable(definition.onRouteChanged, 'onRouteChanged');
            if (input.events.includes('story.changed')) callable(definition.onStoryChange, 'onStoryChange');
            if (input.generation) callable(definition.contribute, 'contribute');
            for (const stage of input.pipeline) callable(definition[stage], stage);
            for (const tool of input.tools) callable(definition.tools?.[tool], tool);
            for (const service of input.services) for (const method of service.methods) callable(definition.services?.[service.id]?.[method], service.id + '.' + method);
            return 'null';
        }
        const { context, settings, hostApi } = parse(apiText), modern = hostApi !== '1.0.0';
        const director = hostApi === '1.2.0';
        const writes = ['command', 'replySaved', 'storyChanged', 'service', 'job', 'mediaAction', 'checkpoint'].includes(mode);
        const api = immutable({ hostApi, context: modern ? context : { story: context.story, target: context.target }, settings,
            story: { ...ns('story', ['getMessage']), readMessages: (options = {}) => call('story.readMessages', options),
                ...(director && ns('story', ['participants','visualSources'])),
                ...(modern && { ...ns('story', ['listRoutes', 'tree', 'version', 'readPage', 'readText', 'search', 'state', ...(writes ? ['preview', 'commit', 'undo'] : []),
                        ...(mode === 'command' ? ['open'] : [])], ['open']), listChats: (options = {}) => call('story.listChats', options),
                    changes: (options = {}) => call('story.changes', options) }) },
            storage: { ...ns('storage', ['read', ...(modern ? ['readAt', ...(writes ? ['patchAt'] : [])] : [])]), ...(writes && {
                patch: (scope, patch) => call('storage.patch', { scope, patch }).then(() => undefined) }) },
            ...(modern && { assets: ns('assets', ['list', 'get', 'entries', 'entry', ...(writes ? ['preview', 'commit', 'undo'] : [])]),
                host: ns('host', ['capabilities']), index: ns('index', writes ? ['search', 'put', 'remove'] : ['search'], ['put', 'remove']) }),
            ...(modern && writes && { models: ns('models', ['connections', 'start']), tasks: ns('tasks', ['read', 'cancel', 'embeddings', ...(director ? ['await'] : [])], ['cancel']), network: ns('network', ['request', 'download']),
                ...(director && { jobs: ns('jobs', ['schedule', 'awaitReply']),replyMedia:ns('replyMedia',['developing'],['developing']) }),
                media: { ...ns('media', ['put', 'remove', 'read', ...(director ? ['stats','reclaim'] : [])], ['remove']), list: (options = {}) => call('media.list', options) },
                ...(mode !== 'service' && { services: ns('services', ['list', 'call']) }) }),
            ...(mode === 'command' && { ui: { ...(director && ns('ui', ['export'], ['export'])), replaceDraft: text => call('ui.replaceDraft', text).then(() => undefined) } }),
            resources: { readText: path => call('resources.read', path) }, log: text => call('log', text).then(() => undefined),
        });
        let value;
        if (mode === 'command') value = await callable(definition.commands?.[input.id], input.id)(api, input);
        else if (mode === 'replySaved') value = await callable(definition.onReplySaved, 'onReplySaved')(api, input);
        else if (mode === 'checkpoint') value = await callable(definition.onReplyCheckpoint, 'onReplyCheckpoint')(api, input);
        else if (mode === 'job') value = await callable(definition.onJob, 'onJob')(api, input);
        else if (mode === 'mediaAction') value = await callable(definition.onMediaAction, 'onMediaAction')(api, input);
        else if (mode === 'routeChanged') value = await callable(definition.onRouteChanged, 'onRouteChanged')(api, input);
        else if (mode === 'storyChanged') value = await callable(definition.onStoryChange, 'onStoryChange')(api, input);
        else if (mode === 'service') value = await callable(definition.services?.[input.id]?.[input.method], input.method)(api, input);
        else if (mode === 'tool') value = await callable(definition.tools?.[input.id], input.id)(api, input);
        else value = await callable(definition[mode], mode)(api, input);
        return serialize(value ?? null);
    };
})(globalThis.__tipsy_bridge__)`;

async function run(job: VmJob) {
    const qjs = await (module ??= newQuickJSWASMModuleFromVariant(newVariant(variant, { wasmLocation: new URL(wasmUrl, host.location.href).href })));
    const runtime = qjs.newRuntime();
    runtime.setMemoryLimit(vmLimits.memory);
    runtime.setMaxStackSize(vmLimits.stack);
    let remaining: number = isPromptMode(job.mode) ? vmLimits.contributionCpu : vmLimits.cpu;
    let deadline = Infinity;
    runtime.setInterruptHandler(() => performance.now() >= deadline);
    const withCpu = <T>(run: () => T): T => {
        const start = performance.now(); deadline = start + remaining;
        try { return run(); }
        finally { remaining -= performance.now() - start; deadline = Infinity; }
    };
    const vm = runtime.newContext();
    const handles: QuickJSHandle[] = [];
    const own = (handle: QuickJSHandle) => (handles.push(handle), handle);
    const waiting = new Map<number, QuickJSDeferredPromise>();
    let requests = 0;
    const text = (handle: QuickJSHandle) => {
        if (vm.typeof(handle) !== 'string') throw new Error('插件返回值必须可序列化');
        const value = vm.getString(handle);
        if (value.length > vmLimits.packet) throw new Error('插件消息超过大小限制');
        return value;
    };
    try {
        const bridge = own(vm.newFunction('tipsyRpc', (method, args) => {
            if (job.mode === 'migrate' || job.mode === 'verify') throw new Error('此阶段不允许调用宿主');
            if (++requests > vmLimits.rpcCalls) throw new Error('插件操作超过接口调用次数限制');
            const data = { kind: 'rpc' as const, id: requests, method: text(method), args: text(args) };
            const deferred = vm.newPromise();
            waiting.set(requests, deferred);
            post(data);
            return deferred.handle;
        }));
        vm.setProp(vm.global, '__tipsy_bridge__', bridge);
        const result = withCpu(() => {
            const runner = own(vm.unwrapResult(vm.evalCode(prepare, 'tipsy-sdk.js')));
            if (job.mode === 'migrate' || isPromptMode(job.mode)) {
                // Read-only tasks do not observe device time or ambient randomness.
                vm.unwrapResult(vm.evalCode(`Date.now = () => 0; globalThis.Date = undefined; Math.random = () => { throw new Error('此阶段不提供随机数'); };`, 'tipsy-deterministic.js')).dispose();
            }
            vm.unwrapResult(vm.evalCode(job.code, 'plugin-entry.js')).dispose();
            return own(vm.unwrapResult(vm.callFunction(runner, vm.undefined, own(vm.getProp(vm.global, guestExports)), own(vm.newString(job.mode)),
                own(vm.newString(JSON.stringify(job.input))), own(vm.newString(JSON.stringify(job.api ?? null))))));
        });
        for (;;) {
            withCpu(() => {
                let executed = 0;
                while (runtime.hasPendingJob()) {
                    executed += vm.unwrapResult(runtime.executePendingJobs(32));
                    if (executed > 512 || performance.now() >= deadline) throw new Error('插件任务超过计算配额');
                }
            });
            if (remaining <= 0) throw new Error('插件任务超过计算配额');
            const state = vm.getPromiseState(result);
            if (state.type === 'fulfilled') {
                if (waiting.size) throw new Error('插件必须等待所有宿主调用完成');
                try { return text(state.value); }
                finally { if (!state.notAPromise) state.value.dispose(); }
            }
            if (state.type === 'rejected') withCpu(() => vm.unwrapResult(state));
            if (!waiting.size) throw new Error('插件异步任务没有可等待的宿主调用');
            await new Promise<void>((resolve, reject) => {
                answer = data => {
                    const deferred = waiting.get(data.id);
                    if (!deferred) return;
                    waiting.delete(data.id);
                    try {
                        withCpu(() => {
                            const value = vm.newString('error' in data ? JSON.stringify(data.error) : data.value);
                            try { if ('error' in data) deferred.reject(value); else deferred.resolve(value); }
                            finally { value.dispose(); }
                        });
                        resolve();
                    } catch (error) { reject(error); }
                    finally { deferred.dispose(); }
                };
            });
        }
    } finally {
        answer = undefined;
        for (const deferred of waiting.values()) deferred.dispose();
        for (const handle of handles.reverse()) handle.dispose();
        try { vm.dispose(); } finally { runtime.dispose(); }
    }
}

host.onmessage = (event: MessageEvent<VmRequest>) => {
    const data = event.data;
    const failure = (error: unknown) => post({ kind: 'done', error: (error instanceof Error ? error.message : String(error)).slice(0, 1200) || '插件执行失败' });
    if (data.kind === 'answer') { try { answer?.(data); } catch (error) { failure(error); } return; }
    void run(data.job).then(value => post({ kind: 'done', value }), failure);
};

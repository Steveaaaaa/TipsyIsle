import { isPromptMode, vmLimits, type VmJob, type VmRequest, type VmResponse } from './vm-protocol';
import { PluginApiError } from './errors';

interface Task {
    job: VmJob;
    rpc: (method: string, args: unknown) => Promise<unknown>;
    signal: AbortSignal;
    resolve(value: unknown): void;
    reject(error: unknown): void;
    cancel(): void;
    slot?: Slot;
}
type Lane = 'main' | 'migration' | 'service' | 'prompt';
const laneFor = (job: VmJob): Lane => job.mode === 'migrate' ? 'migration' : job.mode === 'service' ? 'service' : isPromptMode(job.mode) || job.mode === 'tool' ? 'prompt' : 'main';
interface Slot { worker: Worker; lane: Lane; task?: Task; idle?: ReturnType<typeof setTimeout> }
const slots = new Set<Slot>();
const waiting: Task[] = [];
const poolSize = 3;
const idleMs = 30_000;
const priority = (job: VmJob) => job.mode === 'contribute' ? 0 : job.mode === 'command' || job.mode === 'verify' ? 1 : 2;
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 1000);

function discard(slot: Slot) {
    clearTimeout(slot.idle);
    slots.delete(slot); slot.worker.terminate();
}
function finish(slot: Slot, task: Task, error?: unknown, result?: unknown, broken = false) {
    if (slot.task !== task) return;
    slot.task = undefined; task.slot = undefined;
    task.signal.removeEventListener('abort', task.cancel);
    if (broken) discard(slot);
    else slot.idle = setTimeout(() => discard(slot), idleMs);
    if (error !== undefined) task.reject(error); else task.resolve(result);
    drain();
}
function spawn(lane: Lane) {
    const worker = new Worker(new URL('./plugin.worker.ts', import.meta.url), { type: 'module', name: 'tipsy-plugin-sandbox' });
    const slot: Slot = { worker, lane };
    slots.add(slot);
    worker.onerror = event => {
        if (slot.task) finish(slot, slot.task, new Error(event.message || '插件沙箱启动失败'), undefined, true);
        else discard(slot);
    };
    worker.onmessageerror = () => { if (slot.task) finish(slot, slot.task, new Error('插件沙箱通信失败'), undefined, true); else discard(slot); };
    worker.onmessage = (event: MessageEvent<VmResponse>) => {
        const task = slot.task, data = event.data;
        if (!task) return;
        if (data.kind === 'done') {
            try {
                if (data.error) finish(slot, task, new Error(data.error), undefined, true);
                else finish(slot, task, undefined, JSON.parse(data.value ?? 'null'));
            } catch (error) { finish(slot, task, error, undefined, true); }
            return;
        }
        void (async () => {
            let response: VmRequest;
            try {
                const value = JSON.stringify(await task.rpc(data.method, JSON.parse(data.args)) ?? null);
                if (value.length > vmLimits.packet) throw new PluginApiError('QUOTA_EXCEEDED', '宿主返回的数据超过上限');
                response = { kind: 'answer', id: data.id, value };
            } catch (error) {
                response = { kind: 'answer', id: data.id, error: { code: error instanceof PluginApiError ? error.code : 'HOST_ERROR',
                    message: errorText(error) || '插件接口调用失败' } };
            }
            if (slot.task === task && !task.signal.aborted) worker.postMessage(response);
        })();
    };
    return slot;
}
function drainLane(lane: Lane) {
    for (;;) {
        const index = waiting.findIndex(task => laneFor(task.job) === lane);
        if (index < 0) return;
        const pool = [...slots].filter(slot => slot.lane === lane);
        let slot = pool.find(slot => !slot.task);
        // Reserve capacity for an interactive action even while background listeners run.
        if (lane === 'main' && priority(waiting[index].job) === 2 && pool.filter(slot => slot.task && priority(slot.task.job) === 2).length >= poolSize - 1) return;
        if (!slot && pool.length >= (lane === 'main' || lane === 'prompt' ? poolSize : 1)) return;
        const [task] = waiting.splice(index, 1);
        try {
            slot ??= spawn(lane);
            clearTimeout(slot.idle);
            slot.task = task; task.slot = slot;
            slot.worker.postMessage({ kind: 'run', job: task.job } satisfies VmRequest);
        } catch (error) {
            if (slot?.task === task) finish(slot, task, error, undefined, true);
            else { task.signal.removeEventListener('abort', task.cancel); task.reject(error); }
        }
    }
}
function drain() {
    // A storage RPC can need a migration while its calling VM is still resident.
    drainLane('migration'); drainLane('service'); drainLane('prompt'); drainLane('main');
}
export function callVm(job: VmJob, signal: AbortSignal, rpc: Task['rpc'] = async () => { throw new Error('此阶段没有宿主接口'); }): Promise<unknown> {
    signal.throwIfAborted();
    if (waiting.length >= 64) return Promise.reject(new Error('插件任务过多，请稍后重试'));
    return new Promise((resolve, reject) => {
        const task: Task = { job, signal, rpc, resolve, reject, cancel() {
            if (task.slot) finish(task.slot, task, signal.reason, undefined, true);
            else {
                const index = waiting.indexOf(task);
                if (index >= 0) waiting.splice(index, 1);
                signal.removeEventListener('abort', task.cancel);
                reject(signal.reason); drain();
            }
        } };
        const at = waiting.findIndex(other => priority(other.job) > priority(job));
        waiting.splice(at < 0 ? waiting.length : at, 0, task);
        signal.addEventListener('abort', task.cancel, { once: true });
        drain();
    });
}

import { assemblePromptPipeline, type AssemblePromptInput } from './prompt-assembler';
import type { AssembledPromptResult } from '../types';
import { commandCompatibilityRuntime } from '../compatibility/runtime-client';
import { prepareWorldbookVectors } from '../core/worldbook-vectors';
import type { NativeScanHook } from './native-prompt-input';

let workerInstance: Worker | null = null;
let jobSeq = 1;
const pendingJobs = new Map<
    number,
    { resolve: (res: AssembledPromptResult) => void; reject: (err: unknown) => void; timer: ReturnType<typeof setTimeout> }
>();

function getOrSpawnWorker(): Worker | null {
    if (typeof window === 'undefined' || typeof Worker === 'undefined') return null;
    if (workerInstance) return workerInstance;
    try {
        workerInstance = new Worker(new URL('./prompt-pipeline.worker.ts', import.meta.url), {
            type: 'module',
        });
        workerInstance.onmessage = (
            ev: MessageEvent<{ id: number; result?: AssembledPromptResult; error?: string }>,
        ) => {
            const { id, result, error } = ev.data || {};
            const job = pendingJobs.get(id);
            if (!job) return;
            clearTimeout(job.timer);
            pendingJobs.delete(id);
            if (error || !result) job.reject(new Error(error || 'Worker pipeline error'));
            else job.resolve(result);
        };
        workerInstance.onerror = (event) => {
            workerInstance?.terminate();
            workerInstance = null;
            for (const job of pendingJobs.values()) { clearTimeout(job.timer); job.reject(new Error(event.message || '提示词计算线程意外停止')); }
            pendingJobs.clear();
        };
        return workerInstance;
    } catch {
        return null;
    }
}

export async function runPromptPipelineAsync(rawInput: AssemblePromptInput, signal?: AbortSignal, reuseTemplateAssets = false, afterNativeScan?: NativeScanHook): Promise<AssembledPromptResult> {
    const hookedInput = rawInput;
    await prepareWorldbookVectors(hookedInput, signal);
    signal?.throwIfAborted();
    if (typeof window !== 'undefined' && (!hookedInput.templatePreview || /<%|@@if(?:\s|\\[trn])/.test(JSON.stringify([hookedInput.character, hookedInput.lorebooks, hookedInput.lorebookCatalog, hookedInput.preset, hookedInput.messages, hookedInput.injections, hookedInput.helperGeneration, hookedInput.templateTask])))) {
        const result = await commandCompatibilityRuntime('assemblePrompt', [hookedInput], true, reuseTemplateAssets && !!rawInput.templateTask);
        if (!result.assembled) throw new Error('隔离模板环境没有返回提示词结果');
        return result.assembled;
    }
    const worker = hookedInput.nativePrompt?.afterScan ? null : getOrSpawnWorker();

    const assembled = await new Promise<AssembledPromptResult>((resolve, reject) => {
        if (worker) {
            const id = jobSeq++;
            const timer = setTimeout(() => {
                worker.terminate(); workerInstance = null;
                for (const job of pendingJobs.values()) { clearTimeout(job.timer); job.reject(new Error('模板执行超过 20 秒，已停止本轮计算')); }
                pendingJobs.clear();
            }, 20000);
            pendingJobs.set(id, { resolve, reject, timer });
            try {
                worker.postMessage({ id, input: hookedInput });
            } catch (error) {
                pendingJobs.delete(id);
                clearTimeout(timer);
                reject(error);
            }
            return;
        }
        assemblePromptPipeline(hookedInput, undefined, afterNativeScan).then(resolve, reject);
    });

    return assembled;
}

export async function finishPromptTemplateTask(result: AssembledPromptResult, accept: boolean): Promise<void> {
    if (!result.templateTransactionId) return;
    await commandCompatibilityRuntime('finishTemplateTask', [result.templateTransactionId, accept], true);
    delete result.templateTransactionId;
}

export async function claimPromptTemplateTask(result: AssembledPromptResult): Promise<void> {
    if (result.templateTransactionId) await commandCompatibilityRuntime('claimTemplateTask', [result.templateTransactionId], true);
}

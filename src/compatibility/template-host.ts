import { assemblePromptPipeline, type AssemblePromptInput } from '../pipeline/prompt-assembler';
import { TemplateRuntime, type TemplateRuntimeHooks } from '../pipeline/template-runtime';
import { templatePreparationKey } from '../pipeline/template-lifecycle';
import type { AssembledPromptResult } from '../types';
import type { NativeScanHook } from '../pipeline/native-prompt-input';
import _ from 'lodash';

/** One author realm per compatibility session. Functions never cross postMessage.
 * A pipeline retains its lease until the main host accepts or rejects its data. */
export class ResidentTemplateHost {
    readonly defines: Record<string, any> = {};
    readonly initialVariables: Record<string, any> = {};
    private runtime?: TemplateRuntime;
    private key = '';
    private queue: Promise<unknown> = Promise.resolve();
    private currentLease?: { id: string; claim(): void; finish(accept: boolean): void };
    private readonly finished = new Map<string, boolean>();
    private executing = false;
    private committing = false;
    private poisoned?: Error;
    private sessionRevision = 0;
    constructor(private readonly hooks: TemplateRuntimeHooks, private readonly commit: (runtime: TemplateRuntime) => Promise<void>) {}
    get current() { return this.runtime; }
    get isExecuting() { return this.executing; }
    get isIdle() { return !this.executing && !this.committing && !this.currentLease; }
    get failure() { return this.poisoned; }
    /** UI commands wait outside the template transaction, including its commit. */
    whenIdle(): Promise<void> { return this.enqueue(async () => {}); }
    /** Release an old chat's lease before replacing its template state. */
    resetSession(): Promise<void> {
        this.sessionRevision++;
        this.currentLease?.finish(false);
        return this.enqueue(async () => {
            this.runtime?.disposeExecution();
            this.runtime = undefined; this.key = ''; this.finished.clear();
            for (const value of [this.defines, this.initialVariables]) for (const key of Object.keys(value)) delete value[key];
        });
    }
    assertWritable = () => {
        if (this.poisoned) throw this.poisoned;
        if (this.currentLease || this.committing) throw new Error('模板结果正在提交，请等待当前模板调用完成后修改变量');
    };
    private executionWatchdog(): () => void {
        if (this.poisoned) throw this.poisoned;
        const timer = setTimeout(() => {
            this.poisoned = new Error('作者模板运行超过 25 秒，当前环境已失效，请重新载入');
            this.hooks.fault?.(this.poisoned);
        }, 25000);
        return () => clearTimeout(timer);
    }

    private enqueue<T>(run: () => Promise<T>): Promise<T> {
        const next = this.queue.then(() => { if (this.poisoned) throw this.poisoned; return run(); });
        this.queue = next.catch(() => {});
        return next;
    }
    private async prepare(input: AssemblePromptInput): Promise<TemplateRuntime> {
        const key = input.templatePreparationKey ?? templatePreparationKey(input);
        if (!this.runtime) this.runtime = new TemplateRuntime(input, { ...this.hooks, assertWritable: this.assertWritable,
            defines: this.defines, initialVariables: this.initialVariables });
        else this.runtime.begin(input);
        if (key !== this.key || input.templateForcePreload) {
            await this.runtime.preload((text, entry) => this.runtime!.expand(text, entry.depth, entry.role ?? 'system', 'world_info', `world-info:${entry.world}:${entry.uid}`), true);
            this.key = key;
        }
        return this.runtime;
    }
    private checkpoint() {
        return { runtime: this.runtime, state: this.runtime?.checkpoint(), key: this.key,
            defines: _.cloneDeep(this.defines), initialVariables: _.cloneDeep(this.initialVariables) };
    }
    private restore(checkpoint: ReturnType<ResidentTemplateHost['checkpoint']>) {
        this.runtime?.disposeExecution();
        if (checkpoint.state) checkpoint.runtime!.restore(checkpoint.state);
        else {
            for (const value of [this.defines, this.initialVariables]) for (const name of Object.keys(value)) delete value[name];
            Object.assign(this.defines, checkpoint.defines); Object.assign(this.initialVariables, checkpoint.initialVariables);
        }
        this.runtime = checkpoint.runtime; this.key = checkpoint.key;
    }
    private async commitCurrent(): Promise<void> {
        if (!this.runtime?.hasChanges()) return;
        this.committing = true;
        try { await this.commit(this.runtime); this.runtime.acceptChanges(); }
        finally { this.committing = false; if (this.isIdle) this.hooks.idle?.(); }
    }
    /** Returned contexts remain live. Flush their setters before replacing any baseline. */
    save(): Promise<void> {
        return this.enqueue(() => this.commitCurrent());
    }
    run(input: AssemblePromptInput, afterNativeScan?: NativeScanHook): Promise<AssembledPromptResult> {
        const sessionRevision = this.sessionRevision;
        return new Promise((resolve, reject) => {
            void this.enqueue(async () => {
                if (sessionRevision !== this.sessionRevision) throw new Error('模板请求所属聊天已切换');
                await this.commitCurrent();
                const checkpoint = this.checkpoint();
                this.executing = true;
                const stopWatchdog = this.executionWatchdog();
                try {
                    const runtime = await this.prepare(input);
                    const result = await assemblePromptPipeline(input, runtime, afterNativeScan);
                    if (sessionRevision !== this.sessionRevision) throw new Error('模板请求所属聊天已切换');
                    this.assertWritable(); stopWatchdog();
                    // Clone now; next begin() mutates the runtime's data objects in place.
                    const output = structuredClone({ ...result, ...runtime.changes() });
                    const id = crypto.randomUUID();
                    let released = false;
                    let release!: () => void;
                    const accepted = new Promise<void>(done => { release = done; });
                    const finish = (accept: boolean) => {
                        if (released) return;
                        // Acceptance can validate/clone author values and throw. Keep
                        // the lease releasable until that synchronous work succeeded.
                        if (accept) { runtime.acceptChanges(); runtime.finishTransaction(); }
                        else this.restore(checkpoint);
                        released = true; clearTimeout(timer);
                        this.finished.set(id, accept);
                        while (this.finished.size > 64) this.finished.delete(this.finished.keys().next().value!);
                        this.currentLease = undefined; release();
                    };
                    const timer = setTimeout(() => finish(false), 30000);
                    this.currentLease = { id, finish, claim: () => clearTimeout(timer) };
                    this.executing = false;
                    resolve({ ...output, templateTransactionId: id });
                    await accepted;
                } catch (error) {
                    this.restore(checkpoint); reject(error);
                } finally { stopWatchdog(); this.executing = false; this.hooks.idle?.(); }
            }).catch(reject);
        });
    }
    claim(id: string): void {
        if (!this.currentLease || this.currentLease.id !== id) throw new Error('模板事务已经失效，不能保存旧任务');
        this.currentLease.claim();
    }
    finish(id: string, accept: boolean): void {
        if (this.finished.has(id)) {
            if (this.finished.get(id) !== accept) throw new Error('模板事务已按不同结果结束');
            return;
        }
        if (!this.currentLease || this.currentLease.id !== id) throw new Error('模板事务已经失效，不能提交旧任务');
        this.currentLease.finish(accept);
    }
    /** APIs return objects/functions directly to scripts in this origin. */
    api<T>(loadInput: () => Promise<AssemblePromptInput>, run: (runtime: TemplateRuntime) => Promise<T>): Promise<T> {
        const sessionRevision = this.sessionRevision;
        return this.enqueue(async () => {
            if (sessionRevision !== this.sessionRevision) throw new Error('模板调用所属聊天已切换');
            await this.commitCurrent();
            // Fetch inside the queue: an earlier API call may have just changed variables.
            const input = await loadInput();
            const checkpoint = this.checkpoint();
            this.executing = true;
            let accepted = false;
            const stopWatchdog = this.executionWatchdog();
            try {
                const runtime = await this.prepare(input);
                const result = await run(runtime);
                if (sessionRevision !== this.sessionRevision) throw new Error('模板调用所属聊天已切换');
                this.assertWritable(); stopWatchdog();
                await this.commitCurrent();
                accepted = true;
                return result;
            } catch (error) {
                this.restore(checkpoint); throw error;
            } finally { stopWatchdog(); this.executing = false; if (accepted) this.runtime?.finishTransaction(); this.hooks.idle?.(); }
        });
    }
}

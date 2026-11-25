import { z } from 'zod';
import type { JobContext, RouteAddress } from '../../../packages/plugin-sdk/index.js';
import { idSchema, refSchema, routeSchema } from './edits';
import { PluginApiError } from './errors';
import { validateJson } from './storage';

const schedule = z.strictObject({
    key: idSchema,
    queue: z.enum(['realtime', 'maintenance']).optional(),
    route: routeSchema.optional(),
    target: refSchema.optional(),
    generationId: idSchema.optional(),
    payload: z.json(),
});

interface Job {
    id: string;
    signature: string;
    priority: number;
    run(): Promise<void>;
}

const COMPLETED_TTL_MS = 90_000;
const jobs = new Map<string, Job>();
const completed = new Map<string, { id: string; until: number }>();
const queue: Job[] = [];
let running = 0;

function pruneCompleted(now = Date.now()) {
    for (const [key, entry] of completed) {
        if (entry.until <= now) completed.delete(key);
    }
}

function drain() {
    while (running < 2 && queue.length) {
        const job = queue.shift()!;
        running++;
        void job.run().catch(() => {}).finally(() => {
            jobs.delete(job.signature);
            running--;
            drain();
        });
    }
}

export function scheduleJob(
    owner: string,
    args: unknown,
    route: RouteAddress | null,
    generation: { id: string; signal: AbortSignal } | undefined,
    run: (context: JobContext, signal?: AbortSignal) => Promise<unknown>,
) {
    const data = schedule.parse(args);
    const address = data.route ?? route;
    const signal = data.generationId ? generation?.signal : undefined;
    if (data.generationId && generation?.id !== data.generationId) {
        throw new PluginApiError('EXPIRED', '该作业不属于本轮生成');
    }
    signal?.throwIfAborted();

    const now = Date.now();
    pruneCompleted(now);

    const signature = JSON.stringify([owner, address?.chatId, address?.routeId, data.key]);
    const prior = jobs.get(signature);
    if (prior) return prior.id;
    const finished = completed.get(signature);
    if (finished && finished.until > now) return finished.id;

    if (jobs.size >= 32) throw new PluginApiError('QUOTA_EXCEEDED', '后台作业队列已满');
    const id = crypto.randomUUID();
    const payload = validateJson(data.payload, 64_000);
    const job: Job = {
        id,
        signature,
        priority: data.queue === 'maintenance' ? 1 : 0,
        async run() {
            signal?.throwIfAborted();
            await run({ id, payload, key: data.key, route: address, target: data.target, generationId: data.generationId }, signal);
            if (!signal?.aborted) {
                completed.set(signature, { id, until: Date.now() + COMPLETED_TTL_MS });
            }
        },
    };
    jobs.set(signature, job);
    queue.push(job);
    queue.sort((left, right) => left.priority - right.priority);
    queueMicrotask(drain);
    return id;
}

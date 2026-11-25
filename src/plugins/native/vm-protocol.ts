import type { PluginErrorCode } from '../../../packages/plugin-sdk/index.js';

export const vmLimits = { memory: 24 * 1024 * 1024, stack: 512 * 1024, rpcCalls: 160, packet: 640 * 1024,
    cpu: 140, contributionCpu: 55, contributionWall: 850, commandWall: 8000, eventWall: 5500, serviceWall: 4500, toolWall: 2200, migrationWall: 4500 } as const;
export type VmMode = 'command' | 'replySaved' | 'routeChanged' | 'contribute' | 'beforeScan' | 'afterScan' | 'storyChanged' | 'tool' | 'service' | 'migrate' | 'verify' | 'job' | 'checkpoint' | 'mediaAction';
export const isPromptMode = (mode: VmMode) => mode === 'beforeScan' || mode === 'afterScan' || mode === 'contribute';
export interface VmJob {
    mode: VmMode;
    code: string;
    input: unknown;
    api?: unknown;
}
export type VmRequest = { kind: 'run'; job: VmJob } | { kind: 'answer'; id: number; value: string }
    | { kind: 'answer'; id: number; error: { code: PluginErrorCode; message: string } };
export type VmResponse = { kind: 'rpc'; id: number; method: string; args: string }
    | { kind: 'done'; value?: string; error?: string };


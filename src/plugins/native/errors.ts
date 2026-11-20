import type { PluginErrorCode } from '../../../packages/plugin-sdk/index.js';

export class PluginApiError extends Error {
    override readonly name = 'PluginApiError';
    constructor(readonly code: PluginErrorCode, message: string) { super(message); }
}

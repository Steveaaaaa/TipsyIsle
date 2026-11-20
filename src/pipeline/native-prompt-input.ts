import type { PromptInjection, WorldActivation } from '../../packages/plugin-sdk/index.js';

export interface LiteralInjection extends PromptInjection { source: string; label: string }
export interface LiteralHistoryEdit { from: string; through: string; source: string; label: string; text?: string; role?: PromptInjection['role'] }
export interface NativeAfterScan { injections: LiteralInjection[]; history: LiteralHistoryEdit[] }
export interface NativePromptInput { id: string; injections: LiteralInjection[]; macros: Record<string, string>; afterScan: boolean }
export type NativeScanHook = (id: string, activations: WorldActivation[], count: number) => Promise<NativeAfterScan | undefined>;

/** Keep plugin text out of the author template compiler, including through macro substitution. */
export function promptLiterals(input: NativePromptInput) {
    const prefix = `TIPSYLITERAL${input.id.replace(/-/g, '')}X`;
    const marker = new RegExp(`${prefix}(\\d+)Z`, 'g');
    const values: string[] = [];
    const literal = (text: string) => `${prefix}${values.push(text) - 1}Z`;
    const macros = new Map(Object.entries(input.macros).map(([key, value]) => [key, literal(value)]));
    return {
        literal,
        mask: (text: string) => macros.size ? text.replace(/\{\{\s*plugin::([a-z0-9_.-]+)::([a-z0-9_-]+)\s*\}\}/g,
            (token, name, key) => macros.get(`${name}::${key}`) ?? token) : text,
        reveal: (text: string) => text.includes(prefix) ? text.replace(marker, (token, index) => values[Number(index)] ?? token) : text,
    };
}

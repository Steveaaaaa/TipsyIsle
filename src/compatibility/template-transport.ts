import type { AssemblePromptInput } from '../pipeline/prompt-assembler';

/** Only host-owned immutable template tasks use this transport optimization. */
export const templateAssetFields = ['character', 'characterAvatar', 'characterCatalog', 'preset', 'lorebooks', 'lorebookCatalog'] as const;
export type TemplateAssets = Pick<AssemblePromptInput, typeof templateAssetFields[number]>;

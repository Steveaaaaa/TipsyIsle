import { assemblePromptPipeline, type AssemblePromptInput } from './prompt-assembler';

self.onmessage = async (ev: MessageEvent<{ id: number; input: AssemblePromptInput }>) => {
    const { id, input } = ev.data || {};
    try {
        const result = await assemblePromptPipeline(input);
        self.postMessage({ id, result });
    } catch (err) {
        self.postMessage({
            id,
            error: err instanceof Error ? err.message : String(err),
        });
    }
};

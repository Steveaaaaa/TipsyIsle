export function shouldEmitMainGenerationAfterCommands(raw: boolean): boolean {
    return !raw;
}

export function helperGenerationCommandType(config: { should_silence?: boolean }): 'quiet' | 'normal' {
    return config.should_silence === true ? 'quiet' : 'normal';
}

export function shouldCollectGlobalInjections(
    config: { ordered_prompts?: Array<string | object> },
    raw: boolean,
): boolean {
    if (!raw) return true;
    if (Array.isArray(config.ordered_prompts) && !config.ordered_prompts.some(item => typeof item === 'string')) {
        return false;
    }
    return true;
}

export function shouldEmitGlobalGenerationStopped(silent: boolean): boolean {
    return !silent;
}

export function shouldRemoveOnceInjectionsOnIframeGenerationEnded(silent: boolean): boolean {
    return !silent;
}

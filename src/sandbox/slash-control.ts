export class SlashCommandAbortSignal {
    isQuiet = false;
    paused = false;
    aborted = false;
    reason: string | null = null;
}

export class SlashCommandAbortController extends EventTarget {
    readonly signal = new SlashCommandAbortSignal();
    abort(reason = 'No reason.', isQuiet = false): void {
        Object.assign(this.signal, { aborted: true, reason, isQuiet });
        this.dispatchEvent(new Event('abort'));
    }
    pause(reason = 'No reason.'): void {
        Object.assign(this.signal, { paused: true, reason }); this.dispatchEvent(new Event('pause'));
    }
    continue(reason = 'No reason.'): void {
        Object.assign(this.signal, { paused: false, reason }); this.dispatchEvent(new Event('continue'));
    }
}

export class SlashCommandBreakController {
    isBreak = false;
    break(): void { this.isBreak = true; }
}

export class SlashCommandClosureResult {
    interrupt = false;
    pipe = '';
    isBreak = false;
    isAborted = false;
    isQuietlyAborted = false;
    abortReason = '';
    isError = false;
    errorMessage = '';
}

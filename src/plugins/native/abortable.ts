/** Stop waiting for host IO too; it may not support aborting the underlying read. */
export function untilAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise((resolve, reject) => {
        const abort = () => reject(signal.reason);
        if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
        const close = () => signal.removeEventListener('abort', abort);
        void promise.then(value => { close(); resolve(value); }, error => { close(); reject(error); });
    });
}

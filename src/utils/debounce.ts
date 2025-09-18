/**
 * Small debounce helper used to coalesce rapid calls into a single invocation.
 * Preserves `this` and arguments for the wrapped function.
 */
export function debounce<T extends (...args: any[]) => void>(fn: T, wait: number) {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const debounced = function(this: any, ...args: Parameters<T>) {
        if (timer) {
            try { clearTimeout(timer); } catch (e) { /* ignore */ }
        }
        timer = setTimeout(() => {
            timer = null;
            try { fn.apply(this, args); } catch (e) { /* swallow */ }
        }, wait);
        // In Node.js timers have an unref() method which lets the process exit
        // if the timer is the only thing left. Call it when available but
        // guard so browsers (webview) don't throw.
        try {
            if (timer && typeof (timer as any).unref === 'function') {
                try { (timer as any).unref(); } catch (e) { /* ignore */ }
            }
        } catch (e) { /* ignore */ }
    } as T & { cancel?: () => void };

    // Allow callers (tests / disposers) to cancel a pending invocation.
    (debounced as any).cancel = () => {
        if (timer) {
            try { clearTimeout(timer); } catch (e) { /* ignore */ }
            timer = null;
        }
    };

    return debounced as T;
}

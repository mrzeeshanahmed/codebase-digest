/**
 * Small debounce helper used to coalesce rapid calls into a single invocation.
 * Preserves `this` and arguments for the wrapped function.
 */
export function debounce<T extends (...args: any[]) => void>(fn: T, wait: number) {
    let timer: ReturnType<typeof setTimeout> | null = null;
    return function(this: any, ...args: Parameters<T>) {
        if (timer) { clearTimeout(timer); }
        timer = setTimeout(() => {
            timer = null;
            try { fn.apply(this, args); } catch (e) { /* swallow */ }
        }, wait);
    } as T;
}

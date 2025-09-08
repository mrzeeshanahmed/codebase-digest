export type ProgressEvent = {
    op: 'scan' | 'generate' | string;
    mode: 'start' | 'progress' | 'end' | string;
    determinate?: boolean;
    percent?: number;
    message?: string;
    // optional stats for scan progress
    totalFiles?: number;
    totalSize?: number;
};

const listeners: Array<(e: ProgressEvent) => void> = [];
const MAX_LISTENERS = 1000;

export function onProgress(cb: (e: ProgressEvent) => void) {
    if (listeners.length >= MAX_LISTENERS) {
        // Prevent unbounded growth; ignore additional listeners and log a
        // console warning in development. Return a no-op unsubscribe so
        // callers can still safely call the returned function.
        try { console.warn('[eventBus] listener limit reached, rejecting new listener'); } catch {}
        return () => { /* no-op */ };
    }
    listeners.push(cb);
    let removed = false;
    return () => {
        if (removed) { return; }
        removed = true;
        const idx = listeners.indexOf(cb);
        if (idx >= 0) { listeners.splice(idx, 1); }
    };
}

export function emitProgress(e: ProgressEvent) {
    for (const cb of listeners.slice()) {
        try { cb(e); } catch (err) { /* swallow */ }
    }
}

export function clearListeners() {
    listeners.length = 0;
}

export function listenerCount(): number {
    return listeners.length;
}

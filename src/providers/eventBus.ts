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

export function onProgress(cb: (e: ProgressEvent) => void) {
    listeners.push(cb);
    return () => {
        const idx = listeners.indexOf(cb);
        if (idx >= 0) { listeners.splice(idx, 1); }
    };
}

export function emitProgress(e: ProgressEvent) {
    for (const cb of listeners.slice()) {
        try { cb(e); } catch (err) { /* swallow */ }
    }
}

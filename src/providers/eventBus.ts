import { Diagnostics } from '../utils/diagnostics';

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

export type Unsubscribe = (() => void) & { failed?: boolean; reason?: string };

export function onProgress(cb: (e: ProgressEvent) => void): Unsubscribe {
    if (listeners.length >= MAX_LISTENERS) {
        // Prevent unbounded growth; ignore additional listeners and log a
        // console warning. Return an unsubscribe function but mark it as failed
        // so callers can detect that registration did not succeed.
        const reason = '[eventBus] listener limit reached, rejecting new listener';
        try { console.warn(reason); } catch {}
        const noop: Unsubscribe = (() => { /* no-op */ }) as Unsubscribe;
        noop.failed = true;
        noop.reason = reason;
        return noop;
    }
    listeners.push(cb);
    let removed = false;
    const unsub: Unsubscribe = (() => {
        if (removed) { return; }
        removed = true;
        const idx = listeners.indexOf(cb);
        if (idx >= 0) { listeners.splice(idx, 1); }
    }) as Unsubscribe;
    return unsub;
}

const diagnostics = new Diagnostics('debug', 'EventBus');

export function emitProgress(e: ProgressEvent) {
    const snapshot = listeners.slice();
    for (const cb of snapshot) {
        try {
            cb(e);
        } catch (err) {
            // Surface listener errors to diagnostics so they are visible during
            // development and test runs while keeping delivery to other listeners.
            try {
                let msg = '';
                if (err && typeof err === 'object' && err !== null) {
                    const rec = err as Record<string, unknown>;
                    msg = String(rec.stack || rec.message || JSON.stringify(rec));
                } else {
                    msg = String(err);
                }
                diagnostics.error('emitProgress listener threw', msg);
            } catch {}
        }
    }
}

export function clearListeners() {
    listeners.length = 0;
}

export function listenerCount(): number {
    return listeners.length;
}

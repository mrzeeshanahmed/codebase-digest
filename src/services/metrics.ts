export interface MetricsCounters {
    filesProcessed: number;
    filesSkippedBySize: number;
    filesSkippedByIgnore: number;
    filesSkippedByDepth: number;
    filesSkippedByMaxFiles: number;
    filesSkippedByTotalLimit: number;
    bytesRead: number;
}

export interface MetricsTimers {
    scanTime: number;
    readTime: number;
    assembleTime: number;
    tokenTime: number;
    totalElapsed: number;
}

export class Metrics {
    private enabled: boolean;
    counters: MetricsCounters;
    timers: MetricsTimers;
    private timerStarts: Partial<Record<keyof MetricsTimers, number>> = {};
    // Static throttle state shared across instances
    private static _lastWarnTime: number = 0;

    constructor(enabled: boolean) {
        this.enabled = enabled;
        this.counters = {
            filesProcessed: 0,
            filesSkippedBySize: 0,
            filesSkippedByIgnore: 0,
            filesSkippedByDepth: 0,
            filesSkippedByMaxFiles: 0,
            filesSkippedByTotalLimit: 0,
            bytesRead: 0
        };
        this.timers = {
            scanTime: 0,
            readTime: 0,
            assembleTime: 0,
            tokenTime: 0,
            totalElapsed: 0
        };
    }

    inc(counter: keyof MetricsCounters, amount: number = 1) {
    if (!this.enabled) { return; }
        this.counters[counter] += amount;
    }

    startTimer(timer: keyof MetricsTimers) {
    if (!this.enabled) { return; }
        this.timerStarts[timer] = Date.now();
    }

    stopTimer(timer: keyof MetricsTimers): void {
    const startedAt = this.timerStarts[timer];
    if (startedAt === null || startedAt === undefined) { return; }
        if (this.enabled) {
            // If you adopt performance.now(), switch here too.
            this.timers[timer] += Date.now() - startedAt;
        }
        delete this.timerStarts[timer];
    }
    log() {
    if (!this.enabled) { return; }
        // Unified log to output channel
        const details = `Counters: ${JSON.stringify(this.counters)}\nTimers: ${JSON.stringify(this.timers)}`;
        // Write to the Output Channel (non-interactive) instead of showing
        // long / frequent warning toasts which can spam users. Prefer the
        // internalErrors helper which appends details to the Output Channel
        // and shows a brief notification with a 'Show Details' action.
        // Defensive require: don't allow a failed dynamic import to throw here.
        let internalErrors: any | undefined;
        try {
            const utils = require('../utils');
            internalErrors = utils && (utils.internalErrors || utils.internalErrors === undefined ? utils.internalErrors : undefined);
        } catch (err) {
            internalErrors = undefined;
        }

        // Simple sampling + time-window throttle to avoid frequent toasts.
        // Emit either when a) a random 1-in-N sample passes, or b) enough time has passed since last emit.
        const now = Date.now();
        const sampleRate = 10; // 1-in-10 by default
        const minIntervalMs = 60 * 1000; // at most once per minute
        // Use static-ish storage on the class so all instances share the same throttle
    const last = Metrics._lastWarnTime || 0;
        const samplePass = Math.random() < 1 / sampleRate;
        const timePass = now - last > minIntervalMs;

        if (internalErrors && typeof internalErrors.showUserWarning === 'function' && (samplePass || timePass)) {
            try {
                internalErrors.showUserWarning('Performance metrics logged.', details);
                Metrics._lastWarnTime = now;
            } catch (e) {
                try { console.debug(details); } catch (_) { /* swallow */ }
            }
        } else {
            // Fallback: write to console.debug so CI logs still have metrics.
            try { console.debug(details); } catch (_) { /* swallow */ }
        }
    }

    getPerfSummary(): string {
    if (!this.enabled) { return ''; }
        return (
            `\n---\n**Performance Metrics**\n` +
            `Files processed: ${this.counters.filesProcessed}\n` +
            `Files skipped by size: ${this.counters.filesSkippedBySize}\n` +
            `Files skipped by ignore: ${this.counters.filesSkippedByIgnore}\n` +
            `Files skipped by depth: ${this.counters.filesSkippedByDepth}\n` +
            `Files skipped by max files: ${this.counters.filesSkippedByMaxFiles}\n` +
            `Files skipped by total limit: ${this.counters.filesSkippedByTotalLimit}\n` +
            `Bytes read: ${this.counters.bytesRead}\n` +
            `Scan time: ${this.timers.scanTime} ms\n` +
            `Read time: ${this.timers.readTime} ms\n` +
            `Token time: ${this.timers.tokenTime} ms\n` +
            `Assemble time: ${this.timers.assembleTime} ms\n` +
            `Total elapsed: ${this.timers.totalElapsed} ms\n`
        );
    }
}

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

    stopTimer(timer: keyof MetricsTimers) {
    if (!this.enabled || !this.timerStarts[timer]) { return; }
        this.timers[timer] += Date.now() - (this.timerStarts[timer] as number);
        this.timerStarts[timer] = undefined;
    }

    log() {
    if (!this.enabled) { return; }
        // Unified log to output channel
        const details = `Counters: ${JSON.stringify(this.counters)}\nTimers: ${JSON.stringify(this.timers)}`;
        // Use interactiveMessages for explicit user-visible warnings via the utils barrel
        const { interactiveMessages } = require('../utils');
        if (interactiveMessages && typeof interactiveMessages.showUserWarning === 'function') {
            interactiveMessages.showUserWarning('Performance metrics logged.', [details]);
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

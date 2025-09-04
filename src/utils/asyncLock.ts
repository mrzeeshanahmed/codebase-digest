/**
 * Lightweight async mutex per-key. Keeps a queue of waiters and ensures only
 * one holder at a time. Intentionally tiny to avoid new dependencies.
 */
export class Mutex {
    private _locked = false;
    private _waiters: Array<() => void> = [];

    async lock(): Promise<() => void> {
        if (!this._locked) {
            this._locked = true;
            return this._release.bind(this);
        }
        return new Promise(resolve => {
            this._waiters.push(() => {
                this._locked = true;
                resolve(this._release.bind(this));
            });
        });
    }

    private _release() {
        const next = this._waiters.shift();
        if (next) {
            // call next to resolve its promise and transfer lock
            try { next(); } catch (e) { /* swallow */ }
        } else {
            this._locked = false;
        }
    }
}

const _mutexes: Map<string, Mutex> = new Map();

export function getMutex(key: string): Mutex {
    let m = _mutexes.get(key);
    if (!m) {
        m = new Mutex();
        _mutexes.set(key, m);
    }
    return m;
}

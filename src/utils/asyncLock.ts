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
        // Attempt to hand off the lock to the next queued waiter. If a waiter
        // callback throws synchronously we log and try the next waiter. We keep
        // the lock logically occupied while there are remaining waiters so new
        // callers can't acquire it out-of-order. Only when the queue is empty
        // do we mark the mutex as unlocked.
        while (true) {
            const next = this._waiters.shift();
            if (!next) {
                // No queued waiters: release the lock
                this._locked = false;
                return;
            }
            try {
                // Calling the waiter will resolve its promise and the waiter
                // callback is responsible for setting _locked = true when it
                // becomes the holder.
                next();
                // Successful handoff — the lock is now owned by the waiter.
                return;
            } catch (e) {
                try { console.warn('asyncLock: next() callback failed', e); } catch {}
                // Continue the loop and try the next waiter. Do not change
                // this._locked here — the lock remains logically held until a
                // waiter successfully takes it or the queue is exhausted.
                continue;
            }
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

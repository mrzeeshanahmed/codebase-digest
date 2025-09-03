export interface CancellationToken {
    isCancellationRequested?: boolean;
}

/**
 * Run a list of async tasks with limited concurrency while preserving result order.
 * tasks: an array of functions returning a Promise<T>
 */
export async function runPool<T>(tasks: Array<() => Promise<T>>, concurrency = 8, token?: CancellationToken): Promise<T[]> {
    const results: T[] = new Array(tasks.length);
    let inFlight = 0;
    let idx = 0;

    return new Promise<T[]>((resolve, reject) => {
        function runNext() {
            if (token && token.isCancellationRequested) {
                return reject(new Error('Cancelled'));
            }
            if (idx >= tasks.length && inFlight === 0) {
                return resolve(results);
            }
            while (inFlight < concurrency && idx < tasks.length) {
                const current = idx;
                const task = tasks[current];
                idx++;
                inFlight++;
                task()
                    .then(r => { results[current] = r; })
                    .catch(err => { throw err; })
                    .finally(() => {
                        inFlight--;
                        // schedule next on next tick
                        setImmediate(runNext);
                    });
            }
        }
        runNext();
    });
}

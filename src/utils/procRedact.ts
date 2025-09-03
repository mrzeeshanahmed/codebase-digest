import { spawn } from 'child_process';
import { scrubTokens } from './redaction';

export interface SpawnOptions {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
}

/**
 * Spawn git with args and return a promise that resolves with stdout on success,
 * or rejects with a scrubbed error on failure. This centralizes sanitization.
 */
export function spawnGitPromise(args: string[], opts?: SpawnOptions): Promise<{ stdout: string; stderr: string }>{
    return new Promise((resolve, reject) => {
        const proc = spawn('git', args, opts as any);
        let out = '';
        let err = '';
        if (proc.stdout) {
            proc.stdout.on('data', (d: Buffer) => { out += d.toString(); });
        }
        if (proc.stderr) {
            proc.stderr.on('data', (d: Buffer) => { err += d.toString(); });
        }
        proc.on('error', (e: any) => {
            const msg = scrubTokens(String(e && e.message ? e.message : e));
            reject(new Error(msg));
        });
        proc.on('exit', (code: number) => {
            if (code !== 0) {
                const msg = scrubTokens(`git ${args[0] || ''} failed with code ${code}`);
                // include stderr when present but scrub it
                const detail = err ? `: ${scrubTokens(err)}` : '';
                return reject(new Error(msg + detail));
            }
            resolve({ stdout: out, stderr: err });
        });
    });
}

/**
 * Wrapper around global fetch that scrubs error messages before rethrowing.
 */
export async function safeFetch(input: any, init?: any): Promise<any> {
    try {
        // forward to global fetch (may be mocked in tests)
        // @ts-ignore
        const res: any = await fetch(input as any, init as any);
        return res;
    } catch (e: any) {
        const msg = scrubTokens(String(e && e.message ? e.message : e));
        throw new Error(msg);
    }
}

export default { spawnGitPromise, safeFetch };

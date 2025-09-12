import { spawn } from 'child_process';
import * as vscode from 'vscode';
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
        // Basic validation: ensure args is an array of simple tokens (no control characters or shell metacharacters)
        if (!Array.isArray(args)) { return reject(new Error('Invalid git args')); }
        for (const a of args) {
            if (typeof a !== 'string') { return reject(new Error('Invalid git arg type')); }
            // Allow backslashes because Windows paths include '\'. Keep other suspicious chars.
            if (/[*`$<>|;&\n\r]/.test(a)) { return reject(new Error('Suspicious characters in git args')); }
        }
    // Respect user's configured git.path in VS Code settings if provided.
    // Be defensive: tests/partial vscode mocks may not provide workspace.getConfiguration.
    let gitPath = 'git';
    try {
        const cfg = (vscode && vscode.workspace && typeof vscode.workspace.getConfiguration === 'function') ? vscode.workspace.getConfiguration('git') : null;
        if (cfg && typeof cfg.get === 'function') {
            const p = cfg.get('path');
            if (typeof p === 'string' && p.length > 0) { gitPath = p; }
        }
    } catch (e) {
        // swallow and use default 'git'
    }
    const proc = spawn(gitPath, args, Object.assign({}, opts || {}, { shell: false }) as any);
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
        // Avoid leaking raw header values. If caller provided init/headers include a scrubbed summary.
        try {
            const safeHdrs = scrubHeaders(init);
            const detail = safeHdrs ? ` [headers: ${safeHdrs}]` : '';
            throw new Error(msg + detail);
        } catch (_) {
            throw new Error(msg);
        }
    }
}

/**
 * Produce a scrubbed, one-line summary of request headers suitable for diagnostics.
 * Header values are passed through scrubTokens to remove tokens before including.
 */
export function scrubHeaders(init?: any): string {
    try {
        if (!init || !init.headers) { return ''; }
        const headers = init.headers as any;
        const parts: string[] = [];
        if (typeof headers.forEach === 'function') {
            try {
                headers.forEach((v: any, k: string) => { parts.push(`${k}: ${scrubTokens(String(v))}`); });
            } catch (_) { /* ignore iteration errors */ }
        } else if (typeof headers === 'object') {
            for (const k of Object.keys(headers)) {
                try { parts.push(`${k}: ${scrubTokens(String((headers as any)[k]))}`); } catch (_) { parts.push(k + ': [unavailable]'); }
            }
        }
        return parts.join(', ');
    } catch (_) { return ''; }
}

export default { spawnGitPromise, safeFetch };

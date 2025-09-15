import { spawn, SpawnOptions as NodeSpawnOptions } from 'child_process';
import * as vscode from 'vscode';
import { scrubTokens } from './redaction';

export type SpawnOptions = NodeSpawnOptions;

/**
 * Spawn git with args and return a promise that resolves with stdout on success,
 * or rejects with a scrubbed error on failure. This centralizes sanitization.
 */
export function spawnGitPromise(args: string[], opts?: SpawnOptions, onChunk?: (chunk: { stream: 'stdout' | 'stderr'; data: string }) => void): Promise<{ stdout: string; stderr: string }>{
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
    const spawnOpts: NodeSpawnOptions = Object.assign({}, opts || {}, { shell: false });
    const proc = spawn(gitPath, args, spawnOpts);
        let out = '';
        let err = '';
        if (proc.stdout) {
            proc.stdout.on('data', (d: Buffer) => {
                const s = d.toString();
                out += s;
                try { if (typeof onChunk === 'function') { onChunk({ stream: 'stdout', data: s }); } } catch (_) { /* swallow listener errors */ }
            });
        }
        if (proc.stderr) {
            proc.stderr.on('data', (d: Buffer) => {
                const s = d.toString();
                err += s;
                try { if (typeof onChunk === 'function') { onChunk({ stream: 'stderr', data: s }); } } catch (_) { /* swallow listener errors */ }
            });
        }
        proc.on('error', (e: unknown) => {
            let msg = '';
            try {
                if (e && typeof e === 'object' && e !== null && 'message' in e) {
                    msg = String((e as Record<string, unknown>)['message']);
                } else {
                    msg = String(e);
                }
            } catch { msg = String(e); }
            reject(new Error(scrubTokens(msg)));
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
export async function safeFetch(input: unknown, init?: unknown): Promise<unknown> {
    try {
    // Resolve global fetch robustly (may be polyfilled or mocked in tests)
    const maybeFetch = (globalThis as unknown);
    const nativeFetch = maybeFetch && typeof (maybeFetch as Record<string, unknown>)['fetch'] === 'function' ? (maybeFetch as Record<string, unknown>)['fetch'] as (i: unknown, init?: unknown) => Promise<unknown> : undefined;
    if (!nativeFetch) { throw new Error('fetch is not available in this environment'); }
    const res = await nativeFetch(input, init);
        return res;
    } catch (e: unknown) {
        let msg = '';
        try {
            if (e && typeof e === 'object' && e !== null && 'message' in e) { msg = String((e as Record<string, unknown>)['message']); }
            else { msg = String(e); }
        } catch { msg = String(e); }
        const safeHdrs = scrubHeaders(init);
        const detail = safeHdrs ? ` [headers: ${safeHdrs}]` : '';
        throw new Error(scrubTokens(msg) + detail);
    }
}

/**
 * Produce a scrubbed, one-line summary of request headers suitable for diagnostics.
 * Header values are passed through scrubTokens to remove tokens before including.
 */
export function scrubHeaders(init?: unknown): string {
    try {
        if (!init || typeof init !== 'object') { return ''; }
    const hdrs = (init as Record<string, unknown>)['headers'];
    if (!hdrs) { return ''; }
        const parts: string[] = [];
        // Headers instance
        if (hdrs) {
            const hdrRec = hdrs as Record<string, unknown>;
            try {
                // Headers-like objects often provide a forEach method; check and call if present
                const hdrLike = hdrRec as { forEach?: unknown };
                const maybeForEach = hdrLike.forEach;
                if (typeof maybeForEach === 'function') {
                    // Call with a properly-typed callback
                    (maybeForEach as (cb: (v: unknown, k: string) => void) => void)((v: unknown, k: string) => { parts.push(`${k}: ${scrubTokens(String(v))}`); });
                }
            } catch (_) { /* ignore iteration errors */ }
        } else if (Array.isArray(hdrs)) {
            for (const item of hdrs as Array<unknown>) {
                if (Array.isArray(item) && item.length >= 2) {
                    try { parts.push(`${String(item[0])}: ${scrubTokens(String(item[1]))}`); } catch (_) { /* ignore */ }
                }
            }
        } else if (typeof hdrs === 'object') {
            for (const k of Object.keys(hdrs as Record<string, unknown>)) {
                try { parts.push(`${k}: ${scrubTokens(String((hdrs as Record<string, unknown>)[k] ?? ''))}`); } catch (_) { parts.push(k + ': [unavailable]'); }
            }
        }
        return parts.join(', ');
    } catch (_) { return ''; }
}

export default { spawnGitPromise, safeFetch };

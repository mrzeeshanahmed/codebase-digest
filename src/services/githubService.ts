import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
// Track created temp dirs for session-scoped cleanup
const _createdTmpDirs: string[] = [];
import { internalErrors, interactiveMessages } from '../utils';
import { logErrorToChannel } from '../utils/errorHandler';
import { spawnGitPromise, safeFetch } from '../utils/procRedact';
import { scrubTokens } from '../utils/redaction';
// (no-op) additional logging helper imported where needed

// Helpers
function stringifyErr(e: unknown): string {
    if (typeof e === 'string') { return e; }
    if (!e) { return String(e); }
    if (typeof e === 'object' && 'message' in e) {
        try { return String((e as { message?: unknown }).message ?? String(e)); } catch (ex) { return String(e); }
    }
    try { return String(e); } catch (ex) { return '[unserializable error]'; }
}

function safeAssignDetails(err: unknown, details: string) {
    try {
        if (err && typeof err === 'object' && err !== null) {
            try { (err as Record<string, unknown>)['details'] = details; } catch (_) { /* ignore */ }
        }
    } catch (_) { /* ignore */ }
}

// Validation helpers to reduce risk of command injection via crafted refs or owner/repo
function isValidOwnerRepo(s: string): boolean {
    // Basic owner/repo check: two path segments composed of allowed chars
    return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(s);
}

function isSafeRefName(ref: string): boolean {
    // Accept simple branch/tag names and full ref names without shell metacharacters.
    // Allow alphanumerics, /, -, _, ., and refs like refs/heads/foo
    return /^[A-Za-z0-9_\-\.\/]+$/.test(ref);
}

function isSafeSubpath(p: string): boolean {
    // Subpath for sparse-checkout should not attempt traversal and should be a relative path
    if (!p || typeof p !== 'string') { return false; }
    // Normalize separators to POSIX style for validation
    const norm = p.replace(/\\/g, '/');
    // Allow absolute paths by stripping leading slashes for validation
    const trimmed = norm.replace(/^\/+/, '');
    // Disallow parent traversal segments
    if (trimmed.split('/').some(seg => seg === '..' || seg.includes('..'))) { return false; }
    // Allow typical path chars, letters, numbers, - _ . / and no shell metacharacters
    return /^[A-Za-z0-9_\-\.\/]+$/.test(trimmed);
}

export interface RemoteRepoMeta {
    ownerRepo: string;
    resolved: {
        sha: string;
        branch?: string;
        tag?: string;
        commit?: string;
    };
    subpath?: string;
}

// Build remote summary block for display
export function buildRemoteSummary(meta: RemoteRepoMeta): string {
    // Guard defensively in case tests or callers provide a meta without a resolved block.
    const resolved = meta && (meta as any).resolved ? (meta as any).resolved as { sha?: string; branch?: string; tag?: string; commit?: string } : { sha: '(unknown)' };
    const refLabel = (resolved && (resolved.branch || resolved.tag || resolved.commit)) ? (resolved.branch || resolved.tag || resolved.commit) : '(default)';
    const sha = resolved && resolved.sha ? resolved.sha : '(unknown)';
    return `# Remote Source\nRepository: ${meta.ownerRepo}\nRef: ${refLabel} => ${sha}\nSubpath: ${meta.subpath || '-'}\n`;
}

export async function runSubmoduleUpdate(repoPath: string): Promise<void> {
    // Use spawnGitPromise wrapper which validates args and scrubs output
    await spawnGitPromise(['submodule', 'update', '--init', '--recursive'], { cwd: repoPath, env: process.env }).then(() => {});
}

export async function authenticate(): Promise<string> {
    // Request minimal scopes first (no 'repo') to support public repo access without elevated scopes.
    // If the user authorizes with a session that lacks necessary scopes for private repos, callers
    // that need 'repo' will need to request a re-auth with the broader scope.
    let session = await vscode.authentication.getSession('github', [], { createIfNone: true });
    if (!session || !session.accessToken) {
        // Fall back to requesting repo scope (for private repo access) if user agrees.
        session = await vscode.authentication.getSession('github', ['repo'], { createIfNone: true });
    }
    if (!session || !session.accessToken) {
        throw new internalErrors.GitAuthError('github.com', 'GitHub authentication failed');
    }
    return session.accessToken;
}

async function githubApiRequest(endpoint: string, token: string): Promise<unknown> {
    const raw = await safeFetch(`https://api.github.com${endpoint}`, {
        headers: { Authorization: `Bearer ${token}` }
    });
    if (!raw || typeof raw !== 'object') { throw new Error('Unexpected response from GitHub API'); }
    const res = raw as { ok?: boolean; status?: number; headers?: { get: (k: string) => string | null }; statusText?: string; json?: () => Promise<unknown> };
    const ok = typeof res.ok === 'boolean' ? res.ok : false;
    const status = typeof res.status === 'number' ? res.status : 0;
    const headers = res.headers && typeof res.headers.get === 'function' ? res.headers : undefined;
    if (!ok) {
        const isRateLimit = status === 429 || (status === 403 && headers && headers.get('x-ratelimit-remaining') === '0');
        if (isRateLimit) {
            throw new internalErrors.RateLimitError('GitHub', `GitHub API rate limit exceeded (${status}).`);
        }
        if (status === 404) {
            throw new Error('Repository or reference not found. Check owner/repo and ref.');
        }
        if (status === 401) {
            throw new internalErrors.GitAuthError('github.com', `Authentication failed or insufficient permissions (${status}).`);
        }
        throw new Error(`GitHub API error: ${status} ${res.statusText || ''}`);
    }
    return res.json ? await res.json() : undefined;
}

export async function resolveRefToSha(ownerRepo: string, ref?: { tag?: string; branch?: string; commit?: string }, token?: string): Promise<string> {
    if (ref?.commit) { return ref.commit; }
    // Validate owner/repo form to avoid unexpected input reaching git commands
    if (!isValidOwnerRepo(ownerRepo)) {
        throw new Error(scrubTokens(`Invalid repository identifier: ${ownerRepo}`));
    }
    const [owner, repo] = ownerRepo.split('/');
    // Try API if token is present
    if (token) {
        let attempts = 0;
        let currentToken = token;
        while (attempts < 2) {
            try {
                if (ref?.tag) {
                    const tagsRes = await githubApiRequest(`/repos/${owner}/${repo}/tags`, currentToken);
                    if (Array.isArray(tagsRes)) {
                        const tagObj = tagsRes.find(t => {
                            if (!t || typeof t !== 'object') { return false; }
                            const name = (t as Record<string, unknown>)['name'];
                            return typeof name === 'string' && name === ref.tag;
                        }) as Record<string, unknown> | undefined;
                        if (!tagObj) { throw new Error(scrubTokens(`Tag not found: ${ref.tag}`)); }
                        const commitObj = tagObj['commit'] as Record<string, unknown> | undefined;
                        return String(commitObj && typeof commitObj['sha'] !== 'undefined' ? String(commitObj['sha']) : '');
                    }
                    throw new Error(scrubTokens('Unexpected response when listing tags'));
                }
                if (ref?.branch) {
                    const branchRes = await githubApiRequest(`/repos/${owner}/${repo}/branches/${ref.branch}`, currentToken);
                    if (branchRes && typeof branchRes === 'object') {
                        const commitObj = (branchRes as Record<string, unknown>)['commit'] as Record<string, unknown> | undefined;
                        return String(commitObj && typeof commitObj['sha'] !== 'undefined' ? String(commitObj['sha']) : '');
                    }
                    throw new Error(scrubTokens('Unexpected branch response from GitHub API'));
                }
                // Default: HEAD of default branch
                const repoInfo = await githubApiRequest(`/repos/${owner}/${repo}`, currentToken);
                if (repoInfo && typeof repoInfo === 'object') {
                    const defaultBranch = (repoInfo as Record<string, unknown>)['default_branch'] as string | undefined;
                    const branch = await githubApiRequest(`/repos/${owner}/${repo}/branches/${defaultBranch}`, currentToken);
                    if (branch && typeof branch === 'object') {
                        const commitObj = (branch as Record<string, unknown>)['commit'] as Record<string, unknown> | undefined;
                        return String(commitObj && typeof commitObj['sha'] !== 'undefined' ? String(commitObj['sha']) : '');
                    }
                }
                throw new Error(scrubTokens('Unexpected repository response from GitHub API'));
            } catch (apiErr: unknown) {
                attempts += 1;
                if (apiErr instanceof internalErrors.GitAuthError) {
                    // Ask user if they want to re-auth
                    const resp = await interactiveMessages.showUserError(apiErr, scrubTokens('Authentication required to access GitHub repository'));
                    if (resp && typeof resp === 'object' && (resp as Record<string, unknown>)['action'] === 'signIn') {
                        try {
                            currentToken = await authenticate();
                            continue; // retry with new token
                        } catch (aErr) {
                            throw apiErr;
                        }
                    }
                    throw apiErr;
                }
                if (apiErr instanceof internalErrors.RateLimitError) {
                    await interactiveMessages.showUserError(apiErr, scrubTokens('GitHub API rate limit reached'));
                    throw apiErr;
                }
                // Other API errors: break and fall back to ls-remote
                if (attempts >= 1) { break; }
            }
        }
    }
    // Fallback: git ls-remote. Prefer using an authenticated URL when we have a token so
    // private repositories can be resolved. We still scrub tokens from any surfaced messages.
    const refName = ref?.tag ? `refs/tags/${ref.tag}` : ref?.branch ? `refs/heads/${ref.branch}` : 'HEAD';
    // Validate refName (skip HEAD which is allowed)
    if (refName !== 'HEAD') {
        if (!isSafeRefName(refName)) {
            throw new Error(scrubTokens(`Invalid ref name: ${refName}`));
        }
    }
            try {
                const remoteUrl = token ? `https://x-access-token:${encodeURIComponent(token)}@github.com/${owner}/${repo}.git` : `https://github.com/${owner}/${repo}.git`;
                return await spawnGitPromise(['ls-remote', remoteUrl, refName]).then(r => {
                    let stdout = '';
                    if (r && typeof r === 'object') {
                        const s = (r as Record<string, unknown>)['stdout'];
                        if (typeof s === 'string') { stdout = s; }
                    }
                    const match = stdout.match(/^([a-f0-9]+)\s+/m);
                    if (match) { return match[1]; }
                    throw new Error(scrubTokens(`Could not resolve ref: ${refName}`));
                });
            } catch (lsErr: unknown) {
        // Scrub any tokens or repo/ref values before throwing up to callers. Provide an actionable message.
        const safeRef = scrubTokens(refName);
        const rawDetails = stringifyErr(lsErr);
        const scrubbedDetails = scrubTokens(rawDetails);
        // Detect common platform/tooling issues and give more helpful guidance
        const lower = (scrubbedDetails || '').toLowerCase();
        if (lower.includes('enoent') || lower.includes('spawn git') || lower.includes('not found')) {
            const msg = 'Git executable not found or not available on PATH. Install Git and ensure `git --version` works from your shell.';
            const err = new Error(msg);
            safeAssignDetails(err, scrubbedDetails);
            throw err;
        }
        // Generic actionable message for resolution failures
        const suggestions = ['Ensure the repository and ref exist', 'For private repositories ensure your GitHub authentication token has appropriate scopes (repo)', 'Check network/firewall/proxy settings', `Try running: git ls-remote ${scrubTokens(token ? 'https://<redacted>@github.com/' + owner + '/' + repo + '.git' : 'https://github.com/' + owner + '/' + repo + '.git')} ${safeRef}`];
        const msg = `Could not resolve reference ${safeRef} via git ls-remote. ${suggestions.join('; ')}.`;
        const err = new Error(msg);
        safeAssignDetails(err, scrubbedDetails);
        throw err;
    }
}

export async function partialClone(ownerRepo: string, shaOrRef: string, subpath?: string, tmpDir?: string, opts?: { skipSparse?: boolean, skipFilter?: boolean }, authToken?: string): Promise<string> {
    const [owner, repo] = ownerRepo.split('/');
    // Optional token passed from caller; if provided, use it for authenticated clone via GIT_ASKPASS
    const providedToken = authToken;
    // Use GIT_ASKPASS to avoid embedding token in command args. The askpass
    // helper is written into the clone directory so it can read a token from
    // an environment variable. We recreate the helper if the dir is re-made
    // during retry paths.
    const url = `https://github.com/${owner}/${repo}.git`;
    // Use a session-unique prefix to reduce collisions and make tmp dir scoping obvious
    const sessionPrefix = `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2,8)}-`;
    let dir = tmpDir || fs.mkdtempSync(path.join(os.tmpdir(), `${sessionPrefix}${repo}-`));
    if (!tmpDir) {
        _createdTmpDirs.push(dir);
        // Write a small metadata file so we can later identify the creator process
        try {
                    const meta: Record<string, unknown> = {
                        pid: process.pid,
                        ppid: (process as { ppid?: number }).ppid || null,
                        createdAt: new Date().toISOString(),
                        exec: process.execPath,
                        stack: (new Error()).stack?.split('\n').slice(2,8)
                    };
                    fs.writeFileSync(path.join(dir, '.codebase-digest-creator.json'), JSON.stringify(meta, null, 2));
        } catch (e) { /* best-effort, ignore */ }
    }
    let env: any = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
    // Optional output channel and buffered chunk writer for streaming git output
    let outChannel: vscode.OutputChannel | undefined;
    // Buffer and timer for coalescing small writes
    let writeBuffer = '';
    let flushTimer: NodeJS.Timeout | undefined;
    const FLUSH_MS_DEFAULT = 150;
    let flushMs = FLUSH_MS_DEFAULT;
    // Configurable UX: show channel when starting, and close on complete
    let showOnStart = true;
    let closeOnComplete = false;
    try {
        outChannel = vscode.window.createOutputChannel('Code Ingest');
        try {
            const cfg = vscode.workspace && typeof vscode.workspace.getConfiguration === 'function' ? vscode.workspace.getConfiguration('codebaseDigest') : null;
            if (cfg && typeof cfg.get === 'function') {
                const s = cfg.get('showIngestOutputChannel', true);
                const c = cfg.get('closeIngestOutputOnComplete', false);
                const fm = cfg.get('ingestOutputFlushMs', FLUSH_MS_DEFAULT);
                showOnStart = typeof s === 'boolean' ? s : true;
                closeOnComplete = typeof c === 'boolean' ? c : false;
                flushMs = typeof fm === 'number' && fm >= 20 ? fm : FLUSH_MS_DEFAULT;
            }
        } catch (_) { /* ignore config read errors */ }
    } catch (_) { outChannel = undefined; }

    const scheduleFlush = () => {
        try {
            if (flushTimer) { return; }
            flushTimer = setTimeout(() => {
                try {
                    if (outChannel && writeBuffer.length > 0) {
                        outChannel.append(writeBuffer);
                    }
                } catch (_) { /* ignore */ }
                writeBuffer = '';
                if (flushTimer) { clearTimeout(flushTimer); flushTimer = undefined; }
            }, flushMs) as unknown as NodeJS.Timeout;
        } catch (_) { /* ignore */ }
    };

    const chunkWriter = (chunk: { stream: 'stdout' | 'stderr'; data: string }) => {
        try {
            const text = scrubTokens(chunk.data || '');
            // Coalesce into buffer and schedule a flush
            writeBuffer += text;
            scheduleFlush();
        } catch (_) { /* ignore logging errors */ }
    };

    // Optionally show the channel at start and write a start line
    const startTime = Date.now();
    const writeStartLine = () => {
        try {
            if (outChannel && showOnStart) {
                outChannel.appendLine(`=== Ingest started: ${new Date(startTime).toISOString()} - ${owner}/${repo} ===`);
            }
        } catch (_) { /* ignore */ }
    };
    try { if (outChannel && showOnStart) { outChannel.show(true); } } catch (_) { /* ignore */ }
    writeStartLine();
    // Helper to write askpass script into `dir` and set env vars accordingly
    // Write askpass helper into a separate temp dir (not the clone target) so the
    // clone target stays empty. Only create the helper when we have a token.
    let askpassDir: string | undefined;
    let askpassPath: string | undefined;
    const writeAskpass = () => {
        if (!providedToken) { return; }
        try {
            askpassDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codebase-digest-askpass-'));
            askpassPath = path.join(askpassDir, 'git-askpass.sh');
            const script = `#!/bin/sh\ncase \"$1\" in\n*Username*) printf 'x-access-token\\n' ;;\n*Password*) printf '%s\\n' \"$GIT_ASKPASS_TOKEN\" ;;\n*) printf '\\n' ;;\nesac\n`;
            fs.writeFileSync(askpassPath, script, { mode: 0o700 });
            try { fs.chmodSync(askpassPath, 0o700); } catch (e) { /* ignore */ }
            env = { ...env, GIT_ASKPASS: askpassPath, GIT_ASKPASS_TOKEN: providedToken };
        } catch (e) {
            // If we cannot write the helper, fall back to token-in-url as last resort.
            // Swallow here; clone will still attempt and may fail with a sanitized error.
            try { askpassDir = undefined; askpassPath = undefined; } catch (_) {}
        }
    };
    // Create askpass helper before any clone attempt
    writeAskpass();
    // Wrap clone+sparse logic so we can cleanup the temp dir on failure if we created it
    const createdHere = !tmpDir;
    try {
        // Step 1: git clone
        // Pick clone args; allow opts.skipFilter to disable the blob filter if requested
        const baseCloneArgsTemplate = opts && opts.skipFilter ? ['clone','--no-checkout','--depth','1','--single-branch',url] : ['clone','--no-checkout','--depth','1','--filter=blob:none','--single-branch',url];
        // Defensive retry: if an external process has created a conflicting temp dir
        // (destination already exists and is not empty), allocate a fresh mkdtemp and retry.
        const maxCloneAttempts = 3;
        let cloneAttempt = 0;
        // (chunkWriter is declared at function scope)

        while (true) {
            const baseCloneArgs = [...baseCloneArgsTemplate, dir];
            try {
                await spawnGitPromise(baseCloneArgs, { env }, chunkWriter).then(() => {});
                break; // success
            } catch (cloneErr: any) {
                    const details = scrubTokens(String(cloneErr && typeof cloneErr === 'object' ? String((cloneErr as Record<string, unknown>)['details'] || (cloneErr as Record<string, unknown>)['message'] || String(cloneErr)) : String(cloneErr || '')));
                const lower = (details || '').toLowerCase();
                // Detect missing git executable and rethrow with clearer guidance
                    if (lower.includes('enoent') || lower.includes('spawn git') || lower.includes('not found')) {
                    const msg = 'Git not found: please install Git and ensure it is available on your PATH. Visit https://git-scm.com/downloads, install Git, then restart Visual Studio Code and retry. Verify by running `git --version` in your terminal.';
                    const err = new Error(msg);
                        safeAssignDetails(err, details);
                    throw err;
                }
                // Handle destination-collision cases by retrying with a fresh mkdtemp
                if (lower.includes('already exists') || lower.includes('destination path')) {
                    cloneAttempt += 1;
                    if (cloneAttempt >= maxCloneAttempts) {
                        // Exhausted retries; rethrow original error
                        throw cloneErr;
                    }
                    // Allocate a new temp dir and continue; do not attempt to remove an
                    // externally-created directory. Track newly-created dirs for cleanup.
                        try {
                            const newDir = fs.mkdtempSync(path.join(os.tmpdir(), `${sessionPrefix}${repo}-`));
                            if (!tmpDir) { _createdTmpDirs.push(newDir); }
                            // Best-effort: annotate dir so future investigations can attribute it
                            try {
                                const meta: Record<string, unknown> = {
                                    pid: process.pid,
                                    ppid: (process as { ppid?: number }).ppid || null,
                                    createdAt: new Date().toISOString(),
                                    exec: process.execPath,
                                    stack: (new Error()).stack?.split('\n').slice(2,8)
                                };
                                fs.writeFileSync(path.join(newDir, '.codebase-digest-creator.json'), JSON.stringify(meta, null, 2));
                            } catch (_) { /* ignore */ }
                            dir = newDir;
                        // Re-write askpass helper if needed so GIT_ASKPASS points to a valid file
                        try { writeAskpass(); } catch (_) { /* ignore */ }
                        // continue loop and retry clone
                        continue;
                    } catch (mkErr) {
                        // If we cannot create a fresh temp dir, surface original clone error
                        throw cloneErr;
                    }
                }
                // Otherwise rethrow the clone error
                throw cloneErr;
            }
        }
        // Step 2: sparse-checkout if subpath and not explicitly skipped
        if (subpath && !(opts && opts.skipSparse)) {
            // Validate subpath provided by caller to avoid passing malicious
            // values into git sparse-checkout commands which could be abused
            // to cause unexpected behavior or reveal filesystem structure.
            if (!isSafeSubpath(subpath)) {
                throw new Error(scrubTokens(`Invalid subpath for sparse-checkout: ${subpath}`));
            }
            try {
                await spawnGitPromise(['sparse-checkout','init','--cone'], { cwd: dir, env }, chunkWriter).then(() => {});
                await spawnGitPromise(['sparse-checkout','set', subpath], { cwd: dir, env }, chunkWriter).then(() => {});
            } catch (sparseErr: any) {
                // Scrub error and present retry choices to the user to try less strict clone options.
                const safeMsg = scrubTokens(String(sparseErr && sparseErr.message ? sparseErr.message : sparseErr));
                try {
                    const choice = await vscode.window.showQuickPick([
                        { label: 'Retry: full clone (no sparse, may be larger)', id: 'full' },
                        { label: 'Retry: clone without --filter (try sparse again)', id: 'nofilter' },
                        { label: 'Cancel', id: 'cancel' }
                    ], { placeHolder: `Sparse checkout failed: ${safeMsg}`, ignoreFocusOut: true });
                    if (!choice || choice.id === 'cancel') {
                        throw new Error(scrubTokens('Sparse checkout failed and user canceled retry.'));
                    }
                    // Remove possibly-partially-created dir before retrying
                    if (fs.existsSync(dir)) { fs.rmSync(dir, { recursive: true, force: true }); }
                    // Re-create dir for retry
                    fs.mkdirSync(dir, { recursive: true });
                    // Re-write askpass helper into the recreated dir so GIT_ASKPASS points to a valid file
                    try { writeAskpass(); } catch (e) { /* ignore */ }
                    if (choice.id === 'nofilter') {
                        // Retry clone without blob filter and attempt sparse again
                        await spawnGitPromise(['clone','--no-checkout','--depth','1','--single-branch',url,dir], { env }, chunkWriter);
                        // attempt sparse again
                        await spawnGitPromise(['sparse-checkout','init','--cone'], { cwd: dir, env }, chunkWriter).then(() => {});
                        await spawnGitPromise(['sparse-checkout','set', subpath], { cwd: dir, env }, chunkWriter).then(() => {});
                    } else if (choice.id === 'full') {
                        // Full shallow clone (no --no-checkout necessary)
                        await spawnGitPromise(['clone','--depth','1','--single-branch',url,dir], { env }, chunkWriter);
                        // No sparse needed; subpath will be present in working tree after checkout
                    }
                } catch (retryErr: any) {
                    // Propagate a scrubbed retry error so caller can handle cleanup
                    if (retryErr && typeof retryErr === 'object' && 'message' in retryErr) {
                        try { (retryErr as Record<string, unknown>)['message'] = scrubTokens(String((retryErr as Record<string, unknown>)['message'])); } catch (_) {}
                    }
                    throw retryErr;
                }
            }
        }
    } catch (err) {
        // On any failure, if we created the dir here, attempt best-effort cleanup before propagating
        // Write a failure line with duration
        try {
            const dur = Date.now() - startTime;
            if (outChannel) {
                outChannel.appendLine(`=== Ingest FAILED after ${dur} ms ===`);
                try { if (err && String(err)) { outChannel.appendLine(scrubTokens(String(err))); } } catch (_) { /* ignore */ }
            }
        } catch (_) { /* ignore */ }
        try {
            if (createdHere && fs.existsSync(dir)) { await cleanup(dir); }
        } catch (ce) {
            // swallow cleanup errors; caller will see original error
        }
        // Also attempt to cleanup the askpass helper dir if we created one
        try {
            if (askpassDir && fs.existsSync(askpassDir)) { fs.rmSync(askpassDir, { recursive: true, force: true }); }
        } catch (_) { /* ignore */ }
        // As a final best-effort, attempt to clean any session-scoped temp dirs
        try {
            cleanupSessionTmpDirs();
        } catch (_) { /* ignore */ }
        // Rethrow after cleanup
        try { throw err; } catch (e) { throw e; }
    }
    // Step 3: git checkout
    try {
        // Validate shaOrRef prior to handing to git. Allow full 40-char hex shas,
        // short shas (7+ hex), or safe ref names validated by isSafeRefName.
        const isFullSha = /^[a-f0-9]{40}$/.test(shaOrRef);
        const isShortSha = /^[a-f0-9]{7,40}$/.test(shaOrRef);
        if (!(isFullSha || isShortSha || isSafeRefName(shaOrRef))) {
            throw new Error(scrubTokens(`Invalid git ref or sha: ${shaOrRef}`));
        }
    await spawnGitPromise(['checkout', shaOrRef], { cwd: dir, env }, chunkWriter).then(() => {});
    } catch (checkoutErr: any) {
        const details = scrubTokens(String(checkoutErr && typeof checkoutErr === 'object' ? String((checkoutErr as Record<string, unknown>)['details'] || (checkoutErr as Record<string, unknown>)['message'] || String(checkoutErr)) : String(checkoutErr || '')));
        const lower = (details || '').toLowerCase();
        if (lower.includes('enoent') || lower.includes('spawn git') || lower.includes('not found')) {
            const msg = 'Git not found: please install Git and ensure it is available on your PATH. Visit https://git-scm.com/downloads, install Git, then restart Visual Studio Code and retry. Verify by running `git --version` in your terminal.';
            const err = new Error(msg);
            safeAssignDetails(err, details);
            throw err;
        }
        throw checkoutErr;
    }
    // Clean up the askpass helper now that clone/checkout are complete. Keep the
    // clone target intact; the helper is only needed for the git operations above.
    try {
        if (askpassDir && fs.existsSync(askpassDir)) { fs.rmSync(askpassDir, { recursive: true, force: true }); }
    } catch (_) { /* ignore */ }
    // Write completion line and flush buffer
    try {
        const dur = Date.now() - startTime;
        if (outChannel) {
            outChannel.appendLine(`=== Ingest completed: ${new Date().toISOString()} (duration ${dur} ms) ===`);
        }
    } catch (_) { /* ignore */ }
    // Flush any remaining buffered output and optionally close the channel
    try {
        if (flushTimer) { clearTimeout(flushTimer); flushTimer = undefined; }
        if (outChannel && writeBuffer.length > 0) { outChannel.append(writeBuffer); writeBuffer = ''; }
        if (outChannel && closeOnComplete) {
            try { outChannel.hide(); } catch (_) { /* ignore */ }
        }
    } catch (_) { /* ignore */ }

    return dir;
}

export async function cleanup(tmpDir: string): Promise<void> {
    if (fs.existsSync(tmpDir)) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
}

// Cleanup any lingering tmp dirs created during this session (best-effort)
export function cleanupSessionTmpDirs(): void {
    for (const d of _createdTmpDirs.slice()) {
        try {
            if (fs.existsSync(d)) {
                fs.rmSync(d, { recursive: true, force: true });
            }
        } catch (e) {
            // swallow
        }
    }
}

export async function ingestRemoteRepo(urlOrSlug: string, options?: { ref?: { tag?: string; branch?: string; commit?: string }, subpath?: string, includeSubmodules?: boolean }, tmpDir?: string): Promise<{ localPath: string; meta: RemoteRepoMeta }> {
    let localPath: string | undefined;
    try {
        let ownerRepo = urlOrSlug;
        if (urlOrSlug.startsWith('https://')) {
            const m = urlOrSlug.match(/github.com\/([^\/]+\/[^\/]+)(?:\/|$)/);
            if (!m) {
                await interactiveMessages.showUserError(new Error('Invalid GitHub URL'), tmpDir || urlOrSlug);
                throw new Error('Invalid GitHub URL');
            }
            ownerRepo = m[1];
        }
        // Normalize input: remove trailing .git if user supplied owner/repo.git
        ownerRepo = ownerRepo.replace(/\.git$/, '');

        // Authenticate (caller is responsible for providing a writable tmpDir)
        const token = await authenticate();

        // Resolve the requested ref to a SHA
        let sha: string;
        try {
            sha = await resolveRefToSha(ownerRepo, options?.ref, token);
        } catch (err: any) {
            if (err && err.message) { err.message = scrubTokens(String(err.message)); }
            if (err instanceof internalErrors.RateLimitError) {
                await interactiveMessages.showUserError(err, scrubTokens(String(err.message)));
            } else if (err instanceof internalErrors.GitAuthError) {
                await interactiveMessages.showUserError(err, scrubTokens('Authentication required to access this repository.'));
            } else {
                await interactiveMessages.showUserError(new Error(scrubTokens('Remote repository ingest failed.')), scrubTokens(String(err)));
            }
            throw err;
        }

        // Perform partial clone into the caller-provided tmpDir
        localPath = await partialClone(ownerRepo, sha, options?.subpath, tmpDir, undefined, token);

        // If includeSubmodules, run git submodule update --init --recursive
        if (options?.includeSubmodules) {
            await runSubmoduleUpdate(localPath!);
        }

        return {
            localPath: localPath!,
            meta: {
                ownerRepo,
                resolved: { sha, branch: options?.ref?.branch, tag: options?.ref?.tag, commit: options?.ref?.commit },
                subpath: options?.subpath
            }
        };
    } finally {
        // Ensure temporary directory is cleaned up on any failure path if it exists and wasn't returned
        try {
            if (tmpDir && (!localPath || !localPath.startsWith(tmpDir))) {
                await cleanup(tmpDir);
            }
        } catch (cleanupErr) {
            try { logErrorToChannel(cleanupErr, `Failed to cleanup temporary dir ${tmpDir}`); } catch (e) { try { console.error('cleanup reporting failed', e); } catch {} }
        }
    }
}

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
// Track created temp dirs for session-scoped cleanup
const _createdTmpDirs: string[] = [];
import { exec } from 'child_process';
import { internalErrors, interactiveMessages } from '../utils';
import { spawnGitPromise, safeFetch } from '../utils/procRedact';
import { scrubTokens } from '../utils/redaction';

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
    return `# Remote Source\nRepository: ${meta.ownerRepo}\nRef: ${meta.resolved.branch || meta.resolved.tag || meta.resolved.commit || '(default)'} => ${meta.resolved.sha}\nSubpath: ${meta.subpath || '-'}\n`;
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

async function githubApiRequest(endpoint: string, token: string): Promise<any> {
    const res = await safeFetch(`https://api.github.com${endpoint}`, {
        headers: { Authorization: `Bearer ${token}` }
    });
    if (!res.ok) {
        const isRateLimit = res.status === 429 || (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0');
        if (isRateLimit) {
            throw new internalErrors.RateLimitError('GitHub', `GitHub API rate limit exceeded (${res.status}).`);
        }
        if (res.status === 404) {
            throw new Error('Repository or reference not found. Check owner/repo and ref.');
        }
        if (res.status === 401 || (res.status === 403 && !isRateLimit)) {
            throw new internalErrors.GitAuthError('github.com', `Authentication failed or insufficient permissions (${res.status}).`);
        }
        throw new Error(`GitHub API error: ${res.status} ${res.statusText}`);
    }
    return await res.json();
}

export async function resolveRefToSha(ownerRepo: string, ref?: { tag?: string; branch?: string; commit?: string }, token?: string): Promise<string> {
    if (ref?.commit) { return ref.commit; }
    const [owner, repo] = ownerRepo.split('/');
    // Try API if token is present
    if (token) {
        let attempts = 0;
        let currentToken = token;
        while (attempts < 2) {
            try {
                if (ref?.tag) {
                    const tags = await githubApiRequest(`/repos/${owner}/${repo}/tags`, currentToken);
                    const tagObj = tags.find((t: any) => t.name === ref.tag);
                    if (!tagObj) { throw new Error(scrubTokens(`Tag not found: ${ref.tag}`)); }
                    return tagObj.commit.sha;
                }
                if (ref?.branch) {
                    const branch = await githubApiRequest(`/repos/${owner}/${repo}/branches/${ref.branch}`, currentToken);
                    return branch.commit.sha;
                }
                // Default: HEAD of default branch
                const repoInfo = await githubApiRequest(`/repos/${owner}/${repo}`, currentToken);
                const branch = await githubApiRequest(`/repos/${owner}/${repo}/branches/${repoInfo.default_branch}`, currentToken);
                return branch.commit.sha;
            } catch (apiErr: any) {
                attempts += 1;
                if (apiErr instanceof internalErrors.GitAuthError) {
                    // Ask user if they want to re-auth
                    const resp = await interactiveMessages.showUserError(apiErr, scrubTokens('Authentication required to access GitHub repository'));
                    if (resp && (resp as any).action === 'signIn') {
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
    try {
        const remoteUrl = token ? `https://x-access-token:${encodeURIComponent(token)}@github.com/${owner}/${repo}.git` : `https://github.com/${owner}/${repo}.git`;
        return await spawnGitPromise(['ls-remote', remoteUrl, refName]).then(r => {
            const match = (r.stdout || '').match(/^([a-f0-9]+)\s+/m);
            if (match) { return match[1]; }
            throw new Error(scrubTokens(`Could not resolve ref: ${refName}`));
        });
    } catch (lsErr: any) {
        // Scrub any tokens or repo/ref values before throwing up to callers. Provide an actionable message.
        const safeRef = scrubTokens(refName);
        const rawDetails = lsErr && (lsErr.details || lsErr.message) ? String(lsErr.details || lsErr.message) : String(lsErr || '');
        const scrubbedDetails = scrubTokens(rawDetails);
        // Detect common platform/tooling issues and give more helpful guidance
        const lower = (scrubbedDetails || '').toLowerCase();
        if (lower.includes('enoent') || lower.includes('spawn git') || lower.includes('not found')) {
            const msg = 'Git executable not found or not available on PATH. Install Git and ensure `git --version` works from your shell.';
            const err = new Error(msg);
            try { (err as any).details = scrubbedDetails; } catch (_) {}
            throw err;
        }
        // Generic actionable message for resolution failures
        const suggestions = ['Ensure the repository and ref exist', 'For private repositories ensure your GitHub authentication token has appropriate scopes (repo)', 'Check network/firewall/proxy settings', `Try running: git ls-remote ${scrubTokens(token ? 'https://<redacted>@github.com/' + owner + '/' + repo + '.git' : 'https://github.com/' + owner + '/' + repo + '.git')} ${safeRef}`];
        const msg = `Could not resolve reference ${safeRef} via git ls-remote. ${suggestions.join('; ')}.`;
        const err = new Error(msg);
        try { (err as any).details = scrubbedDetails; } catch (_) {}
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
    const dir = tmpDir || fs.mkdtempSync(path.join(os.tmpdir(), `${sessionPrefix}${repo}-`));
    if (!tmpDir) { _createdTmpDirs.push(dir); }
    let env: any = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
    // Helper to write askpass script into `dir` and set env vars accordingly
    const askpassPath = path.join(dir, '.git-askpass.sh');
    const writeAskpass = () => {
        const script = `#!/bin/sh\ncase \"$1\" in\n*Username*) printf 'x-access-token\\n' ;;\n*Password*) printf '%s\\n' \"$GIT_ASKPASS_TOKEN\" ;;\n*) printf '\\n' ;;\nesac\n`;
        try {
            fs.writeFileSync(askpassPath, script, { mode: 0o700 });
            try { fs.chmodSync(askpassPath, 0o700); } catch (e) { /* ignore */ }
        } catch (e) {
            // If we cannot write the helper, fall back to token-in-url as last resort
            // but ensure we scrub outputs. This should be rare.
            // Note: we still prefer the askpass approach.
        }
        if (providedToken) {
            env = { ...env, GIT_ASKPASS: askpassPath, GIT_ASKPASS_TOKEN: providedToken };
        }
    };
    // Create askpass helper before any clone attempt
    writeAskpass();
    // Wrap clone+sparse logic so we can cleanup the temp dir on failure if we created it
    const createdHere = !tmpDir;
    try {
        // Step 1: git clone
        // Pick clone args; allow opts.skipFilter to disable the blob filter if requested
    const baseCloneArgs = opts && opts.skipFilter ? ['clone','--no-checkout','--depth','1','--single-branch',url,dir] : ['clone','--no-checkout','--depth','1','--filter=blob:none','--single-branch',url,dir];
    try {
        await spawnGitPromise(baseCloneArgs, { env }).then(() => {});
    } catch (cloneErr: any) {
        const details = scrubTokens(String(cloneErr && (cloneErr.details || cloneErr.message) ? (cloneErr.details || cloneErr.message) : cloneErr || ''));
        const lower = (details || '').toLowerCase();
        if (lower.includes('enoent') || lower.includes('spawn git') || lower.includes('not found')) {
            // Provide clearer guidance for missing Git executable
            const msg = 'Git not found: please install Git and ensure it is available on your PATH. Visit https://git-scm.com/downloads, install Git, then restart Visual Studio Code and retry. Verify by running `git --version` in your terminal.';
            const err = new Error(msg);
            try { (err as any).details = details; } catch (_) {}
            throw err;
        }
        throw cloneErr;
    }
        // Step 2: sparse-checkout if subpath and not explicitly skipped
        if (subpath && !(opts && opts.skipSparse)) {
            try {
                await spawnGitPromise(['sparse-checkout','init','--cone'], { cwd: dir, env }).then(() => {});
                await spawnGitPromise(['sparse-checkout','set', subpath], { cwd: dir, env }).then(() => {});
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
                        await spawnGitPromise(['clone','--no-checkout','--depth','1','--single-branch',url,dir], { env });
                        // attempt sparse again
                        await spawnGitPromise(['sparse-checkout','init','--cone'], { cwd: dir, env }).then(() => {});
                        await spawnGitPromise(['sparse-checkout','set', subpath], { cwd: dir, env }).then(() => {});
                    } else if (choice.id === 'full') {
                        // Full shallow clone (no --no-checkout necessary)
                        await spawnGitPromise(['clone','--depth','1','--single-branch',url,dir], { env });
                        // No sparse needed; subpath will be present in working tree after checkout
                    }
                } catch (retryErr: any) {
                    // Propagate a scrubbed retry error so caller can handle cleanup
                    if (retryErr && retryErr.message) { retryErr.message = scrubTokens(String(retryErr.message)); }
                    throw retryErr;
                }
            }
        }
    } catch (err) {
        // On any failure, if we created the dir here, attempt best-effort cleanup before propagating
        try {
            if (createdHere && fs.existsSync(dir)) { await cleanup(dir); }
        } catch (ce) {
            // swallow cleanup errors; caller will see original error
        }
        throw err;
    }
    // Step 3: git checkout
    try {
        await spawnGitPromise(['checkout', shaOrRef], { cwd: dir, env }).then(() => {});
    } catch (checkoutErr: any) {
        const details = scrubTokens(String(checkoutErr && (checkoutErr.details || checkoutErr.message) ? (checkoutErr.details || checkoutErr.message) : checkoutErr || ''));
        const lower = (details || '').toLowerCase();
        if (lower.includes('enoent') || lower.includes('spawn git') || lower.includes('not found')) {
            const msg = 'Git not found: please install Git and ensure it is available on your PATH. Visit https://git-scm.com/downloads, install Git, then restart Visual Studio Code and retry. Verify by running `git --version` in your terminal.';
            const err = new Error(msg);
            try { (err as any).details = details; } catch (_) {}
            throw err;
        }
        throw checkoutErr;
    }
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

export async function ingestRemoteRepo(urlOrSlug: string, options?: { ref?: { tag?: string; branch?: string; commit?: string }, subpath?: string, includeSubmodules?: boolean }): Promise<{ localPath: string; meta: RemoteRepoMeta }> {
    let tmpDir: string | undefined;
    let localPath: string | undefined;
    try {
        let ownerRepo = urlOrSlug;
        let refType = '';
        let refValue = '';
        if (urlOrSlug.startsWith('https://')) {
            const m = urlOrSlug.match(/github.com\/([^\/]+\/[^\/]+)(?:\/|$)/);
            if (!m) {
                await interactiveMessages.showUserError(new Error(scrubTokens('Invalid GitHub URL or owner/repo slug')), scrubTokens(urlOrSlug));
                throw new Error(scrubTokens('Invalid GitHub URL or owner/repo slug'));
            }
            ownerRepo = m[1];
        }
        // Determine repository visibility first. If the repository is public we can
        // bypass authentication entirely. If private, only allow ingest when the
        // authenticated user is the repo owner.
        let token: string | undefined = undefined;
        let resolved: { sha: string; branch?: string; tag?: string; commit?: string } = { sha: '' };
        try {
            // Unauthenticated request to check repo visibility
            const repoResp = await safeFetch(`https://api.github.com/repos/${ownerRepo}`);
            if (repoResp && repoResp.ok) {
                const repoInfo = await repoResp.json();
                if (!repoInfo.private) {
                    // Public repo — do not request auth, proceed unauthenticated
                    token = undefined;
                } else {
                    // Private repo — require authentication and verify ownership
                    const sessionToken = await authenticate();
                    // Fetch repository info using authenticated request to ensure access
                    const [repoOwner, repoName] = ownerRepo.split('/');
                    const repoInfoAuth = await githubApiRequest(`/repos/${repoOwner}/${repoName}`, sessionToken);
                    // Fetch authenticated user
                    const userInfo = await githubApiRequest('/user', sessionToken);
                    const authLogin = userInfo && userInfo.login ? String(userInfo.login) : null;
                    const repoOwnerLogin = repoInfoAuth && repoInfoAuth.owner && repoInfoAuth.owner.login ? String(repoInfoAuth.owner.login) : null;
                    if (!authLogin || !repoOwnerLogin || authLogin !== repoOwnerLogin) {
                        throw new Error('Access denied: the authenticated GitHub account does not own this private repository.');
                    }
                    token = sessionToken;
                }
            } else {
                // If we couldn't determine visibility (network/rate-limit), fall back
                // to attempting authentication so the later resolveRefToSha can use
                // the API path if possible.
                token = await authenticate();
            }
        } catch (visErr: any) {
            // If checking visibility failed due to network/auth or other transient
            // issues, fall back to requesting authentication so we can proceed.
            try {
                token = await authenticate();
            } catch (authErr) {
                // Re-throw original visibility error if authentication fails too
                if (visErr && visErr.message) { visErr.message = scrubTokens(String(visErr.message)); }
                throw visErr;
            }
        }
        if (options?.ref) {
            if (options.ref.branch) { refType = 'branch'; refValue = options.ref.branch; }
            if (options.ref.tag) { refType = 'tag'; refValue = options.ref.tag; }
            if (options.ref.commit) { refType = 'commit'; refValue = options.ref.commit; }
        }
        let sha: string;
        try {
            sha = await resolveRefToSha(ownerRepo, options?.ref, token);
        } catch (err: any) {
            // Ensure message is scrubbed before user display
            if (err && err.message) { err.message = scrubTokens(String(err.message)); }
            if (err instanceof internalErrors.RateLimitError) {
                await interactiveMessages.showUserError(err, scrubTokens(String(err.message)));
            } else if (err instanceof internalErrors.GitAuthError) {
                // Suggest signing in when auth errors occur
                await interactiveMessages.showUserError(err, scrubTokens('Authentication required to access this repository.')); 
            } else {
                await interactiveMessages.showUserError(new Error(scrubTokens('Remote repository ingest failed.')), scrubTokens(String(err)));
            }
            throw err;
        }
        resolved.sha = sha;
        resolved.branch = options?.ref?.branch;
        resolved.tag = options?.ref?.tag;
        resolved.commit = options?.ref?.commit;
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `${ownerRepo.replace('/', '-')}-`));
        try {
            localPath = await partialClone(ownerRepo, sha, options?.subpath, tmpDir, undefined, token);
        } catch (err: any) {
            if (err && err.message) { err.message = scrubTokens(String(err.message)); }
            await interactiveMessages.showUserError(new Error(scrubTokens('Git clone or checkout failed.')), scrubTokens(String(err)));
            throw err;
        }
        // If includeSubmodules, run git submodule update --init --recursive
        if (options?.includeSubmodules) {
            try {
                await spawnGitPromise(['submodule', 'update', '--init', '--recursive'], { cwd: localPath!, env: process.env }).then(() => {});
            } catch (err: any) {
                if (err && err.message) { err.message = scrubTokens(String(err.message)); }
                await interactiveMessages.showUserError(new Error(scrubTokens('Git submodule update failed.')), scrubTokens(String(err)));
                throw err;
            }
        }
        return {
            localPath: localPath!,
            meta: {
                ownerRepo,
                resolved,
                subpath: options?.subpath
            }
        };
    } catch (err) {
        throw err;
    } finally {
        // Ensure temporary directory is cleaned up on any failure path if it exists and wasn't returned
        try {
            if (tmpDir && (!localPath || !localPath.startsWith(tmpDir))) {
                await cleanup(tmpDir);
            }
        } catch (cleanupErr) {
            const ch = vscode.window.createOutputChannel('Codebase Digest Errors');
            ch.appendLine(`Failed to cleanup temporary dir ${tmpDir}: ${String(cleanupErr)}`);
            ch.show(true);
        }
    }
}

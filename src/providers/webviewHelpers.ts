import * as vscode from 'vscode';
import * as path from 'path';
import { WebviewCommand, WebviewCommands } from '../types/webview';
import { ConfigurationService } from '../services/configurationService';

// Minimal HTML-escaping helper to avoid injecting unescaped paths into webview HTML.
// Escapes: & < > " '
function escapeHtml(s: string): string {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// Lightweight typed shape for messages we accept from the webview. Additional
// properties are permitted but treated as untrusted (unknown) until validated.
export interface WebviewMessage {
    type: WebviewCommand | string;
    [key: string]: unknown;
}

export function isWebviewMessage(obj: unknown): obj is WebviewMessage {
    return !!obj && typeof obj === 'object' && typeof (obj as Record<string, unknown>)['type'] === 'string';
}

/**
 * Set HTML for a webview by rewriting resource URIs and injecting a strict CSP.
 */
export function setWebviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri) {
    const fs = require('fs');
    // Try multiple locations where index.html may exist in development and packaged builds.
    const indexCandidates = [
        path.join(extensionUri.fsPath, 'resources', 'webview', 'index.html'),
        path.join(extensionUri.fsPath, 'dist', 'resources', 'webview', 'index.html'),
        path.join(extensionUri.fsPath, 'out', 'resources', 'webview', 'index.html')
    ];
    let html: string | undefined;
    let indexPath: string | undefined;
    for (const p of indexCandidates) {
        try { if (fs.existsSync(p)) { indexPath = p; break; } } catch (e) { /* ignore */ }
    }
    if (indexPath) {
        try { html = fs.readFileSync(indexPath, 'utf8'); } catch (e) { html = undefined; }
    }
    if (!html) {
        // Fail open: provide a helpful debug page so users can see where we looked for index.html
        try {
            // Attempt to generate a nonce for the CSP; fall back to no-nonce when unavailable
            let nonceAttr = '';
            let nonce = undefined as string | undefined;
            try {
                const crypto = require('crypto');
                nonce = crypto.randomBytes(16).toString('base64');
                nonceAttr = ` nonce="${nonce}"`;
            } catch (_) {
                nonce = undefined;
                nonceAttr = '';
            }
            const cspMeta = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src ${webview.cspSource}${nonce ? ` 'nonce-${nonce}'` : ''}; style-src ${webview.cspSource}${nonce ? ` 'nonce-${nonce}'` : ''}; img-src ${webview.cspSource} data:;">`;
            const candidatesList = indexCandidates.map(p => `<li><code>${escapeHtml(p)}</code></li>`).join('\n');
            webview.html = `<!doctype html><html><head>${cspMeta}</head><body><h2>Extension resource missing</h2><p>The webview index.html could not be found. I looked in these locations:</p><ul>${candidatesList}</ul><p>Extension root: <code>${escapeHtml(extensionUri.fsPath)}</code></p><p>To fix this, ensure <code>resources/webview/index.html</code> exists (or check the packaged <code>dist/resources/webview/index.html</code>).</p><pre style="white-space:pre-wrap;">If this keeps failing during development, run the build step that populates the resources (e.g., the extension's build or packaging script).</pre></body></html>`;
        } catch (_) {
            // best-effort: if even assigning html fails, swallow to avoid extension crash
        }
        return;
    }
    // Rewrite <link> tags but skip absolute, data, or already-webview URIs
    // Helper to escape regex metacharacters for safe replacement (used below)
    function escapeRegExp(s: string) {
        return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    // Match href attributes using either single or double quotes and capture the quote char
    html = html.replace(/<link\b[^>]*\bhref\s*=\s*(['"])(.*?)\1[^>]*>/gi, (m: string, quote: string, href: string) => {
        try {
            if (/^(https?:|data:|vscode-resource:|vscode-webview-resource:)/i.test(href) || href.indexOf(webview.cspSource) !== -1) {
                return m;
            }
            const resolved = resolveResourcePath(href, extensionUri);
            
            if (!resolved) { return m; }
            const uri = webview.asWebviewUri(vscode.Uri.file(resolved)).toString();
            // Replace only the href attribute value (preserve quoting and other attributes)
            // Replace the quoted href value directly to avoid complex RegExp pitfalls.
            return m.replace(quote + href + quote, `${quote}${uri}${quote}`);
        } catch (e) { return m; }
    });

    // Rewrite <script src=> tags but skip absolute, data, or already-webview URIs
    // Match script src attributes with either single or double quotes
    html = html.replace(/<script\b[^>]*\bsrc\s*=\s*(['"])(.*?)\1[^>]*>/gi, (m: string, quote: string, src: string) => {
        try {
            if (/^(https?:|data:|vscode-resource:|vscode-webview-resource:)/i.test(src) || src.indexOf(webview.cspSource) !== -1) {
                return m;
            }
            const resolved = resolveResourcePath(src, extensionUri);
            if (!resolved) { return m; }
            const uri = webview.asWebviewUri(vscode.Uri.file(resolved)).toString();
            // Replace the quoted src value directly to avoid RegExp pitfalls.
            return m.replace(quote + src + quote, `${quote}${uri}${quote}`);
        } catch (e) { return m; }
    });
    // Rewrite image src attributes to use the webview asWebviewUri so resources are loaded from the local webview root.
    // Match single- or double-quoted src attributes and self-closing tags consistently.
    html = html.replace(/<img\s+[^>]*src=(['"])(.*?)\1[^>]*\/?>/gi, (m: string, quote: string, src: string) => {
        try {
            // Pass through absolute, data, or already-webview URIs unchanged
            if (/^(https?:|data:|vscode-resource:|vscode-webview-resource:)/i.test(src) || src.indexOf(webview.cspSource) !== -1) {
                return m;
            }

            // Normalize slashes for matching (handle Windows backslashes)
            const normalized = src.replace(/\\/g, '/');

            // Prefer the canonical resolver which checks both webview and icons locations
            let resolved: string | undefined = resolveResourcePath(normalized, extensionUri);
            // As a defensive fallback, if resolveResourcePath didn't find it, check icons locations directly
            if (!resolved) {
                const iconsMatch = normalized.match(/(?:\/(?:icons)\/)(.*)$/i);
                const rel = iconsMatch ? iconsMatch[1] : normalized;
                resolved = findExisting([path.join(extensionUri.fsPath, 'resources', 'icons', rel), path.join(extensionUri.fsPath, 'dist', 'resources', 'icons', rel), path.join(extensionUri.fsPath, 'resources', 'webview', normalized), path.join(extensionUri.fsPath, 'dist', 'resources', 'webview', normalized)]);
            }
            if (!resolved) { return m; }
            const uri = webview.asWebviewUri(vscode.Uri.file(resolved));
            // Replace only the src attribute value, preserving the original quoting and other attributes
            return m.replace(new RegExp(`src=${quote}${escapeRegExp(src)}${quote}`), `src=${quote}${uri.toString()}${quote}`);
        } catch (e) {
            // If rewriting fails, leave the tag unchanged to avoid breaking the page
            return m;
        }
    });

    // (escapeRegExp is defined above)
    
    // Resolve a resource href/src relative to the extension and dist locations.
    function resolveResourcePath(href: string, extensionUri: vscode.Uri): string | undefined {
    // Normalize common authoring prefixes so callers may reference assets as
    // "resources/..." or "dist/resources/..." or relative paths like "../icons/...".
    let normalized = href.replace(/\\/g, '/');
    // We'll attempt a set of sensible candidate locations instead of manipulating
    // the path string in-place. This handles roots like
    //  - resources/webview/styles.css
    //  - dist/resources/webview/styles.css
    //  - ../icons/icon.png (relative to webview/index.html)

    // Build a deterministic list of candidate locations. When the author
    // used upward-relative paths (e.g. "../icons/foo.png"), treat those
    // as relative to the packaged webview resources directory so they do not
    // accidentally resolve outside the extension root.
    const candidates: string[] = [];

    // Helper: ensure a candidate remains inside the extension folder. This
    // guards against paths that escape via excessive ".." segments.
    function isInsideExtension(candidateAbs: string) {
        try {
            const base = path.resolve(extensionUri.fsPath);
            const cand = path.resolve(candidateAbs);
            // On Windows, make comparison case-insensitive
            const rel = path.relative(base, cand);
            if (!rel) { return true; }
            // If relative path starts with '..' then candidate is outside
            if (rel.split(path.sep)[0] === '..') { return false; }
            return true;
        } catch (e) { return false; }
    }

    // If the href contains parent-directory segments, prefer resolving
    // it against the resources/webview folder (and its dist/out variants).
    const looksUp = normalized.indexOf('..') !== -1 && /(^|\/)\.\.(?:\/|$)/.test(normalized);
    // canonical relative without leading './'
    let rel = normalized.replace(/^\.\//, '');

    if (looksUp) {
        candidates.push(path.join(extensionUri.fsPath, 'resources', 'webview', rel));
        candidates.push(path.join(extensionUri.fsPath, 'dist', 'resources', 'webview', rel));
        candidates.push(path.join(extensionUri.fsPath, 'out', 'resources', 'webview', rel));
    }

    // Always include common explicit locations (in this order of preference):
    candidates.push(path.join(extensionUri.fsPath, 'resources', 'webview', rel));
    candidates.push(path.join(extensionUri.fsPath, 'dist', 'resources', 'webview', rel));
    candidates.push(path.join(extensionUri.fsPath, 'out', 'resources', 'webview', rel));

    // Allow direct references rooted at the extension (e.g., "resources/..." or "icons/...")
    candidates.push(path.join(extensionUri.fsPath, rel));
    candidates.push(path.join(extensionUri.fsPath, 'dist', rel));

    // If the author referenced icons via a ".../icons/..." segment, check icons folders
    const iconsMatch = rel.match(/(?:\/(?:icons)\/)(.*)$/i);
    if (iconsMatch && iconsMatch[1]) {
        const rest = iconsMatch[1];
        candidates.push(path.join(extensionUri.fsPath, 'resources', 'icons', rest));
        candidates.push(path.join(extensionUri.fsPath, 'dist', 'resources', 'icons', rest));
        candidates.push(path.join(extensionUri.fsPath, 'out', 'resources', 'icons', rest));
    }

    // Normalize and filter candidates to ensure they don't escape the extension dir
    const normalizedCands = candidates.map(p => path.normalize(p)).filter(p => isInsideExtension(p));
    return findExisting(normalizedCands);
    }

    function findExisting(cands: string[]): string | undefined {
        for (const c of cands) {
            try { if (fs.existsSync(c)) { return c; } } catch (e) { /* ignore */ }
        }
        return undefined;
    }
    // Remove any existing CSP meta tags (including those our helper may have injected previously).
    html = html.replace(/<meta[^>]+http-equiv=['"]?Content-Security-Policy['"]?[^>]*>/gi, '');
    // Ensure there is only one <head> opening tag: keep the first and remove duplicates to avoid malformed HTML
    // Approach: find the first occurrence index, keep that match, then remove any subsequent <head> tags by operating
    // on the substring after the first match. This avoids relying on replace-callback offsets which can be inconsistent
    // across JS engines or with large HTML strings.
    const headRe = /<head\b[^>]*>/i;
    const firstMatch = headRe.exec(html);
    if (firstMatch && firstMatch.index !== undefined) {
        const firstIdx = firstMatch.index;
        const firstMatched = firstMatch[0];
        const before = html.slice(0, firstIdx + firstMatched.length);
        let after = html.slice(firstIdx + firstMatched.length);
        // Remove any other <head ...> occurrences in the remainder
        after = after.replace(/<head\b[^>]*>/gi, '<!-- duplicate <head> removed -->');
        html = before + after;
    } else {
        // If no <head> matched case-insensitively, leave html as-is
    }

    // Generate a nonce for any inline <style> or <script> we might need to allow.
    // CSP nonces are base64; using crypto for secure randomness. Build and inject
    // a CSP meta tag that always includes webview.cspSource and the nonce when available.
    try {
        const crypto = require('crypto');
        const nonce = crypto.randomBytes(16).toString('base64');
        // Attach nonce attribute to any inline <style> tags so they are allowed by the CSP nonce.
        html = html.replace(/<style(\s[^>]*)?>/gi, (m: string, attrs: string) => {
            // if nonce already present, leave unchanged
            if (attrs && /nonce\s*=/.test(attrs)) { return m; }
            const rest = attrs || '';
            return `<style${rest} nonce="${nonce}">`;
        });
        // Attach nonce to any <script> tags (inline or with src). Scripts with src are already allowed via cspSource.
        html = html.replace(/<script(\s[^>]*)?>/gi, (m: string, attrs: string) => {
            if (attrs && /nonce\s*=/.test(attrs)) { return m; }
            const rest = attrs || '';
            return `<script${rest} nonce="${nonce}">`;
        });

        const cspMeta = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src ${webview.cspSource} 'nonce-${nonce}'; style-src ${webview.cspSource} 'nonce-${nonce}'; img-src ${webview.cspSource} data:;">`;
        // Inject CSP meta deterministically: prefer inserting into <head>, otherwise
        // create a <head> after <html> or prepend to document as a last resort.
        if (!/Content-Security-Policy/i.test(html)) {
            if (/<head\b[^>]*>/i.test(html)) {
                html = html.replace(/<head\b[^>]*>/i, (match: string) => `${match}${cspMeta}`);
            } else if (/<html\b[^>]*>/i.test(html)) {
                // Insert a minimal head containing the CSP immediately after <html ...>
                html = html.replace(/<html\b[^>]*>/i, (match: string) => `${match}<head>${cspMeta}</head>`);
            } else {
                // No html/head tags present; prepend the CSP meta so it appears early in the document
                html = `${cspMeta}${html}`;
            }
        }
    } catch (e) {
        // If crypto isn't available, fall back to a CSP without nonce but still
        // ensure webview.cspSource is present and injected deterministically.
        const cspMeta = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src ${webview.cspSource}; style-src ${webview.cspSource}; img-src ${webview.cspSource} data:;">`;
        if (!/Content-Security-Policy/i.test(html)) {
            if (/<head\b[^>]*>/i.test(html)) {
                html = html.replace(/<head\b[^>]*>/i, (match: string) => `${match}${cspMeta}`);
            } else if (/<html\b[^>]*>/i.test(html)) {
                html = html.replace(/<html\b[^>]*>/i, (match: string) => `${match}<head>${cspMeta}</head>`);
            } else {
                html = `${cspMeta}${html}`;
            }
        }
    }
    webview.html = html;
}

// Shared wiring for webview message routing to avoid duplication between panel and sidebar view
// Minimal interface describing the subset of treeProvider we rely on here.
// Keep it intentionally small to avoid coupling to implementation details.
export interface TreeProviderLike {
    refresh?: () => void;
    getPreviewData?: () => { totalFiles?: number } | null;
    setSelectionByRelPaths?: (paths: string[]) => void;
    workspaceRoot?: string;
}

export function wireWebviewMessages(webview: vscode.Webview, treeProvider: unknown, folderPath: string, onConfigSet: (changes: Record<string, unknown>) => Promise<void>, onGetState?: () => void, context?: vscode.ExtensionContext) {
    // Restore any persisted state for this workspace folder into the webview
    try {
        if (context) {
            const key = `codebaseDigest:webviewState:${folderPath || 'global'}`;
            const stored = context.workspaceState.get(key);
                if (stored) {
                try { webview.postMessage({ type: WebviewCommands.restoredState, state: stored }); } catch (e) { try { console.warn('webviewHelpers: post restoredState failed', stringifyError(e)); } catch {} }
            }
        }
    } catch (e) { try { console.warn('webviewHelpers: workspaceState.update failed', stringifyError(e)); } catch {} }

    // Note: Webview doesn't provide a standard onDidDispose API here. We rely on
    // capped retries and clearing timers when selection is successfully applied
    // to avoid infinite background retries. Host providers can augment disposal
    // handling if they expose a panel/window lifecycle to clear timers earlier.

    // Register the message listener and ensure it is disposed when the extension/context is disposed.
    try {
        // Wrap the process call so both synchronous errors and promise rejections
        // are caught. This ensures message types like 'configRequest' are always
        // routed and won't cause an unhandled rejection to escape the host.
        const disp = webview.onDidReceiveMessage((msg: unknown) => {
            try {
                if (!isWebviewMessage(msg)) { return; }
                const res = processWebviewMessage(msg, webview, treeProvider, folderPath, onConfigSet, onGetState, context);
                // If the handler returns a promise, attach a rejection handler to
                // avoid unhandled promise rejections bubbling out of the event loop.
                if (res && typeof (res as Promise<unknown>).catch === 'function') {
                    (res as Promise<unknown>).catch((err: unknown) => {
                        try { console.warn('webviewHelpers: processWebviewMessage rejected', stringifyError(err)); } catch {};
                    });
                }
            } catch (err) {
                try { console.warn('webviewHelpers: processWebviewMessage threw', stringifyError(err)); } catch {};
            }
        });
        // If a context is provided, attach the disposable so VS Code will dispose it on deactivation.
        if (context) {
            try {
                const ctxRec = context as unknown as { subscriptions?: unknown };
                if (Array.isArray(ctxRec.subscriptions)) {
                    try { Array.prototype.push.call(ctxRec.subscriptions, disp); } catch (e) { /* ignore push errors */ }
                }
            } catch (e) { /* ignore */ }
        }
    } catch (e) {
        // Best-effort: if registering the listener fails, swallow to avoid crashing the extension
    }
}

function stringifyError(e: any): string {
    try {
        if (!e) { return String(e); }
        if (typeof e === 'string') { return e; }
        if (e && typeof e === 'object') { return String((e.stack || e.message) || JSON.stringify(e)); }
        return String(e);
    } catch (_) { try { return String(e); } catch { return '[unserializable error]'; } }
}

export async function processWebviewMessage(msg: WebviewMessage, webview: vscode.Webview, treeProvider: unknown, folderPath: string, onConfigSet: (changes: Record<string, unknown>) => Promise<void>, onGetState?: () => void, context?: vscode.ExtensionContext) {
    // Basic validation: ensure msg is an object
    if (!msg || typeof msg !== 'object') { return; }
    // Whitelist top-level message types we handle to avoid accidental/hostile payloads
    const allowedTypes = new Set(['getState', 'persistState', 'configRequest', 'config', 'action']);
    if (!allowedTypes.has(msg.type)) { return; }
    if (msg.type === 'getState') {
        if (onGetState) { onGetState(); }
        return;
    }
    // Allow webview to persist lightweight UI state (e.g., last-selected files)
        if (msg.type === 'persistState' && msg.state && context) {
        try {
            const key = `codebaseDigest:webviewState:${folderPath || 'global'}`;
            context.workspaceState.update(key, msg.state);
    } catch (e) { try { console.warn('webviewHelpers: workspaceState.update failed', stringifyError(e)); } catch {} }
        return;
    }
    if (msg.type === 'configRequest') {
        const folder = folderPath || '';
        // Use ConfigurationService to get a validated, typed snapshot for reads
        try {
            const cfgSnapshot = ConfigurationService.getWorkspaceConfig(vscode.Uri.file(folder));
            const thresholdsDefault = { maxFiles: 25000, maxTotalSizeBytes: 536870912, tokenLimit: 32000 };
            const thresholds = (cfgSnapshot as any).thresholds || {};
            const maxFiles = typeof cfgSnapshot.maxFiles === 'number' ? cfgSnapshot.maxFiles : thresholds.maxFiles || thresholdsDefault.maxFiles;
            const maxTotalSizeBytes = typeof cfgSnapshot.maxTotalSizeBytes === 'number' ? cfgSnapshot.maxTotalSizeBytes : thresholds.maxTotalSizeBytes || thresholdsDefault.maxTotalSizeBytes;
            const tokenLimit = typeof cfgSnapshot.tokenLimit === 'number' ? cfgSnapshot.tokenLimit : thresholds.tokenLimit || thresholdsDefault.tokenLimit;
            webview.postMessage({ type: WebviewCommands.config, folderPath: folder, settings: {
                respectGitignore: cfgSnapshot.respectGitignore,
                presets: Array.isArray((cfgSnapshot as any).presets) ? (cfgSnapshot as any).presets : [],
                // include filterPresets for UI compatibility; fall back to presets if absent
                filterPresets: Array.isArray((cfgSnapshot as any).filterPresets) ? (cfgSnapshot as any).filterPresets : (Array.isArray((cfgSnapshot as any).presets) ? (cfgSnapshot as any).presets : []),
                outputFormat: cfgSnapshot.outputFormat,
                tokenModel: cfgSnapshot.tokenModel,
                binaryFilePolicy: cfgSnapshot.binaryFilePolicy,
                maxFiles,
                maxTotalSizeBytes,
                tokenLimit,
                thresholds: Object.assign({}, thresholdsDefault, thresholds),
                showRedacted: cfgSnapshot.showRedacted,
                redactionPatterns: Array.isArray(cfgSnapshot.redactionPatterns) ? cfgSnapshot.redactionPatterns : [],
                redactionPlaceholder: cfgSnapshot.redactionPlaceholder || '[REDACTED]'
            }});
        } catch (e) { try { console.warn('webviewHelpers: post config failed', stringifyError(e)); } catch {} }
        return;
    }
    if (msg.type === 'config' && msg.action === 'set' && msg.changes) {
        // Sanitize incoming changes: only allow known keys and simple scalar types
    const safeKeys = ['respectGitignore','outputFormat','tokenModel','binaryFilePolicy','maxFiles','maxTotalSizeBytes','tokenLimit','presets','showRedacted','redactionPatterns','redactionPlaceholder','filterPresets','contextLimit'];
        const safeChanges: Record<string, unknown> = {};
            try {
                // Coerce to unknown and validate per-key rather than using unsafe casts
                const changesRaw = msg.changes as unknown;
                if (changesRaw && typeof changesRaw === 'object') {
                    const changes = changesRaw as Record<string, unknown>;
                    for (const k of Object.keys(changes)) {
                        if (!safeKeys.includes(k)) { continue; }
                        const v = changes[k];
                        // Basic type checks
                        if (v === null || v === undefined) { safeChanges[k] = v; continue; }
                        if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') { safeChanges[k] = v; }
                        else if (Array.isArray(v)) { safeChanges[k] = v.slice(0, 100).map(x => (typeof x === 'string' ? x : String(x))); }
                        // ignore objects and functions
                    }
                }
                // delegate persistence to caller with sanitized payload
                (async () => { try { await onConfigSet(safeChanges); } catch (e) { try { console.warn('webviewHelpers: onConfigSet failed', stringifyError(e)); } catch {} } })();
        } catch (e) { /* swallow malformed changes */ }
        return;
    }
    if (msg.type === 'action') {
        const commandMap: Record<string, string> = {
            refresh: 'codebaseDigest.refreshTree',
            selectAll: 'codebaseDigest.selectAll',
            clearSelection: 'codebaseDigest.clearSelection',
            expandAll: 'codebaseDigest.expandAll',
            collapseAll: 'codebaseDigest.collapseAll',
            generateDigest: 'codebaseDigest.generateDigest',
            tokenCount: 'codebaseDigest.estimateTokens'
        };
    const folderFromMsg = (typeof (msg.folderPath) === 'string') ? msg.folderPath : (typeof (msg.folder) === 'string' ? msg.folder : undefined);
    // Narrow the unknown treeProvider to the minimal TreeProviderLike we can rely on.
    const tp: TreeProviderLike | undefined = (treeProvider && typeof treeProvider === 'object') ? (treeProvider as TreeProviderLike) : undefined;
    const targetFolder = folderFromMsg || folderPath || (tp && typeof tp.workspaceRoot === 'string' ? tp.workspaceRoot : '') || '';

    const actionType = typeof msg.actionType === 'string' ? msg.actionType : undefined;
    if (actionType === 'pauseScan') {
                try {
                    const { safeExecuteCommand } = require('../utils/safeExecuteCommand');
                    try {
                        await safeExecuteCommand('codebaseDigest.pauseScan', targetFolder);
                    } catch (err) {
                        try { webview.postMessage({ type: WebviewCommands.diagnostic, level: 'error', message: `pauseScan failed: ${stringifyError(err)}` }); } catch (e) { try { console.warn('webviewHelpers: post diagnostic failed', stringifyError(e)); } catch {} }
                        try { vscode.window.showErrorMessage(`pauseScan failed: ${stringifyError(err)}`); } catch (e) { /* swallow */ }
                        try { console.warn('webviewHelpers: pauseScan failed', stringifyError(err)); } catch (e) { /* swallow */ }
                    }
                } catch (err) {
                    try { console.warn('webviewHelpers: pauseScan require failed', stringifyError(err)); } catch {}
                }
            return;
        }
        // Apply a named preset (e.g., Code/Docs/Tests) persisted per-workspace
    if (actionType === 'applyPreset' && typeof msg.preset === 'string') {
            const allowed = ['default', 'codeOnly', 'docsOnly', 'testsOnly'];
            const preset = msg.preset;
            if (!allowed.includes(preset)) { return; }
                try {
                    // Keep updates using WorkspaceConfiguration.update to preserve persistence semantics
                    const cfg = vscode.workspace.getConfiguration('codebaseDigest', vscode.Uri.file(targetFolder || ''));
                    await cfg.update('filterPresets', [preset], vscode.ConfigurationTarget.Workspace);
                    try { if (tp && typeof tp.refresh === 'function') { tp.refresh(); } } catch (e) { try { console.warn('webviewHelpers: treeProvider.refresh failed', stringifyError(e)); } catch {} }
                    try {
                        // Read back using ConfigurationService snapshot for consistent shape when posting
                        const snapshot = ConfigurationService.getWorkspaceConfig(vscode.Uri.file(targetFolder || ''));
                        try { webview.postMessage({ type: WebviewCommands.config, folderPath: targetFolder, settings: { filterPresets: (snapshot as any).filterPresets || [] } }); } catch (e) { try { console.warn('webviewHelpers: post config failed', stringifyError(e)); } catch {} }
                    } catch (e) { try { console.warn('webviewHelpers: post config failed', stringifyError(e)); } catch {} }
                    return;
                } catch (err) {
                    // fallback to command if direct persistence fails
                    try {
                        const { safeExecuteCommand } = require('../utils/safeExecuteCommand');
                        try {
                            await safeExecuteCommand('codebaseDigest.applyPreset', targetFolder, preset);
                        } catch (e) {
                            try { webview.postMessage({ type: WebviewCommands.diagnostic, level: 'error', message: `applyPreset failed: ${stringifyError(e)}` }); } catch (ee) { try { console.warn('webviewHelpers: post diagnostic failed', stringifyError(ee)); } catch {} }
                            try { console.warn('webviewHelpers: applyPreset executeCommand failed', stringifyError(e)); } catch {}
                        }
                    } catch (err2) {
                        try { console.warn('webviewHelpers: applyPreset require failed', stringifyError(err2)); } catch {}
                    }
                    return;
                }
        }
    if (actionType === 'resumeScan') {
            try {
                const { safeExecuteCommand } = require('../utils/safeExecuteCommand');
                try {
                    await safeExecuteCommand('codebaseDigest.resumeScan', targetFolder);
                } catch (err) {
                    try { webview.postMessage({ type: WebviewCommands.diagnostic, level: 'error', message: `resumeScan failed: ${stringifyError(err)}` }); } catch (e) { try { console.warn('webviewHelpers: post diagnostic failed', stringifyError(e)); } catch {} }
                    try { vscode.window.showErrorMessage(`resumeScan failed: ${stringifyError(err)}`); } catch (e) { /* swallow */ }
                    try { console.warn('webviewHelpers: resumeScan failed', stringifyError(err)); } catch (e) { /* swallow */ }
                }
            } catch (err) {
                try { console.warn('webviewHelpers: resumeScan require failed', stringifyError(err)); } catch {}
            }
            return;
        }
        // Allow webview to request cancellation of long writes
    if (actionType === 'cancelWrite') {
            try {
                // defer require to avoid circular deps at module init
                const eb = require('../providers/eventBus');
                if (eb && typeof eb.emitProgress === 'function') {
                    eb.emitProgress({ op: 'write', mode: 'cancel' });
                }
            } catch (e) { /* swallow */ }
            return;
        }
        if (actionType === 'ingestRemote' && typeof msg.repo === 'string') {
            const params = { repo: msg.repo as string, ref: typeof msg.ref === 'string' ? msg.ref as string : undefined, subpath: typeof msg.subpath === 'string' ? msg.subpath as string : undefined, includeSubmodules: !!msg.includeSubmodules };
                (async () => {
                    try {
                        const { safeExecuteCommand } = require('../utils/safeExecuteCommand');
                        try {
                            const result: any = await safeExecuteCommand('codebaseDigest.ingestRemoteRepoProgrammatic', params);
                            try { webview.postMessage({ type: WebviewCommands.ingestPreview, payload: result }); } catch (e) { try { console.warn('webviewHelpers: post ingestPreview failed', stringifyError(e)); } catch {} }
                        } catch (err) {
                            try { webview.postMessage({ type: WebviewCommands.ingestError, error: String(err) }); } catch (e) { try { console.warn('webviewHelpers: post ingestError failed', stringifyError(e)); } catch {} }
                        }
                    } catch (err) {
                        try { console.warn('webviewHelpers: ingestRemote require failed', stringifyError(err)); } catch {}
                    }
                })();
            return;
        }

    if (actionType === 'setSelection' && Array.isArray(msg.relPaths)) {
            // Apply selection only when provider appears to have roots.
            // The webview side implements replay/retry logic; avoid scheduling
            // additional retries here to prevent duplicate attempts and UI churn.
            try {
                const preview = tp && typeof tp.getPreviewData === 'function' ? tp.getPreviewData() : null;
                const totalFiles = preview && typeof preview.totalFiles === 'number' ? preview.totalFiles : undefined;
                // Prefer explicit rootNodes when available, but this property may be
                // private on some provider implementations. Use a defensive 'in'
                // check and runtime guard to avoid relying on typings here.
                let hasRoots: boolean | undefined;
                try {
                    if (treeProvider && typeof treeProvider === 'object') {
                        const tpObj = treeProvider as unknown as { rootNodes?: unknown };
                        if (Array.isArray(tpObj.rootNodes)) {
                            hasRoots = (tpObj.rootNodes as unknown[]).length > 0;
                        } else {
                            hasRoots = typeof totalFiles === 'number' ? totalFiles > 0 : undefined;
                        }
                    } else {
                        hasRoots = typeof totalFiles === 'number' ? totalFiles > 0 : undefined;
                    }
                } catch (e) {
                    hasRoots = typeof totalFiles === 'number' ? totalFiles > 0 : undefined;
                }
                if (!hasRoots) { return; }
            } catch (e) { /* swallow detection errors */ }

            try {
                if (tp && typeof tp.setSelectionByRelPaths === 'function') {
                    tp.setSelectionByRelPaths(msg.relPaths as string[]);
                }
            } catch (e) { /* ignore provider errors */ }
            try {
                const preview = tp && typeof tp.getPreviewData === 'function' ? tp.getPreviewData() : null;
                if (preview) { webview.postMessage({ type: WebviewCommands.state, state: preview }); }
            } catch (e) { try { console.warn('webviewHelpers: post state failed', stringifyError(e)); } catch {} }
            return;
        }
    if (actionType === 'toggleExpand' && typeof msg.relPath === 'string') {
                try {
                    const { safeExecuteCommand } = require('../utils/safeExecuteCommand');
                    try {
                        await safeExecuteCommand('codebaseDigest.toggleExpand', targetFolder, msg.relPath);
                    } catch (err) {
                        try { webview.postMessage({ type: WebviewCommands.diagnostic, level: 'error', message: `toggleExpand failed: ${stringifyError(err)}` }); } catch (e) { try { console.warn('webviewHelpers: post diagnostic failed', stringifyError(e)); } catch {} }
                        try { vscode.window.showErrorMessage(`toggleExpand failed: ${stringifyError(err)}`); } catch (e) { /* swallow */ }
                        try { console.warn('webviewHelpers: toggleExpand failed', stringifyError(err)); } catch (e) { /* swallow */ }
                    }
                } catch (err) {
                    try { console.warn('webviewHelpers: toggleExpand require failed', stringifyError(err)); } catch {}
                }
            return;
        }
    if (actionType && commandMap[actionType]) {
            // For bulk actions like expandAll/collapseAll ensure the command is registered
            // so we don't attempt to call an unregistered command which would warn in the host.
            try {
                const cmdId = commandMap[actionType as string];
                // Only special-case expandAll/collapseAll diagnostics; other commands may be safely executed.
                if (msg.actionType === 'expandAll' || msg.actionType === 'collapseAll') {
                    // getCommands(false) returns installed commands; includeInternal=false for performance
                    const registered = (await vscode.commands.getCommands(false));
                    if (!registered || !registered.includes(cmdId)) {
                        try { webview.postMessage({ type: WebviewCommands.diagnostic, level: 'warning', message: `command '${cmdId}' not registered; action '${msg.actionType}' ignored.` }); } catch (e) { try { console.warn('webviewHelpers: post diagnostic failed', stringifyError(e)); } catch {} }
                        return;
                    }
                }

                try {
                    const { safeExecuteCommand } = require('../utils/safeExecuteCommand');
                    if (actionType === 'generateDigest' && msg.overrides) {
                            // Validate overrides come in as a simple map of primitive values.
                            const ovRaw = msg.overrides as unknown;
                            const overrides: Record<string, unknown> = {};
                            if (ovRaw && typeof ovRaw === 'object') {
                                for (const k of Object.keys(ovRaw as Record<string, unknown>)) {
                                    const v = (ovRaw as Record<string, unknown>)[k];
                                    if (v === null || v === undefined) { overrides[k] = v; continue; }
                                    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') { overrides[k] = v; continue; }
                                    // flatten arrays to string[] if present
                                    if (Array.isArray(v)) { overrides[k] = (v as unknown[]).slice(0, 200).map(x => (typeof x === 'string' ? x : String(x))); continue; }
                                    // otherwise ignore complex values
                                }
                            }
                            try {
                                await safeExecuteCommand(cmdId, targetFolder, overrides);
                            } catch (err) {
                                try { webview.postMessage({ type: WebviewCommands.diagnostic, level: 'error', message: `${cmdId} failed: ${stringifyError(err)}` }); } catch (e) { try { console.warn('webviewHelpers: post diagnostic failed', stringifyError(e)); } catch {} }
                                try { vscode.window.showErrorMessage(`${cmdId} failed: ${stringifyError(err)}`); } catch (e) { /* swallow */ }
                                try { console.warn('webviewHelpers: command failed', cmdId, stringifyError(err)); } catch {}
                            }
                        } else {
                            try {
                                await safeExecuteCommand(cmdId, targetFolder);
                            } catch (err) {
                                try { webview.postMessage({ type: WebviewCommands.diagnostic, level: 'error', message: `${cmdId} failed: ${stringifyError(err)}` }); } catch (e) { try { console.warn('webviewHelpers: post diagnostic failed', stringifyError(e)); } catch {} }
                                try { vscode.window.showErrorMessage(`${cmdId} failed: ${stringifyError(err)}`); } catch (e) { /* swallow */ }
                                try { console.warn('webviewHelpers: command failed', cmdId, stringifyError(err)); } catch {}
                            }
                        }
                } catch (err) {
                                try { webview.postMessage({ type: WebviewCommands.diagnostic, level: 'error', message: `${cmdId} failed: ${stringifyError(err)}` }); } catch (e) { try { console.warn('webviewHelpers: post diagnostic failed', stringifyError(e)); } catch {} }
                    try { vscode.window.showErrorMessage(`${cmdId} failed: ${stringifyError(err)}`); } catch (e) { /* swallow */ }
                }
            } catch (e) {
                try { console.warn('webviewHelpers: executeCommand routing failed', stringifyError(e)); } catch {}
            }
            return;
        }
    }
}

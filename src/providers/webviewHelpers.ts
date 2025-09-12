import * as vscode from 'vscode';
import * as path from 'path';

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

    // Helper to normalize and return candidate absolute paths
    const cands: string[] = [];
    // 1) direct path relative to extension root (e.g., "resources/webview/styles.css")
    cands.push(path.join(extensionUri.fsPath, normalized));
    // 2) dist-prefixed variant
    cands.push(path.join(extensionUri.fsPath, 'dist', normalized));
    // 3) treat the href as relative to the resources/webview folder (common authoring)
    cands.push(path.join(extensionUri.fsPath, 'resources', 'webview', normalized));
    cands.push(path.join(extensionUri.fsPath, 'dist', 'resources', 'webview', normalized));
    // 4) treat as an icons reference
    cands.push(path.join(extensionUri.fsPath, 'resources', 'icons', normalized));
    cands.push(path.join(extensionUri.fsPath, 'dist', 'resources', 'icons', normalized));

    // Normalize each candidate (collapses ../ segments) and check existence
    const normalizedCands = cands.map(p => path.normalize(p));
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
    const headMatches = [] as {match:string, idx:number}[];
    let hMatch: RegExpExecArray | null;
    const headRe = /<head\b[^>]*>/gi;
    while ((hMatch = headRe.exec(html)) !== null) { headMatches.push({match: hMatch[0], idx: hMatch.index}); }
    if (headMatches.length > 1) {
        // preserve first occurrence, remove others
        const firstIdx = headMatches[0].idx;
        html = html.replace(/<head\b[^>]*>/gi, (m:string, offset:number) => offset === firstIdx ? m : '<!-- duplicate <head> removed -->');
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
export function wireWebviewMessages(webview: vscode.Webview, treeProvider: any, folderPath: string, onConfigSet: (changes: Record<string, any>) => Promise<void>, onGetState?: () => void, context?: vscode.ExtensionContext) {
    // Restore any persisted state for this workspace folder into the webview
    try {
        if (context) {
            const key = `codebaseDigest:webviewState:${folderPath || 'global'}`;
            const stored = context.workspaceState.get(key);
            if (stored) {
                try { webview.postMessage({ type: 'restoredState', state: stored }); } catch (e) { try { console.warn('webviewHelpers: post restoredState failed', stringifyError(e)); } catch {} }
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
        const disp = webview.onDidReceiveMessage((msg: any) => {
            try {
                const res = processWebviewMessage(msg, webview, treeProvider, folderPath, onConfigSet, onGetState, context);
                // If the handler returns a promise, attach a rejection handler to
                // avoid unhandled promise rejections bubbling out of the event loop.
                if (res && typeof (res as any).catch === 'function') {
                    (res as any).catch((err: any) => {
                        try { console.warn('webviewHelpers: processWebviewMessage rejected', stringifyError(err)); } catch {};
                    });
                }
            } catch (err) {
                try { console.warn('webviewHelpers: processWebviewMessage threw', stringifyError(err)); } catch {};
            }
        });
        // If a context is provided, attach the disposable so VS Code will dispose it on deactivation.
        if (context && Array.isArray((context as any).subscriptions)) {
            try { (context as any).subscriptions.push(disp); } catch (e) { /* ignore push errors */ }
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

export async function processWebviewMessage(msg: any, webview: vscode.Webview, treeProvider: any, folderPath: string, onConfigSet: (changes: Record<string, any>) => Promise<void>, onGetState?: () => void, context?: vscode.ExtensionContext) {
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
        const cfg = vscode.workspace.getConfiguration('codebaseDigest', vscode.Uri.file(folder));
        const thresholdsDefault = { maxFiles: 25000, maxTotalSizeBytes: 536870912, tokenLimit: 32000 };
        // Provide both legacy and normalized keys to the webview for backwards compatibility.
        const thresholds = cfg.get('thresholds', thresholdsDefault) as any || {};
        const maxFiles = cfg.get('maxFiles', thresholds.maxFiles || thresholdsDefault.maxFiles) as number;
        const maxTotalSizeBytes = cfg.get('maxTotalSizeBytes', thresholds.maxTotalSizeBytes || thresholdsDefault.maxTotalSizeBytes) as number;
        const tokenLimit = cfg.get('tokenLimit', thresholds.tokenLimit || thresholdsDefault.tokenLimit) as number;

        try {
            webview.postMessage({ type: 'config', folderPath: folder, settings: {
            // normalized key names (preferred)
            respectGitignore: cfg.get('respectGitignore', cfg.get('gitignore', true)),
            presets: cfg.get('presets', []),
            outputFormat: cfg.get('outputFormat', 'text'),
            tokenModel: cfg.get('tokenModel', 'chars-approx'),
            binaryFilePolicy: cfg.get('binaryFilePolicy', cfg.get('binaryPolicy', 'skip')),
            // flattened thresholds for easier UI binding
            maxFiles,
            maxTotalSizeBytes,
            tokenLimit,
            // legacy shape for older webview consumers
            thresholds: Object.assign({}, thresholdsDefault, thresholds),
            // redaction settings
            showRedacted: cfg.get('showRedacted', false),
            redactionPatterns: cfg.get('redactionPatterns', []),
            redactionPlaceholder: cfg.get('redactionPlaceholder', '[REDACTED]')
            }});
    } catch (e) { try { console.warn('webviewHelpers: post config failed', stringifyError(e)); } catch {} }
        return;
    }
    if (msg.type === 'config' && msg.action === 'set' && msg.changes) {
        // Sanitize incoming changes: only allow known keys and simple scalar types
    const safeKeys = ['respectGitignore','outputFormat','tokenModel','binaryFilePolicy','maxFiles','maxTotalSizeBytes','tokenLimit','presets','showRedacted','redactionPatterns','redactionPlaceholder','filterPresets','contextLimit'];
        const safeChanges: Record<string, any> = {};
            try {
                for (const k of Object.keys(msg.changes || {})) {
                if (!safeKeys.includes(k)) { continue; }
                const v = msg.changes[k];
                // Basic type checks
                if (v === null || v === undefined) { safeChanges[k] = v; continue; }
                if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') { safeChanges[k] = v; }
                else if (Array.isArray(v)) { safeChanges[k] = v.slice(0, 100).map(x => (typeof x === 'string' ? x : String(x))); }
                // ignore objects and functions
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
        const targetFolder = (msg && (msg.folderPath || msg.folder)) || folderPath || treeProvider['workspaceRoot'] || '';

        if (msg.actionType === 'pauseScan') {
            vscode.commands.executeCommand('codebaseDigest.pauseScan', targetFolder);
            return;
        }
        // Apply a named preset (e.g., Code/Docs/Tests) persisted per-workspace
        if (msg.actionType === 'applyPreset' && typeof msg.preset === 'string') {
            const allowed = ['default', 'codeOnly', 'docsOnly', 'testsOnly'];
            const preset = msg.preset;
            if (!allowed.includes(preset)) { return; }
            try {
                const cfg = vscode.workspace.getConfiguration('codebaseDigest', vscode.Uri.file(targetFolder || ''));
                await cfg.update('filterPresets', [preset], vscode.ConfigurationTarget.Workspace);
                try { if (treeProvider && typeof treeProvider.refresh === 'function') { treeProvider.refresh(); } } catch (e) { try { console.warn('webviewHelpers: treeProvider.refresh failed', stringifyError(e)); } catch {} }
                try { webview.postMessage({ type: 'config', folderPath: targetFolder, settings: { filterPresets: cfg.get('filterPresets', []) } }); } catch (e) { try { console.warn('webviewHelpers: post config failed', stringifyError(e)); } catch {} }
                return;
            } catch (err) {
                // fallback to command if direct persistence fails
                try { await vscode.commands.executeCommand('codebaseDigest.applyPreset', targetFolder, preset); } catch (e) { try { console.warn('webviewHelpers: applyPreset executeCommand failed', stringifyError(e)); } catch {} }
                return;
            }
        }
        if (msg.actionType === 'resumeScan') {
            vscode.commands.executeCommand('codebaseDigest.resumeScan', targetFolder);
            return;
        }
        // Allow webview to request cancellation of long writes
        if (msg.actionType === 'cancelWrite') {
            try {
                // defer require to avoid circular deps at module init
                const eb = require('../providers/eventBus');
                if (eb && typeof eb.emitProgress === 'function') {
                    eb.emitProgress({ op: 'write', mode: 'cancel' });
                }
            } catch (e) { /* swallow */ }
            return;
        }
        if (msg.actionType === 'ingestRemote' && msg.repo) {
            const params = { repo: msg.repo, ref: msg.ref, subpath: msg.subpath, includeSubmodules: !!msg.includeSubmodules };
                vscode.commands.executeCommand('codebaseDigest.ingestRemoteRepoProgrammatic', params).then((result: any) => {
                try { webview.postMessage({ type: 'ingestPreview', payload: result }); } catch (e) { try { console.warn('webviewHelpers: post ingestPreview failed', stringifyError(e)); } catch {} }
            }, (err: any) => { try { webview.postMessage({ type: 'ingestError', error: String(err) }); } catch (e) { try { console.warn('webviewHelpers: post ingestError failed', stringifyError(e)); } catch {} } });
            return;
        }

        if (msg.actionType === 'setSelection' && Array.isArray(msg.relPaths)) {
            // Apply selection only when provider appears to have roots.
            // The webview side implements replay/retry logic; avoid scheduling
            // additional retries here to prevent duplicate attempts and UI churn.
            try {
                const preview = (typeof treeProvider.getPreviewData === 'function') ? treeProvider.getPreviewData() : null;
                const totalFiles = preview && typeof preview.totalFiles === 'number' ? preview.totalFiles : undefined;
                const hasRoots = Array.isArray((treeProvider as any).rootNodes) ? ((treeProvider as any).rootNodes.length > 0) : (typeof totalFiles === 'number' ? totalFiles > 0 : undefined);
                if (!hasRoots) { return; }
            } catch (e) { /* swallow detection errors */ }

            try {
                treeProvider.setSelectionByRelPaths(msg.relPaths);
            } catch (e) { /* ignore provider errors */ }
            try { const preview = typeof treeProvider.getPreviewData === 'function' ? treeProvider.getPreviewData() : null; if (preview) { webview.postMessage({ type: 'state', state: preview }); } } catch (e) { try { console.warn('webviewHelpers: post state failed', stringifyError(e)); } catch {} }
            return;
        }
        if (msg.actionType === 'toggleExpand' && typeof msg.relPath === 'string') {
            vscode.commands.executeCommand('codebaseDigest.toggleExpand', targetFolder, msg.relPath);
            return;
        }
        if (commandMap[msg.actionType]) {
            if (msg.actionType === 'generateDigest' && msg.overrides) {
                vscode.commands.executeCommand(commandMap[msg.actionType], targetFolder, msg.overrides);
            } else {
                vscode.commands.executeCommand(commandMap[msg.actionType], targetFolder);
            }
            return;
        }
    }
}

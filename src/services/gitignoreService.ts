import * as fs from 'fs';
import * as path from 'path';
import { minimatch } from 'minimatch';

/**
 * Lightweight gitignore-like matcher used by tests.
 */
type Matcher = {
    raw: string;
    isNegation: boolean;
    cleaned: string;
    anchored: boolean;
    directoryOnly: boolean;
    matcher: (inputPath: string, isDir: boolean) => boolean;
};

export class GitignoreService {
    private matchersByDir: Map<string, Array<Matcher>> = new Map();
    private loadedDirs: Set<string> = new Set();
    private workspaceRoot?: string;

    addIgnoreFile(dirOrFilePath: string, patterns: string[]) {
        let dir = dirOrFilePath;
        const base = path.basename(dirOrFilePath);
        if (base === '.gitignore' || base === '.gitingestignore') { dir = path.dirname(dirOrFilePath); }
        const normalized = this.normalizeAbs(dir);
        const matchers = this.compilePatternsToMatchers(patterns || [], normalized);
        this.matchersByDir.set(normalized, matchers);
        this.loadedDirs.add(normalized);
    }

    loadIgnoreFile(fileOrDir: string, content: string) {
        const lines = String(content || '').split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));
        this.addIgnoreFile(fileOrDir, lines);
    }

    async loadRoot(rootPath: string, fileNames: string[] = ['.gitignore', '.gitingestignore']) {
        const rootNorm = this.normalizeAbs(rootPath || process.cwd());
        this.workspaceRoot = rootNorm;
        await this.loadForDir(rootPath, fileNames);
    }

    async loadForDir(dirAbsPath: string, fileNames: string[] = ['.gitignore', '.gitingestignore']) {
        const norm = this.normalizeAbs(dirAbsPath);
        if (this.loadedDirs.has(norm)) { return; }
        const patterns: string[] = [];
        for (const fn of fileNames) {
            try {
                const fp = path.join(dirAbsPath, fn);
                if (fs.existsSync(fp)) {
                    const content = fs.readFileSync(fp, 'utf8');
                    const lines = content.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));
                    patterns.push(...lines);
                }
            } catch (e) {}
        }
        const matchers = this.compilePatternsToMatchers(patterns, norm);
        this.matchersByDir.set(norm, matchers);
        this.loadedDirs.add(norm);
    }

    getEffectiveMatchers(relPath: string): Matcher[] {
        const all: Array<{ dir: string; matchers: Matcher[] }> = [];
        const looksAbsolute = !!relPath && (relPath.startsWith('/') || /^[A-Za-z]:\\/.test(relPath));
        if (looksAbsolute) {
            const full = this.normalizeAbs(relPath);
            for (const [dir, matchers] of this.matchersByDir.entries()) {
                if (full === dir || full.startsWith(dir + '/')) { all.push({ dir, matchers }); }
            }
        } else {
            for (const [dir, matchers] of this.matchersByDir.entries()) { all.push({ dir, matchers }); }
        }
        all.sort((a, b) => a.dir.length - b.dir.length);
        return all.reduce((acc, x) => acc.concat(x.matchers), [] as Matcher[]);
    }

    private compilePatternsToMatchers(patterns: string[], dirKey: string): Matcher[] {
        return (patterns || []).map(raw => {
            const pat = raw.replace(/\\/g, '/');
            const isNeg = pat.startsWith('!');
            const pattern = isNeg ? pat.slice(1) : pat;
            const anchored = pattern.startsWith('/');
            const dirOnly = pattern.endsWith('/');
            const cleaned = pattern.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '');
            return {
                raw,
                isNegation: isNeg,
                cleaned,
                anchored,
                directoryOnly: dirOnly,
                matcher: (inputPath: string, isDir: boolean) => {
                    const looksAbsolute = !!inputPath && (inputPath.startsWith('/') || /^[A-Za-z]:\\/.test(inputPath));
                    let testPath = inputPath.replace(/\\/g, '/').replace(/^\/+/, '');
                    if (looksAbsolute) {
                        const full = this.normalizeAbs(inputPath);
                        if (!(full === dirKey || full.startsWith(dirKey + '/'))) { return false; }
                        testPath = full === dirKey ? '' : full.slice(dirKey.length + 1);
                    }
                    if (anchored) {
                        const anchoredPat = cleaned.startsWith('/') ? cleaned.slice(1) : cleaned;
                        if (!anchoredPat) { return false; }
                        if (dirOnly) { return testPath === anchoredPat || testPath.startsWith(anchoredPat + '/'); }
                        return testPath === anchoredPat || testPath.startsWith(anchoredPat + '/');
                    }
                    if (dirOnly) {
                        if (testPath === cleaned) { return !!isDir; }
                        if (testPath.startsWith(cleaned + '/')) { return true; }
                        return false;
                    }
                    if (minimatch(testPath, cleaned, { dot: true })) { return true; }
                    if (minimatch(testPath, `**/${cleaned}`, { dot: true })) { return true; }
                    if (minimatch(testPath, `**/${cleaned}/**`, { dot: true })) { return true; }
                    return false;
                }
            };
        });
    }

    /**
     * Return a list of explicit negation patterns (cleaned) that look like literal paths
     * (no glob chars). Useful for post-scan reconciliation.
     */
    listExplicitNegations(): string[] {
        const out: string[] = [];
        for (const matchers of this.matchersByDir.values()) {
            for (const m of matchers) {
                try {
                    if (m && m.isNegation && typeof m.cleaned === 'string') {
                        const c = m.cleaned.replace(/^\/+/, '');
                        // ignore patterns with globs
                        if (!/[\*\?\[]/.test(c)) { out.push(c); }
                    }
                } catch (e) { }
            }
        }
        // Deduplicate
        return Array.from(new Set(out));
    }


    isIgnored(relPath: string, isDir: boolean = false) {
        try {
            const looksLikeDir = !!relPath && (relPath.endsWith('/') || relPath.endsWith('\\'));
            const isDirLocal = isDir || looksLikeDir;
            const rel = String(relPath).replace(/\\/g, '/');
            const matchers = this.getEffectiveMatchers(rel);
            return this.evaluate(rel, isDirLocal, matchers);
        } catch (e) { return false; }
    }

    // Public evaluate used by tests: apply matchers with last-rule-wins logic
    evaluate(relPath: string, isDir: boolean, matchers: Matcher[]): boolean {
        let ignored: boolean | undefined = undefined;
        for (const pat of matchers) {
            try {
                if (pat && typeof pat.matcher === 'function' && pat.matcher(relPath, isDir)) {
                    ignored = !pat.isNegation;
                }
            } catch (e) { }
        }
        return !!ignored;
    }

    clear() {
        // If called as instance method, 'this' will have maps
        try {
            const selfAny: unknown = this;
            if (selfAny && typeof selfAny === 'object') {
                const selfRec = selfAny as Record<string, unknown>;
                const m = selfRec['matchersByDir'];
                const l = selfRec['loadedDirs'];
                if (m instanceof Map) { try { (m as Map<string, Matcher[]>).clear(); } catch {} }
                if (l instanceof Set) { try { (l as Set<string>).clear(); } catch {} }
            }
        } catch (e) { }
        // Also attempt to clear any maps attached to the class prototype (older tests call GitignoreService.prototype.clear())
        try {
            const proto = Object.getPrototypeOf(this);
            if (proto && typeof proto === 'object') {
                const protoRec = proto as Record<string, unknown>;
                const pm = protoRec['matchersByDir'];
                const pl = protoRec['loadedDirs'];
                if (pm instanceof Map) { try { (pm as Map<string, Matcher[]>).clear(); } catch {} }
                if (pl instanceof Set) { try { (pl as Set<string>).clear(); } catch {} }
            }
        } catch (e) { }
    }

    getWorkspaceRoot(): string {
        if (this.workspaceRoot) { return this.workspaceRoot; }
        const root = require('../utils/pathUtils').PathUtils.getWorkspaceRoot();
        return root || process.cwd();
    }

    normalizeAbs(p: string) {
        if (!p) { return ''; }
        const workspaceRoot = this.getWorkspaceRoot() || process.cwd();
        let candidate = p;
        if (!path.isAbsolute(candidate)) { candidate = path.join(workspaceRoot, candidate); }
        let s = candidate.replace(/\\/g, '/');
        s = s.replace(/\/+/g, '/');
        if (!s.startsWith('/')) { s = '/' + s; }
        if (s.length > 1 && s.endsWith('/')) { s = s.slice(0, -1); }
        return s;
    }
}
    // Implements last-rule-wins and negation logic

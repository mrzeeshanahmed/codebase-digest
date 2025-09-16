import { minimatch } from 'minimatch';
import { DigestConfig } from '../types/interfaces';
import { GitignoreService } from './gitignoreService';

export class FilterService {
    /**
     * Filters a list of files using include/exclude patterns, preset, and gitignore.
     */
    static filterFileList(
        files: string[],
        includePatterns: string[],
        excludePatterns: string[],
        preset?: { include?: string[], exclude?: string[] },
        gitignore?: GitignoreService,
        includedFileTypes?: string[]
    ): string[] {
        // Move !-prefixed patterns from includePatterns to excludePatterns
        // and remember which excludes were explicit negations so they are
        // preserved later when include/exclude overlap is resolved.
        const parsedInclude: string[] = [];
        const parsedExclude: string[] = [...excludePatterns];
        const explicitNegations: string[] = [];
        for (const p of includePatterns) {
            if (typeof p === 'string' && p.startsWith('!')) {
                const neg = p.slice(1);
                parsedExclude.push(neg);
                explicitNegations.push(neg);
            } else if (typeof p === 'string') {
                parsedInclude.push(p);
            }
        }
        // Add includedFileTypes to include patterns if present
        if (includedFileTypes && includedFileTypes.length > 0) {
            for (const p of includedFileTypes) {
                parsedInclude.push(p);
            }
        }
    const { include, exclude } = FilterService.processPatterns(parsedInclude, parsedExclude, preset, includedFileTypes, explicitNegations);
        const includeArray = Array.from(include);
        const excludeArray = Array.from(exclude);
    // If the original includePatterns contained explicit negations (e.g. '!path'),
    // those should be respected as explicit excludes even when a broad include exists.
    // Detect this by checking the raw includePatterns array for '!'-prefixed entries.
    const hasExplicitNegations = Array.isArray(includePatterns) && includePatterns.some(p => typeof p === 'string' && p.startsWith('!'));
        return files.filter(relPath => {
            if (hasExplicitNegations) {
                // Exclude-first: honor explicit negations/explicit exclude patterns
                for (const pattern of excludeArray) {
                    if (minimatch(relPath, pattern, { dot: true, nocase: false, matchBase: false })) { return false; }
                }
                for (const pattern of includeArray) {
                    if (minimatch(relPath, pattern, { dot: true, nocase: false, matchBase: false })) { return true; }
                }
                if (gitignore && gitignore.isIgnored(relPath)) { return false; }
                return true;
            }
            // Default include-wins semantics when no explicit negations were provided
            if (includeArray.length > 0) {
                for (const pattern of includeArray) {
                    if (minimatch(relPath, pattern, { dot: true, nocase: false, matchBase: false })) { return true; }
                }
                return false;
            }
            // No includes: apply excludes then gitignore
            for (const pattern of excludeArray) {
                if (minimatch(relPath, pattern, { dot: true, nocase: false, matchBase: false })) { return false; }
            }
            if (gitignore && gitignore.isIgnored(relPath)) { return false; }
            return true;
        });
    }
    static resolvePreset(name: string): { include: string[]; exclude: string[] } {
        switch (name) {
            case 'codeOnly':
                return {
                    include: [
                        '**/*.js', '**/*.ts', '**/*.jsx', '**/*.tsx', '**/*.py', '**/*.java', '**/*.go', '**/*.cpp', '**/*.c', '**/*.cs', '**/*.rb', '**/*.php', '**/*.rs', '**/*.swift', '**/*.kt', '**/*.m', '**/*.scala', '**/*.sh', '**/*.pl', '**/*.dart', '**/*.lua', '**/*.groovy', '**/*.sql', '**/*.html', '**/*.css', '**/*.scss', '**/*.json', '**/*.xml', '**/*.yml', '**/*.yaml'
                    ],
                    exclude: ['docs/**', '**/*.md', '**/*.rst', '**/*.ipynb']
                };
            case 'docsOnly':
                return {
                    include: ['**/*.md', '**/*.rst'],
                    exclude: [
                        '**/*.js', '**/*.ts', '**/*.jsx', '**/*.tsx', '**/*.py', '**/*.java', '**/*.go', '**/*.cpp', '**/*.c', '**/*.cs', '**/*.rb', '**/*.php', '**/*.rs', '**/*.swift', '**/*.kt', '**/*.m', '**/*.scala', '**/*.sh', '**/*.pl', '**/*.dart', '**/*.lua', '**/*.groovy', '**/*.sql', '**/*.html', '**/*.css', '**/*.scss', '**/*.json', '**/*.xml', '**/*.yml', '**/*.yaml', '**/*.ipynb', '**/test.*', '**/spec.*', '**/tests/**'
                    ]
                };
            case 'testsOnly':
                return {
                    include: ['**/test.*', '**/spec.*', '**/tests/**'],
                    exclude: [
                        '**/*.md', '**/*.rst', 'docs/**', '**/*.ipynb'
                    ]
                };
            case 'default':
            default:
                return { include: [], exclude: [] };
        }
    }

    static parsePatterns(list: string[]): Set<string> {
        return new Set(list.map(p => p.trim()).filter(Boolean));
    }

    static processPatterns(
        includePatterns: string[],
        excludePatterns: string[],
        preset?: { include?: string[], exclude?: string[] },
        includedFileTypes?: string[]
    , explicitNegations: string[] = []
    ): { include: Set<string>, exclude: Set<string> } {
    // Normalize patterns to POSIX and deduplicate
    const norm = (arr: string[] = []) => arr.map(p => p.replace(/\\/g, '/').trim()).filter(Boolean);
    let includeArr = norm(includePatterns || []);
    let excludeArr = norm(excludePatterns || []);
    const explicitNegArr = norm(explicitNegations || []);
        // Merge preset
        if (preset) {
            if (preset.include) { includeArr = includeArr.concat(norm(preset.include)); }
            if (preset.exclude) { excludeArr = excludeArr.concat(norm(preset.exclude)); }
        }
        // Add includedFileTypes
        if (includedFileTypes && includedFileTypes.length > 0) {
            includeArr = includeArr.concat(norm(includedFileTypes));
        }
        // Deduplicate
        let includeSet = new Set(includeArr);
        let excludeSet = new Set(excludeArr);
        // Remove overlap: if a pattern is in both, remove from exclude (include wins)
        // but preserve explicit negations that were originally provided as '!pattern'.
        const explicitSet = new Set(explicitNegArr);
        for (const pattern of includeSet) {
            if (excludeSet.has(pattern) && !explicitSet.has(pattern)) { excludeSet.delete(pattern); }
        }
        return { include: includeSet, exclude: excludeSet };
    }

    static shouldExclude(relPath: string, cfg: DigestConfig, gitignore: GitignoreService, isDir: boolean = false): boolean {
        relPath = relPath.replace(/\\/g, '/');
        if (cfg.respectGitignore && gitignore.isIgnored(relPath, isDir)) { return true; }
        for (const pattern of cfg.excludePatterns) {
            if (minimatch(relPath, pattern.replace(/\\/g, '/'), { dot: true, nocase: false, matchBase: false })) { return true; }
        }
        return false;
    }

    static shouldInclude(relPath: string, cfg: DigestConfig, gitignore: GitignoreService, isDir: boolean = false): boolean {
        relPath = relPath.replace(/\\/g, '/');
        if (!cfg.includePatterns || cfg.includePatterns.length === 0) {
            return !FilterService.shouldExclude(relPath, cfg, gitignore, isDir);
        }
        // If matches any include, return true only if not gitignored when respectGitignore is enabled.
        // This mirrors FileScanner.shouldSkipEntry semantics where include patterns do not override gitignore.
        let matchesInclude = false;
        for (const pattern of cfg.includePatterns) {
            if (minimatch(relPath, pattern.replace(/\\/g, '/'), { dot: true, nocase: false, matchBase: false })) { matchesInclude = true; break; }
        }
        if (!matchesInclude) { return false; }
        if (cfg.respectGitignore && gitignore && gitignore.isIgnored(relPath, isDir)) { return false; }
        return true;
    }
}
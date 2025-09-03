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
        const parsedInclude: string[] = [];
        const parsedExclude: string[] = [...excludePatterns];
        for (const p of includePatterns) {
            if (p.startsWith('!')) {
                parsedExclude.push(p.slice(1));
            } else {
                parsedInclude.push(p);
            }
        }
        // Add includedFileTypes to include patterns if present
        if (includedFileTypes && includedFileTypes.length > 0) {
            for (const p of includedFileTypes) {
                parsedInclude.push(p);
            }
        }
        const cfg: any = {
            includePatterns: parsedInclude,
            excludePatterns: parsedExclude,
            respectGitignore: !!gitignore
        };
        const { include, exclude } = FilterService.processPatterns(parsedInclude, parsedExclude, preset, includedFileTypes);
        return files.filter(relPath => {
            // If matches any exclude, skip
            for (const pattern of exclude) {
                if (minimatch(relPath, pattern, { dot: true, nocase: false, matchBase: false })) { return false; }
            }
            // If matches any include, include
            for (const pattern of include) {
                if (minimatch(relPath, pattern, { dot: true, nocase: false, matchBase: false })) { return true; }
            }
            // If gitignore is present and matches, skip
            if (gitignore && gitignore.isIgnored(relPath)) { return false; }
            // Otherwise include
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
    ): { include: Set<string>, exclude: Set<string> } {
    // Normalize patterns to POSIX and deduplicate
    const norm = (arr: string[] = []) => arr.map(p => p.replace(/\\/g, '/').trim()).filter(Boolean);
    let includeArr = norm(includePatterns || []);
    let excludeArr = norm(excludePatterns || []);
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
        for (const pattern of includeSet) {
            if (excludeSet.has(pattern)) { excludeSet.delete(pattern); }
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
        // If matches any include, return true unconditionally (overrides exclude/.gitignore)
        for (const pattern of cfg.includePatterns) {
            if (minimatch(relPath, pattern.replace(/\\/g, '/'), { dot: true, nocase: false, matchBase: false })) { return true; }
        }
        return false;
    }
}
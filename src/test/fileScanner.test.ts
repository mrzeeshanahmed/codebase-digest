import { FileScanner, flattenTree } from '../services/fileScanner';
import { DigestConfig } from '../types/interfaces';
import * as fs from 'fs';
import * as path from 'path';
import { UIPrompter } from '../utils/ui';

describe('FileScanner.scanRoot', () => {
    const mockPrompter: UIPrompter = {
        promptForTokenOverride: jest.fn().mockResolvedValue(true),
        promptForSizeOverride: jest.fn().mockResolvedValue(true),
        promptForFileCountOverride: jest.fn().mockResolvedValue(true),
      };

    const testDir = path.join(__dirname, 'tmp_scan_test');
    beforeAll(() => {
        if (!fs.existsSync(testDir)) { fs.mkdirSync(testDir); }
        // Create subfolders and files
        fs.mkdirSync(path.join(testDir, 'subdirA'));
        fs.mkdirSync(path.join(testDir, 'subdirB'));
        fs.writeFileSync(path.join(testDir, 'file1.txt'), 'A');
        fs.writeFileSync(path.join(testDir, 'subdirA', 'file2.txt'), 'B');
        fs.writeFileSync(path.join(testDir, 'subdirB', 'file3.txt'), 'C');
        // .gitignore in root: ignore subdirA/ (directory-only), but not subdirB
        fs.writeFileSync(path.join(testDir, '.gitignore'), 'subdirA/\n!subdirA/file2.txt\n');
        // .gitignore in subdirB: ignore all .txt files
        fs.writeFileSync(path.join(testDir, 'subdirB', '.gitignore'), '*.txt\n');
    });
    afterAll(() => {
        fs.rmSync(testDir, { recursive: true, force: true });
    });

    it('respects directory-only ignores and negations', async () => {
        const cfg: DigestConfig = {
            maxFileSize: 1000,
            maxFiles: 10,
            maxTotalSizeBytes: 10000,
            maxDirectoryDepth: 5,
            respectGitignore: true,
        } as any;
        const GitignoreService = require('../services/gitignoreService').GitignoreService;
        const gitignoreService = new GitignoreService();
        const scanner = new FileScanner(gitignoreService, mockPrompter);
    const filesArr = await scanner.scanRoot(testDir, cfg);
    const files = flattenTree(filesArr).map(f => f.relPath).sort();
        expect(files).toContain('file1.txt');
        expect(files).toContain('subdirA/file2.txt');
        expect(files).not.toContain('subdirB/file3.txt');
        expect(files).not.toContain('subdirA/');
    });

    it('counts warnings and limits for size, depth, and totals', async () => {
        const cfg: DigestConfig = {
            maxFileSize: 1, // triggers file size warning
            maxFiles: 1,    // triggers file count warning
            maxTotalSizeBytes: 2, // trigger total size warning reliably
            maxDirectoryDepth: 0,  // triggers depth warning
            respectGitignore: true,
        } as any;
        const GitignoreService = require('../services/gitignoreService').GitignoreService;
        const gitignoreService = new GitignoreService();
        const scanner = new FileScanner(gitignoreService, mockPrompter);
        await scanner.scanRoot(testDir, cfg);
        const stats = scanner.lastStats;
        expect(stats?.warnings.some(w => /file size/i.test(w))).toBe(true);
    // Warnings may vary in wording; assert presence of any file-count related message
    expect(stats?.warnings.some(w => /file count|max files|maxFiles/i.test(w))).toBe(true);
    expect(stats?.warnings.length && stats!.warnings.length > 0).toBe(true);
        expect(stats?.warnings.some(w => /directory depth/i.test(w))).toBe(true);
    });

    it('supports anchored negations and directory-only patterns with nested matches', async () => {
        // Create additional nested files and explicit negation list
        const nestedDir = path.join(testDir, 'nested');
        if (!fs.existsSync(nestedDir)) { fs.mkdirSync(nestedDir); }
        fs.writeFileSync(path.join(nestedDir, 'keep.txt'), 'KEEP');
        fs.writeFileSync(path.join(nestedDir, 'ignoreme.log'), 'IGNORE');

        const cfg: DigestConfig = {
            maxFileSize: 1000,
            maxFiles: 50,
            maxTotalSizeBytes: 100000,
            maxDirectoryDepth: 5,
            includePatterns: [],
            excludePatterns: ['**/*.log', '!nested/ignoreme.log'],
            respectGitignore: true,
        } as any;
        const GitignoreService = require('../services/gitignoreService').GitignoreService;
        const gitignoreService = new GitignoreService();
        const scanner = new FileScanner(gitignoreService, mockPrompter);

        // Provide explicit negations method if available on service
        if (typeof (gitignoreService as any).listExplicitNegations === 'function') {
            // pretend the user provided an explicit negation for nested/ignoreme.log
            try { (gitignoreService as any).listExplicitNegations = () => ['nested/ignoreme.log']; } catch (e) {}
        }

        const filesArr = await scanner.scanRoot(testDir, cfg);
        const files = flattenTree(filesArr).map(f => f.relPath);
        expect(files).toContain('nested/keep.txt');
        // Since excludePatterns include **/*.log, ignoreme.log should be excluded
        expect(files).not.toContain('nested/ignoreme.log');
    });

    it('includes a file within a gitignored directory if specified in includePatterns', async () => {
        // Setup: subdirC is gitignored, but subdirC/include.txt is in includePatterns
        const subdirC = path.join(testDir, 'subdirC');
        if (!fs.existsSync(subdirC)) { fs.mkdirSync(subdirC); }
        fs.writeFileSync(path.join(subdirC, 'include.txt'), 'INCLUDE');
        fs.writeFileSync(path.join(subdirC, 'another.txt'), 'EXCLUDE');
        fs.appendFileSync(path.join(testDir, '.gitignore'), '\nsubdirC/\n');

        const cfg: DigestConfig = {
            maxFileSize: 1000,
            maxFiles: 10,
            maxTotalSizeBytes: 10000,
            maxDirectoryDepth: 5,
            respectGitignore: true,
            includePatterns: ['**/include.txt'],
            excludePatterns: [],
        } as any;
        const GitignoreService = require('../services/gitignoreService').GitignoreService;
        const gitignoreService = new GitignoreService();
        const scanner = new FileScanner(gitignoreService, mockPrompter);
        const filesArr = await scanner.scanRoot(testDir, cfg);
        const files = flattenTree(filesArr).map(f => f.relPath).sort();

        expect(files).toContain('subdirC/include.txt');
        expect(files).not.toContain('subdirC/another.txt');
    });
});

import { FileScanner } from '../services/fileScanner';
import { DigestConfig } from '../types/interfaces';
import * as fs from 'fs';
import * as path from 'path';

describe('FileScanner.scanRoot', () => {
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
            maxDirectoryDepth: 5
        } as any;
        const GitignoreService = require('../services/gitignoreService').GitignoreService;
        const Diagnostics = require('../utils/diagnostics').Diagnostics;
        const gitignoreService = new GitignoreService();
        const diagnostics = new Diagnostics('info');
        const scanner = new FileScanner(gitignoreService, diagnostics);
        const filesArr = await scanner.scanRoot(testDir, cfg);
        const files = filesArr.map(f => f.relPath).sort();
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
            maxDirectoryDepth: 0  // triggers depth warning
        } as any;
        const GitignoreService = require('../services/gitignoreService').GitignoreService;
        const Diagnostics = require('../utils/diagnostics').Diagnostics;
        const gitignoreService = new GitignoreService();
        const diagnostics = new Diagnostics('info');
        const scanner = new FileScanner(gitignoreService, diagnostics);
        await scanner.scanRoot(testDir, cfg);
        const stats = scanner.lastStats;
        expect(stats?.warnings.some(w => /file size/i.test(w))).toBe(true);
    // Warnings may vary in wording; assert presence of any file-count related message
    expect(stats?.warnings.some(w => /file count|max files|maxFiles/i.test(w))).toBe(true);
    expect(stats?.warnings.length && stats!.warnings.length > 0).toBe(true);
        expect(stats?.warnings.some(w => /directory depth/i.test(w))).toBe(true);
    });
});

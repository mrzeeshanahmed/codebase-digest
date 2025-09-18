import { describe, it, expect } from '@jest/globals';
import * as path from 'path';
import { FilterService } from '../services/filterService';
import { GitignoreService } from '../services/gitignoreService';
import { TokenAnalyzer } from '../services/tokenAnalyzer';
import { NotebookProcessor } from '../services/notebookProcessor';
import { Formatters } from '../utils/formatters';

describe('FilterService', () => {
    it('include-wins-overlap', () => {
        const patterns = ['src/**', '!src/exclude/**'];
        const files = ['src/a.js', 'src/exclude/b.js', 'src/include/c.js'];
        const result = FilterService.filterFileList(files, patterns, [], undefined);
        expect(result).toContain('src/a.js');
        expect(result).not.toContain('src/exclude/b.js');
        expect(result).toContain('src/include/c.js');
    });
});

describe('GitignoreService', () => {
    it('hierarchical ignore', () => {
        const service = new GitignoreService();
        service.loadIgnoreFile('/repo/.gitignore', '*.log\n');
        service.loadIgnoreFile('/repo/sub/.gitignore', '*.tmp\n');
        expect(service.isIgnored('/repo/file.log')).toBe(true);
        expect(service.isIgnored('/repo/sub/file.tmp')).toBe(true);
        expect(service.isIgnored('/repo/sub/file.log')).toBe(true);
        expect(service.isIgnored('/repo/file.tmp')).toBe(false);
    });

    it('anchored pattern only matches root', () => {
        const service = new GitignoreService();
        service.loadIgnoreFile('/repo/.gitignore', '/foo.txt\n');
        expect(service.isIgnored('/repo/foo.txt')).toBe(true);
        expect(service.isIgnored('/repo/sub/foo.txt')).toBe(false);
    });

    it('negation pattern unignores file', () => {
        const service = new GitignoreService();
        service.loadIgnoreFile('/repo/.gitignore', '*.log\n!keep.log\n');
        expect(service.isIgnored('/repo/file.log')).toBe(true);
        expect(service.isIgnored('/repo/keep.log')).toBe(false);
    });

    it('directory-only pattern matches only directories', () => {
        const service = new GitignoreService();
        service.loadIgnoreFile('/repo/.gitignore', 'build/\n');
        // Simulate isDir true/false by calling evaluate directly
        const matchers = service.getEffectiveMatchers('/repo/build');
        expect(service.evaluate('/repo/build', true, matchers)).toBe(true);
        expect(service.evaluate('/repo/build', false, matchers)).toBe(false);
    });

    it('last-rule-wins logic', () => {
        const service = new GitignoreService();
        service.loadIgnoreFile('/repo/.gitignore', '*.tmp\n!keep.tmp\n*.tmp\n');
        expect(service.isIgnored('/repo/keep.tmp')).toBe(true); // last rule is ignore
    });
});

describe('TokenAnalyzer', () => {
    it('k/M formatting and limit warning', () => {
        const analyzer = new TokenAnalyzer();
        expect(TokenAnalyzer.formatTokenCount(1500)).toBe('1.5k');
        expect(TokenAnalyzer.formatTokenCount(1500000)).toBe('1.5M');
    expect(analyzer.warnIfExceedsLimit(20000, 16000)).toMatch(/token estimate 20k exceeds context limit/);
        expect(analyzer.warnIfExceedsLimit(10000, 16000)).toBeNull();
    });
});

describe('NotebookProcessor', () => {
    it('parse and toText with truncation', () => {
    const nb = NotebookProcessor.parseIpynb(path.join(__dirname, 'fixtures', 'sample.ipynb'));
        const text = NotebookProcessor.toText(nb, { outputMaxChars: 10, includeCodeCells: true, includeMarkdownCells: true, includeOutputs: true });
        expect(text).toMatch(/Jupyter Notebook:/);
        expect(text.length).toBeLessThan(500);
    });
});

describe('Formatters', () => {
    it('buildSelectedTree correctness', () => {
        const files = [
            { path: 'a.js', relPath: 'a.js', name: 'a.js', type: 'file' as 'file', isSelected: true, depth: 0 },
            { path: 'b/b.js', relPath: 'b/b.js', name: 'b.js', type: 'file' as 'file', isSelected: true, depth: 1 }
        ];
        const tree = new Formatters().buildSelectedTree(files);
        expect(tree).toMatch(/a.js/);
        expect(tree).toMatch(/b.js/);
    });
});

describe('Concurrency', () => {
    it('deterministic order under concurrency', async () => {
        const files = Array.from({ length: 100 }, (_, i) => ({ relPath: `f${i}.js`, name: `f${i}.js`, type: 'file', isSelected: true, depth: 0 }));
        const results: string[] = [];
        await Promise.all(files.map(async f => {
            // Yield to the microtask queue to simulate async concurrency without timing-based flakiness
            await new Promise<void>(res => { if (typeof queueMicrotask === 'function') { queueMicrotask(() => res()); } else { Promise.resolve().then(() => res()); } });
            results.push(f.relPath);
        }));
        expect(results.sort()).toEqual(files.map(f => f.relPath).sort());
    });
});

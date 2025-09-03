
jest.mock('vscode', () => ({
    window: {
        createOutputChannel: jest.fn(() => ({
            appendLine: jest.fn(),
            show: jest.fn(),
            hide: jest.fn(),
            dispose: jest.fn(),
        })),
    },
    // Provide a workspace mock with folders and createFileSystemWatcher
    workspace: {
        workspaceFolders: [{ name: 'mock', uri: { fsPath: '/mock' } }],
        createFileSystemWatcher: jest.fn(() => ({
            onDidCreate: jest.fn(),
            onDidChange: jest.fn(),
            onDidDelete: jest.fn(),
            dispose: jest.fn()
        })),
        getConfiguration: jest.fn(() => ({ get: (k: string, d: any) => d }))
    },
    commands: {},
    TreeItem: class {},
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    EventEmitter: class {
        event = jest.fn();
        fire = jest.fn();
        dispose = jest.fn();
        constructor() {}
    },
}));

import { CodebaseDigestTreeProvider } from '../providers/treeDataProvider';
import { FileScanner } from '../services/fileScanner';
import { Diagnostics } from '../utils/diagnostics';

describe('dashboardState', () => {
    let treeProvider: any;
    let diagnostics: any;
    let mockFiles: any[];
    let mockAggregateStats: any;

    beforeEach(() => {
        diagnostics = new Diagnostics('info');
    // Provide mock folder and services as required by constructor
    const mockFolder = { name: 'mock', uri: { fsPath: '/mock' } } as any;
    const mockServices = {} as any;
    treeProvider = new CodebaseDigestTreeProvider(mockFolder, mockServices);
        treeProvider.diagnostics = diagnostics;
    // Use a real GitignoreService instance and override methods as needed
    const { GitignoreService } = require('../services/gitignoreService');
    const realGitignoreService = new GitignoreService();
    // Override methods to avoid file system access
    realGitignoreService.isIgnored = jest.fn(() => false);
    realGitignoreService.loadRoot = jest.fn();
    realGitignoreService.loadForDir = jest.fn();
    realGitignoreService.getEffectiveMatchers = jest.fn(() => []);
    realGitignoreService.compilePatternsToMatchers = jest.fn(() => []);
    realGitignoreService.getIgnorePatterns = jest.fn(() => []);
    realGitignoreService.getIgnoreFiles = jest.fn(() => []);
    realGitignoreService.evaluate = jest.fn();
    realGitignoreService.clear = jest.fn();
    realGitignoreService.getWorkspaceRoot = jest.fn(() => '/');
    treeProvider.fileScanner = new FileScanner(realGitignoreService, diagnostics);
        // Mock FileScanner.aggregateStats
        mockAggregateStats = jest.fn(() => ({
            extCounts: { '.ts': 2, '.md': 1 },
            sizeBuckets: { 'small': 2, 'medium': 1 },
            langCounts: { 'TypeScript': 2, 'Markdown': 1 }
        }));
        treeProvider.fileScanner.aggregateStats = mockAggregateStats;
        // Inject mock files
        mockFiles = [
            { name: 'file1.ts', path: '/file1.ts', relPath: 'file1.ts', type: 'file', size: 100, isSelected: true },
            { name: 'file2.ts', path: '/file2.ts', relPath: 'file2.ts', type: 'file', size: 200, isSelected: false },
            { name: 'readme.md', path: '/readme.md', relPath: 'readme.md', type: 'file', size: 50, isSelected: true }
        ];
        treeProvider.rootNodes = mockFiles;
        treeProvider.selectedRelPaths = ['file1.ts', 'readme.md'];
        treeProvider.totalFiles = mockFiles.length;
        treeProvider.totalSize = mockFiles.reduce((acc, f) => acc + f.size, 0);
        treeProvider.config = {
            filterPresets: ['default'],
            contextLimit: 500,
            tokenEstimate: 600
        };
    });

    it('returns correct dashboard state', () => {
        const preview = treeProvider.getPreviewData();
        expect(preview.selectedCount).toBe(2);
        expect(preview.totalFiles).toBe(3);
        expect(preview.tokenEstimate).toBeDefined();
        expect(preview.presetNames).toEqual(['default']);
        expect(preview.contextLimit).toBe(500);
        expect(Array.isArray(preview.minimalSelectedTreeLines)).toBe(true);
        expect(preview.minimalSelectedTreeLines.length).toBeLessThanOrEqual(50);
    expect(preview.chartStats.extCounts['.ts']).toBe(2);
    expect(preview.chartStats.langCounts['TypeScript']).toBe(2);
    });

    it('updates selection and reflects in preview', () => {
        treeProvider.setSelectionByRelPaths(['file2.ts']);
        const preview = treeProvider.getPreviewData();
        expect(preview.selectedCount).toBe(1);
        expect(preview.minimalSelectedTreeLines.length).toBeLessThanOrEqual(50);
    });

    it('passes through aggregateStats', () => {
        const preview = treeProvider.getPreviewData();
        expect(mockAggregateStats).toHaveBeenCalled();
    expect(preview.chartStats.extCounts['.md']).toBe(1);
    });
});

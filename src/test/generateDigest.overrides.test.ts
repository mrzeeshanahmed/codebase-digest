import * as vscode from 'vscode';
import { generateDigest } from '../providers/digestProvider';

// Minimal mocks to exercise generateDigest without scanning a repo
const mockFileNode = { relPath: 'foo.txt', size: 10, isDirectory: false, path: require('path').join(process.cwd(), 'foo.txt'), name: 'foo.txt', type: 'file' } as any;

class MockTreeProvider {
    getSelectedFiles() { return [mockFileNode]; }
    selectAll() { /* noop */ }
}

class MockWorkspaceManager {
    getBundleForFolder(_wf: vscode.WorkspaceFolder) {
        // Provide minimal services used by generateDigest with lightweight mocks
        const contentProcessor = {
            getFileContent: async (_filePath: string, _ext: string, _cfg: any) => ({ content: 'This contains a secret value', isBinary: false }),
            // include static scanDirectory for remote tests if ever used
            scanDirectory: ContentProcessorSafeScan
        } as any;
        const tokenAnalyzer = {
            estimate: (_body: string) => 1,
            warnIfExceedsLimit: (_tokens: number, _limit: number) => null
        } as any;
        return {
            diagnostics: { info: () => {}, warn: () => {}, error: () => {} },
            cacheService: undefined,
            contentProcessor,
            tokenAnalyzer,
            metrics: undefined
        } as any;
    }
}

async function ContentProcessorSafeScan(_root: string, _cfg: any) {
    return [mockFileNode];
}

describe('generateDigest transient overrides', () => {
    it('respects one-shot showRedacted override (no redaction applied)', async () => {
        // Provide a fake workspace folder
        const wf = { uri: { fsPath: process.cwd() } } as vscode.WorkspaceFolder;
        // Mock workspace.getConfiguration to return a minimal config used by generateDigest
    const originalGetConfig = (vscode.workspace as any).getConfiguration;
    (vscode.workspace as any).getConfiguration = (_section: string, _resource: any) => {
            return {
                showRedacted: false,
                redactionPatterns: ['secret'],
                redactionPlaceholder: '[REDACTED]',
                tokenModel: 'chars-approx',
                tokenDivisorOverrides: {},
                outputFormat: 'text',
                outputSeparatorsHeader: '\n---\n',
                cacheEnabled: false,
                performanceCollectMetrics: false,
                maxFiles: 1000,
                maxTotalSizeBytes: 1e9,
                maxFileSize: 1e7,
                maxDirectoryDepth: 10,
                includePatterns: [],
                excludePatterns: [],
                remoteRepo: '',
                remoteRepoOptions: {},
                outputPresetCompatible: false,
                filterPresets: []
            } as any;
        };

        const treeProvider = new MockTreeProvider() as any;
        const workspaceManager = new MockWorkspaceManager() as any;

    // Patch OutputWriter to avoid VS Code UI interactions during test
    const OutputWriter = require('../services/outputWriter').OutputWriter;
    const origWrite = OutputWriter.prototype.write;
    try {
        OutputWriter.prototype.write = async function (_output: string, _cfg: any) { /* noop */ };
        // Call with override to show redacted values (i.e., do not apply redaction)
        const result = await generateDigest(wf, workspaceManager, treeProvider, { showRedacted: true });
        // restore OutputWriter in finally below
        expect(result).toBeDefined();
        // When showRedacted=true, redactionApplied should be false
        expect((result as any)?.metadata?.redactionApplied).toBe(false);
    } finally {
        // restore OutputWriter and workspace config
        OutputWriter.prototype.write = origWrite;
        (vscode.workspace as any).getConfiguration = originalGetConfig;
    }

    });
});

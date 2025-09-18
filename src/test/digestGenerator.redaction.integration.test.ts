import { DigestGenerator } from '../services/digestGenerator';
import { ContentProcessor } from '../services/contentProcessor';
import { TokenAnalyzer } from '../services/tokenAnalyzer';
import { FileNode, DigestConfig } from '../types/interfaces';

// Mock vscode OutputChannel used by DigestGenerator.getErrorChannel
const appendCalls: string[] = [];
const mockChannel = {
    appendLine: (s: string) => { appendCalls.push(String(s)); },
    show: (_preserveFocus?: boolean) => { /* noop */ },
    dispose: () => { /* noop */ }
} as any;

// Replace the vscode window.createOutputChannel used inside DigestGenerator
jest.mock('vscode', () => ({
    window: {
        createOutputChannel: () => mockChannel
    }
}));

describe('DigestGenerator redaction integration', () => {

    beforeEach(() => {
        appendCalls.length = 0;
        jest.resetModules();
    });

    it('redacts secrets in JSON output and does not log raw secrets', async () => {
        // Minimal TokenAnalyzer mock with diagnostics collector
        const tokenAnalyzer = { diagnostics: { info: jest.fn() }, estimate: (_s: string) => 1 } as unknown as TokenAnalyzer;
        // Minimal ContentProcessor that just returns the text unchanged
        const contentProcessor = { process: async (s: string) => s } as unknown as ContentProcessor;

        // Re-import DigestGenerator after mocking vscode
        const { DigestGenerator: DG } = require('../services/digestGenerator');
        const gen = new DG(contentProcessor, tokenAnalyzer as any);

        // Create a fake file node containing a secret
        const secret = 'my secret key=SUPERSECRET12345';
        const files: FileNode[] = [
            { path: 'secrets.txt', relPath: 'secrets.txt', size: secret.length, type: 'file', name: 'secrets.txt', isSelected: false, depth: 1 }
        ];

        const cfg: DigestConfig = { maxFiles: 10, redactionPatterns: ['SUPERSECRET12345'], redactionPlaceholder: '[REDACTED]' } as any;

        const res = await gen.generate(files, cfg as any, [], 'json');

        // The content should be valid JSON and not include the raw secret
        expect(typeof res.content).toBe('string');
        expect(res.content).not.toContain('SUPERSECRET12345');
        expect(res.content).toContain('[REDACTED]');

        // If outputObjects exist, they should also be redacted
        if (Array.isArray(res.outputObjects)) {
            for (const o of res.outputObjects) {
                if (o.header) { expect(String(o.header)).not.toContain('SUPERSECRET12345'); }
                if (o.body) { expect(String(o.body)).not.toContain('SUPERSECRET12345'); }
            }
        }

        // Ensure nothing logged to the OutputChannel contains the raw secret
        for (const l of appendCalls) {
            expect(l).not.toContain('SUPERSECRET12345');
        }
    });
});

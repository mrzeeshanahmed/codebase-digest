import { validateConfig } from '../utils/validateConfig';
import { DigestConfig } from '../types/interfaces';

class MockDiagnostics {
    public warns: string[] = [];
    warn(msg: string) { this.warns.push(msg); }
}

describe('validateConfig redaction handling', () => {
    test('coerces invalid redaction settings', () => {
        const cfg = {
            maxFileSize: 1024,
            maxFiles: 10,
            maxTotalSizeBytes: 10000,
            maxDirectoryDepth: 5,
            excludePatterns: [],
            includePatterns: [],
            respectGitignore: true,
            gitignoreFiles: [],
            outputFormat: 'markdown',
            includeMetadata: true,
            includeTree: true,
            includeSummary: true,
            includeFileContents: true,
            useStreamingRead: true,
            binaryFilePolicy: 'skip',
            notebookProcess: true,
            tokenEstimate: true,
            tokenModel: 'chars-approx',
            performanceLogLevel: 'info',
            performanceCollectMetrics: true,
            outputSeparatorsHeader: '\n---\n',
            outputWriteLocation: 'editor'
        } as unknown as DigestConfig;

        // Inject invalid redaction values
        (cfg as any).showRedacted = 'notabool';
        (cfg as any).redactionPatterns = 12345;
        (cfg as any).redactionPlaceholder = 999;

        const diag = new MockDiagnostics();
        validateConfig(cfg, diag as any);

        // showRedacted coerced to boolean false
        expect(cfg.showRedacted).toBe(false);
        // redactionPatterns coerced to empty array
        expect(Array.isArray(cfg.redactionPatterns)).toBe(true);
        if (Array.isArray(cfg.redactionPatterns)) {
            expect(cfg.redactionPatterns.length).toBe(0);
        }
        // redactionPlaceholder coerced to default string
        expect(typeof cfg.redactionPlaceholder).toBe('string');
        expect(cfg.redactionPlaceholder).toBe('[REDACTED]');
        // diagnostics recorded warnings
        expect(diag.warns.length).toBeGreaterThanOrEqual(1);
    });
});

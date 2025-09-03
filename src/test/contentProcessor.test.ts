import { ContentProcessor } from '../services/contentProcessor';
import { DigestConfig } from '../types/interfaces';
import * as fs from 'fs';
import * as path from 'path';
import { Diagnostics } from '../utils/diagnostics';

describe('ContentProcessor.getFileContent', () => {
    const testDir = path.join(__dirname, 'tmp_content_test');
    const diagnostics = new Diagnostics('info');
    beforeAll(() => {
        if (!fs.existsSync(testDir)) { fs.mkdirSync(testDir); }
    });
    afterAll(() => {
        fs.rmSync(testDir, { recursive: true, force: true });
    });

    it('normalizes text file content', async () => {
        const filePath = path.join(testDir, 'file.txt');
        fs.writeFileSync(filePath, 'Hello\r\nWorld!');
        const cfg: DigestConfig = { maxFileSize: 1000, maxFiles: 10, maxTotalSizeBytes: 10000, maxDirectoryDepth: 2 } as any;
    const processor = new ContentProcessor();
    const result = await processor.getFileContent(filePath, '.txt', cfg);
        expect(result.content).toBe('Hello\nWorld!');
        expect(result.isBinary).toBe(false);
    });

    it('skips binary file when policy is skip', async () => {
        const filePath = path.join(testDir, 'file.bin');
        fs.writeFileSync(filePath, Buffer.from([0, 255, 0, 255]));
        const cfg: DigestConfig = { maxFileSize: 1000, maxFiles: 10, maxTotalSizeBytes: 10000, maxDirectoryDepth: 2, binaryFilePolicy: 'skip' } as any;
    const processor = new ContentProcessor();
    const result = await processor.getFileContent(filePath, '.bin', cfg);
        expect(result.content).toMatch(/\[binary file skipped\]/i);
        expect(result.isBinary).toBe(true);
    });

    it('returns placeholder for binary file when policy is includePlaceholder', async () => {
        const filePath = path.join(testDir, 'file2.bin');
        fs.writeFileSync(filePath, Buffer.from([0, 255, 0, 255]));
        const cfg: DigestConfig = { maxFileSize: 1000, maxFiles: 10, maxTotalSizeBytes: 10000, maxDirectoryDepth: 2, binaryFilePolicy: 'includePlaceholder' } as any;
    const processor = new ContentProcessor();
    const result = await processor.getFileContent(filePath, '.bin', cfg);
    expect(result.content).toMatch(/\[binary file: 4 B\]/i);
        expect(result.isBinary).toBe(true);
    });

    it('returns base64 for binary file when policy is includeBase64', async () => {
    const filePath = path.join(testDir, 'file3.bin');
    fs.writeFileSync(filePath, Buffer.from([1, 2, 3, 4]));
    const cfg: DigestConfig = { maxFileSize: 1000, maxFiles: 10, maxTotalSizeBytes: 10000, maxDirectoryDepth: 2, binaryFilePolicy: 'includeBase64', base64FenceLanguage: 'base64' } as any;
    const processor = new ContentProcessor();
    const result = await processor.getFileContent(filePath, '.bin', cfg);
    expect(result.content).toMatch(/AQIDBA==/);
    expect(result.isBinary).toBe(true);
    });

    it('maps notebookProcess=true to NotebookProcessor.buildNotebookContent', async () => {
        const filePath = path.join(testDir, 'file.ipynb');
        const nbJson = {
            cells: [
                { cell_type: 'markdown', source: ['# Title'], metadata: {} },
                { cell_type: 'code', source: ['print("hi")'], outputs: ['hi'], metadata: {} }
            ],
            metadata: {}
        };
        fs.writeFileSync(filePath, JSON.stringify(nbJson));
        const cfg: DigestConfig = { maxFileSize: 1000, maxFiles: 10, maxTotalSizeBytes: 10000, maxDirectoryDepth: 2, notebookProcess: true } as any;
    const processor = new ContentProcessor();
    const result = await processor.getFileContent(filePath, '.ipynb', cfg);
        expect(result.content).toMatch(/Jupyter Notebook:/);
        expect(result.content).toMatch(/# Title/);
        expect(result.content).toMatch(/print\("hi"\)/);
        expect(result.isBinary).toBe(false);
    });
});

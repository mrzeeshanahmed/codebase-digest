import { FSUtils } from '../utils/fsUtils';
import * as os from 'os';
import * as path from 'path';
import * as fsp from 'fs/promises';
import * as fs from 'fs';

describe('FSUtils.readTextFile streaming yields and normalizes', () => {
    const tmpDir = path.join(os.tmpdir(), 'codebase-digest-tests');
    const filePath = path.join(tmpDir, 'large-crlf-test.txt');
    beforeAll(async () => {
        await fsp.mkdir(tmpDir, { recursive: true });
        // Generate >5MB file by writing many lines with CRLF endings
        const stream = fs.createWriteStream(filePath, { encoding: 'utf8' });
        const line = 'This is a test line with CRLF endings.' + '\r\n';
        const lineSize = Buffer.byteLength(line, 'utf8');
        const targetBytes = 5 * 1024 * 1024 + 1000; // ~5MB
        let written = 0;
        while (written < targetBytes) {
            if (!stream.write(line)) {
                // backpressure; wait for drain
                await new Promise<void>((res) => stream.once('drain', () => res()));
            }
            written += lineSize;
        }
        await new Promise((res) => stream.end(res));
    }, 60000);

    afterAll(async () => {
        try { await fsp.unlink(filePath); } catch {};
        try { await fsp.rmdir(tmpDir); } catch {};
    });

    test('streaming read normalizes CRLF to LF and yields', async () => {
        const content = await FSUtils.readTextFile(filePath, true);
        // Should not contain any CR characters
        expect(content.indexOf('\r')).toBe(-1);
    // Original file should be >5MB
    const stat = await fsp.stat(filePath);
    expect(stat.size).toBeGreaterThan(5 * 1024 * 1024);
    // After normalization each CRLF becomes LF: normalized length + number_of_lines === original size
    const lineCount = Math.max(0, content.split('\n').length - 1);
    expect(stat.size).toBe(content.length + lineCount);
        // Check that lines end with single LF
        const sample = content.slice(0, 1000);
        expect(/\r\n/.test(sample)).toBe(false);
        expect(/\n/.test(sample)).toBe(true);
    }, 60000);
});

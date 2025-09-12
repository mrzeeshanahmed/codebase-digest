import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FSUtils } from '../utils/fsUtils';

describe('FSUtils', () => {
    it('readTextFile streaming should read and normalize line endings', async () => {
        const tmp = path.join(os.tmpdir(), 'fsutils-test.txt');
        fs.writeFileSync(tmp, 'line1\r\nline2\rline3\n');
        try {
            const content = await FSUtils.readTextFile(tmp, true);
            expect(content).toBe('line1\nline2\nline3\n');
        } finally {
            try { fs.unlinkSync(tmp); } catch (e) {}
        }
    });

    it('readFileBase64 should return base64 for a binary file', async () => {
        const tmp = path.join(os.tmpdir(), 'fsutils-bin-test.bin');
        const data = Buffer.from([0,1,2,3,4,5,6,7,8,9]);
        fs.writeFileSync(tmp, data);
        try {
            const b64 = await FSUtils.readFileBase64(tmp);
            expect(typeof b64).toBe('string');
            expect(b64.length).toBeGreaterThan(0);
        } finally {
            try { fs.unlinkSync(tmp); } catch (e) {}
        }
    });
});

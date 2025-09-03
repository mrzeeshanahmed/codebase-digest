/**
 * FSUtils: File system helpers for safe stat, binary detection, streaming reads, and formatting.
 */
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';

export class FSUtils {
    /**
     * Safely stat a file, returns fs.Stats or null on error.
     */
    static async safeStat(filePath: string): Promise<fs.Stats | null> {
        try {
            return await fsp.stat(filePath);
        } catch {
            return null;
        }
    }

    /**
     * Checks if a file is binary by reading first 8KB and looking for null byte or >30% non-text bytes.
     */
    static async isBinary(filePath: string): Promise<boolean> {
        try {
            const fd = await fsp.open(filePath, 'r');
            const buf = Buffer.alloc(8192);
            const { bytesRead } = await fd.read(buf, 0, 8192, 0);
            await fd.close();
            let nonTextCount = 0;
            for (let i = 0; i < bytesRead; i++) {
                const byte = buf[i];
                if (byte === 0) { return true; }
                // Typical text: tab(9), LF(10), CR(13), 32-126 (printable ASCII)
                if (!(byte === 9 || byte === 10 || byte === 13 || (byte >= 32 && byte <= 126))) {
                    nonTextCount++;
                }
            }
            if (bytesRead > 0 && nonTextCount / bytesRead > 0.3) {
                return true;
            }
            return false;
        } catch {
            return false;
        }
    }

    /**
     * Checks if a path is readable by attempting fs.access with R_OK.
     */
    static async isReadable(filePath: string): Promise<boolean> {
        try {
            await fsp.access(filePath, fs.constants.R_OK);
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Reads a text file, streaming if requested, normalizes CRLF/CR to LF. Streaming mode collects chunks, joins, then normalizes once.
     */
    static async readTextFile(filePath: string, streaming = false): Promise<string> {
        if (!streaming) {
            try {
                const data = await fsp.readFile(filePath, 'utf8');
                return data.replace(/\r\n?/g, '\n');
            } catch {
                return '';
            }
        } else {
            try {
                const chunks: string[] = [];
                const stream = fs.createReadStream(filePath, { encoding: 'utf8' }) as fs.ReadStream & AsyncIterable<string>;
                for await (const chunkRaw of stream) {
                    const chunk = typeof chunkRaw === 'string' ? chunkRaw : String(chunkRaw);
                    chunks.push(chunk);
                    // Yield control to the event loop between chunks so long-running reads don't starve timers
                    await new Promise((res) => setImmediate(res));
                }
                // Normalize line endings only once after joining
                return chunks.join('').replace(/\r\n?/g, '\n');
            } catch {
                return '';
            }
        }
    }

    /**
     * Returns human-readable file size string (e.g., 12.3 KB/MB/GB).
     */
    static humanFileSize(bytes: number): string {
    if (bytes < 1024) { return `${bytes} B`; }
        const units = ['KB', 'MB', 'GB', 'TB'];
        let i = -1;
        do {
            bytes /= 1024;
            i++;
        } while (bytes >= 1024 && i < units.length - 1);
        return `${bytes.toFixed(1)} ${units[i]}`;
    }

    /**
     * Reads a file and returns its base64 string (for binary placeholder policy).
     */
    static async readFileBase64(filePath: string): Promise<string> {
        try {
            const data = await fsp.readFile(filePath);
            return data.toString('base64');
        } catch {
            return '';
        }
    }
}

import { FSUtils } from '../utils/fsUtils';

/**
 * Wrapper around FSUtils.readTextFile that ensures streaming read is used and
 * normalizes line endings to LF. Returns the full file contents as a string.
 */
export async function streamLargeFile(filePath: string): Promise<string> {
    // Force streaming mode
    const text = await FSUtils.readTextFile(filePath, true);
    return text.replace(/\r\n/g, '\n');
}

export default { streamLargeFile };

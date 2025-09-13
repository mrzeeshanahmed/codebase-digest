import { FSUtils } from '../utils/fsUtils';

/**
 * Wrapper around FSUtils.readTextFile that ensures streaming read is used.
 * FSUtils.readTextFile already normalizes CRLF to LF, so this function simply
 * returns the provided text when streaming is requested.
 */
export async function streamLargeFile(filePath: string): Promise<string> {
    // Force streaming mode
    return await FSUtils.readTextFile(filePath, true);
}

export default { streamLargeFile };

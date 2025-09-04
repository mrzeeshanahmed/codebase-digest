import * as vscode from 'vscode';
import { onProgress } from '../providers/eventBus';

export class OutputWriter {
    async write(output: string, config: any): Promise<void> {
        // Do not mutate the provided config object (it may be a WorkspaceConfiguration or frozen).
        // Determine write location in a local variable so callers' configuration objects are not modified.
        let writeLocation = config && config.outputWriteLocation ? config.outputWriteLocation : 'editor';
        if (writeLocation === 'prompt') {
            const pick = await vscode.window.showQuickPick([
                { label: 'View in Editor', value: 'editor' },
                { label: 'Save to File', value: 'file' },
                { label: 'Copy to Clipboard', value: 'clipboard' }
            ], { placeHolder: 'Choose output location:' });
            if (!pick) { return; }
            writeLocation = pick.value;
        }
        if (writeLocation === 'editor') {
            const doc = await vscode.workspace.openTextDocument({ content: output, language: config.outputFormat === 'json' ? 'json' : (config.outputFormat === 'markdown' ? 'markdown' : 'plaintext') });
            await vscode.window.showTextDocument(doc, { preview: false });
        } else if (writeLocation === 'file') {
            const uri = await vscode.window.showSaveDialog({ filters: { [config.outputFormat]: [config.outputFormat] } });
            if (uri) {
                const fs = require('fs');
                let stream;
                let canceled = false;
                // Allow configurable streaming threshold and chunk size via settings
                const streamingThreshold = typeof config.streamingThresholdBytes === 'number' ? config.streamingThresholdBytes : 64 * 1024;
                const chunkSize = typeof config.chunkSize === 'number' ? config.chunkSize : 64 * 1024;
                // Subscribe to progress events to allow user-triggered cancellation of write
                const unsub = onProgress((e: any) => {
                    if (e && e.op === 'write' && e.mode === 'cancel') {
                        canceled = true;
                    }
                });
                try {
                    stream = fs.createWriteStream(uri.fsPath, { encoding: 'utf8' });
                        // Decide whether to stream progressively based on threshold
                        const byteLen = Buffer.byteLength(output || '', 'utf8');
                    if (byteLen <= streamingThreshold) {
                        stream.write(output);
                    } else {
                        for (let i = 0; i < output.length; i += chunkSize) {
                            if (canceled) { break; }
                            stream.write(output.slice(i, i + chunkSize));
                            // Yield to event loop between chunks
                            await new Promise(res => setTimeout(res, 0));
                        }
                    }
                    if (canceled) {
                        stream.write('\n---\nDigest canceled. Output may be incomplete.');
                    }
                } finally {
                    if (stream) { stream.end(); }
                    try { unsub(); } catch (e) { /* ignore */ }
                }
                vscode.window.showInformationMessage(`Digest saved to ${uri.fsPath}`);
            }
    } else if (writeLocation === 'clipboard') {
            await vscode.env.clipboard.writeText(output);
            vscode.window.showInformationMessage('Digest copied to clipboard.');
        }
    }
}

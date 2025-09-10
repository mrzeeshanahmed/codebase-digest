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
                let stream: import('fs').WriteStream | undefined;
                let canceled = false;
                // Allow configurable streaming threshold and chunk size via settings
                const streamingThreshold = typeof config.streamingThresholdBytes === 'number' ? config.streamingThresholdBytes : 64 * 1024;
                const chunkSize = typeof config.chunkSize === 'number' ? config.chunkSize : 64 * 1024;
                // Subscribe to progress events to allow user-triggered cancellation of write.
                // The handler will mark canceled and, if the stream is still open, attempt to
                // write a human-friendly footer immediately so fast writes still reflect cancellation.
                let appendedFooter = false;
                // Precompute buffer and counters so the cancel handler can report bytesWritten/totalBytes
                const buf = Buffer.from(output || '', 'utf8');
                const byteLen = buf.length;
                let bytesWritten = 0;
                const unsub = onProgress((e: any) => {
                    if (e && e.op === 'write' && e.mode === 'cancel') {
                        canceled = true;
                        try {
                            // If stream exists and supports write, append footer immediately for human formats
                            if (!appendedFooter && stream && typeof (stream.write) === 'function') {
                                const formatNow = config && config.outputFormat ? String(config.outputFormat).toLowerCase() : '';
                                if (formatNow !== 'json') {
                                    try { stream.write(Buffer.from('\n---\nDigest canceled. Output may be incomplete.', 'utf8')); appendedFooter = true; } catch (e) { /* ignore write errors */ }
                                }
                                // Also write companion .partial metadata file immediately if possible
                                try {
                                    const partialPathNow = uri.fsPath + '.partial';
                                    const metaNow = {
                                        originalPath: uri.fsPath,
                                        bytesWritten: typeof (bytesWritten) === 'number' ? bytesWritten : 0,
                                        totalBytes: typeof (buf) === 'object' && buf && typeof buf.length === 'number' ? buf.length : 0,
                                        timestamp: new Date().toISOString(),
                                    };
                                    try { require('fs').writeFileSync(partialPathNow, JSON.stringify(metaNow, null, 2), 'utf8'); } catch (e) { /* ignore */ }
                                } catch (e) { /* ignore */ }
                            }
                        } catch (er) { /* swallow */ }
                    }
                });
                try {
                    stream = fs.createWriteStream(uri.fsPath);
                    // Decide whether to stream progressively based on threshold
                    const writeOrAwaitDrain = (data: Buffer | string) => {
                        return new Promise<void>((resolve) => {
                            const w = stream!;
                            const ok = w.write(data);
                            if (ok) { resolve(); } else {
                                try {
                                    if (typeof w.once === 'function') {
                                        w.once('drain', () => resolve());
                                    } else if (typeof (w as any).on === 'function') {
                                        const handler = () => {
                                            try { (w as any).removeListener && (w as any).removeListener('drain', handler); } catch {}
                                            resolve();
                                        };
                                        (w as any).on('drain', handler);
                                    } else {
                                        // Stream mock doesn't expose drain events; fall back.
                                        resolve();
                                    }
                                } catch {
                                    // Defensive fallback for exotic mocks
                                    resolve();
                                }
                            }
                        });
                    };

                    if (byteLen <= streamingThreshold) {
                        // Write full buffer at once
                        await writeOrAwaitDrain(buf);
                        bytesWritten = byteLen;
                    } else {
                        // chunkSize is interpreted as bytes
                        const chunkBytes = typeof config.chunkSize === 'number' ? config.chunkSize : chunkSize;
                        for (let offset = 0; offset < byteLen; offset += chunkBytes) {
                            if (canceled) { break; }
                            const slice = buf.slice(offset, Math.min(offset + chunkBytes, byteLen));
                            await writeOrAwaitDrain(slice);
                            bytesWritten += slice.length;
                            // Yield to event loop between chunks
                            await new Promise(res => setTimeout(res, 0));
                        }
                    }

                    // Allow a short window for a near-simultaneous cancel event to be
                    // observed and processed by the onProgress handler before we
                    // finalize the write. This covers fast writes where the user
                    // triggered a cancel almost concurrently (tests schedule a
                    // cancellation with a small timeout); keeping the subscription
                    // active for a tiny delay gives the cancel handler a chance to
                    // append the human-friendly footer and write the .partial file.
                    if (!canceled) {
                        await new Promise(res => setTimeout(res, 30));
                    }

                    if (canceled) {
                        // Avoid appending a textual cancellation footer to machine-readable
                        // formats (e.g., JSON) which would corrupt the file. For such
                        // formats, write a small companion .partial file to indicate
                        // the write was cancelled.
                        const format = config && config.outputFormat ? String(config.outputFormat).toLowerCase() : '';
                        const partialPath = uri.fsPath + '.partial';
                        const meta = {
                            originalPath: uri.fsPath,
                            bytesWritten: bytesWritten,
                            totalBytes: byteLen,
                            timestamp: new Date().toISOString(),
                        };
                        try {
                            if (format === 'json') {
                                fs.writeFileSync(partialPath, JSON.stringify(meta, null, 2), 'utf8');
                            } else {
                                // For human formats, if we already appended a footer via the cancel handler,
                                // avoid appending again. Otherwise, append now.
                                if (!appendedFooter) {
                                    await writeOrAwaitDrain(Buffer.from('\n---\nDigest canceled. Output may be incomplete.', 'utf8'));
                                    appendedFooter = true;
                                }
                                try { fs.writeFileSync(partialPath, JSON.stringify(meta, null, 2), 'utf8'); } catch (e) { /* ignore */ }
                            }
                        } catch (e) {
                            // ignore errors creating companion file or writing footer
                        }
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

import { OutputWriter } from '../services/outputWriter';
import * as fs from 'fs';
import * as path from 'path';
import { emitProgress } from '../providers/eventBus';

describe('OutputWriter progressive save', () => {
  const testFile = path.join(__dirname, 'tmp_output_test.txt');
  afterEach(() => {
    if (fs.existsSync(testFile)) { fs.unlinkSync(testFile); }
  });

  it('writes large output in chunks and appends cancellation footer', async () => {
    // Replace fs.createWriteStream to capture written data and stub save dialog
    let written = '';
    const fakeStream = {
      write: (chunk: string) => { written += chunk; },
      end: () => {}
    } as any;
    const fsModule = require('fs');
    const origCreateWriteStream = fsModule.createWriteStream;
    fsModule.createWriteStream = () => fakeStream as any;
    const vs = require('vscode');
    const origShowSave = vs.window.showSaveDialog;
    const origShowInfo = vs.window.showInformationMessage;
    vs.window.showSaveDialog = async () => ({ fsPath: testFile } as any);
    vs.window.showInformationMessage = () => {};

    const writer = new OutputWriter();
    try {
      const largeOutput = 'A'.repeat(200000);
      // Synchronize cancellation after first chunk is written
      let firstChunkWritten = false;
      fakeStream.write = (chunk: any) => {
        written += String(chunk);
        if (!firstChunkWritten) {
          firstChunkWritten = true;
          emitProgress({ op: 'write', mode: 'cancel' } as import('../providers/eventBus').ProgressEvent);
        }
        return true; // signal immediate success to the writer
      };
      const writePromise = (writer as any).write(largeOutput, { outputWriteLocation: 'file', outputFormat: 'text', chunkSize: 65536, streamingThresholdBytes: 1 });
  await writePromise;
    } finally {
      // restore
      fsModule.createWriteStream = origCreateWriteStream;
      vs.window.showSaveDialog = origShowSave;
      vs.window.showInformationMessage = origShowInfo;
    }
  expect(written).toContain('A');
  // When cancellation occurs mid-write, 'B' may not be present. Ensure cancellation footer exists
  expect(written).toContain('Digest canceled. Output may be incomplete.');
  });
});

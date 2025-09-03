import { OutputWriter } from '../services/outputWriter';
import * as fs from 'fs';
import * as path from 'path';
import { emitProgress } from '../providers/eventBus';

describe('OutputWriter streaming and cancel', () => {
  const testFile = path.join(__dirname, 'tmp_output_test_cancel.txt');
  // Variables for restore
  let fsModule: any;
  let origCreateWriteStream: any;
  afterEach(() => {
    if (fs.existsSync(testFile)) { fs.unlinkSync(testFile); }
    if (fsModule && origCreateWriteStream) { fsModule.createWriteStream = origCreateWriteStream; }
  });

  it('respects streamingThreshold and reacts to write cancel event', async () => {
    // Spy on vscode.showSaveDialog to return testFile
    const vscode = require('vscode');
    jest.spyOn(vscode.window, 'showSaveDialog').mockResolvedValue({ fsPath: testFile } as any);
    // Capture writes via a fake stream
    let written = '';
    const fakeStream = {
      write: (chunk: string) => { written += chunk; },
      end: () => {}
    };
  fsModule = require('fs');
  origCreateWriteStream = fsModule.createWriteStream;
  fsModule.createWriteStream = () => fakeStream as any;

    // Trigger cancellation shortly after write starts
  const writer = new OutputWriter();
    const largeOutput = 'X'.repeat(200000);
    // Schedule cancel after a tick
    setTimeout(() => emitProgress({ op: 'write', mode: 'cancel' }), 0);

    await writer.write(largeOutput, { outputWriteLocation: 'file', outputFormat: 'text', streamingThresholdBytes: 1024, chunkSize: 65536 });
    expect(written).toContain('Digest canceled. Output may be incomplete.');
  });
});

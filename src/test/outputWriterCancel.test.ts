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
    // Capture writes via a fake stream and trigger cancellation on first write
    let written = '';
    let firstWrite = true;
    const fakeStream = {
      write: (chunk: string) => {
        written += chunk;
        if (firstWrite) {
          firstWrite = false;
          // trigger cancel event synchronously when writing starts
          emitProgress({ op: 'write', mode: 'cancel' });
        }
      },
      end: () => {}
    };
  fsModule = require('fs');
  origCreateWriteStream = fsModule.createWriteStream;
  fsModule.createWriteStream = () => fakeStream as any;

    // Trigger cancellation shortly after write starts
  const writer = new OutputWriter();
    // Increase output size to exceed streamingThresholdBytes (1024) and trigger streaming/cancellation
    const largeOutput = 'X'.repeat(2000); // Ensure we exceed streamingThresholdBytes

    await writer.write(largeOutput, { outputWriteLocation: 'file', outputFormat: 'text', streamingThresholdBytes: 1024, chunkSize: 65536 });
    expect(written).toContain('Digest canceled. Output may be incomplete.');
  });
});

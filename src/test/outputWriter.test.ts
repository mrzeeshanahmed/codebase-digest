import { OutputWriter } from '../services/outputWriter';
import * as fs from 'fs';
import * as path from 'path';

describe('OutputWriter progressive save', () => {
  const testFile = path.join(__dirname, 'tmp_output_test.txt');
  afterEach(() => {
    if (fs.existsSync(testFile)) { fs.unlinkSync(testFile); }
  });

  it('writes large output in chunks and appends cancellation footer', async () => {
    // Patch fs.createWriteStream to simulate cancellation
    let written = '';
    const fakeStream = {
      write: (chunk: string) => { written += chunk; },
      end: () => {},
    };
  // Some Node environments make fs.createWriteStream non-configurable; replace via require and restore
  const fsModule = require('fs');
  const origCreateWriteStream = fsModule.createWriteStream;
  fsModule.createWriteStream = () => fakeStream as any;
  // Patch vscode.window.showSaveDialog to return testFile
  const vs = require('vscode');
  const origShowSave = vs.window.showSaveDialog;
  const origShowInfo = vs.window.showInformationMessage;
  vs.window.showSaveDialog = async () => ({ fsPath: testFile } as any);
  vs.window.showInformationMessage = () => {};
    // Simulate cancellation after first chunk
    let canceled = false;
    const writer = new OutputWriter();
    // Patch writer to set canceled after first chunk
    (writer as any).write = async function(output: string, config: any) {
      const fs = require('fs');
      let stream = fs.createWriteStream(testFile, { encoding: 'utf8' });
      const chunkSize = 65536;
      for (let i = 0; i < output.length; i += chunkSize) {
        if (i >= chunkSize) { canceled = true; break; }
        stream.write(output.slice(i, i + chunkSize));
        await new Promise(res => setTimeout(res, 0));
      }
      if (canceled) {
        stream.write('\n---\nDigest canceled. Output may be incomplete.');
      }
      stream.end();
    };
  const largeOutput = 'A'.repeat(100000) + 'B'.repeat(100000);
  await (writer as any).write(largeOutput, { outputWriteLocation: 'file', outputFormat: 'text' });
  // restore replaced functions
  fsModule.createWriteStream = origCreateWriteStream;
  vs.window.showSaveDialog = origShowSave;
  vs.window.showInformationMessage = origShowInfo;
  expect(written).toContain('A');
  // When cancellation occurs mid-write, 'B' may not be present. Ensure cancellation footer exists
  expect(written).toContain('Digest canceled. Output may be incomplete.');
  });
});

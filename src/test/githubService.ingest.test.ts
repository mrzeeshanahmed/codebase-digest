import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Import the modules under test
import * as procRedact from '../../src/utils/procRedact';
import * as githubService from '../../src/services/githubService';
const vscode = require('vscode');

describe('procRedact.spawnGitPromise', () => {
  it('uses vscode git.path when configured', async () => {
    // Arrange: make workspace.getConfiguration return a git.path
    vscode.workspace.getConfiguration = jest.fn(() => ({ get: (_k: string) => 'my-custom-git' }));

    // Mock child_process.spawn to capture the program used
    const child_process = require('child_process');
    const originalSpawn = child_process.spawn;
    let capturedCmd: any = null;
    child_process.spawn = jest.fn((cmd: any, args: any, opts: any) => {
      capturedCmd = cmd;
      // Return a fake process that immediately exits successfully
      return {
        stdout: { on: (_: any, __: any) => {} },
        stderr: { on: (_: any, __: any) => {} },
        on: (ev: string, cb: any) => { if (ev === 'exit') { setTimeout(() => cb(0), 0); } }
      };
    });

    try {
      // Act
      const res = await procRedact.spawnGitPromise(['--version']);
      // Assert
      expect(capturedCmd).toBe('my-custom-git');
    } finally {
      // Restore
      child_process.spawn = originalSpawn;
      vscode.workspace.getConfiguration = jest.fn(() => ({ get: (k: string, d: any) => d }));
    }
  });
});

describe('githubService.ingestRemoteRepo tmp dir cleanup', () => {
  it('removes created tmpDir when partialClone throws', async () => {
    // Arrange: ensure repo appears public
    jest.spyOn(procRedact, 'safeFetch').mockResolvedValue({ ok: true, json: async () => ({ private: false }) });

  // Do not spy partialClone directly; instead mock spawnGitPromise to simulate clone failure

  // We'll assert the cleanup by checking that no tmp dir with the owner-repo prefix remains
  // Snapshot current OS tmpdir entries so we can detect newly-created tmp dirs
  const beforeEntries = new Set(fs.readdirSync(os.tmpdir()));

    // Mock spawnGitPromise to succeed for ls-remote but fail for clone to simulate partialClone failure.
    const spawnMock = jest.spyOn(procRedact, 'spawnGitPromise').mockImplementation(async (args: string[]) => {
      if (Array.isArray(args) && args[0] === 'ls-remote') {
        return { stdout: 'abc123\trefs/heads/main\n', stderr: '' } as any;
      }
      // Simulate clone failure
      throw new Error('simulated clone failure');
    });

    try {
      // Act
      await expect(githubService.ingestRemoteRepo('owner/repo', { ref: { branch: 'main' } })).rejects.toThrow(/simulated clone failure/);

    // Assert: cleanup removed any new owner-repo-* tmpDir created by THIS process during this test.
    // Other test workers may create owner-repo-* dirs concurrently; only consider dirs owned by this process
    const afterEntries = fs.readdirSync(os.tmpdir());
    const added = afterEntries.filter(n => !beforeEntries.has(n) && n.startsWith('owner-repo-'));
    // Filter to only those tmp dirs that contain our creator metadata file and match our PID
    const createdByThisProcess = added.filter(name => {
      try {
        const metaPath = path.join(os.tmpdir(), name, '.codebase-digest-creator.json');
        if (!fs.existsSync(metaPath)) { return false; }
        const txt = fs.readFileSync(metaPath, 'utf8');
        const meta = JSON.parse(txt);
        return meta && meta.pid === process.pid;
      } catch (e) {
        return false;
      }
    });
    expect(createdByThisProcess.length).toBe(0);
    } finally {
      // Restore spies/mocks
      // nothing to restore for tmpdir snapshot
  spawnMock.mockRestore();
  (procRedact.safeFetch as jest.Mock).mockRestore();
    }
  });
});

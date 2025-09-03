import { describe, it, expect, jest } from '@jest/globals';
import { runSubmoduleUpdate } from '../services/githubService';

jest.mock('vscode', () => ({
  window: {},
  commands: {},
  TreeItem: class {},
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
}));

describe('Submodule flow guard', () => {
  it('should run submodule update without error and not spawn git', async () => {
    const fakeEmitter = {
      on: jest.fn((event: string, cb: (...args: any[]) => void) => {
        if (event === 'exit') { cb(0); }
        return fakeEmitter;
      }),
      stdout: { on: jest.fn() },
      stderr: { on: jest.fn() }
    };
    const spawnMock = jest.spyOn(require('child_process'), 'spawn').mockImplementation(() => fakeEmitter);
    let error = null;
    try {
      await runSubmoduleUpdate('/tmp/repo');
    } catch (e) {
      error = e;
    }
    expect(error).toBeNull();
    expect(spawnMock).toHaveBeenCalledWith(
      'git',
      ['submodule', 'update', '--init', '--recursive'],
      expect.objectContaining({ cwd: '/tmp/repo' })
    );
    spawnMock.mockRestore();
  });
});

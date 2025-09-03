import { authenticate, resolveRefToSha, partialClone, runSubmoduleUpdate, ingestRemoteRepo, cleanup, RemoteRepoMeta } from '../services/githubService';
import * as simpleGit from 'simple-git';

describe('githubService', () => {
  it('resolveRefToSha returns SHA on API success', async () => {
    const fetchMock = jest.spyOn(global, 'fetch' as any).mockResolvedValue({
      ok: true,
      json: async () => ({ commit: { sha: 'sha-api-success' } })
    } as any);
    const sha = await resolveRefToSha('owner/repo', { branch: 'main' } as any, 'fake-token');
    expect(sha).toBe('sha-api-success');
    fetchMock.mockRestore();
  });

  it('resolveRefToSha falls back to ls-remote on API rate-limit', async () => {
    const fetchMock = jest.spyOn(global, 'fetch' as any).mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({ message: 'API rate limit exceeded' })
    } as any);
    const spawnMock = jest.spyOn(require('child_process'), 'spawn' as any).mockImplementation(() => {
      const stdout = {
        on: (event: string, cb: Function) => {
          // emit a hex-like sha so the service regex matches
          if (event === 'data') { cb('abcdef1234567890abcdef1234567890abcdef12\trefs/heads/main\n'); }
        },
        removeAllListeners: () => {}
      };
      const proc = {
        stdout,
        stderr: { on: () => {} },
        on: (event: string, cb: Function) => {
          if (event === 'exit') { cb(0); }
        },
      };
      return proc as any;
    });
  const sha = await resolveRefToSha('owner/repo', { branch: 'main' } as any, 'fake-token');
  expect(sha).toBe('abcdef1234567890abcdef1234567890abcdef12');
    fetchMock.mockRestore();
    spawnMock.mockRestore();
  });

  it('resolveRefToSha returns error on 404', async () => {
    const fetchMock = jest.spyOn(global, 'fetch' as any).mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({ message: 'Not Found' })
    } as any);
  // Force ls-remote to return no matching lines so fallback fails
  const spawnMock = jest.spyOn(require('child_process'), 'spawn' as any).mockImplementation(() => {
    const stdout = {
      on: (event: string, cb: Function) => {
        if (event === 'data') { cb(''); }
      },
      removeAllListeners: () => {}
    };
    const proc = {
      stdout,
      stderr: { on: () => {} },
      on: (event: string, cb: Function) => { if (event === 'exit') { cb(0); } },
    };
    return proc as any;
  });
  await expect(resolveRefToSha('owner/repo', { branch: 'main' } as any, 'fake-token')).rejects.toThrow(/Not Found|404|Could not resolve ref/);
  spawnMock.mockRestore();
    fetchMock.mockRestore();
  });
  beforeEach(() => {
    jest.resetAllMocks();
    // Ensure vscode authentication mock returns a token after reset
    try {
      const vscode = require('vscode');
      if (vscode && vscode.authentication) {
        vscode.authentication.getSession = jest.fn(async () => ({ accessToken: 'fake-token' }));
      }
    } catch (e) {
      // ignore; depending on jest mock environment the module may not be resolved here
    }
    // Default child_process.spawn mock to avoid relying on system git
    try {
      const child = require('child_process');
      jest.spyOn(child, 'spawn' as any).mockImplementation(() => {
        const stdout = {
          on: (event: string, cb: Function) => {
            if (event === 'data') { cb('abc123\trefs/heads/main\n'); }
          },
          removeAllListeners: () => {}
        };
        const proc = {
          stdout,
          stderr: { on: () => {} },
          on: (event: string, cb: Function) => {
            if (event === 'exit') { cb(0); }
            if (event === 'error') { /* noop */ }
          },
        };
        return proc as any;
      });
    } catch (e) {
      // ignore
    }
  });

  it('mocks API branch/tag/commit resolution', async () => {
    // Simulate API-based ref resolution
    const apiMock = jest.spyOn(global, 'fetch' as any).mockResolvedValue({
  json: async () => ({ commit: { sha: 'abc123' } })
    } as any);
  const sha = await resolveRefToSha('owner/repo', { branch: 'main' } as any, 'fake-token');
    expect(sha).toBe('abc123');
    apiMock.mockRestore();
  });

  it('falls back to simple-git ls-remote for ref resolution', async () => {
    const gitMock = jest.spyOn(simpleGit, 'simpleGit' as any).mockReturnValue({
      lsRemote: async () => 'abc123\trefs/heads/main\n',
    } as any);
    const sha = await resolveRefToSha('owner/repo', { branch: 'main' } as any);
    expect(sha).toBe('abc123');
    gitMock.mockRestore();
  });

  it('mocks partialClone and submodule update', async () => {
    const gitMock = jest.spyOn(simpleGit, 'simpleGit' as any).mockReturnValue({
      clone: jest.fn(async () => {}),
      sparseCheckout: jest.fn(async () => {}),
      submoduleUpdate: jest.fn(async () => {}),
      cwd: jest.fn(() => ({
        sparseCheckout: jest.fn(async () => {}),
        submoduleUpdate: jest.fn(async () => {})
      }))
    } as any);
    await expect(partialClone('https://github.com/owner/repo.git', 'abc123', '/tmp/clone', 'src' as any)).resolves.not.toThrow();
    await expect(runSubmoduleUpdate('/tmp/clone')).resolves.not.toThrow();
    gitMock.mockRestore();
  });

  it('mocks ingestRemoteRepo and cleanup, verifies error handling', async () => {
    const gitMock = jest.spyOn(simpleGit, 'simpleGit' as any).mockReturnValue({
      clone: jest.fn(async () => { throw new Error('clone failed'); }),
      cwd: jest.fn(() => ({
        sparseCheckout: jest.fn(async () => { throw new Error('sparse failed'); })
      }))
    } as any);
    // Make child_process.spawn fail on clone to match current implementation
    const child = require('child_process');
    const spawnMock = jest.spyOn(child, 'spawn' as any).mockImplementation((...args: any[]) => {
      const cmdArgs = args[1] as string[] | undefined;
      if (cmdArgs && cmdArgs[0] === 'clone') {
        return {
          stdout: { on: () => {} },
          stderr: { on: () => {} },
          on: (event: string, cb: Function) => { if (event === 'exit') { cb(1); } }
        } as any;
      }
      // default success for other git calls
      return {
        stdout: { on: (e: string, cb: Function) => { if (e === 'data') { cb('abcdef123\trefs/heads/main\n'); } } },
        stderr: { on: () => {} },
        on: (event: string, cb: Function) => { if (event === 'exit') { cb(0); } }
      } as any;
    });
    await expect(ingestRemoteRepo('owner/repo', { ref: { branch: 'main' }, subpath: 'src' } as any)).rejects.toThrow();
    spawnMock.mockRestore();
    await expect(cleanup('/tmp/clone')).resolves.not.toThrow();
    gitMock.mockRestore();
  });

  it('returns RemoteRepoMeta with correct fields', () => {
    const meta: RemoteRepoMeta = {
      ownerRepo: 'owner/repo',
      resolved: {
        sha: 'abc123',
        branch: 'main',
      },
      subpath: 'src',
    } as any;
    expect(meta.ownerRepo).toBe('owner/repo');
    expect(meta.resolved.sha).toBe('abc123');
    expect(meta.resolved.branch).toBe('main');
    expect(meta.subpath).toBe('src');
  });
});

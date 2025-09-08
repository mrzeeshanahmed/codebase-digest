import * as githubService from '../services/githubService';
import { spawnGitPromise } from '../utils/procRedact';

jest.mock('../utils/procRedact', () => ({
  spawnGitPromise: jest.fn()
}));

describe('resolveRefToSha ls-remote fallback', () => {
  afterEach(() => jest.restoreAllMocks());

  it('uses authenticated ls-remote when token present and returns sha', async () => {
    const token = 'ghp_FAKE_TOKEN';
    // Mock spawnGitPromise to return stdout with sha
    (spawnGitPromise as jest.Mock).mockResolvedValue({ stdout: '0123456789abcdef0123456789abcdef01234567\trefs/heads/main\n' });

    const sha = await (githubService as any).resolveRefToSha('owner/repo', { branch: 'main' }, token);

    expect(sha).toBe('0123456789abcdef0123456789abcdef01234567');
    // Ensure spawnGitPromise was called with ls-remote and an authenticated URL
    expect((spawnGitPromise as jest.Mock).mock.calls[0][0][0]).toBe('ls-remote');
    const calledUrl = (spawnGitPromise as jest.Mock).mock.calls[0][0][1];
    expect(calledUrl).toContain('x-access-token');
    expect(calledUrl).toContain('github.com/owner/repo.git');
  });
});

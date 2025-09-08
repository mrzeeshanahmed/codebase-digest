import { ingestRemoteRepoProgrammatic } from '../commands/ingestRemoteRepo';
import * as githubService from '../services/githubService';
import { ContentProcessor } from '../services/contentProcessor';

describe('ingestRemoteRepoProgrammatic keepTmpDir', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns localPath when keepTmpDir is true and does not cleanup temp dir', async () => {
    // Arrange: stub githubService.ingestRemoteRepo to return a fake localPath
    const fakeLocal = 'E:/tmp/fake-repo-keep';
    jest.spyOn(githubService as any, 'ingestRemoteRepo').mockResolvedValue({ localPath: fakeLocal, meta: {} });
    const cleanupSpy = jest.spyOn(githubService as any, 'cleanup').mockResolvedValue(undefined);

    // Stub ContentProcessor to avoid filesystem access
    jest.spyOn(ContentProcessor as any, 'scanDirectory').mockResolvedValue([]);
    jest.spyOn(ContentProcessor.prototype as any, 'getFileContent').mockResolvedValue({ content: '' });

    // Act
    const res: any = await ingestRemoteRepoProgrammatic({ repo: 'owner/repo', keepTmpDir: true } as any);

    // Assert
    expect(res).toBeDefined();
    expect((res as any).localPath).toBe(fakeLocal);
    // cleanup should not have been called by the function when keepTmpDir=true
    expect(cleanupSpy).not.toHaveBeenCalled();
  });
});

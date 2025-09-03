import { ingestRemoteRepo, cleanup as cleanupRemoteTmp, RemoteRepoMeta } from './githubService';

export class RemoteRepoService {
    async ingest(repo: string, options: any): Promise<{ tempPath: string, meta: RemoteRepoMeta }> {
        const result = await ingestRemoteRepo(repo, options);
        return { tempPath: result.localPath, meta: result.meta };
    }
    async cleanup(tempPath: string): Promise<void> {
        await cleanupRemoteTmp(tempPath);
    }
}

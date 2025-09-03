import { describe, it, expect } from '@jest/globals';
import { buildRemoteSummary } from '../services/githubService';

jest.mock('vscode', () => ({
  window: {},
  commands: {},
  TreeItem: class {},
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
}));

describe('Remote summary metadata block', () => {
  it('should build correct summary block', () => {
    const meta = {
      ownerRepo: 'octocat/Hello-World',
      resolved: { sha: 'abc123', branch: 'main' },
      subpath: 'src',
    };
    const summary = buildRemoteSummary(meta);
    expect(summary).toContain('Repository: octocat/Hello-World');
    expect(summary).toContain('Ref: main => abc123');
    expect(summary).toContain('Subpath: src');
  });
});

import * as vscode from 'vscode';

// Jest will hoist jest.mock calls; use requireActual for non-mocked parts
jest.mock('vscode', () => {
  const original = jest.requireActual('vscode');
  return {
    ...original,
    commands: {
      registerCommand: jest.fn(() => ({ dispose: () => {} })),
    },
  };
});

// Mock the command registration modules so we can verify they're called
const mockRegisterCommands = jest.fn();
const mockRegisterToggles = jest.fn();
const mockRegisterSelectionCommands = jest.fn();
const mockRegisterRefreshTree = jest.fn();
const mockRegisterIngestRemoteRepo = jest.fn();
const mockViewMetrics = jest.fn();

jest.mock('../src/commands/generateDigest', () => ({ registerCommands: (...args: any[]) => mockRegisterCommands(...args) }));
jest.mock('../src/commands/toggles', () => ({ registerToggles: (...args: any[]) => mockRegisterToggles(...args) }));
jest.mock('../src/commands/selectionCommands', () => ({ registerSelectionCommands: (...args: any[]) => mockRegisterSelectionCommands(...args) }));
jest.mock('../src/commands/refreshTree', () => ({ registerRefreshTree: (...args: any[]) => mockRegisterRefreshTree(...args) }));
jest.mock('../src/commands/ingestRemoteRepo', () => ({ registerIngestRemoteRepo: (...args: any[]) => mockRegisterIngestRemoteRepo(...args) }));
jest.mock('../src/commands/viewMetrics', () => ({ viewMetricsCommand: (...args: any[]) => mockViewMetrics(...args) }));

import { registerFolderCommands } from '../src/commands/index';
import { CodebaseDigestTreeProvider } from '../src/providers/treeDataProvider';
import { WorkspaceManager } from '../src/services/workspaceManager';

// Minimal fake tree provider to pass into the registrar
class FakeTreeProvider implements Partial<CodebaseDigestTreeProvider> {
  // implement nothing; registrar should call the registration functions with this provider
}

describe('registerFolderCommands', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('calls per-folder registration helpers', () => {
    const context: any = { subscriptions: [] };
    const treeProvider: any = new FakeTreeProvider();
    const workspaceManager: any = new WorkspaceManager([] as any);

    registerFolderCommands(context, treeProvider as any, workspaceManager, [] as any);

    // Expect mocked registration functions to have been called with provided args
    expect(mockRegisterToggles).toHaveBeenCalledWith(context, treeProvider);
    expect(mockRegisterCommands).toHaveBeenCalledWith(context, treeProvider, { workspaceManager });
    expect(mockRegisterSelectionCommands).toHaveBeenCalledWith(context, treeProvider);
    expect(mockRegisterRefreshTree).toHaveBeenCalledWith(context, treeProvider);
  });
});

// Tests for commands/index.ts registrar

jest.mock('../commands/generateDigest', () => ({ registerCommands: jest.fn() }));
jest.mock('../commands/toggles', () => ({ registerToggles: jest.fn() }));
jest.mock('../commands/selectionCommands', () => ({ registerSelectionCommands: jest.fn() }));
jest.mock('../commands/refreshTree', () => ({ registerRefreshTree: jest.fn() }));
jest.mock('../commands/ingestRemoteRepo', () => ({ registerIngestRemoteRepo: jest.fn() }));

import * as vscode from 'vscode';
import { registerFolderCommands, registerAllCommands } from '../commands/index';
import { WorkspaceManager } from '../services/workspaceManager';

const { registerCommands } = require('../commands/generateDigest');
const { registerToggles } = require('../commands/toggles');
const { registerSelectionCommands } = require('../commands/selectionCommands');
const { registerRefreshTree } = require('../commands/refreshTree');
const { registerIngestRemoteRepo } = require('../commands/ingestRemoteRepo');

class FakeTreeProvider {}

describe('commands/index registrar', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('registerFolderCommands calls per-folder helpers', () => {
    const context: any = { subscriptions: [] };
    const tp = new FakeTreeProvider();
    const wm = new WorkspaceManager([] as any);

    registerFolderCommands(context, tp as any, wm, [] as any);

    expect(registerToggles).toHaveBeenCalledWith(context, tp);
    expect(registerCommands).toHaveBeenCalledWith(context, tp, { workspaceManager: wm });
    expect(registerSelectionCommands).toHaveBeenCalledWith(context, tp);
    expect(registerRefreshTree).toHaveBeenCalledWith(context, tp);
  });

  it('registerAllCommands invokes global registrations', () => {
    const context: any = { subscriptions: [] };
    const treeProviders = new Map<string, any>();
    const wm = new WorkspaceManager([] as any);

    // Create a fake provider and add to map
    const tp = new FakeTreeProvider();
    treeProviders.set('/some/path', tp as any);

    registerAllCommands(context, treeProviders, wm, [] as any);

    // registerIngestRemoteRepo should have been called (global registration)
    expect(registerIngestRemoteRepo).toHaveBeenCalledWith(context);
    // and per-folder helper should run for our provider (registerToggles called)
    expect(registerToggles).toHaveBeenCalled();
  });
});

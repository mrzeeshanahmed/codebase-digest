jest.mock('vscode', () => ({
    window: {
        createOutputChannel: jest.fn(() => ({
            appendLine: jest.fn(),
            show: jest.fn(),
            hide: jest.fn(),
            dispose: jest.fn(),
        })),
    },
    // Provide a workspace mock with folders and createFileSystemWatcher
    workspace: {
        workspaceFolders: [{ name: 'mock', uri: { fsPath: '/mock' } }],
        createFileSystemWatcher: jest.fn(() => ({
            onDidCreate: jest.fn(),
            onDidChange: jest.fn(),
            onDidDelete: jest.fn(),
            dispose: jest.fn()
        })),
        getConfiguration: jest.fn(() => ({ get: (k: string, d: any) => d }))
    },
    commands: {},
    TreeItem: class {
        [k: string]: any;
        constructor(label: any, collapsibleState?: any) {
            (this as any).label = label;
            (this as any).collapsibleState = collapsibleState;
        }
    },
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    Uri: {
        file: (p: string) => ({ fsPath: p })
    },
    ThemeIcon: class {
        constructor(_name: string) { }
    },
    EventEmitter: class {
        event = jest.fn();
        fire = jest.fn();
        dispose = jest.fn();
        constructor() {}
    },
}));

import { CodebaseDigestTreeProvider } from '../providers/treeDataProvider';

describe('treeDataProvider hierarchy and expand/collapse', () => {
    let treeProvider: any;

    beforeEach(() => {
        const mockFolder = { name: 'mock', uri: { fsPath: '/mock' } } as any;
        const mockServices = {} as any;
        treeProvider = new CodebaseDigestTreeProvider(mockFolder, mockServices);
    });

    it('returns hydrated children immediately and toggles expand state', async () => {
        // Create a hierarchical rootNodes with a directory that already has children
        const childFile = { type: 'file', name: 'a.txt', relPath: 'src/a.txt', path: '/mock/src/a.txt', size: 10, isSelected: false } as any;
        const dirNode = { type: 'directory', name: 'src', relPath: 'src', path: '/mock/src', depth: 0, children: [childFile], isSelected: false } as any;
        treeProvider.rootNodes = [dirNode];

        // getChildren(undefined) should return root nodes (hydrated)
        const roots = await treeProvider.getChildren(undefined as any);
        expect(Array.isArray(roots)).toBe(true);
        expect(roots.length).toBe(1);

        // getChildren(dirNode) should return the existing children (no loading placeholder)
        const children = await treeProvider.getChildren(dirNode);
        expect(Array.isArray(children)).toBe(true);
        expect(children.length).toBe(1);
        expect(children[0].name).toBe('a.txt');

        // Initially collapsed
        const treeItemBefore = treeProvider.getTreeItem(dirNode);
        expect(treeItemBefore.collapsibleState).toBe(1); // Collapsed

        // Toggle expand and ensure tree item reports expanded
        treeProvider.toggleExpand(dirNode.relPath);
        const treeItemAfter = treeProvider.getTreeItem(dirNode);
        expect(treeItemAfter.collapsibleState).toBe(2); // Expanded
    });

    it('renders virtual group badges correctly', () => {
        // Virtual group node should show count and formatted size in description
        const groupNode = {
            type: 'directory',
            name: 'GroupX',
            relPath: 'virtual:GroupX',
            path: '',
            depth: 0,
            children: [],
            virtualType: 'virtualGroup',
            childCount: 3,
            totalSize: 0
        } as any;
    const treeItem = treeProvider.getTreeItem(groupNode);
    expect(treeItem.description).toMatch(/3 files/);
    // Note: getTreeItem sets contextValue to element.type later, so expect 'directory'
    expect(treeItem.contextValue).toBe('directory');
    });
});

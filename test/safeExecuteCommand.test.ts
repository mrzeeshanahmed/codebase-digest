import { safeExecuteCommand, safeExecuteCommandOrThrow } from '../src/utils/safeExecuteCommand';

// Jest will automatically hoist jest.mock calls; we need to mock vscode
jest.mock('vscode', () => ({
    commands: {
        executeCommand: jest.fn(),
    },
    window: {
        showErrorMessage: jest.fn(),
        createOutputChannel: jest.fn(() => ({ appendLine: jest.fn(), dispose: jest.fn() })),
    }
}));

const vscode = require('vscode');

describe('safeExecuteCommand', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });
    it('returns the result when command resolves', async () => {
        (vscode.commands.executeCommand as jest.Mock).mockResolvedValue('ok');
        const res = await safeExecuteCommand('some.command', 1, 2);
        expect(res).toBe('ok');
        expect(vscode.commands.executeCommand).toHaveBeenCalledWith('some.command', 1, 2);
    });
    it('shows error message and returns undefined on rejection', async () => {
        (vscode.commands.executeCommand as jest.Mock).mockRejectedValue(new Error('boom'));
        const res = await safeExecuteCommand('some.command');
        expect(res).toBeUndefined();
        expect(vscode.window.showErrorMessage).toHaveBeenCalled();
    });
});

describe('safeExecuteCommandOrThrow', () => {
    beforeEach(() => jest.clearAllMocks());
    it('returns result on success', async () => {
        (vscode.commands.executeCommand as jest.Mock).mockResolvedValue(123);
        const r = await safeExecuteCommandOrThrow('a');
        expect(r).toBe(123);
    });
    it('throws on failure after showing error message', async () => {
        (vscode.commands.executeCommand as jest.Mock).mockRejectedValue(new Error('fail'));
        await expect(safeExecuteCommandOrThrow('b')).rejects.toThrow('fail');
        expect(vscode.window.showErrorMessage).toHaveBeenCalled();
    });
});

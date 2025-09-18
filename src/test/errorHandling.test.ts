import * as path from 'path';
import * as vscode from 'vscode';

jest.mock('vscode');

describe('error handling', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  test('handler error is reported via handleError and does not propagate', async () => {
    const errHandler = require('../utils/errorHandler');
    const spy = jest.spyOn(errHandler, 'handleError').mockImplementation(async () => {});

    // Simulate a handler wrapper that catches and reports errors
    const handler = async () => {
      throw new Error('simulated handler failure');
    };

    // Wrapper that should call handleError and swallow
    const wrapper = async () => {
      try {
        await handler();
      } catch (e) {
        await errHandler.handleError(e, 'handler failed', { showUser: false });
      }
    };

    // Should not throw
    await expect(wrapper()).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalledTimes(1);
    const call = spy.mock.calls[0];
    expect(call[1]).toBe('handler failed');
  });

  test('generateDigest reports generation errors via handleError', async () => {
    // Import generateDigest and stub the DigestGenerator to throw
    const errHandler = require('../utils/errorHandler');
    const spy = jest.spyOn(errHandler, 'handleError').mockImplementation(async () => {});

    // Create a fake workspace folder
    const wf: any = { uri: { fsPath: path.resolve(__dirname, '..') } };

    // Create a fake workspaceManager whose getBundleForFolder returns services
    const fakeServices = {
      diagnostics: {
        error: jest.fn(),
        warn: jest.fn(),
      },
      cacheService: undefined,
      contentProcessor: {
        scanDirectory: jest.fn().mockResolvedValue([]),
      },
      tokenAnalyzer: {
        warnIfExceedsLimit: jest.fn(),
      }
    };

    const workspaceManager = {
      getBundleForFolder: jest.fn().mockReturnValue(fakeServices)
    };

    // Now mock the DigestGenerator to throw when generate is called
    const DigestGenerator = jest.requireActual('../services/digestGenerator').DigestGenerator;
    const MockedDigestGenerator = jest.fn().mockImplementation(() => ({
      generate: async () => { throw new Error('generation failed'); }
    }));

    jest.doMock('../services/digestGenerator', () => ({ DigestGenerator: MockedDigestGenerator }));

  // Import after mocking (synchronously to work in Jest environment)
  const { generateDigest } = require('../providers/digestProvider');

    // Call generateDigest and ensure it resolves (does not throw) and handleError was called
    await expect(generateDigest(wf, workspaceManager as any)).resolves.toBeUndefined();
  expect(spy).toHaveBeenCalled();
  // One of the calls should include a generation-related context string
  const contexts = spy.mock.calls.map(c => String(c[1] || ''));
  const matched = contexts.some(c => /digest generation|generation failed|digest generation failed|generate/i.test(c));
  expect(matched).toBe(true);
  });
});

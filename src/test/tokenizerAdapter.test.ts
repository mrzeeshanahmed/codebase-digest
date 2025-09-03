import { describe, it, expect } from '@jest/globals';
import { TokenAnalyzer } from '../services/tokenAnalyzer';
import { registerTokenizer, getTokenizer } from '../plugins/index';

describe('Tokenizer Adapter', () => {
  beforeEach(() => {
    // Reset the tokenizer registry before each test
    const pluginsIndex = require('../plugins/index');
    try {
      if (Array.isArray(pluginsIndex.tokenizers)) {
        // Clear in-place to preserve module reference
        pluginsIndex.tokenizers.length = 0;
      }
    } catch (e) {}
  });
  it('uses tiktoken adapter when present', () => {
    // Register a mock tiktoken adapter
    registerTokenizer('tiktoken', (content, cfg) => 42);
    const analyzer = new TokenAnalyzer();
    const result = analyzer.estimate('hello world', 'tiktoken');
    expect(result).toBe(42);
  });

  it('falls back to chars-approx when adapter missing', () => {
    // Ensure getTokenizer returns undefined so TokenAnalyzer falls back
    jest.resetModules();
    jest.mock('../plugins/index', () => ({
      getTokenizer: (name: string) => undefined,
      registerTokenizer: () => {}
    }), { virtual: true });
    const analyzer = new TokenAnalyzer();
    const result = analyzer.estimate('hello world', 'tiktoken');
    // chars-approx divisor is 4
    expect(result).toBe(Math.ceil('hello world'.length / 4));
  });
});

import { CacheService } from '../services/cacheService';
import { DigestConfig } from '../types/interfaces';

describe('CacheService.computeKey', () => {
  const baseConfig: DigestConfig = {
    include: ['src/**'],
    exclude: ['test/**'],
    outputSeparatorsHeader: '---',
    outputFormat: 'markdown',
    filterPresets: ['codeOnly'],
    token: {
      model: 'default',
      divisorOverrides: {},
      limit: 0,
    },
  } as any;

  const cacheService = new CacheService();

  it('produces stable keys for property reordering', () => {
    const paramsA = {
      sourceType: 'local' as const,
      includePatterns: ['src/**'],
      excludePatterns: ['test/**'],
      outputSeparatorsHeader: '---',
      outputFormat: 'markdown',
      filterPresets: ['codeOnly'],
    };
    const paramsB = {
      sourceType: 'local' as const,
      excludePatterns: ['test/**'],
      includePatterns: ['src/**'],
      outputSeparatorsHeader: '---',
      outputFormat: 'markdown',
      filterPresets: ['codeOnly'],
    };
    const keyA = cacheService.computeKey(paramsA as any);
    const keyB = cacheService.computeKey(paramsB as any);
    expect(keyA).toBe(keyB);
  });

  it('produces different keys for different include/exclude arrays', () => {
    const paramsA = {
      sourceType: 'local' as const,
      includePatterns: ['src/**'],
      excludePatterns: ['test/**'],
      outputSeparatorsHeader: '---',
      outputFormat: 'markdown',
      filterPresets: ['codeOnly'],
    };
    const paramsB = {
      sourceType: 'local' as const,
      includePatterns: ['src/**', 'lib/**'],
      excludePatterns: ['test/**'],
      outputSeparatorsHeader: '---',
      outputFormat: 'markdown',
      filterPresets: ['codeOnly'],
    };
    const keyA = cacheService.computeKey(paramsA as any);
    const keyB = cacheService.computeKey(paramsB as any);
    expect(keyA).not.toBe(keyB);
  });

  it('produces different keys for different outputSeparatorsHeader', () => {
    const paramsA = {
      sourceType: 'local' as const,
      includePatterns: ['src/**'],
      excludePatterns: ['test/**'],
      outputSeparatorsHeader: '---',
      outputFormat: 'markdown',
      filterPresets: ['codeOnly'],
    };
    const paramsB = {
      sourceType: 'local' as const,
      includePatterns: ['src/**'],
      excludePatterns: ['test/**'],
      outputSeparatorsHeader: '###',
      outputFormat: 'markdown',
      filterPresets: ['codeOnly'],
    };
    const keyA = cacheService.computeKey(paramsA as any);
    const keyB = cacheService.computeKey(paramsB as any);
    expect(keyA).not.toBe(keyB);
  });

  it('produces stable keys for deeply nested config property reordering', () => {
    const paramsA = {
      sourceType: 'local' as const,
      includePatterns: ['src/**'],
      excludePatterns: ['test/**'],
      outputSeparatorsHeader: '---',
      outputFormat: 'markdown',
      filterPresets: ['codeOnly'],
      token: { model: 'default', divisorOverrides: { js: 4, py: 2 }, limit: 0 },
    };
    const paramsB = {
      sourceType: 'local' as const,
      includePatterns: ['src/**'],
      excludePatterns: ['test/**'],
      outputSeparatorsHeader: '---',
      outputFormat: 'markdown',
      filterPresets: ['codeOnly'],
      token: { divisorOverrides: { py: 2, js: 4 }, model: 'default', limit: 0 },
    };
    const keyA = cacheService.computeKey(paramsA as any);
    const keyB = cacheService.computeKey(paramsB as any);
    expect(keyA).toBe(keyB);
  });
});

import { describe, it, expect } from '@jest/globals';
import { GitignoreService } from '../services/gitignoreService';

describe('GitignoreService - anchored and negation', () => {
  beforeEach(() => {
    GitignoreService.prototype.clear();
  });

  it('should ignore anchored patterns', () => {
    const svc = new GitignoreService();
    svc.addIgnoreFile(process.cwd(), ['/build']);
    expect(svc.isIgnored('build/file.js')).toBe(true);
    expect(svc.isIgnored('src/build/file.js')).toBe(false);
  });

  it('should unignore with negation', () => {
    const svc = new GitignoreService();
    svc.addIgnoreFile(process.cwd(), ['build/', '!build/keep.js']);
    expect(svc.isIgnored('build/skip.js')).toBe(true);
    expect(svc.isIgnored('build/keep.js')).toBe(false);
  });

  it('should only match directories for trailing slash', () => {
    const svc = new GitignoreService();
    svc.addIgnoreFile(process.cwd(), ['dist/']);
    expect(svc.isIgnored('dist/')).toBe(true);
    expect(svc.isIgnored('dist/file.js')).toBe(true);
    expect(svc.isIgnored('src/dist/file.js')).toBe(false);
  });
});

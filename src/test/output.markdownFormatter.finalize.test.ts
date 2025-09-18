import { MarkdownFormatter } from '../format/output/markdownFormatter';

describe('MarkdownFormatter.finalize', () => {
  it('joins chunks with the configured separator (strict equality)', () => {
    const fmt = new MarkdownFormatter();
    const cfg: any = { outputSeparatorsHeader: '\n---\n' };
    const chunks = ['alpha', 'beta'];
    const result = fmt.finalize(chunks as any, cfg);
    expect(result).toBe(chunks.join(cfg.outputSeparatorsHeader));
  });
});

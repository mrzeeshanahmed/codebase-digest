import { TextFormatter } from '../format/output/textFormatter';

describe('TextFormatter.finalize', () => {
  it('joins chunks with the configured separator (strict equality)', () => {
    const fmt = new TextFormatter();
    const cfg: any = { outputSeparatorsHeader: '\n---\n' };
    const chunks = ['one', 'two', 'three'];
    const result = fmt.finalize(chunks as any, cfg);
    expect(result).toBe(chunks.join(cfg.outputSeparatorsHeader));
  });
});

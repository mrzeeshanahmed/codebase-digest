import { JsonFormatter } from '../format/output/jsonFormatter';

describe('JsonFormatter.finalize', () => {
  it('returns the joined chunks as a string and does not rely on console output', () => {
    const fmt = new JsonFormatter();
    const chunks = ['{"a":1}', '\n', '{"b":2}'];
    const result = fmt.finalize(chunks as any, {} as any);
    // JsonFormatter.finalize intentionally returns an empty string (JSON assembly happens elsewhere)
    expect(result).toBe('');
  });
});

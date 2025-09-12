import { redactSecrets } from '../utils/redactSecrets';

describe('redactSecrets', () => {
    it('returns original when input is not a string', () => {
        // @ts-ignore intentionally pass non-string
        const res = redactSecrets(null as any, {});
        expect(res.applied).toBe(false);
        expect(typeof res.content).toBe('string');
    });

    it('applies the custom placeholder when a secret-like pattern is present', () => {
        const input = 'key = abcdef1234567890';
        const res = redactSecrets(input, { redactionPlaceholder: '<REDACTED>' } as any);
        // Expect redaction to have been applied and content to contain the placeholder
        expect(res.applied).toBe(true);
        expect(res.content.includes('<REDACTED>')).toBe(true);
    });

    it('does not apply redaction when input contains no secret-like patterns', () => {
        const input = 'no secrets here';
        const res = redactSecrets(input, { redactionPlaceholder: '<REDACTED>' } as any);
        // Expect no redaction to be applied and content to remain free of the placeholder
        expect(res.applied).toBe(false);
        expect(res.content.includes('<REDACTED>')).toBe(false);
    });
});

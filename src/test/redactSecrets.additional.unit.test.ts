import { redactSecrets } from '../utils/redactSecrets';

describe('redactSecrets additional cases', () => {
    it('redacts AWS access key pattern', () => {
        const aws = 'my aws key AKIAABCDEFGHIJKLMNOP';
        const res = redactSecrets(aws, { redactionPlaceholder: '[REDACTED]' } as any);
        expect(res.applied).toBe(true);
        expect(res.content).toContain('[REDACTED]');
        expect(res.content).not.toContain('AKIAABCDEFGHIJKLMNOP');
    });

    it('redacts JWT tokens', () => {
        const jwt = 'auth: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.header.payload';
        const res = redactSecrets(jwt, {} as any);
        expect(res.applied).toBe(true);
        expect(res.content).toContain('[REDACTED]');
        expect(res.content).not.toContain('eyJhbGci');
    });

    it('redacts high-entropy string when context keyword present', () => {
        const secretVal = 'a'.repeat(25) + 'B1C2D3E4F5G6H7I8J9K0';
        const input = `token: ${secretVal}`;
        const res = redactSecrets(input, { redactionPlaceholder: '<REDACTED>' } as any);
        expect(res.applied).toBe(true);
        expect(res.content).toContain('<REDACTED>');
        expect(res.content).not.toContain(secretVal);
    });
});

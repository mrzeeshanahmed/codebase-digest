/**
 * Simple redaction helpers for logs and user-facing messages.
 * Keep patterns conservative to avoid over-redaction in tests.
 */
export function scrubTokens(input: string): string {
    if (!input || typeof input !== 'string') { return input; }
    let out = input;
    // Redact credential-in-URL patterns: https://<creds>@...
    out = out.replace(/https?:\/\/(?:[^@\s]+)@/gi, (m) => {
        return m.replace(/https?:\/\//i, 'https://[REDACTED]@');
    });
    // Redact Authorization: Bearer tokens
    out = out.replace(/Bearer\s+[A-Za-z0-9\._\-]+/gi, 'Bearer [REDACTED]');
    // Redact common GitHub token prefixes (ghp_, gho_, ghf_, gha_, ghs_)
    out = out.replace(/gh[pousr]_[A-Za-z0-9_\-]{36,}/g, '[REDACTED_GITHUB_TOKEN]');
    // Redact long-looking alphanumeric secrets when they appear after token= or access_token=
    out = out.replace(/(access_token|token)=([A-Za-z0-9_\-\.]{20,})/gi, (m, p1, p2) => `${p1}=[REDACTED]`);
    return out;
}

export default { scrubTokens };

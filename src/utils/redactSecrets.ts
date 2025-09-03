/**
 * redactSecrets - simple configurable redaction utility
 * Accepts a string and a config object. Config may contain:
 * - redactionPatterns: string[] (regex strings)
 * - redactionPlaceholder: string (default: '[REDACTED]')
 * - showRedacted: boolean (if true, do not redact)
 * Returns { content: string, applied: boolean }
 */
export function redactSecrets(input: string, config?: any): { content: string; applied: boolean } {
    if (!input || typeof input !== 'string') {
        return { content: input, applied: false } as any;
    }
    const showRedacted = config && config.showRedacted;
    if (showRedacted) {
        return { content: input, applied: false };
    }
    const defaultPatterns = [
        // JWT-like
        "[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+",
        // Common API key assignment
        "(?:(?:api[_-]?key|apikey|apiKey|authorization|auth_token|token|access_token|secret)[:=]\\s*['\"]?[A-Za-z0-9-_\\.]{8,256}['\"]?)",
        // AWS access key
        "AKIA[0-9A-Z]{16}",
        // Generic long hex/string secrets
        "(?:(?:secret|password|passwd|pw)[:=]\\s*['\"]?[A-Za-z0-9\\/+=_-]{8,256}['\"]?)"
    ];
    const patterns = Array.isArray(config && config.redactionPatterns) && config.redactionPatterns.length > 0
        ? config.redactionPatterns
        : defaultPatterns;
    const placeholder = (config && config.redactionPlaceholder) || '[REDACTED]';

    let out = input;
    let applied = false;
    for (const p of patterns) {
        try {
            // allow patterns provided as "/.../flags" or plain regex body
            let re: RegExp;
            if (typeof p !== 'string') { continue; }
            const m = p.match(/^\/(.*)\/(\w*)$/);
            if (m) {
                re = new RegExp(m[1], (m[2] || '') + 'g');
            } else {
                re = new RegExp(p, 'g');
            }
            if (re.test(out)) {
                applied = true;
                out = out.replace(re, placeholder);
            }
        } catch (e) {
            // ignore invalid patterns
            // continue to next
        }
    }
    return { content: out, applied };
}

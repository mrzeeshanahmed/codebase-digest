/**
 * redactSecrets - simple configurable redaction utility
 * Accepts a string and a config object. Config may contain:
 */
import { validateConfig } from '../utils/validateConfig';
import { DigestConfig } from '../types/interfaces';

/**
 * A structured rule for finding and redacting a secret.
 */
interface RedactionRule {
    /** A human-readable name for the rule (e.g., "AWS Access Key"). */
    name: string;
    /** The regular expression to find potential secrets. Must be global. */
    pattern: RegExp;
    /** Optional: Only redact if one of these keywords is on the same line. */
    context?: string[];
    /** Optional: Redact only a specific capture group from the pattern. Group 0 is the full match. */
    redactGroup?: number;
    /** Optional: Perform an entropy check on the matched string or group. */
    checkEntropy?: boolean;
}

/**
 * Calculates the Shannon entropy of a string. Higher values indicate more randomness.
 * A good threshold for secrets is typically around 3.5 or 4.0.
 * @param str The string to analyze.
 * @returns The entropy value.
 */
function calculateEntropy(str: string): number {
    if (!str) { return 0; }
    const charCounts: { [key: string]: number } = {};
    for (const char of str) {
        charCounts[char] = (charCounts[char] || 0) + 1;
    }
    let entropy = 0;
    const len = str.length;
    for (const char in charCounts) {
        const p = charCounts[char] / len;
        entropy -= p * Math.log2(p);
    }
    return entropy;
}

// A curated list of high-confidence, specific patterns for common secrets.
const defaultRules: RedactionRule[] = [
    {
        name: 'AWS Access Key',
        pattern: /(AKIA[0-9A-Z]{16})/g,
    },
    {
        name: 'JSON Web Token (JWT)',
        pattern: /(eyJ[A-Za-z0-9-_=]+\.[A-Za-z0-9-_=]+\.[A-Za-z0-9-_.+/=]+)/g,
    },
    {
        name: 'Generic API Key',
        // Matches common key assignments like API_KEY = "value"
        pattern: /(key|token|secret|password|passwd|pw)\s*[:=]\s*['"]?([A-Za-z0-9\/\+=_-]{16,})['"]?/gi,
        redactGroup: 2, // Only redact the key's value
    },
    {
        name: 'High Entropy String',
        // Matches long, random-looking strings but ONLY if context keywords are present
        pattern: /(['"]?([A-Za-z0-9\/\+=_-]{20,})['"]?)/g,
        redactGroup: 2,
        checkEntropy: true,
        context: ['secret', 'token', 'key', 'auth', 'bearer', 'password', 'apikey'],
    },
];

/**
 * Redacts secrets from a string using a context-aware, rule-based system.
 *
 * @param input The string to redact secrets from.
 * @param config Configuration object, may contain `redactionPatterns`, `redactionPlaceholder`, and `showRedacted`.
 * @returns An object containing the redacted content and a boolean indicating if redaction was applied.
 */
export function redactSecrets(
    input: string,
    config?: Partial<DigestConfig>
): { content: string; applied: boolean } {
    if (input === null || input === undefined || typeof input !== 'string') {
        return { content: String(input ?? ''), applied: false };
    }
    if (config?.showRedacted) {
    return { content: input, applied: false };
    }

    // Merge user-provided patterns (if any) before the default rules so user intent is prioritized.
    // Normalize legacy alias: allow 'redactionPlaceholder' or 'redactionPlaceholder' only.
    const placeholder = (typeof config?.redactionPlaceholder === 'string' && config!.redactionPlaceholder) ? config!.redactionPlaceholder : '[REDACTED]';

    const userPatterns = Array.isArray(config?.redactionPatterns) ? config!.redactionPatterns : [] as any[];

    // Helper to escape literal strings for RegExp
    const escapeForRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    const compiledUserRules: RedactionRule[] = [];
    for (const raw of userPatterns) {
        if (!raw || typeof raw !== 'string') { continue; }
        const trimmed = raw.trim();
        if (!trimmed) { continue; }
        try {
            let re: RegExp | null = null;
            // If user provided a /pattern/flags form, extract body and flags
            const m = trimmed.match(/^\/(.*)\/(g?i?m?s?u?y?)$/);
            if (m) {
                const body = m[1];
                let flags = m[2] || '';
                if (!flags.includes('g')) { flags += 'g'; }
                re = new RegExp(body, flags);
            } else {
                // Heuristic: if the string contains regex special characters, treat it as a pattern
                // Allow common constructs like [], (), +, ?, ^, $ and |
                if (/[.\\^$*+?()[\]{}|]/.test(trimmed)) {
                    // compile as provided, ensure global
                    re = new RegExp(trimmed, 'g');
                } else {
                    // treat as literal
                    re = new RegExp(escapeForRegExp(trimmed), 'g');
                }
            }
            if (re) {
                // Ensure global flag so replace semantics work predictably
                const flags = re.flags && re.flags.includes('g') ? re.flags : (re.flags + 'g').replace(/[^gimsyu]/g, '');
                const safeRe = new RegExp(re.source, flags);
                compiledUserRules.push({ name: 'User pattern', pattern: safeRe });
                // If the user likely intended \w or \d but wrote w+/d+ (backslash lost), also add an alternate
                try {
                    let alt = trimmed;
                    if (alt.indexOf('\\w') === -1 && /w\+/.test(alt)) {
                        alt = alt.replace(/w\+/g, '[A-Za-z0-9_]+');
                    }
                    if (alt.indexOf('\\d') === -1 && /d\+/.test(alt)) {
                        alt = alt.replace(/d\+/g, '[0-9]+');
                    }
                    if (alt !== trimmed) {
                        try {
                            const altRe = new RegExp(alt, 'g');
                            compiledUserRules.push({ name: 'User pattern (alt)', pattern: altRe });
                        } catch (e) {
                            // ignore alternate compile errors
                        }
                    }
                } catch (e) {
                    // ignore alternate compile errors
                }
            }
        } catch (e) {
            // On invalid regex, skip the pattern but don't throw
            continue;
        }
    }

    const rules = [...compiledUserRules, ...defaultRules];
    const entropyThreshold = 3.5;

    let out = input;
    let applied = false;
    let lines = out.split('\n');

    for (const rule of rules) {
        const newLines: string[] = [];
        for (const line of lines) {
            let modifiedLine = line;
            const matches = Array.from(line.matchAll(rule.pattern));

            if (matches.length === 0) {
                newLines.push(line);
                continue;
            }

            // Check context if required by the rule
            if (rule.context && !rule.context.some(keyword => line.toLowerCase().includes(keyword))) {
                newLines.push(line);
                continue;
            }

            for (const match of matches) {
                const groupIndex = rule.redactGroup ?? 0;
                const target = match[groupIndex];

                if (!target) { continue; }

                // Perform entropy check if required
                if (rule.checkEntropy && calculateEntropy(target) < entropyThreshold) {
                    continue;
                }
        
                // Avoid redacting parts of file paths or common non-secrets
                if (target.includes('/') || target.includes('\\') || target.toLowerCase() === 'true' || target.toLowerCase() === 'false') {
                    continue;
                }

                // Replace the target in the line
                // We do this carefully to handle multiple matches in a single line
                if (modifiedLine.includes(target)) {
                    // Use a safely-escaped RegExp replace instead of string.replaceAll
                    const esc = escapeForRegExp(target);
                    modifiedLine = modifiedLine.replace(new RegExp(esc, 'g'), placeholder);
                    applied = true;
                }
            }
            newLines.push(modifiedLine);
        }
        // Update the lines for the next rule so replacements accumulate
        out = newLines.join('\n');
        lines = out.split('\n');
    }

    return { content: out, applied };
}

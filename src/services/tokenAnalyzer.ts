// TokenAnalyzer: Pluggable estimators, baseline character-based
export class TokenAnalyzer {
    /**
     * Alias for test compatibility: formatTokenCount
     */
    static formatTokenCount(n: number): string {
        return TokenAnalyzer.prototype.formatEstimate.call(TokenAnalyzer.prototype, n);
    }
    private static defaultDivisors: Record<string, number> = {
        'chars-approx': 4,
    'gpt-4o': 4,
    'gpt-3.5': 4,
        'gpt-4o-mini': 4,
        'claude-3.5': 4,
        'o200k': 4
    };

    /**
     * Estimate token count for given content and model, with optional divisor overrides.
     */
    estimate(content: string, model: string, divisorOverrides?: Record<string, number>): number {
        if (!content) { return 0; }
        // Use plugin if model is 'tiktoken' and plugin is available
        if (model === 'tiktoken') {
            try {
                // Prefer a synchronous require so callers that run in hot paths
                // don't need to await an init promise. If optional adapter isn't
                // present it'll throw and be ignored.
                const plugins = require('../plugins/index');
                if (plugins && typeof plugins.getTokenizer === 'function') {
                    const tokenizer = plugins.getTokenizer('tiktoken');
                    if (typeof tokenizer === 'function') { return tokenizer(content, {}); }
                }
            } catch {}
        }
        const divisors = { ...TokenAnalyzer.defaultDivisors, ...(divisorOverrides || {}) };
        const divisor = divisors[model] || divisors['chars-approx'] || 4;

        // Support comment weighting via a special override key 'commentWeight'
        // If provided, attempt to heuristically split comments from code and weight comment length accordingly.
        const commentWeight = typeof (divisorOverrides && (divisorOverrides as any).commentWeight) === 'number'
            ? (divisorOverrides as any).commentWeight
            : 1;

        let effectiveLength = content.length;
        if (commentWeight !== 1) {
            try {
                // Simple heuristics for common comment styles: // single-line, /* */ block, # line
                // Extract block comments
                let commentsLen = 0;
                const blockRe = /\/\*[\s\S]*?\*\//g;
                let m: RegExpExecArray | null;
                while ((m = blockRe.exec(content)) !== null) {
                    commentsLen += m[0].length;
                }
                // Extract // line comments
                const lineRe = /(^|[^:]|^)\/\/.*$/gm; // naive
                while ((m = lineRe.exec(content)) !== null) {
                    commentsLen += m[0].replace(/^([^\/]*)\//, '/').length; // approximate
                }
                // Extract # comments (python/shell)
                const hashRe = /(^|\n)\s*#.*$/gm;
                while ((m = hashRe.exec(content)) !== null) {
                    commentsLen += m[0].length - (m[1] ? m[1].length : 0);
                }
                // Bound commentsLen
                if (commentsLen < 0) { commentsLen = 0; }
                if (commentsLen > content.length) { commentsLen = content.length; }
                const nonCommentLen = content.length - commentsLen;
                effectiveLength = nonCommentLen + commentWeight * commentsLen;
            } catch (e) {
                effectiveLength = content.length;
            }
        }

        return Math.ceil(effectiveLength / divisor);
    }

    /**
     * Format token estimate with k/M suffixes.
     */
    formatEstimate(n: number): string {
    if (n < 1000) { return n.toString(); }
    if (n < 1000000) { return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k'; }
    return (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
    }

    /**
     * Warn if estimate exceeds limit; returns warning message or null.
     */
    warnIfExceedsLimit(estimate: number, limit?: number): string | null {
        if (limit && estimate > limit) {
            return `Warning: token estimate ${this.formatEstimate(estimate)} exceeds context limit (${this.formatEstimate(limit)}).`;
        }
        return null;
    }
}

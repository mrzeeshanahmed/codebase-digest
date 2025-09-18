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
        'gpt-4o-mini-8k': 4,
        'gpt-4o-mini-16k': 4,
        'claude-3.5': 4,
        'claude-2.1': 4,
        'claude-2': 4,
        'o200k': 4,
        'o1': 4,
        'o2': 4
    };

    /**
     * Estimate token count for given content and model, with optional divisor overrides.
     */
    estimate(content: string, model: string, divisorOverrides?: Record<string, number>): number {
        if (!content) { return 0; }

        if (model === 'tiktoken') {
            const tiktokenEstimate = this._getTiktokenEstimate(content);
            if (tiktokenEstimate !== null) {
                return tiktokenEstimate;
            }
        }

        const divisor = this._getDivisor(model, divisorOverrides);
        const commentWeight = divisorOverrides?.['commentWeight'] ?? 1;

        const effectiveLength = commentWeight !== 1
            ? this._getCommentWeightedLength(content, commentWeight)
            : content.length;

        return Math.ceil(effectiveLength / divisor);
    }

    private _getTiktokenEstimate(content: string): number | null {
        try {
            const plugins = require('../plugins/index');
            if (plugins && typeof plugins.getTokenizer === 'function') {
                const tokenizer = plugins.getTokenizer('tiktoken');
                if (typeof tokenizer === 'function') {
                    return tokenizer(content, {});
                }
            }
        } catch {
            // tiktoken plugin not available
        }
        return null;
    }

    private _getDivisor(model: string, divisorOverrides?: Record<string, number>): number {
        const divisors = { ...TokenAnalyzer.defaultDivisors, ...(divisorOverrides || {}) };
        return divisors[model] || divisors['chars-approx'] || 4;
    }

    private _getCommentWeightedLength(content: string, commentWeight: number): number {
        try {
            let commentsLen = 0;
            const blockRe = /\/\*[\s\S]*?\*\//g;
            let m: RegExpExecArray | null;
            while ((m = blockRe.exec(content)) !== null) {
                commentsLen += m[0].length;
            }

            const lineRe = /(^|[^:]|^)\/\/.*$/gm;
            while ((m = lineRe.exec(content)) !== null) {
                commentsLen += m[0].replace(/^([^\/]*)\//, '/').length;
            }

            const hashRe = /(^|\n)\s*#.*$/gm;
            while ((m = hashRe.exec(content)) !== null) {
                commentsLen += m[0].length - (m[1] ? m[1].length : 0);
            }

            commentsLen = Math.max(0, Math.min(commentsLen, content.length));
            const nonCommentLen = content.length - commentsLen;
            return nonCommentLen + commentWeight * commentsLen;
        } catch (e) {
            return content.length;
        }
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

import { describe, it, expect } from '@jest/globals';
import { TokenAnalyzer } from '../services/tokenAnalyzer';

describe('TokenAnalyzer comment weighting', () => {
    it('weights comments lower when commentWeight < 1', () => {
        const analyzer = new TokenAnalyzer();
        const code = `// comment line 1\n// comment line 2\nconst a = 1;\nconst b = 2;\n`;
        const base = analyzer.estimate(code, 'chars-approx');
        const weighted = analyzer.estimate(code, 'chars-approx', { commentWeight: 0.75 });
        expect(weighted).toBeLessThanOrEqual(base);
    });

    it('weights comments higher when commentWeight > 1', () => {
        const analyzer = new TokenAnalyzer();
        const code = `/* big block comment */\nfunction x() { return 42; }\n`;
        const base = analyzer.estimate(code, 'chars-approx');
        const weighted = analyzer.estimate(code, 'chars-approx', { commentWeight: 1.5 });
        expect(weighted).toBeGreaterThanOrEqual(base);
    });
});

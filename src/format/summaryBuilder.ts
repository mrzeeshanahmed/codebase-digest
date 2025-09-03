import { DigestConfig, TraversalStats, FileNode } from '../types/interfaces';
import { Formatters } from '../utils/formatters';
import { getAnalyzer, listAnalyzers, AnalyzerResult } from '../plugins/index';

// Limit how many files we run analyzers on during summary generation to avoid heavy work
const ANALYZER_SAMPLE_LIMIT = 20;

export async function buildSummary(cfg: DigestConfig, stats: TraversalStats, files: FileNode[], tokenEstimate: number, warnings: string[]) {
    const formatters = new Formatters();
    let base = formatters.buildSummary(cfg, stats, files, tokenEstimate, '', '', warnings);

    // Optionally enrich the summary with analyzer findings if enabled
    if ((cfg as any).includeAnalysisSummary) {
        try {
            const langs = listAnalyzers();
            if (langs && langs.length > 0) {
                // Collect a small sample of candidate files (prefer JS/TS)
                const candidates = files.filter(f => ['.js', '.ts', '.jsx', '.tsx'].includes((f.name && f.name.split('.').pop() ? '.' + f.name.split('.').pop() : '').toLowerCase()));
                const sample = candidates.slice(0, ANALYZER_SAMPLE_LIMIT);
                const findings: string[] = [];
                for (const f of sample) {
                    const ext = '.' + (f.name.split('.').pop() || '');
                    const lang = ext.replace('.', '');
                    const analyzer = getAnalyzer(lang);
                    if (!analyzer) { continue; }
                    try {
                        // We don't pass file content here to keep cost low; analyzers may read content themselves if needed
                        const resAny = await analyzer(f.path, ext).catch(() => ({} as AnalyzerResult));
                        const res = resAny as AnalyzerResult;
                        if (res && typeof res.summary === 'string' && res.summary.length > 0) {
                            findings.push(`${f.relPath}: ${res.summary}`);
                        }
                    } catch (_) {
                        // ignore analyzer errors
                    }
                }
                if (findings.length > 0) {
                    base += '\n\nAnalyzer Summary:\n' + findings.slice(0, 50).join('\n');
                }
            }
        } catch (e) {
            // Non-fatal: if analyzers fail, return base summary
        }
    }

    return base;
}

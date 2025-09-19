import { DigestConfig, TraversalStats, FileNode } from '../types/interfaces';
import { Formatters } from '../utils/formatters';
import { getAnalyzer, listAnalyzers, AnalyzerResult } from '../plugins/index';
import { env, ExtensionMode } from 'vscode';
import { isRecord } from '../utils/typeGuards';

// Limit how many files we run analyzers on during summary generation to avoid heavy work
const ANALYZER_SAMPLE_LIMIT = 20;

export async function buildSummary(cfg: DigestConfig, stats: TraversalStats, files: FileNode[], tokenEstimate: number, warnings: string[]) {
    const formatters = new Formatters();
    let base = formatters.buildSummary(cfg, stats, files, tokenEstimate, '', '', warnings);

    // Optionally enrich the summary with analyzer findings if enabled
    if (isRecord(cfg) && (cfg as any).includeAnalysisSummary) {
        try {
            const langs = listAnalyzers();
            if (langs && langs.length > 0) {
                // Collect a small sample of candidate files driven by registered analyzers.
                // If analyzers are registered for languages other than JS/TS, include those
                // languages in the sampling instead of hardcoding a single set.
                const analyzerLangs = (langs || []).map((l: string) => String(l).toLowerCase());
                let candidates: FileNode[] = [];
                if (analyzerLangs.length > 0) {
                    candidates = files.filter(f => {
                        const ext = (f.name && f.name.split('.').pop() ? (f.name.split('.').pop() as string).toLowerCase() : '');
                        return analyzerLangs.includes(ext);
                    });
                } else {
                    // Backwards-compatible fallback: prefer JS/TS when no analyzers are registered
                    candidates = files.filter(f => ['js', 'ts', 'jsx', 'tsx'].includes((f.name && f.name.split('.').pop() ? (f.name.split('.').pop() as string).toLowerCase() : '')));
                }
                const sample = candidates.slice(0, ANALYZER_SAMPLE_LIMIT);
                const findings: string[] = [];
                const MAX_FINDING_LEN = 200; // cap per-file summary length to avoid bloating headers
                for (const f of sample) {
                    const ext = '.' + (f.name.split('.').pop() || '');
                    const lang = ext.replace('.', '');
                    const analyzer = getAnalyzer(lang);
                    if (!analyzer) { continue; }
                        try {
                        // Lightweight call: do not pass file content (analyzers may choose to read it themselves).
                        const resRaw = await analyzer(f.path, ext, undefined);
                        const res = (resRaw && typeof resRaw === 'object' && 'summary' in (resRaw as Record<string, unknown>)) ? resRaw as AnalyzerResult : undefined;
                        if (res && typeof res.summary === 'string' && res.summary.length > 0) {
                            // Normalize whitespace and cap length to prevent large summaries from bloating the header
                            let s = res.summary.replace(/\s+/g, ' ').trim();
                            if (s.length > MAX_FINDING_LEN) { s = s.slice(0, MAX_FINDING_LEN) + '…'; }
                            findings.push(`${f.relPath}: ${s}`);
                        }
                    } catch (ae) {
                        // Non-fatal: log analyzer errors in non-Production modes for visibility.
                        // Use VS Code's extensionMode when available; fall back to process.env if not.
                        try {
                            const isProduction = (typeof env !== 'undefined' && typeof ExtensionMode !== 'undefined')
                                ? ((env as any).extensionMode === ExtensionMode.Production)
                                : (process && process.env && String(process.env.NODE_ENV).toLowerCase() === 'production');
                            if (!isProduction) {
                                console.warn(`analyzer(${lang}) failed for ${f.relPath}: ${String(ae)}`);
                            }
                        } catch (e) { /* ignore logging errors */ }
                        continue;
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

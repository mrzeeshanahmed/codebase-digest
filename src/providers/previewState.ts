import { FileNode } from '../types/interfaces';
import { FileScanner } from '../services/fileScanner';
import { buildFileTree } from './treeHelpers';
import { buildTreeLines } from '../format/treeBuilder';

export function computePreviewState(rootNodes: FileNode[], selectedFiles: FileNode[], fileScanner: FileScanner, config?: Record<string, unknown>) {
    const maxLines = (config && typeof config['maxSelectedTreeLines'] === 'number') ? (config['maxSelectedTreeLines'] as number) : 50;
    // Use the single canonical tree builder for both minimal (selected-only)
    // and full tree modes so truncation and CRLF normalization are consistent.
    const minimalSelectedTreeLines = selectedFiles.length > 0
        ? buildTreeLines(selectedFiles, 'minimal', maxLines)
        : buildTreeLines(rootNodes, 'full', maxLines);
    const chartStats = fileScanner.aggregateStats(selectedFiles.length > 0 ? selectedFiles : rootNodes);
    // Compute a lightweight token estimate for preview/status.
    // Align the preview heuristic with TokenAnalyzer by using a small in-memory
    // divisor map for common token models. Respect optional lightweight
    // `config.tokenDivisorOverrides` when provided (no I/O).
    // Old behavior used config.tokenEstimate as a boolean which produced 0/1 values.
    // New behavior estimates tokens from selected files using a fast heuristic:
    // - Prefer using file.size as proxy: ceil(size / divisor)
    // - If size missing, fallback to relPath length / divisor
    // This avoids heavy I/O while producing meaningful counts for the UI.
    const model = (config && typeof config['tokenModel'] === 'string') ? String(config['tokenModel']) : 'chars-approx';
    const divisorMap: Record<string, number> = {
        'chars-approx': 4,
        'gpt-4o': 4,
        'gpt-3.5': 4,
        'gpt-4o-mini': 4,
        'claude-3.5': 4,
        'o200k': 4,
        // keep tiktoken default conservative; adapters may provide their own tokenizer
        'tiktoken': 4
    };
    const overrides = (config && typeof config['tokenDivisorOverrides'] === 'object' && config['tokenDivisorOverrides'] !== null) ? config['tokenDivisorOverrides'] as Record<string, unknown> : undefined;
    const divisorFromOverrides = overrides && typeof overrides[model] === 'number' ? (overrides[model] as number) : undefined;
    const divisor = (typeof divisorFromOverrides === 'number' && divisorFromOverrides > 0) ? divisorFromOverrides : (divisorMap[model] || 4);
    let tokenEstimate = 0;
    if (selectedFiles.length === 0) {
        // No explicit selection: fall back to a workspace-level heuristic so the UI
        // (preview delta / banner) can show a meaningful token estimate.
        // Prefer the fileScanner's lastStats.totalSize (accurate) when available,
        // otherwise leave as 0.
        const totalSize = fileScanner?.lastStats?.totalSize;
            if (typeof totalSize === 'number' && totalSize > 0) {
            tokenEstimate = Math.ceil(totalSize / divisor);
        } else {
            tokenEstimate = 0;
        }
    } else {
        for (const f of selectedFiles) {
            if (typeof f.size === 'number' && f.size > 0) {
                tokenEstimate += Math.ceil(f.size / divisor);
            } else if (f.relPath && f.relPath.length > 0) {
                tokenEstimate += Math.ceil(f.relPath.length / divisor);
            } else if (f.path && f.path.length > 0) {
                tokenEstimate += Math.ceil(f.path.length / divisor);
            }
        }
    }
    const warnings = fileScanner?.lastStats?.warnings || [];
    const presetNames = config && Array.isArray(config['filterPresets']) ? (config['filterPresets'] as unknown[]).map(p => String(p)) : [];
    const contextLimit = (config && typeof config['contextLimit'] === 'number') ? (config['contextLimit'] as number) : ((config && typeof config['tokenLimit'] === 'number') ? (config['tokenLimit'] as number) : 0);

    // totalFiles fallback count
    let totalFiles = fileScanner?.lastStats?.totalFiles;
    if (typeof totalFiles !== 'number') {
        const countFiles = (nodes: FileNode[]): number => {
            let count = 0;
            for (const node of nodes) {
                if (node.type === 'file') { count++; }
                if (node.children) { count += countFiles(node.children); }
            }
            return count;
        };
        totalFiles = countFiles(rootNodes);
    }
    // Collect all file relPaths and build a hierarchical file tree for the webview
    const allFilePaths: string[] = [];
    const collectPaths = (nodes: FileNode[]) => {
        for (const node of nodes) {
            if (node.type === 'file' && node.relPath) { allFilePaths.push(node.relPath); }
            if (node.children) { collectPaths(node.children); }
        }
    };
    collectPaths(rootNodes);

    // Build a hierarchical file tree and selected paths for the webview
    const fileTree = buildFileTree(allFilePaths);
    const selectedPaths = selectedFiles.filter(f => f.relPath).map(f => f.relPath);

    return {
        selectedCount: selectedFiles.length,
        selectedSize: selectedFiles.reduce((acc, n) => acc + (n.size || 0), 0),
    totalFiles,
    fileTree,
    selectedPaths,
        tokenEstimate,
        presetNames,
        contextLimit,
        chartStats,
        minimalSelectedTreeLines,
    warnings,
    // Extract virtual groups summary if present at top-level
    virtualGroups: rootNodes
        .filter(r => typeof r === 'object' && r !== null)
        .map(r => r as unknown as Record<string, unknown>)
        .filter(rr => typeof rr['virtualType'] === 'string' && rr['virtualType'] === 'virtualGroup')
        .map(rr => ({ name: typeof rr['name'] === 'string' ? rr['name'] as string : '', count: typeof rr['childCount'] === 'number' ? rr['childCount'] as number : 0, totalSize: typeof rr['totalSize'] === 'number' ? rr['totalSize'] as number : 0 }))
    };
}

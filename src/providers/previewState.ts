import { FileNode } from '../types/interfaces';
import { FileScanner } from '../services/fileScanner';

export function computePreviewState(rootNodes: FileNode[], selectedFiles: FileNode[], fileScanner: FileScanner, config: any) {
    const maxLines = config.maxSelectedTreeLines || 50;
    const minimalSelectedTreeLines = selectedFiles.length > 0
        ? require('../utils/formatters').Formatters.buildSelectedTreeLines(selectedFiles, maxLines)
        : require('../format/treeBuilder').buildTreeLines(rootNodes, 'full', maxLines);
    const chartStats = fileScanner.aggregateStats(selectedFiles.length > 0 ? selectedFiles : rootNodes);
    // Compute a lightweight token estimate for preview/status.
    // Old behavior used config.tokenEstimate as a boolean which produced 0/1 values.
    // New behavior estimates tokens from selected files using a fast heuristic:
    // - Prefer using file.size as proxy: ceil(size / 4)
    // - If size missing, fallback to relPath length / 4
    // This avoids heavy I/O while producing meaningful counts for the UI.
    let tokenEstimate = 0;
    if (selectedFiles.length === 0) {
        tokenEstimate = 0;
    } else {
        for (const f of selectedFiles) {
            if (typeof f.size === 'number' && f.size > 0) {
                tokenEstimate += Math.ceil(f.size / 4);
            } else if (f.relPath && f.relPath.length > 0) {
                tokenEstimate += Math.ceil(f.relPath.length / 4);
            } else if (f.path && f.path.length > 0) {
                tokenEstimate += Math.ceil(f.path.length / 4);
            }
        }
    }
    const warnings = fileScanner?.lastStats?.warnings || [];
    const presetNames = config.filterPresets || [];
    const contextLimit = config.contextLimit || config.tokenLimit || 0;

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
    // Build a flattened file list (DFS) of relPaths to provide a fallback file list when no selection exists
    const flattenedFiles: string[] = [];
    const maxFlatten = 500;
    const collect = (nodes: FileNode[]) => {
        for (const node of nodes) {
            if (flattenedFiles.length >= maxFlatten) { return; }
            if (node.type === 'file' && node.relPath) { flattenedFiles.push(node.relPath); }
            if (node.children) { collect(node.children); if (flattenedFiles.length >= maxFlatten) { return; } }
        }
    };
    collect(rootNodes);
    return {
        selectedCount: selectedFiles.length,
        selectedSize: selectedFiles.reduce((acc, n) => acc + (n.size || 0), 0),
        totalFiles,
        flattenedFiles,
        tokenEstimate,
        presetNames,
        contextLimit,
        chartStats,
        minimalSelectedTreeLines,
    warnings,
    // Extract virtual groups summary if present at top-level
    virtualGroups: rootNodes.filter(r => (r as any).virtualType === 'virtualGroup').map(g => ({ name: g.name, count: (g as any).childCount || 0, totalSize: (g as any).totalSize || 0 }))
    };
}

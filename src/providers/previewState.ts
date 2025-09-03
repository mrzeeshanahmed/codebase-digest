import { FileNode } from '../types/interfaces';
import { FileScanner } from '../services/fileScanner';

export function computePreviewState(rootNodes: FileNode[], selectedFiles: FileNode[], fileScanner: FileScanner, config: any) {
    const maxLines = config.maxSelectedTreeLines || 50;
    const minimalSelectedTreeLines = selectedFiles.length > 0
        ? require('../utils/formatters').Formatters.buildSelectedTreeLines(selectedFiles, maxLines)
        : [];
    const chartStats = fileScanner.aggregateStats(selectedFiles.length > 0 ? selectedFiles : rootNodes);
    const tokenEstimate = config.tokenEstimate || 0;
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
    return {
        selectedCount: selectedFiles.length,
        selectedSize: selectedFiles.reduce((acc, n) => acc + (n.size || 0), 0),
        totalFiles,
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

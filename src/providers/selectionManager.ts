import { FileNode } from '../types/interfaces';

export type OnChangeFn = (node?: FileNode | undefined) => void;
export type PreviewUpdaterFn = () => void;

export class SelectionManager {
    private getRoots: () => FileNode[];
    private selectedRelPaths: string[];
    private onChange: OnChangeFn;
    private previewUpdater?: PreviewUpdaterFn;

    constructor(getRoots: () => FileNode[], selectedRelPaths: string[], onChange: OnChangeFn, previewUpdater?: PreviewUpdaterFn) {
        this.getRoots = getRoots;
        this.selectedRelPaths = selectedRelPaths;
        this.onChange = onChange;
        this.previewUpdater = previewUpdater;
    }

    toggleSelection(node: FileNode) {
        node.isSelected = !node.isSelected;
        this.onChange(node);
        if (this.previewUpdater) { this.previewUpdater(); }
    }

    getSelectedFiles(): FileNode[] {
        const selected: FileNode[] = [];
        const traverse = (node: FileNode) => {
            if (node.isSelected && node.type === 'file') {
                selected.push(node);
            }
            if (node.children) {
                for (const child of node.children) {
                    traverse(child);
                }
            }
        };
        for (const root of this.getRoots()) {
            traverse(root);
        }
        selected.sort((a, b) => a.relPath.localeCompare(b.relPath));
        return selected;
    }

    clearSelection(): void {
        // Reset selection state on all nodes and clear the selectedRelPaths cache.
        this.selectedRelPaths.length = 0;
        const clearNode = (node: FileNode) => {
            try { node.isSelected = false; } catch (e) {}
            if (node.children) {
                for (const child of node.children) { clearNode(child); }
            }
        };
        for (const node of this.getRoots()) { clearNode(node); }
        this.onChange(undefined);
        if (this.previewUpdater) { this.previewUpdater(); }
    }

    setSelectionByRelPaths(relPaths: string[]): void {
        // Convert requested relPaths into a Set for O(1) membership checks and
        // perform a single pass over the tree to update node.isSelected and
        // accumulate selectedRelPaths. This avoids repeated includes/filter
        // operations which produce O(n*m) behavior on large trees.
        const want = new Set(relPaths || []);
        const collected: string[] = [];
        // Traverse with ancestorHas to allow folder relPaths to select contained files
        const markSelection = (node: FileNode, ancestorHas: boolean) => {
            const nodeRequested = want.has(node.relPath);
            const effective = ancestorHas || nodeRequested;
            if (node.type === 'file') {
                try { node.isSelected = !!effective; } catch (e) {}
                if (effective) { collected.push(node.relPath); }
            } else {
                // Do not mark directories as selected; selection is represented by files
                try { node.isSelected = false; } catch (e) {}
            }
            if (node.children) {
                for (const child of node.children) { markSelection(child, effective); }
            }
        };
        for (const node of this.getRoots()) { markSelection(node, false); }
        // Keep selectedRelPaths deterministic and compact: sort by relPath so
        // callers relying on stable ordering (and persisted snapshots) behave
        // consistently. getSelectedFiles() also sorts, so this aligns both APIs.
        collected.sort((a, b) => a.localeCompare(b));
        this.selectedRelPaths = collected;
        this.onChange(undefined);
        if (this.previewUpdater) { this.previewUpdater(); }
    }

    selectAll(): void {
        // Use a Set to collect file relPaths and avoid O(n^2) includes checks
        const collected = new Set<string>();
        const selectNode = (node: FileNode) => {
            if (node.type === 'file') {
                try { node.isSelected = true; } catch (e) {}
                if (node.relPath) { collected.add(node.relPath); }
            } else {
                try { node.isSelected = false; } catch (e) {}
            }
            if (node.children) {
                for (const child of node.children) { selectNode(child); }
            }
        };
        for (const node of this.getRoots()) { selectNode(node); }
        this.selectedRelPaths = Array.from(collected).sort((a, b) => a.localeCompare(b));
        this.onChange(undefined);
        if (this.previewUpdater) { this.previewUpdater(); }
    }
}

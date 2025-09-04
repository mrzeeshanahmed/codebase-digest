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
        this.selectedRelPaths.length = 0;
        const clearNode = (node: FileNode) => {
            node.isSelected = false;
            this.selectedRelPaths = this.selectedRelPaths.filter(rp => rp !== node.relPath);
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
        const markSelection = (node: FileNode) => {
            const isSel = want.has(node.relPath);
            node.isSelected = !!isSel;
            if (node.type === 'file' && isSel) {
                collected.push(node.relPath);
            }
            if (node.children) {
                for (const child of node.children) { markSelection(child); }
            }
        };
        for (const node of this.getRoots()) { markSelection(node); }
        // Keep selectedRelPaths deterministic and compact: sort by relPath so
        // callers relying on stable ordering (and persisted snapshots) behave
        // consistently. getSelectedFiles() also sorts, so this aligns both APIs.
        collected.sort((a, b) => a.localeCompare(b));
        this.selectedRelPaths = collected;
        this.onChange(undefined);
        if (this.previewUpdater) { this.previewUpdater(); }
    }

    selectAll(): void {
        this.selectedRelPaths.length = 0;
        const selectNode = (node: FileNode) => {
            node.isSelected = true;
            if (node.type === 'file') {
                if (!this.selectedRelPaths.includes(node.relPath)) { this.selectedRelPaths.push(node.relPath); }
            }
            if (node.children) {
                for (const child of node.children) { selectNode(child); }
            }
        };
        for (const node of this.getRoots()) { selectNode(node); }
        this.onChange(undefined);
        if (this.previewUpdater) { this.previewUpdater(); }
    }
}

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
        this.selectedRelPaths.length = 0;
        const markSelection = (node: FileNode) => {
            node.isSelected = relPaths.includes(node.relPath);
            if (node.isSelected) {
                if (!this.selectedRelPaths.includes(node.relPath)) { this.selectedRelPaths.push(node.relPath); }
            } else {
                this.selectedRelPaths = this.selectedRelPaths.filter(rp => rp !== node.relPath);
            }
            if (node.children) {
                for (const child of node.children) { markSelection(child); }
            }
        };
        for (const node of this.getRoots()) { markSelection(node); }
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

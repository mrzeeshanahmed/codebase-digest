import { FileNode } from '../types/interfaces';

export const MAX_EXPAND_DEPTH = 5;

export type OnDidChangeCallback = (node?: FileNode | undefined) => void;
export type OnPreviewUpdateCallback = () => void;

export class ExpandState {
    private expandedRelPaths: Set<string> = new Set();
    private maxDepth: number;
    private onDidChange?: OnDidChangeCallback;
    private onPreviewUpdate?: OnPreviewUpdateCallback;

    constructor(opts?: { maxDepth?: number, onDidChange?: OnDidChangeCallback, onPreviewUpdate?: OnPreviewUpdateCallback }) {
        this.maxDepth = opts?.maxDepth ?? MAX_EXPAND_DEPTH;
        this.onDidChange = opts?.onDidChange;
        this.onPreviewUpdate = opts?.onPreviewUpdate;
    }

    isExpanded(relPath: string): boolean {
        return this.expandedRelPaths.has(relPath);
    }

    setExpanded(relPath: string, expanded: boolean): void {
        if (expanded) {
            this.expandedRelPaths.add(relPath);
        } else {
            this.expandedRelPaths.delete(relPath);
        }
        this.onDidChange && this.onDidChange();
        this.onPreviewUpdate && this.onPreviewUpdate();
    }

    toggle(relPath: string): void {
        if (this.expandedRelPaths.has(relPath)) {
            this.expandedRelPaths.delete(relPath);
        } else {
            this.expandedRelPaths.add(relPath);
        }
        this.onDidChange && this.onDidChange();
        this.onPreviewUpdate && this.onPreviewUpdate();
    }

    expandAll(rootNodes: FileNode[]): void {
        const expandNode = (node: FileNode, depth: number) => {
            // Include nodes at depth == maxDepth, but don't recurse further past maxDepth
            if (node.type === 'directory' && depth <= this.maxDepth) {
                this.expandedRelPaths.add(node.relPath);
                if (node.children && depth < this.maxDepth) {
                    for (const child of node.children) {
                        expandNode(child, depth + 1);
                    }
                }
            }
        };
        for (const root of rootNodes) {
            expandNode(root, 0);
        }
        this.onDidChange && this.onDidChange();
        this.onPreviewUpdate && this.onPreviewUpdate();
    }

    collapseAll(): void {
        this.expandedRelPaths.clear();
        this.onDidChange && this.onDidChange();
        this.onPreviewUpdate && this.onPreviewUpdate();
    }

    getExpandedRelPaths(): string[] { return Array.from(this.expandedRelPaths); }
}

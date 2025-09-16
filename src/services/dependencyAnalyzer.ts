import * as fs from 'fs';
import * as vscode from 'vscode';

export async function analyzeImports(filePath: string, ext: string, content?: string): Promise<string[]> {
    const norm = (ext || '').toLowerCase();
    if (!['.js', '.ts', '.jsx', '.tsx'].includes(norm)) { return []; }
    try {
        const cfg = vscode.workspace && typeof vscode.workspace.getConfiguration === 'function' ? vscode.workspace.getConfiguration('codebaseDigest') : null;
        if (cfg && typeof cfg.get === 'function') {
            const enabled = cfg.get('enableDependencyAnalysis', true);
            if (!enabled) { return []; }
        }
    } catch (_) { /* ignore config read errors and proceed */ }
    try {
        if (!content) { content = await fs.promises.readFile(filePath, 'utf8'); }
    } catch (e) {
        return [];
    }

    // Try TypeScript compiler API if available
    try {
    // dynamic require so ts is optional
    const ts = require('typescript');
        const sf = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true);
        const imports: string[] = [];
        const visit = (node: any) => {
            // ImportDeclaration and ExportDeclaration with moduleSpecifier
            if (node.kind === ts.SyntaxKind.ImportDeclaration || node.kind === ts.SyntaxKind.ExportDeclaration) {
                const spec = node.moduleSpecifier && node.moduleSpecifier.text;
                if (spec) { imports.push(spec); }
            }
            // CallExpression require('x')
            if (node.kind === ts.SyntaxKind.CallExpression) {
                const expr = node.expression;
                if (expr && expr.kind === ts.SyntaxKind.Identifier && expr.escapedText === 'require' && node.arguments && node.arguments[0]) {
                    const a = node.arguments[0];
                    if (a.text) { imports.push(a.text); }
                }
            }
            // ImportExpression: import('x')
            if (node.kind === ts.SyntaxKind.ImportExpression && node.expression && node.expression.text) {
                imports.push(node.expression.text);
            }
            ts.forEachChild(node, visit);
        };
        visit(sf);
        // Deduplicate and return
        return Array.from(new Set(imports));
    } catch (e) {
        // fallback to regex heuristics
    }

    const imports: string[] = [];
    try {
        // import ... from 'x'
        const re1 = /import\s+(?:[^'";]+?\s+from\s+)?['"]([^'"]+)['"]/g;
        let m: RegExpExecArray | null;
        while ((m = re1.exec(content)) !== null) {
            imports.push(m[1]);
        }
        // export ... from 'x'
        const re2 = /export\s+[^'";]+?from\s+['"]([^'"]+)['"]/g;
        while ((m = re2.exec(content)) !== null) {
            imports.push(m[1]);
        }
        // require('x')
        const re3 = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
        while ((m = re3.exec(content)) !== null) {
            imports.push(m[1]);
        }
        // dynamic import('x')
        const re4 = /import\(\s*['"]([^'"]+)['"]\s*\)/g;
        while ((m = re4.exec(content)) !== null) {
            imports.push(m[1]);
        }
    } catch (e) {
        // ignore
    }
    return Array.from(new Set(imports));
}

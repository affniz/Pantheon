import { Project, SyntaxKind } from 'ts-morph';
import * as path from 'node:path';
import * as fs from 'node:fs';

const SKIP_DIRS = new Set([
    'node_modules', 'dist', '.turbo', '.git', 'coverage', '.pantheon',
]);

/**
 * Build a compact, AST-derived codebase map for a TypeScript/JavaScript project.
 * Scans all .ts/.tsx/.js/.jsx files under projectRoot, extracts exported
 * symbols (functions, classes, interfaces, type aliases, constants), and
 * produces a compressed text representation suitable for injection into an
 * LLM system prompt.
 * Target output: 1,500-2,500 tokens for a typical TS monorepo.
 * Structural/navigational only - NOT semantic RAG.
 */
export async function buildRepoMap(projectRoot: string): Promise<string> {
    const start = Date.now();

    const sourceFiles: string[] = [];
    collectFiles(projectRoot, projectRoot, sourceFiles);

    if (sourceFiles.length === 0) {
        return '(No TypeScript/JavaScript source files found)';
    }

    const project = new Project({
        useInMemoryFileSystem: false,
        skipAddingFilesFromTsConfig: true,
        compilerOptions: { allowJs: true, noEmit: true },
    });

    project.addSourceFilesAtPaths(sourceFiles);

    const sections: string[] = [];

    for (const sf of project.getSourceFiles()) {
        const filePath = sf.getFilePath();
        const relPath = path.relative(projectRoot, filePath);
        const symbols: string[] = [];

        // Exported functions
        for (const fn of sf.getFunctions()) {
            if (!fn.isExported()) continue;
            const name = fn.getName() ?? '(anonymous)';
            const params = fn.getParameters().map((p) => p.getText()).join(', ');
            const retType = fn.getReturnTypeNode()?.getText() ?? '';
            symbols.push(retType ? 'fn ' + name + '(' + params + '): ' + retType : 'fn ' + name + '(' + params + ')');
        }

        // Exported classes
        for (const cls of sf.getClasses()) {
            if (!cls.isExported()) continue;
            const name = cls.getName() ?? '(anonymous)';
            const methods = cls.getMethods()
                .filter((m) => m.getScope() !== 'private' && m.getScope() !== 'protected')
                .map((m) => m.getName() + '(' + m.getParameters().map((p) => p.getName()).join(', ') + ')');
            const methodStr = methods.length > 0 ? ' { ' + methods.slice(0, 6).join(', ') + ' }' : '';
            symbols.push('class ' + name + methodStr);
        }

        // Exported interfaces
        for (const iface of sf.getInterfaces()) {
            if (!iface.isExported()) continue;
            const props = iface.getProperties().slice(0, 8)
                .map((p) => p.getName() + (p.hasQuestionToken() ? '?' : '') + ': ' + (p.getTypeNode()?.getText() ?? 'unknown'))
                .join('; ');
            symbols.push('interface ' + iface.getName() + ' { ' + props + ' }');
        }

        // Exported type aliases
        for (const ta of sf.getTypeAliases()) {
            if (!ta.isExported()) continue;
            symbols.push('type ' + ta.getName());
        }

        // Exported variable declarations
        for (const vs of sf.getVariableStatements()) {
            if (!vs.isExported()) continue;
            for (const decl of vs.getDeclarations()) {
                const init = decl.getInitializer();
                if (init && init.getKind() === SyntaxKind.ArrowFunction) {
                    symbols.push('const ' + decl.getName() + ' (arrow fn)');
                } else {
                    symbols.push('const ' + decl.getName());
                }
            }
        }

        if (symbols.length > 0) {
            sections.push(relPath + "\n  " + symbols.join("\n  "));
        }
    }

    const elapsed = Date.now() - start;
    const header = "Codebase map (" + sourceFiles.length + " files, " + sections.length + " with exports, built in " + elapsed + "ms):";
    return header + "\n\n" + sections.join("\n\n");
}

function collectFiles(root: string, dir: string, out: string[]): void {
    let entries: import('fs').Dirent[];
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return;
    }
    for (const entry of entries) {
        if (SKIP_DIRS.has(entry.name)) continue;
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            collectFiles(root, fullPath, out);
        } else if (entry.isFile() && /.(ts|tsx|js|jsx)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
            out.push(fullPath);
        }
    }
}

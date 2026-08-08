import * as fs from "node:fs";
import * as path from "node:path";
import type { Tool } from "../tool-registry.js";
import type { Sandbox } from "../../sandbox/sandbox.js";

export const listDirectoryTool: Tool = {
    definition: {
        name: "list_directory",
        description:
            "List the contents of a directory. Returns file and directory names. " +
            "Use this to explore the project structure.",
        parameters: {
            type: "object",
            properties: {
                path: {
                    type: "string",
                    description:
                        "Path to the directory to list (relative to project root or absolute). " +
                        "Defaults to the project root if omitted.",
                },
                recursive: {
                    type: "boolean",
                    description:
                        "If true, list contents recursively. Defaults to false.",
                },
                maxDepth: {
                    type: "number",
                    description:
                        "Maximum recursion depth (only used when recursive is true). Defaults to 3.",
                },
            },
            required: [],
        },
        safety: "safe",
    },

    async execute(args: Record<string, unknown>, sandbox: Sandbox): Promise<string> {
        const dirPath = typeof args["path"] === "string" ? args["path"] : ".";
        const recursive = args["recursive"] === true;
        const maxDepth = typeof args["maxDepth"] === "number" ? args["maxDepth"] : 3;

        try {
            const resolved = sandbox.resolvePath(dirPath);
            const stat = fs.statSync(resolved);

            if (!stat.isDirectory()) {
                return `Error: "${dirPath}" is not a directory. Use read_file instead.`;
            }

            const entries: string[] = [];
            listDir(resolved, resolved, 0, maxDepth, recursive, entries);

            if (entries.length === 0) {
                return `Directory "${dirPath}" is empty.`;
            }

            return entries.join("\n");
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return `Error listing directory: ${message}`;
        }
    },
};

function listDir(
    basePath: string,
    currentPath: string,
    depth: number,
    maxDepth: number,
    recursive: boolean,
    output: string[]
): void {
    const entries = fs.readdirSync(currentPath, { withFileTypes: true });

    // Sort: directories first, then files, alphabetically
    entries.sort((a, b) => {
        if (a.isDirectory() && !b.isDirectory()) return -1;
        if (!a.isDirectory() && b.isDirectory()) return 1;
        return a.name.localeCompare(b.name);
    });

    for (const entry of entries) {
        // Skip hidden files and common noise
        if (entry.name === "node_modules" || entry.name === ".git") continue;

        const indent = "  ".repeat(depth);
        const relativePath = path.relative(basePath, path.join(currentPath, entry.name));

        if (entry.isDirectory()) {
            output.push(`${indent}📁 ${relativePath}/`);
            if (recursive && depth < maxDepth) {
                listDir(
                    basePath,
                    path.join(currentPath, entry.name),
                    depth + 1,
                    maxDepth,
                    recursive,
                    output
                );
            }
        } else {
            const size = fs.statSync(path.join(currentPath, entry.name)).size;
            const sizeStr = formatSize(size);
            output.push(`${indent}📄 ${relativePath} (${sizeStr})`);
        }
    }
}

function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

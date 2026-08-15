import * as fs from "node:fs";
import type { Tool } from "../tool-registry.js";
import type { Sandbox } from "../../sandbox/sandbox.js";

export const readFileTool: Tool = {
    definition: {
        name: "read_file",
        description:
            "Read the contents of a file. Returns the file content as text. " +
            "Use this to inspect source code, configuration files, or any text file.",
        parameters: {
            type: "object",
            properties: {
                path: {
                    type: "string",
                    description:
                        "Path to the file to read (relative to project root or absolute).",
                },
                maxLines: {
                    type: "number",
                    description:
                        "Maximum number of lines to return. Omit to read the entire file. " +
                        "Use a smaller value for very large files to limit context usage.",
                },
            },
            required: ["path"],
        },
        safety: "safe",
    },

    async execute(args: Record<string, unknown>, sandbox: Sandbox): Promise<string> {
        const filePath = args["path"];
        if (typeof filePath !== "string") {
            return "Error: 'path' argument must be a string.";
        }

        const maxLines = typeof args["maxLines"] === "number" ? args["maxLines"] : Infinity;

        try {
            const resolved = sandbox.resolvePath(filePath);
            const stat = fs.statSync(resolved);

            if (stat.isDirectory()) {
                return `Error: "${filePath}" is a directory, not a file. Use list_directory instead.`;
            }

            const content = fs.readFileSync(resolved, "utf-8");
            const lines = content.split("\n");

            if (lines.length > maxLines) {
                const truncated = lines.slice(0, maxLines).join("\n");
                return (
                    truncated +
                    `\n\n--- Showing first ${maxLines} of ${lines.length} lines. ` +
                    `Use maxLines to see more. ---`
                );
            }

            return content;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return `Error reading file: ${message}`;
        }
    },
};

import * as fs from "node:fs";
import * as path from "node:path";
import type { Tool } from "../tool-registry.js";
import type { Sandbox } from "../../sandbox/sandbox.js";

export const writeFileTool: Tool = {
    definition: {
        name: "write_file",
        description:
            "Write content to a file. Creates the file if it doesn't exist, " +
            "and creates parent directories as needed. Overwrites existing content.",
        parameters: {
            type: "object",
            properties: {
                path: {
                    type: "string",
                    description:
                        "Path to the file to write (relative to project root or absolute).",
                },
                content: {
                    type: "string",
                    description: "The content to write to the file.",
                },
            },
            required: ["path", "content"],
        },
        safety: "destructive",
    },

    async execute(args: Record<string, unknown>, sandbox: Sandbox): Promise<string> {
        const filePath = args["path"];
        const content = args["content"];

        if (typeof filePath !== "string") {
            return "Error: 'path' argument must be a string.";
        }
        if (typeof content !== "string") {
            return "Error: 'content' argument must be a string.";
        }

        try {
            const resolved = sandbox.resolvePath(filePath);

            // Ensure parent directories exist
            const dir = path.dirname(resolved);
            fs.mkdirSync(dir, { recursive: true });

            fs.writeFileSync(resolved, content, "utf-8");

            const lines = content.split("\n").length;
            return `Successfully wrote ${lines} lines to ${resolved}`;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return `Error writing file: ${message}`;
        }
    },
};

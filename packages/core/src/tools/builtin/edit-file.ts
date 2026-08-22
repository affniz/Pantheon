import * as fs from "node:fs";
import type { Tool } from "../tool-registry.js";
import type { Sandbox } from "../../sandbox/sandbox.js";

export const editFileTool: Tool = {
    definition: {
        name: "edit_file",
        description:
            "Make a targeted edit to an existing file by replacing an exact substring. " +
            "Finds the FIRST occurrence of `targetContent` in the file and replaces it with `replacementContent`. " +
            "Prefer this over write_file for any modification to an existing file — it avoids full rewrites, " +
            "preserves surrounding content, and prevents accidental deletions. " +
            "Use write_file only when creating a brand-new file.",
        parameters: {
            type: "object",
            properties: {
                path: {
                    type: "string",
                    description:
                        "Path to the file to edit (relative to project root or absolute).",
                },
                targetContent: {
                    type: "string",
                    description:
                        "The exact string to find and replace. Must match the file content exactly " +
                        "(including whitespace and line endings). The edit will fail if this string " +
                        "is not found — read the file first if unsure of the exact content.",
                },
                replacementContent: {
                    type: "string",
                    description:
                        "The string to substitute in place of targetContent.",
                },
            },
            required: ["path", "targetContent", "replacementContent"],
        },
        safety: "destructive",
    },

    async execute(args: Record<string, unknown>, sandbox: Sandbox): Promise<string> {
        const filePath = args["path"];
        const targetContent = args["targetContent"];
        const replacementContent = args["replacementContent"];

        if (typeof filePath !== "string") {
            return "Error: 'path' argument must be a string.";
        }
        if (typeof targetContent !== "string") {
            return "Error: 'targetContent' argument must be a string.";
        }
        if (typeof replacementContent !== "string") {
            return "Error: 'replacementContent' argument must be a string.";
        }

        try {
            const resolved = sandbox.resolvePath(filePath);

            // Read the file
            let original: string;
            try {
                original = fs.readFileSync(resolved, "utf-8");
            } catch (readError) {
                const message = readError instanceof Error ? readError.message : String(readError);
                return `Error reading file: ${message}`;
            }

            // Check that targetContent is present
            const idx = original.indexOf(targetContent);
            if (idx === -1) {
                return (
                    `Error: targetContent not found in ${resolved}. ` +
                    `The string you provided does not exist verbatim in the file. ` +
                    `Use read_file to inspect the current contents and try again.`
                );
            }

            // Replace the first occurrence
            const edited =
                original.slice(0, idx) +
                replacementContent +
                original.slice(idx + targetContent.length);

            fs.writeFileSync(resolved, edited, "utf-8");

            const oldLines = targetContent.split("\n").length;
            const newLines = replacementContent.split("\n").length;

            return (
                `Successfully edited ${resolved}: ` +
                `replaced ${oldLines} line(s) with ${newLines} line(s) at position ${idx}.`
            );
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return `Error editing file: ${message}`;
        }
    },
};

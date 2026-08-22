import { execFile } from "node:child_process";
import * as path from "node:path";
import type { Tool } from "../tool-registry.js";
import type { Sandbox } from "../../sandbox/sandbox.js";

export const grepTool: Tool = {
    definition: {
        name: "grep",
        description:
            "Search for a pattern across files using ripgrep (rg). " +
            "Returns matching lines with file paths and line numbers. " +
            "This tool is auto-approved and does not require a permission prompt. " +
            "Use it for codebase search instead of shell grep to avoid permission prompts.",
        parameters: {
            type: "object",
            properties: {
                pattern: {
                    type: "string",
                    description: "The search pattern (string or regex).",
                },
                path: {
                    type: "string",
                    description:
                        "Directory or file to search (relative to project root or absolute). " +
                        "Defaults to the project root if omitted.",
                },
                caseInsensitive: {
                    type: "boolean",
                    description: "If true, perform a case-insensitive search. Default: false.",
                },
                contextLines: {
                    type: "number",
                    description:
                        "Number of context lines to include around each match. Default: 0.",
                },
                fileGlob: {
                    type: "string",
                    description:
                        "Glob pattern to restrict search to specific file types, e.g. '*.ts'. " +
                        "Optional.",
                },
            },
            required: ["pattern"],
        },
        // safe: auto-approved, no permission gate, never goes through the shell allowlist
        safety: "safe",
    },

    async execute(args: Record<string, unknown>, sandbox: Sandbox): Promise<string> {
        const pattern = args["pattern"];
        const searchPath = typeof args["path"] === "string" ? args["path"] : ".";
        const caseInsensitive = args["caseInsensitive"] === true;
        const contextLines =
            typeof args["contextLines"] === "number" ? Math.max(0, args["contextLines"]) : 0;
        const fileGlob = typeof args["fileGlob"] === "string" ? args["fileGlob"] : undefined;

        if (typeof pattern !== "string" || pattern.trim() === "") {
            return "Error: 'pattern' argument must be a non-empty string.";
        }

        // Resolve search path within sandbox
        let resolvedSearchPath: string;
        try {
            resolvedSearchPath = sandbox.resolvePath(searchPath);
        } catch {
            resolvedSearchPath = path.resolve(sandbox.projectRoot, searchPath);
        }

        // Build rg argument list — call rg directly via execFile (NOT via sandbox allowlist)
        const rgArgs: string[] = [
            "--line-number",
            "--no-heading",
            "--color=never",
        ];

        if (caseInsensitive) {
            rgArgs.push("--ignore-case");
        }

        if (contextLines > 0) {
            rgArgs.push();
        }

        if (fileGlob) {
            rgArgs.push();
        }

        rgArgs.push("--", pattern, resolvedSearchPath);

        return new Promise<string>((resolve) => {
            execFile(
                "rg",
                rgArgs,
                {
                    cwd: sandbox.projectRoot,
                    timeout: 30_000,
                    maxBuffer: 1024 * 1024 * 2, // 2 MB
                    // Strip secrets — consistent with shell tool
                    env: { PATH: process.env["PATH"] ?? "/usr/local/bin:/usr/bin:/bin" },
                },
                (error, stdout, stderr) => {
                    if (error) {
                        // rg exits with code 1 when no matches are found — not a real error
                        const exitCode =
                            "code" in error && typeof error.code === "number" ? error.code : 1;
                        if (exitCode === 1 && !stderr) {
                            resolve("No matches found.");
                            return;
                        }
                        if (exitCode === 127 || (stderr && stderr.includes("not found"))) {
                            resolve(
                                "Error: ripgrep (rg) is not installed or not in PATH. " +
                                    "Install it from https://github.com/BurntSushi/ripgrep",
                            );
                            return;
                        }
                        // Other errors — return whatever output we got
                        const out = stdout.trim() || stderr.trim() || error.message;
                        resolve(out || "grep returned no output.");
                        return;
                    }

                    const output = stdout.trim();
                    if (!output) {
                        resolve("No matches found.");
                        return;
                    }

                    // Truncate very large outputs
                    const MAX_CHARS = 50_000;
                    if (output.length > MAX_CHARS) {
                        const truncated = output.slice(0, MAX_CHARS);
                        resolve(truncated + "\n\n[Output truncated — too many matches. Narrow your search.]");
                        return;
                    }

                    resolve(output);
                },
            );
        });
    },
};

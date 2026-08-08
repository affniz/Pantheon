import { execFile } from "node:child_process";
import type { Tool } from "../tool-registry.js";
import type { Sandbox } from "../../sandbox/sandbox.js";

export const shellTool: Tool = {
    definition: {
        name: "shell",
        description:
            "Execute a shell command and return its output. " +
            "Use this for running build tools, git commands, searching with grep/find, etc. " +
            "Commands run in the project root directory.",
        parameters: {
            type: "object",
            properties: {
                command: {
                    type: "string",
                    description: "The shell command to execute.",
                },
                timeout: {
                    type: "number",
                    description:
                        "Timeout in milliseconds. Defaults to 30,000 (30 seconds).",
                },
            },
            required: ["command"],
        },
        safety: "destructive",
    },

    async execute(args: Record<string, unknown>, sandbox: Sandbox): Promise<string> {
        const command = args["command"];
        if (typeof command !== "string") {
            return "Error: 'command' argument must be a string.";
        }

        const timeout =
            typeof args["timeout"] === "number"
                ? args["timeout"]
                : sandbox.shellTimeout;

        try {
            // Validate command against blocklist
            sandbox.validateCommand(command);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return `Error: ${message}`;
        }

        return new Promise<string>((resolve) => {
            execFile(
                "/bin/sh",
                ["-c", command],
                {
                    cwd: sandbox.projectRoot,
                    timeout,
                    maxBuffer: 1024 * 1024, // 1 MB buffer
                    env: { ...process.env },
                },
                (error, stdout, stderr) => {
                    const parts: string[] = [];

                    if (stdout) {
                        parts.push(sandbox.truncateOutput(stdout));
                    }
                    if (stderr) {
                        parts.push(`STDERR:\n${sandbox.truncateOutput(stderr)}`);
                    }

                    if (error) {
                        const exitCode =
                            "code" in error && typeof error.code === "number"
                                ? error.code
                                : 1;

                        if (error.killed) {
                            parts.push(
                                `\nProcess killed (timeout after ${timeout}ms)`
                            );
                        }

                        // Still return output even on error — many commands
                        // use non-zero exit codes for valid output (e.g., grep)
                        if (parts.length === 0) {
                            parts.push(error.message);
                        }
                        parts.push(`\nExit code: ${exitCode}`);
                    } else {
                        parts.push("\nExit code: 0");
                    }

                    resolve(parts.join("\n"));
                }
            );
        });
    },
};

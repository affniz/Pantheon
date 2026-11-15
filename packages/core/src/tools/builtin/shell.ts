import type { Tool } from "../tool-registry.js";
import type { Sandbox } from "../../sandbox/sandbox.js";

export const shellTool: Tool = {
    definition: {
        name: "shell",
        description:
            "Execute a shell command and return its output. " +
            "Use this for running build tools, git commands, searching with grep/find, etc. " +
            "Commands run in the project root directory. Pipelines and && / || / ; are allowed when every " +
            "command in them is on the allowlist; command substitution, redirection to files and " +
            "background jobs are not.",
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

        // Validate against the allowlist, then run through the sandbox's executor —
        // a host process by default, a throw-away container in docker mode.
        let result;
        try {
            result = await sandbox.exec(command, { timeoutMs: timeout });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return `Error: ${message}`;
        }

        if (result.spawnError) {
            return `Error: ${result.spawnError}`;
        }

        const parts: string[] = [];
        if (result.stdout) {
            parts.push(sandbox.truncateOutput(result.stdout));
        }
        if (result.stderr) {
            parts.push(`STDERR:\n${sandbox.truncateOutput(result.stderr)}`);
        }
        if (result.timedOut) {
            parts.push(`\nProcess killed (timeout after ${timeout}ms)`);
        }
        // Output is returned even on failure — many commands use a non-zero exit
        // code for a perfectly valid answer (e.g. grep with no matches).
        parts.push(`\nExit code: ${result.exitCode}`);
        return parts.join("\n");
    },
};

import * as path from "node:path";
import * as fs from "node:fs";

export interface SandboxConfig {
    /** The project root — all file operations are jailed to this directory */
    projectRoot: string;
    /** Max output size for shell commands (chars). Default: 10,000 */
    maxOutputSize: number;
    /** Shell command timeout (ms). Default: 30,000 */
    shellTimeout: number;
}

/** Patterns that are blocked in shell commands */
const BLOCKED_COMMAND_PATTERNS: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
    { pattern: /\bsudo\b/, reason: "sudo is not allowed in sandboxed execution" },
    { pattern: /\bchmod\s+777\b/, reason: "chmod 777 is not allowed — too permissive" },
    { pattern: /\brm\s+(-[^\s]*\s+)*\/(?!\.)/, reason: "rm with absolute root paths is not allowed" },
    { pattern: /\bmkfs\b/, reason: "filesystem formatting is not allowed" },
    { pattern: /\bdd\s+.*of=\/dev\//, reason: "writing to device files is not allowed" },
    { pattern: />\s*\/dev\/sd[a-z]/, reason: "writing to block devices is not allowed" },
    { pattern: /\bcurl\b.*\|\s*(bash|sh|zsh)/, reason: "piping curl to shell is not allowed" },
    { pattern: /\bwget\b.*\|\s*(bash|sh|zsh)/, reason: "piping wget to shell is not allowed" },
];

/**
 * Sandbox enforces filesystem boundaries and shell restrictions.
 * All tool operations must go through the sandbox for validation.
 */
export class Sandbox {
    readonly projectRoot: string;
    readonly maxOutputSize: number;
    readonly shellTimeout: number;

    constructor(config: SandboxConfig) {
        const resolved = path.resolve(config.projectRoot);
        // Use realpathSync to normalize symlinks (e.g., /var → /private/var on macOS)
        // so the jail check is consistent with resolvePath's realpathSync calls.
        this.projectRoot = fs.existsSync(resolved) ? fs.realpathSync(resolved) : resolved;
        this.maxOutputSize = config.maxOutputSize;
        this.shellTimeout = config.shellTimeout;
    }

    /**
     * Create a sandbox with sensible defaults.
     */
    static create(projectRoot: string): Sandbox {
        return new Sandbox({
            projectRoot,
            maxOutputSize: 10_000,
            shellTimeout: 30_000,
        });
    }

    /**
     * Resolves a relative or absolute path and verifies it's within projectRoot.
     * Throws if the resolved path escapes the jail.
     *
     * For existing paths, symlinks are resolved to prevent symlink escapes.
     * For non-existing paths (e.g., writeFile), the parent directory is checked.
     */
    resolvePath(inputPath: string): string {
        // Resolve relative to project root
        const resolved = path.resolve(this.projectRoot, inputPath);

        // For existing files/dirs, resolve symlinks to prevent escapes
        if (fs.existsSync(resolved)) {
            const realPath = fs.realpathSync(resolved);
            this._assertWithinJail(realPath, inputPath);
            return realPath;
        }

        // For non-existing paths (e.g., about to create a file),
        // verify the resolved path itself is within the jail
        this._assertWithinJail(resolved, inputPath);

        // Also check the parent directory (if it exists) for symlink escapes
        const parentDir = path.dirname(resolved);
        if (fs.existsSync(parentDir)) {
            const realParent = fs.realpathSync(parentDir);
            // The real parent must still be within the project root
            this._assertWithinJail(realParent, inputPath);
        }

        return resolved;
    }

    /**
     * Validates a shell command is safe to execute.
     * Blocks known-dangerous patterns.
     * Returns the command unchanged if it passes validation, or throws with a reason.
     */
    validateCommand(command: string): string {
        for (const { pattern, reason } of BLOCKED_COMMAND_PATTERNS) {
            if (pattern.test(command)) {
                throw new Error(`Blocked command: ${reason}. Command: ${command}`);
            }
        }
        return command;
    }

    /**
     * Truncates output to the configured max size, appending a notice if truncated.
     */
    truncateOutput(output: string): string {
        if (output.length <= this.maxOutputSize) {
            return output;
        }
        return (
            output.slice(0, this.maxOutputSize) +
            `\n\n--- Output truncated at ${this.maxOutputSize.toLocaleString()} characters ---`
        );
    }

    private _assertWithinJail(resolvedPath: string, originalInput: string): void {
        const normalizedResolved = path.normalize(resolvedPath);
        const normalizedRoot = path.normalize(this.projectRoot);

        if (
            !normalizedResolved.startsWith(normalizedRoot + path.sep) &&
            normalizedResolved !== normalizedRoot
        ) {
            throw new Error(
                `Path "${originalInput}" resolves to "${resolvedPath}" which is outside the project root "${this.projectRoot}". Access denied.`
            );
        }
    }
}

import * as path from "node:path";
import * as fs from "node:fs";
import type { SandboxConfig as SandboxSettings } from "@pantheon/shared";
import { DockerExecutor, HostExecutor, type CommandExecutor, type ExecResult } from "./executor.js";
import type { FileCoordinator } from "./file-coordinator.js";

export interface ShellAllowlistEntry {
    /** Command binary name (e.g. "git", "ls", "npm") */
    command: string;
    /**
     * Allowed subcommands / first arguments.
     * If empty or undefined, all subcommands are permitted.
     */
    subcommands?: string[];
    /**
     * Regex patterns for arguments that are never allowed,
     * even when the command/subcommand is on the allowlist.
     */
    blockedArgs?: RegExp[];
    /** Human-readable description for audit logging */
    description: string;
}

export interface SandboxConfig {
    /** The project root — all file operations are jailed to this directory */
    projectRoot: string;
    /** Max output size for shell commands (chars). Default: 50,000 */
    maxOutputSize: number;
    /** Shell command timeout (ms). Default: 30,000 */
    shellTimeout: number;
    /**
     * Shell command allowlist configuration.
     * When enabled (default), only commands on the allowlist are permitted.
     * When disabled, all commands are allowed (not recommended for production).
     */
    allowlist: AllowlistConfig;
    /** Where shell commands run. Default: directly on the host. */
    executor?: CommandExecutor;
}

export interface AllowlistConfig {
    /** Whether allowlist mode is active. Default: true */
    enabled: boolean;
    /** Effective allowlist entries (defaults merged with user additions) */
    entries: ShellAllowlistEntry[];
}

/**
 * Default shell command allowlist.
 * Contains commonly needed read-only and testing commands.
 * Users can extend this via config or add per-session overrides.
 */
export const DEFAULT_SHELL_ALLOWLIST: ShellAllowlistEntry[] = [
    // ── File inspection (read-only) ──────────────────────────────────────────
    { command: "ls",   description: "List directory contents" },
    { command: "cat",  description: "Print file contents" },
    { command: "head", description: "Print first N lines of file" },
    { command: "tail", description: "Print last N lines of file" },
    { command: "wc",   description: "Word/line/byte count" },
    { command: "file", description: "Determine file type" },
    { command: "stat", description: "Display file status" },

    // ── Text processing ───────────────────────────────────────────────────────
    { command: "grep",   description: "Search text with patterns" },
    { command: "egrep",  description: "Extended grep" },
    { command: "fgrep",  description: "Fixed-string grep" },
    {
        command: "rg",
        description: "ripgrep — fast text search",
        blockedArgs: [/--pre\b/, /--hostname-bin\b/], // both run an arbitrary program
    },
    {
        command: "find",
        description: "Find files matching criteria",
        // -exec/-ok run programs, -delete removes files, -fprint*/-fls write files
        blockedArgs: [/-exec/, /-ok(dir)?\b/, /-delete\b/, /-fprint/, /-fls\b/],
    },
    { command: "sort",   description: "Sort lines of text", blockedArgs: [/(^|\s)(-o|--output)\b/] },
    { command: "uniq",   description: "Report or filter duplicate lines" },
    { command: "diff",   description: "Compare files line by line" },
    {
        command: "awk",
        description: "Pattern scanning and processing (text filtering only)",
        // awk is a programming language: system() and "cmd" | getline run programs,
        // print > "file" writes files, getline < "file" reads any file. Its programs
        // are quoted, so the shell-level checks cannot see inside them.
        blockedArgs: [/system\s*\(/, /getline/, /\|/, />/, /(^|\s)(-f|--file|-i|--include|-l|--load)\b/],
    },
    {
        command: "sed",
        description: "Stream editor",
        blockedArgs: [
            /\|\s*(bash|sh|zsh)/,  // block piping to shells
            /(^|\s)-i/,            // block -i / -i.bak in-place file modification
            /--in-place/,
            /(^|\s)(-f|--file)\b/, // a script file cannot be inspected here
            // The `e` command/flag executes a shell command, `w` / `r` write and read
            // arbitrary files (GNU sed): "1e id", "s/a/b/e", "w /tmp/x".
            /(^|[;{}'"\s])\d*[ewr]\s+\S/,
            /s(.)(?:(?!\1).)*\1(?:(?!\1).)*\1[gpIi\d]*[ew]/,
        ],
    },
    { command: "cut",    description: "Remove sections from lines" },
    { command: "tr",     description: "Translate characters" },
    { command: "jq",     description: "JSON processor" },

    // ── System info (read-only) ───────────────────────────────────────────────
    { command: "echo",    description: "Print a line of text" },
    { command: "printf",  description: "Format and print data" },
    { command: "pwd",     description: "Print working directory" },
    { command: "which",   description: "Locate a command" },
    { command: "type",    description: "Describe command type" },
    { command: "env",     description: "Print environment variables" },
    { command: "printenv",description: "Print environment variable values" },
    { command: "uname",   description: "Print system info" },
    { command: "date",    description: "Print current date and time" },
    { command: "whoami",  description: "Print current user name" },
    { command: "id",      description: "Print user identity" },
    { command: "hostname",description: "Print hostname" },
    { command: "sleep",   description: "Delay execution (used in scripts and tests)" },
    { command: "true",    description: "Exit with success" },
    { command: "false",   description: "Exit with failure" },

    // ── Git (read-only operations) ────────────────────────────────────────────
    {
        command: "git",
        subcommands: ["status", "log", "diff", "show", "branch", "rev-parse", "describe",
                      "tag", "stash", "remote", "config", "ls-files", "ls-tree", "shortlog",
                      "blame", "grep", "check-ignore", "format-patch"],
        description: "Git version control (read-only subcommands)",
        blockedArgs: [
            // `git config` may read, never write: core.fsmonitor, core.pager and
            // aliases are all ways to make a later git command run a program.
            /^config\s+(?!(--get|--get-all|--get-regexp|--list|-l)\b)/,
            /^config\s*$/,
            /--open-files-in-pager|(^|\s)-O\S*/,   // git grep: runs a program
            /--output\b/,                           // writes a file
            /--ext-diff|--textconv/,                // run configured external programs
            /^stash(\s+(?!list\b|show\b)|\s*$)/,   // only inspect stashes
            /^branch\b.*(\s-[dDmMcCf]\b|--delete|--move|--copy|--force)/,
            /^tag\s+(?!(-l|--list|-n\d*|--contains|--points-at)\b)/,
            /^remote\s+(add|remove|rm|rename|set-url|set-head|set-branches|prune|update)\b/,
        ],
    },

    // ── npm / pnpm / yarn (safe subcommands) ─────────────────────────────────
    {
        command: "npm",
        subcommands: ["list", "ls", "outdated", "info", "view", "why", "audit", "doctor",
                      "run", "test", "pack", "version"],
        description: "npm package manager (safe subcommands)",
    },
    {
        command: "pnpm",
        subcommands: ["list", "ls", "outdated", "info", "view", "why", "audit",
                      "run", "test"],
        description: "pnpm package manager (safe subcommands)",
    },
    {
        command: "yarn",
        subcommands: ["list", "outdated", "info", "why", "audit", "run", "test"],
        description: "yarn package manager (safe subcommands)",
    },
    {
        command: "bun",
        subcommands: ["run", "test", "pm"],
        description: "bun runtime (safe subcommands)",
    },

    // ── TypeScript / Linting / Testing ────────────────────────────────────────
    { command: "tsc",    description: "TypeScript compiler", blockedArgs: [] },
    { command: "eslint", description: "ESLint linter" },
    { command: "prettier",description: "Code formatter" },
    { command: "vitest", description: "Vitest test runner" },
    { command: "jest",   description: "Jest test runner" },
    { command: "mocha",  description: "Mocha test runner" },

    // ── Language runtimes — testing/safe use only ─────────────────────────────
    {
        command: "node",
        description: "Node.js runtime",
        blockedArgs: [
            /-e\s/,
            /--eval/,
            /https?:\/\//,   // block URL arguments (downloading scripts)
            /\.\.\/.*\.(j|t)s/,  // block path traversal to .js/.ts files
        ],
    },
    {
        command: "python",
        description: "Python interpreter",
        blockedArgs: [
            /-c\s/,
            /--eval/,
            /-m\s*(?!pytest|unittest)/,  // block -m except pytest/unittest
            /https?:\/\//,               // block URL args
            /\.\.\/.*\.py/,             // block path traversal to .py files
        ],
    },
    {
        command: "python3",
        description: "Python 3 interpreter",
        blockedArgs: [
            /-c\s/,
            /--eval/,
            /-m\s*(?!pytest|unittest)/,
            /https?:\/\//,
            /\.\.\/.*\.py/,
        ],
    },

    // ── Go / Rust / other ─────────────────────────────────────────────────────
    {
        command: "go",
        subcommands: ["test", "vet", "build", "run", "generate", "list", "doc", "env", "version"],
        description: "Go toolchain",
    },
    {
        command: "cargo",
        subcommands: ["test", "build", "check", "clippy", "fmt", "doc", "run", "tree"],
        description: "Rust cargo build tool",
    },
    {
        command: "make",
        description: "make build tool",
        blockedArgs: [/[;|&]\s*(rm|mv|cp|chmod|chown|dd|mkfs)/],
    },
];

/**
 * Build an effective allowlist by starting with the defaults,
 * removing denied commands, and adding extra entries.
 */
export function buildAllowlist(
    additional: ShellAllowlistEntry[] = [],
    denyFromDefault: string[] = []
): ShellAllowlistEntry[] {
    const denySet = new Set(denyFromDefault);
    const filtered = DEFAULT_SHELL_ALLOWLIST.filter((e) => !denySet.has(e.command));
    return [...filtered, ...additional];
}

/**
 * Sandbox enforces filesystem boundaries and shell restrictions.
 * All tool operations must go through the sandbox for validation.
 */
export class Sandbox {
    readonly projectRoot: string;
    readonly maxOutputSize: number;
    readonly shellTimeout: number;
    private readonly allowlist: AllowlistConfig;
    /** Where validated shell commands run (host process or throw-away container). */
    readonly executor: CommandExecutor;
    /** Set on the per-agent views created by `forAgent()` during orchestration. */
    private writer: { agentId: string; coordinator: FileCoordinator } | undefined;

    constructor(config: SandboxConfig) {
        const resolved = path.resolve(config.projectRoot);
        // Use realpathSync to normalize symlinks (e.g., /var → /private/var on macOS)
        this.projectRoot = fs.existsSync(resolved) ? fs.realpathSync(resolved) : resolved;
        this.maxOutputSize = config.maxOutputSize;
        this.shellTimeout = config.shellTimeout;
        this.allowlist = config.allowlist;
        this.executor = config.executor ?? new HostExecutor();
    }

    /**
     * Build a sandbox from the `sandbox:` block of config.yml: allowlist additions
     * and removals, and the execution backend. Environment overrides:
     *   PANTHEON_EXEC=docker|host, PANTHEON_EXEC_IMAGE, PANTHEON_EXEC_NETWORK=none|bridge
     */
    static fromConfig(projectRoot: string, settings?: Partial<SandboxSettings>): Sandbox {
        const additional: ShellAllowlistEntry[] = (settings?.additionalAllowlist ?? []).map((entry) => ({
            command: entry.command,
            description: entry.description ?? entry.command,
            ...(entry.subcommands ? { subcommands: entry.subcommands } : {}),
            ...(entry.blockedArgs ? { blockedArgs: entry.blockedArgs.map((pattern) => new RegExp(pattern)) } : {}),
        }));

        const execution = settings?.execution;
        const mode = (process.env["PANTHEON_EXEC"]?.trim() || execution?.mode || "host").toLowerCase();
        const image = process.env["PANTHEON_EXEC_IMAGE"]?.trim() || execution?.image;
        const network = process.env["PANTHEON_EXEC_NETWORK"]?.trim() || execution?.network;
        if (mode !== "host" && mode !== "docker") {
            throw new Error(`Unknown execution mode "${mode}" — use "host" or "docker".`);
        }
        if (network !== undefined && network !== "none" && network !== "bridge") {
            throw new Error(`Unknown execution network "${network}" — use "none" or "bridge".`);
        }

        return new Sandbox({
            projectRoot,
            maxOutputSize: 50_000,
            shellTimeout: 30_000,
            allowlist: {
                enabled: settings?.allowlistEnabled ?? true,
                entries: buildAllowlist(additional, settings?.denyFromDefault ?? []),
            },
            executor: mode === "docker"
                ? new DockerExecutor({
                    ...(image ? { image } : {}),
                    ...(network ? { network } : {}),
                    ...(execution?.memory ? { memory: execution.memory } : {}),
                    ...(execution?.cpus ? { cpus: execution.cpus } : {}),
                    ...(execution?.pidsLimit ? { pidsLimit: execution.pidsLimit } : {}),
                    ...(execution?.readOnlyProject !== undefined ? { readOnlyProject: execution.readOnlyProject } : {}),
                    ...(execution?.dockerPath ? { dockerPath: execution.dockerPath } : {}),
                })
                : new HostExecutor(),
        });
    }

    /**
     * A view of this sandbox for one agent of a multi-agent run. It behaves
     * identically, except that file writes go through `coordinator`, which
     * serialises them per file and stops agents overwriting each other's work.
     */
    forAgent(agentId: string, coordinator: FileCoordinator): Sandbox {
        const view = Object.create(this) as Sandbox;
        view.writer = { agentId, coordinator };
        return view;
    }

    /**
     * Wrap a file write. Outside orchestration this simply runs `write`; inside,
     * it is coordinated with the other agents (see FileCoordinator).
     */
    async guardWrite<T>(resolvedPath: string, mode: "create" | "edit", write: () => T | Promise<T>): Promise<T> {
        if (!this.writer) return write();
        return this.writer.coordinator.withWrite(resolvedPath, this.writer.agentId, mode, write);
    }

    /**
     * Validate a shell command against the allowlist, then run it through the
     * configured executor. Throws only when validation fails; execution problems
     * are reported in the result.
     */
    async exec(command: string, options: { timeoutMs?: number; maxBuffer?: number } = {}): Promise<ExecResult> {
        this.validateCommand(command);
        return this.executor.run({
            command,
            cwd: this.projectRoot,
            timeoutMs: options.timeoutMs ?? this.shellTimeout,
            ...(options.maxBuffer !== undefined ? { maxBuffer: options.maxBuffer } : {}),
        });
    }

    /**
     * Create a sandbox with sensible defaults and the default allowlist enabled.
     */
    static create(projectRoot: string): Sandbox {
        return new Sandbox({
            projectRoot,
            maxOutputSize: 50_000,
            shellTimeout: 30_000,
            allowlist: {
                enabled: true,
                entries: DEFAULT_SHELL_ALLOWLIST,
            },
        });
    }

    /**
     * Create a sandbox with a custom allowlist built from defaults + additions - denials.
     */
    static createWithAllowlist(
        projectRoot: string,
        additional: ShellAllowlistEntry[] = [],
        denyFromDefault: string[] = []
    ): Sandbox {
        return new Sandbox({
            projectRoot,
            maxOutputSize: 50_000,
            shellTimeout: 30_000,
            allowlist: {
                enabled: true,
                entries: buildAllowlist(additional, denyFromDefault),
            },
        });
    }

    /**
     * Resolves a relative or absolute path and verifies it's within projectRoot.
     * Throws if the resolved path escapes the jail.
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

        // Walk every existing ancestor segment to catch multi-hop symlink escapes.
        let ancestor = path.dirname(resolved);
        while (true) {
            if (fs.existsSync(ancestor)) {
                const realAncestor = fs.realpathSync(ancestor);
                this._assertWithinJail(realAncestor, inputPath);
                break;
            }
            const parent = path.dirname(ancestor);
            if (parent === ancestor) break;
            ancestor = parent;
        }

        return resolved;
    }

    /**
     * Validate a shell command against the allowlist.
     *
     * In allowlist mode (default):
     *   - Extracts the command binary name from the command string
     *   - Checks it against the allowlist
     *   - If found, checks subcommand restrictions
     *   - If found, checks blocked argument patterns
     *
     * In bypass mode (allowlist.enabled = false):
     *   - All commands are permitted (for development/testing only)
     *
     * The command line is first split into its simple commands (`a | b && c` is
     * three), and *every* one must pass — checking only the first word would let
     * `ls; curl … | sh` through. Command substitution, redirection to files and
     * background execution are refused outright.
     *
     * Returns the command unchanged if valid, throws with a clear reason if not.
     */
    validateCommand(command: string): string {
        if (!this.allowlist.enabled) {
            // Allowlist disabled — permit all commands
            return command;
        }

        if (!command.trim()) {
            throw new Error("Empty command is not allowed");
        }
        const segments = splitShellCommand(command);
        if (segments.length === 0) {
            throw new Error("Empty command is not allowed");
        }
        for (const segment of segments) {
            this.validateSimpleCommand(segment, command);
        }
        return command;
    }

    /** Allowlist, subcommand, blocked-argument and path checks for one simple command. */
    private validateSimpleCommand(trimmed: string, command: string): void {

        // Extract the command binary (first token, ignoring leading env var assignments)
        // e.g. "FOO=bar git status" → "git"
        //      "git status --short" → "git"
        const tokens = trimmed.split(/\s+/);
        let cmdBinary = "";
        let argStart = 0;

        for (let i = 0; i < tokens.length; i++) {
            const token = tokens[i]!;
            if (/^[A-Z_][A-Z0-9_]*=/.test(token)) {
                // env var assignment — skip
                argStart = i + 1;
                continue;
            }
            // Strip any path prefix: /usr/bin/git → git
            cmdBinary = token.split("/").pop() ?? token;
            argStart = i + 1;
            break;
        }

        if (!cmdBinary) {
            throw new Error(`Could not determine command binary from: ${command.slice(0, 100)}`);
        }

        // Look up the command in the allowlist
        const entry = this.allowlist.entries.find((e) => e.command === cmdBinary);

        if (!entry) {
            throw new Error(
                `Command "${cmdBinary}" is not on the allowlist. ` +
                `Use the permission system to request access, or add it to your config.`
            );
        }

        // Check subcommand restriction
        if (entry.subcommands && entry.subcommands.length > 0) {
            const subcommand = tokens[argStart];
            if (!subcommand) {
                throw new Error(
                    `"${cmdBinary}" requires a subcommand. ` +
                    `Allowed: ${entry.subcommands.join(", ")}`
                );
            }
            if (!entry.subcommands.includes(subcommand)) {
                throw new Error(
                    `"${cmdBinary} ${subcommand}" is not allowed. ` +
                    `Allowed subcommands: ${entry.subcommands.join(", ")}`
                );
            }
        }

        // Check blocked argument patterns
        if (entry.blockedArgs && entry.blockedArgs.length > 0) {
            const rest = tokens.slice(argStart).join(" ");
            for (const blockedPattern of entry.blockedArgs) {
                if (blockedPattern.test(rest)) {
                    throw new Error(
                        `Command "${command.slice(0, 100)}" contains a blocked argument pattern (${blockedPattern.toString()})`
                    );
                }
            }
        }

        // Validate any file path arguments are within the project root
        this.validateArgPaths(cmdBinary, tokens.slice(argStart));
    }

    /**
     * Validates that any file path arguments in the command are within the project root.
     * Applied after allowlist check passes, for commands that accept file paths.
     * Throws if any argument resolves to a path outside the jail.
     *
     * Commands checked: cat, head, tail, node, python, python3, stat, file, wc
     */
    private validateArgPaths(cmdBinary: string, argTokens: string[]): void {
        const PATH_ARG_COMMANDS = new Set([
            "cat", "head", "tail", "stat", "file", "wc",
            "node", "python", "python3",
        ]);

        if (!PATH_ARG_COMMANDS.has(cmdBinary)) return;

        for (const rawToken of argTokens) {
            // Compare what the shell will see: quotes are removed before the program runs,
            // so `cat "/etc/passwd"` must be treated exactly like `cat /etc/passwd`.
            const token = rawToken.replace(/["']/g, "");

            // The shell would expand these to paths this check cannot see
            if (token.startsWith("~") || token.includes("$")) {
                throw new Error(
                    `Argument "${rawToken}" uses shell expansion; pass a literal path inside the project instead.`
                );
            }

            // Skip flags (starting with -) and non-path-looking tokens
            if (token.startsWith("-")) continue;

            // Validate absolute paths and relative traversals outside current dir
            if (token.startsWith("/") || token.startsWith("../") || token === ".." || token.includes("/../")) {
                try {
                    this.resolvePath(token);
                } catch {
                    throw new Error(
                        `Argument "${token}" resolves to a path outside the project root. Access denied.`
                    );
                }
            }
        }
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

    /** Get the current allowlist entries (for display/debugging) */
    getAllowlistEntries(): ShellAllowlistEntry[] {
        return [...this.allowlist.entries];
    }

    /** Check if allowlist mode is enabled */
    get isAllowlistEnabled(): boolean {
        return this.allowlist.enabled;
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

/**
 * Split a shell command line into its simple commands, refusing constructs that
 * would run something the allowlist never gets to see.
 *
 * Allowed:  pipelines and lists (`|`, `&&`, `||`, `;`), quoting, `2>&1`-style
 *           descriptor duplication, and discarding output to /dev/null.
 * Refused:  command substitution (`$(…)`, backticks), process substitution,
 *           redirection to or from files, here-documents and background `&`.
 *
 * This is a deliberately conservative scanner, not a shell parser: when in doubt
 * it refuses.
 */
export function splitShellCommand(command: string): string[] {
    const segments: string[] = [];
    let current = "";
    let quote: "'" | '"' | null = null;

    const push = () => {
        const trimmed = current.trim();
        if (trimmed) segments.push(trimmed);
        current = "";
    };
    const refuse = (what: string): never => {
        throw new Error(`${what} is not allowed in shell commands.`);
    };

    for (let i = 0; i < command.length; i++) {
        const ch = command[i]!;
        const next = command[i + 1];

        if (quote === "'") {
            current += ch;
            if (ch === "'") quote = null;
            continue;
        }
        // Substitution is live inside double quotes as well as outside
        if (ch === "`") refuse("Command substitution (backticks)");
        if (ch === "$" && next === "(") refuse("Command substitution $(…)");

        if (quote === '"') {
            current += ch;
            if (ch === "\\" && next !== undefined) {
                current += next;
                i++;
            } else if (ch === '"') {
                quote = null;
            }
            continue;
        }

        if (ch === "\\" && next !== undefined) {
            if (next === "\n") refuse("Line continuation");
            current += ch + next;
            i++;
            continue;
        }
        if (ch === "'" || ch === '"') {
            quote = ch;
            current += ch;
            continue;
        }

        if (ch === "\n" || ch === "\r" || ch === ";") {
            push();
            continue;
        }
        if (ch === "|") {
            if (next === "|" || next === "&") i++; // `||`, `|&`
            push();
            continue;
        }
        if (ch === "&") {
            if (next === "&") {
                i++;
                push();
                continue;
            }
            if (next === ">") refuse("Output redirection to a file");
            refuse("Background execution (&)");
        }
        if (ch === "<") {
            refuse(next === "(" ? "Process substitution" : "Input redirection");
        }
        if (ch === ">") {
            if (next === "(") refuse("Process substitution");
            const rest = command.slice(i + 1);
            // `>&1`, `>&2` (optionally preceded by a descriptor digit already in `current`)
            const dup = /^&[0-9]/.exec(rest);
            if (dup) {
                current += ch + dup[0];
                i += dup[0].length;
                continue;
            }
            // `> /dev/null`, `>> /dev/null`
            const devNull = /^>?\s*\/dev\/null(?=$|[\s;|&)])/.exec(rest);
            if (devNull) {
                current += ch + devNull[0];
                i += devNull[0].length;
                continue;
            }
            refuse("Output redirection to a file (use the write_file tool)");
        }

        current += ch;
    }

    if (quote) throw new Error("Unterminated quote in shell command.");
    push();
    return segments;
}

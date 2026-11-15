import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";

/** Result of running one command. Never rejects — failures are reported in the fields. */
export interface ExecResult {
    stdout: string;
    stderr: string;
    /** Process exit code (1 when the process could not be started or was killed). */
    exitCode: number;
    timedOut: boolean;
    /** Set when the command never ran (shell or docker binary missing, image pull failed, …). */
    spawnError?: string;
}

export interface ExecRequest {
    /** A shell command line, already validated by the Sandbox. */
    command: string;
    /** Directory the command runs in — always the project root. */
    cwd: string;
    timeoutMs: number;
    /** Max bytes of stdout/stderr to keep. Default 1 MiB. */
    maxBuffer?: number;
}

/** Where shell commands issued by agents actually run. */
export interface CommandExecutor {
    readonly kind: "host" | "docker";
    run(request: ExecRequest): Promise<ExecResult>;
    /** One-line description for logs and `pantheon doctor`. */
    describe(): string;
}

/**
 * Environment variables that look like credentials. They are removed before a
 * command runs on the host, so a prompt-injected `echo $GROQ_API_KEY` (or a test
 * suite that dumps its environment) cannot exfiltrate them.
 */
const SECRET_PATTERNS = [
    /_API_KEY$/i, /_TOKEN$/i, /_SECRET$/i, /_PASSWORD$/i, /_KEY$/i, /_CREDENTIALS?$/i,
    /^DATABASE_URL$/i, /_DSN$/i, /^PANTHEON_JWT_SECRET$/i,
];

export function filterEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const filtered: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(env)) {
        if (!SECRET_PATTERNS.some((re) => re.test(key))) {
            filtered[key] = value;
        }
    }
    return filtered;
}

type ExecFileFn = typeof execFile;

function runProcess(
    exec: ExecFileFn,
    bin: string,
    args: string[],
    options: { cwd?: string; timeout: number; maxBuffer: number; env: NodeJS.ProcessEnv },
): Promise<ExecResult> {
    return new Promise((resolve) => {
        exec(bin, args, options, (error, stdout, stderr) => {
            const out = String(stdout ?? "");
            const err = String(stderr ?? "");
            if (!error) {
                resolve({ stdout: out, stderr: err, exitCode: 0, timedOut: false });
                return;
            }
            const code = (error as NodeJS.ErrnoException).code;
            if (typeof code === "string" && code !== "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
                // ENOENT / EACCES: the binary itself could not be started
                resolve({ stdout: out, stderr: err, exitCode: 1, timedOut: false, spawnError: error.message });
                return;
            }
            resolve({
                stdout: out,
                stderr: err,
                exitCode: typeof code === "number" ? code : 1,
                timedOut: Boolean((error as { killed?: boolean }).killed),
            });
        });
    });
}

function findShell(): string {
    if (process.env["SHELL"]) return process.env["SHELL"];
    // /bin/sh is not guaranteed in distroless / minimal images
    for (const candidate of ["/bin/sh", "/bin/bash", "/usr/bin/sh", "/busybox/sh"]) {
        if (fs.existsSync(candidate)) return candidate;
    }
    return "/bin/sh";
}

/** Runs commands directly on the machine Pantheon runs on (the local single-user default). */
export class HostExecutor implements CommandExecutor {
    readonly kind = "host" as const;
    private exec: ExecFileFn;

    constructor(exec: ExecFileFn = execFile) {
        this.exec = exec;
    }

    run({ command, cwd, timeoutMs, maxBuffer }: ExecRequest): Promise<ExecResult> {
        return runProcess(this.exec, findShell(), ["-c", command], {
            cwd,
            timeout: timeoutMs,
            maxBuffer: maxBuffer ?? 1024 * 1024,
            env: filterEnv(process.env),
        });
    }

    describe(): string {
        return "host (commands run directly on this machine)";
    }
}

export interface DockerExecutorOptions {
    /** Image the commands run in. It must contain the project's toolchain. Default: node:22-slim */
    image?: string;
    /** "none" (default) = no network at all; "bridge" = outbound network (e.g. for package installs). */
    network?: "none" | "bridge";
    /** Memory limit, docker syntax. Default: 2g */
    memory?: string;
    /** CPU limit. Default: 2 */
    cpus?: number;
    /** Max processes in the container (fork-bomb guard). Default: 512 */
    pidsLimit?: number;
    /** Mount the project read-only (agents can inspect and run, but not modify via shell). Default: false */
    readOnlyProject?: boolean;
    /** docker binary. Default: "docker" (podman works too). */
    dockerPath?: string;
}

/**
 * Runs each command in its own throw-away container.
 *
 * What the command can see and do is reduced to:
 *   • the project directory, mounted at the same path as on the host (so paths in
 *     commands and error messages match) — and nothing else from the host filesystem;
 *   • no network (unless configured), no host environment variables at all;
 *   • an unprivileged user (the server's uid:gid, so files it creates are owned
 *     correctly), no Linux capabilities, no privilege escalation, a read-only root
 *     filesystem with a private /tmp, and memory / CPU / process limits.
 * The container is removed when the command ends; on timeout it is killed
 * explicitly, because killing the `docker run` client alone leaves it running.
 */
export class DockerExecutor implements CommandExecutor {
    readonly kind = "docker" as const;
    readonly options: Required<DockerExecutorOptions>;
    private exec: ExecFileFn;

    constructor(options: DockerExecutorOptions = {}, exec: ExecFileFn = execFile) {
        this.options = {
            image: options.image ?? "node:22-slim",
            network: options.network ?? "none",
            memory: options.memory ?? "2g",
            cpus: options.cpus ?? 2,
            pidsLimit: options.pidsLimit ?? 512,
            readOnlyProject: options.readOnlyProject ?? false,
            dockerPath: options.dockerPath ?? "docker",
        };
        this.exec = exec;
    }

    /** The full `docker run` argument list for a command (exposed for tests and diagnostics). */
    buildArgs(command: string, cwd: string, containerName: string): string[] {
        const o = this.options;
        const user = typeof process.getuid === "function" && typeof process.getgid === "function"
            ? `${process.getuid()}:${process.getgid()}`
            : undefined;
        return [
            "run",
            "--rm",
            "--name", containerName,
            "--init",                               // reap zombies, forward signals
            "--network", o.network,
            "--cap-drop", "ALL",
            "--security-opt", "no-new-privileges",
            "--pids-limit", String(o.pidsLimit),
            "--memory", o.memory,
            "--cpus", String(o.cpus),
            "--read-only",                          // root filesystem; the project mount and /tmp stay writable
            "--tmpfs", "/tmp:rw,exec,nosuid,size=512m",
            ...(user ? ["--user", user] : []),
            "--env", "HOME=/tmp",                   // tools that insist on a writable home
            "--env", "CI=1",
            "--volume", `${cwd}:${cwd}${o.readOnlyProject ? ":ro" : ""}`,
            "--workdir", cwd,
            o.image,
            "sh", "-c", command,
        ];
    }

    async run({ command, cwd, timeoutMs, maxBuffer }: ExecRequest): Promise<ExecResult> {
        const name = `pantheon-exec-${randomUUID()}`;
        const result = await runProcess(this.exec, this.options.dockerPath, this.buildArgs(command, cwd, name), {
            // No cwd: the docker client does not need it, and it must not inherit secrets either
            timeout: timeoutMs,
            maxBuffer: maxBuffer ?? 1024 * 1024,
            env: { PATH: process.env["PATH"] ?? "/usr/local/bin:/usr/bin:/bin", ...dockerClientEnv() },
        });

        if (result.timedOut) {
            // The client was killed; make sure the container goes with it.
            await runProcess(this.exec, this.options.dockerPath, ["kill", name], {
                timeout: 10_000,
                maxBuffer: 64 * 1024,
                env: { PATH: process.env["PATH"] ?? "/usr/local/bin:/usr/bin:/bin", ...dockerClientEnv() },
            });
        }

        if (result.spawnError) {
            return {
                ...result,
                spawnError:
                    `Could not start "${this.options.dockerPath}" (${result.spawnError}). ` +
                    "Docker execution is enabled (sandbox.execution.mode = docker) but Docker is not available.",
            };
        }
        // docker's own failures (daemon down, image missing) use exit code 125
        if (result.exitCode === 125) {
            return { ...result, spawnError: `Docker could not run the command: ${result.stderr.trim().split("\n").at(-1) ?? "unknown error"}` };
        }
        return result;
    }

    describe(): string {
        const o = this.options;
        return `docker (image ${o.image}, network ${o.network}, ${o.memory} memory, ${o.cpus} cpus${o.readOnlyProject ? ", project read-only" : ""})`;
    }
}

/** Variables the docker *client* needs to find its daemon — passed to it, never into the container. */
function dockerClientEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const key of ["DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH", "HOME", "XDG_RUNTIME_DIR"]) {
        if (process.env[key]) env[key] = process.env[key];
    }
    return env;
}

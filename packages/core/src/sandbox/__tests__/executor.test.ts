import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { execFile } from "node:child_process";
import { DockerExecutor, HostExecutor, filterEnv } from "../executor.js";
import { Sandbox } from "../sandbox.js";
import { shellTool } from "../../tools/builtin/shell.js";

type ExecFile = typeof execFile;
interface Call { bin: string; args: string[]; options: { cwd?: string; timeout?: number; env?: NodeJS.ProcessEnv } }

/** A stand-in for child_process.execFile that records calls and returns scripted results. */
function fakeExec(respond: (call: Call) => { error?: Partial<NodeJS.ErrnoException> & { killed?: boolean }; stdout?: string; stderr?: string }) {
    const calls: Call[] = [];
    const exec = ((bin: string, args: string[], options: Call["options"], callback: (e: unknown, out: string, err: string) => void) => {
        const call = { bin, args, options };
        calls.push(call);
        const r = respond(call);
        callback(r.error ? Object.assign(new Error(r.error.message ?? "failed"), r.error) : null, r.stdout ?? "", r.stderr ?? "");
    }) as unknown as ExecFile;
    return { exec, calls };
}

describe("filterEnv", () => {
    it("removes credential-looking variables and keeps ordinary ones", () => {
        const filtered = filterEnv({
            PATH: "/usr/bin", HOME: "/home/u", NODE_ENV: "test", LANG: "C",
            GROQ_API_KEY: "a", GITHUB_TOKEN: "b", PANTHEON_GITHUB_CLIENT_SECRET: "c", DB_PASSWORD: "d",
            PANTHEON_JWT_SECRET: "e", DATABASE_URL: "postgres://u:pw@h/db", SENTRY_DSN: "f",
            SSH_PRIVATE_KEY: "g", GOOGLE_APPLICATION_CREDENTIALS: "h", PANTHEON_API_TOKEN: "i",
        });
        expect(Object.keys(filtered).sort()).toEqual(["HOME", "LANG", "NODE_ENV", "PATH"]);
    });
});

describe("HostExecutor", () => {
    let tmpDir: string;
    beforeEach(() => {
        tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "exec-host-")));
    });
    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("runs a real command in the given directory and reports output and exit code", async () => {
        const result = await new HostExecutor().run({ command: "pwd && echo oops >&2 && exit 3", cwd: tmpDir, timeoutMs: 5000 });
        expect(result).toEqual({ stdout: tmpDir + "\n", stderr: "oops\n", exitCode: 3, timedOut: false });
    });

    it("does not expose credentials to the command", async () => {
        process.env["PANTHEON_TEST_API_KEY"] = "super-secret-value";
        try {
            const result = await new HostExecutor().run({ command: "env", cwd: tmpDir, timeoutMs: 5000 });
            expect(result.stdout).not.toContain("super-secret-value");
            expect(result.stdout).toContain("PATH=");
        } finally {
            delete process.env["PANTHEON_TEST_API_KEY"];
        }
    });

    it("reports a timeout", async () => {
        const result = await new HostExecutor().run({ command: "sleep 5", cwd: tmpDir, timeoutMs: 100 });
        expect(result.timedOut).toBe(true);
        expect(result.exitCode).not.toBe(0);
    });

    it("reports a missing shell as a spawn error instead of throwing", async () => {
        const { exec } = fakeExec(() => ({ error: { code: "ENOENT", message: "spawn /bin/sh ENOENT" } }));
        const result = await new HostExecutor(exec).run({ command: "ls", cwd: tmpDir, timeoutMs: 1000 });
        expect(result.spawnError).toContain("ENOENT");
        expect(result.exitCode).toBe(1);
    });
});

describe("DockerExecutor", () => {
    const cwd = "/srv/projects/app";

    it("builds an isolated, unprivileged, resource-limited `docker run`", () => {
        const args = new DockerExecutor().buildArgs("npm test", cwd, "pantheon-exec-x");
        const joined = args.join(" ");

        expect(args[0]).toBe("run");
        expect(args).toContain("--rm");
        expect(joined).toContain("--network none");
        expect(joined).toContain("--cap-drop ALL");
        expect(joined).toContain("--security-opt no-new-privileges");
        expect(joined).toContain("--read-only");
        expect(joined).toContain("--pids-limit 512");
        expect(joined).toContain("--memory 2g");
        expect(joined).toContain("--cpus 2");
        expect(joined).toContain("--name pantheon-exec-x");
        // Only the project is mounted, at the same path, and it is the working directory
        expect(args.filter((a) => a === "--volume")).toHaveLength(1);
        expect(joined).toContain(`--volume ${cwd}:${cwd} --workdir ${cwd}`);
        // Never privileged, never the docker socket, never the host network or pid namespace
        expect(joined).not.toMatch(/--privileged|docker\.sock|--network host|--pid[= ]|--cap-add/);
        // Runs as the server's (non-root in production) uid:gid
        expect(joined).toContain(`--user ${process.getuid!()}:${process.getgid!()}`);
        // image, then the command as a single argument to sh -c
        expect(args.slice(-4)).toEqual(["node:22-slim", "sh", "-c", "npm test"]);
    });

    it("passes the command as one argument — it is never interpolated into the docker command line", () => {
        const nasty = `echo "; docker run --privileged -v /:/host evil" && true`;
        const args = new DockerExecutor().buildArgs(nasty, cwd, "n");
        expect(args.at(-1)).toBe(nasty);
        expect(args.filter((a) => a === "--privileged")).toEqual([]);
    });

    it("honours options: image, network, limits and a read-only project", () => {
        const args = new DockerExecutor({ image: "rust:1", network: "bridge", memory: "256m", cpus: 0.5, pidsLimit: 32, readOnlyProject: true })
            .buildArgs("cargo test", cwd, "n").join(" ");
        expect(args).toContain("--network bridge");
        expect(args).toContain("--memory 256m");
        expect(args).toContain("--cpus 0.5");
        expect(args).toContain("--pids-limit 32");
        expect(args).toContain(`--volume ${cwd}:${cwd}:ro`);
        expect(args).toContain(" rust:1 sh -c cargo test");
    });

    it("runs through docker and gives the container none of the server's environment", async () => {
        process.env["PANTHEON_TEST_API_KEY"] = "super-secret-value";
        try {
            const { exec, calls } = fakeExec(() => ({ stdout: "ok\n" }));
            const result = await new DockerExecutor({}, exec).run({ command: "ls", cwd, timeoutMs: 4000 });

            expect(result).toEqual({ stdout: "ok\n", stderr: "", exitCode: 0, timedOut: false });
            expect(calls).toHaveLength(1);
            expect(calls[0]!.bin).toBe("docker");
            expect(calls[0]!.options.timeout).toBe(4000);
            // Neither the docker client's environment nor the container's --env flags carry secrets
            expect(JSON.stringify(calls[0]!.options.env)).not.toContain("super-secret-value");
            const envFlags = calls[0]!.args.filter((_, i, all) => all[i - 1] === "--env");
            expect(envFlags).toEqual(["HOME=/tmp", "CI=1"]);
        } finally {
            delete process.env["PANTHEON_TEST_API_KEY"];
        }
    });

    it("propagates the command's own exit code and output", async () => {
        const { exec } = fakeExec(() => ({ error: { code: 2 as unknown as string }, stdout: "partial", stderr: "tests failed" }));
        const result = await new DockerExecutor({}, exec).run({ command: "npm test", cwd, timeoutMs: 1000 });
        expect(result).toEqual({ stdout: "partial", stderr: "tests failed", exitCode: 2, timedOut: false });
    });

    it("kills the container by name when the command times out", async () => {
        const { exec, calls } = fakeExec((call) => (call.args[0] === "run" ? { error: { killed: true } } : {}));
        const result = await new DockerExecutor({}, exec).run({ command: "sleep 999", cwd, timeoutMs: 50 });

        expect(result.timedOut).toBe(true);
        expect(calls).toHaveLength(2);
        const name = calls[0]!.args[calls[0]!.args.indexOf("--name") + 1];
        expect(name).toMatch(/^pantheon-exec-[0-9a-f-]{36}$/);
        expect(calls[1]!.args).toEqual(["kill", name]);
    });

    it("explains a missing docker binary", async () => {
        const { exec } = fakeExec(() => ({ error: { code: "ENOENT", message: "spawn docker ENOENT" } }));
        const result = await new DockerExecutor({}, exec).run({ command: "ls", cwd, timeoutMs: 1000 });
        expect(result.spawnError).toMatch(/Docker is not available/);
    });

    it("reports docker's own failures (daemon down, image missing) distinctly from the command's", async () => {
        const { exec } = fakeExec(() => ({
            error: { code: 125 as unknown as string },
            stderr: "Unable to find image 'nope:latest' locally\ndocker: Error response from daemon: pull access denied for nope.",
        }));
        const result = await new DockerExecutor({ image: "nope:latest" }, exec).run({ command: "ls", cwd, timeoutMs: 1000 });
        expect(result.spawnError).toMatch(/Docker could not run the command: .*pull access denied/);
    });

    it("gives every command its own container name", async () => {
        const { exec, calls } = fakeExec(() => ({}));
        const docker = new DockerExecutor({}, exec);
        await Promise.all([docker.run({ command: "a", cwd, timeoutMs: 1 }), docker.run({ command: "b", cwd, timeoutMs: 1 })]);
        const names = calls.map((c) => c.args[c.args.indexOf("--name") + 1]);
        expect(new Set(names).size).toBe(2);
    });
});

describe("shell tool with an executor", () => {
    let tmpDir: string;
    beforeEach(() => {
        tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "exec-shell-")));
    });
    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    function dockerSandbox(exec: ExecFile) {
        return new Sandbox({
            projectRoot: tmpDir,
            maxOutputSize: 50_000,
            shellTimeout: 30_000,
            allowlist: { enabled: true, entries: [{ command: "ls", description: "ls" }, { command: "echo", description: "echo" }] },
            executor: new DockerExecutor({}, exec),
        });
    }

    it("runs allowed commands inside the container, mounted at the project root", async () => {
        const { exec, calls } = fakeExec(() => ({ stdout: "file.txt\n" }));
        const output = await shellTool.execute({ command: "ls -la" }, dockerSandbox(exec));

        expect(output).toContain("file.txt");
        expect(output).toContain("Exit code: 0");
        expect(calls[0]!.bin).toBe("docker");
        expect(calls[0]!.args.join(" ")).toContain(`--volume ${tmpDir}:${tmpDir}`);
        expect(calls[0]!.args.at(-1)).toBe("ls -la");
    });

    it("still enforces the allowlist before anything reaches docker", async () => {
        const { exec, calls } = fakeExec(() => ({}));
        const output = await shellTool.execute({ command: "ls; rm -rf /" }, dockerSandbox(exec));
        expect(output).toMatch(/Error: .*not on the allowlist/);
        expect(calls).toHaveLength(0);
    });

    it("surfaces an unavailable docker as an error the model can read", async () => {
        const { exec } = fakeExec(() => ({ error: { code: "ENOENT", message: "spawn docker ENOENT" } }));
        const output = await shellTool.execute({ command: "ls" }, dockerSandbox(exec));
        expect(output).toMatch(/^Error: .*Docker is not available/);
    });

    it("reports timeouts and non-zero exits", async () => {
        const timedOut = fakeExec((call) => (call.args[0] === "run" ? { error: { killed: true }, stdout: "partial" } : {}));
        expect(await shellTool.execute({ command: "ls", timeout: 10 }, dockerSandbox(timedOut.exec))).toContain("Process killed (timeout after 10ms)");

        const failed = fakeExec(() => ({ error: { code: 7 as unknown as string }, stderr: "nope" }));
        const output = await shellTool.execute({ command: "ls" }, dockerSandbox(failed.exec));
        expect(output).toContain("STDERR:\nnope");
        expect(output).toContain("Exit code: 7");
    });
});

describe("reviewer verification uses the executor", () => {
    it("runs tsc and the test command through the sandbox executor, not directly on the host", async () => {
        const tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "exec-review-")));
        try {
            fs.writeFileSync(path.join(tmpDir, "tsconfig.json"), "{}");
            fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }));
            const run = vi.fn().mockResolvedValue({ stdout: "", stderr: "", exitCode: 0, timedOut: false });
            const sandbox = new Sandbox({
                projectRoot: tmpDir,
                maxOutputSize: 1000,
                shellTimeout: 1000,
                allowlist: { enabled: true, entries: [] }, // verification is not subject to the model's allowlist
                executor: { kind: "docker", run, describe: () => "fake" },
            });

            vi.resetModules();
            vi.doMock("../../orchestrator/store.js", () => ({
                OrchestrationStore: class {
                    startAgent = vi.fn();
                    completeAgent = vi.fn();
                    failAgent = vi.fn();
                },
            }));
            const { ReviewerAgent } = await import("../../orchestrator/reviewer.js");
            const gateway = { complete: vi.fn().mockResolvedValue({ message: { role: "assistant", content: "all good" }, usage: { inputTokens: 1, outputTokens: 1 } }) };

            const result = await new ReviewerAgent({
                gateway: gateway as never, reviewerModelId: "m", sessionId: "s", parentAgentId: "p", sandbox,
            }).review({ planId: "p1", sessionId: "s", originalPrompt: "x", tasks: [], createdAt: "now" }, []);

            expect(result.approved).toBe(true);
            expect(run.mock.calls.map((c) => c[0].command)).toEqual(["npx tsc --noEmit", "pnpm vitest run"]);
            expect(run.mock.calls.every((c) => c[0].cwd === tmpDir)).toBe(true);
        } finally {
            vi.doUnmock("../../orchestrator/store.js");
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

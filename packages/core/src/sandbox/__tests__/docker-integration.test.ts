/**
 * DockerExecutor against a real Docker daemon. Skipped when none is available
 * (most laptops running the suite, this repository's dev sandbox); runs in CI,
 * where the runner provides Docker. The unit tests check the command line we
 * build — this checks that the command line actually produces the isolation.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DockerExecutor } from "../executor.js";
import { Sandbox } from "../sandbox.js";
import { shellTool } from "../../tools/builtin/shell.js";

const IMAGE = process.env["PANTHEON_TEST_DOCKER_IMAGE"] ?? "alpine:3.20";

function dockerUsable(): boolean {
    try {
        execFileSync("docker", ["info"], { stdio: "ignore", timeout: 10_000 });
        // Make sure the image is present (pulls once; CI caches layers between steps)
        execFileSync("docker", ["pull", "--quiet", IMAGE], { stdio: "ignore", timeout: 180_000 });
        return true;
    } catch {
        return false;
    }
}

const available = dockerUsable();

describe.skipIf(!available)("DockerExecutor — real daemon", () => {
    let project: string;
    let outside: string;
    const docker = new DockerExecutor({ image: IMAGE });
    const run = (command: string, timeoutMs = 60_000) => docker.run({ command, cwd: project, timeoutMs });

    beforeAll(() => {
        // Under $HOME rather than /tmp: some Docker setups cannot bind-mount the system temp dir
        const base = fs.mkdtempSync(path.join(os.homedir(), ".pantheon-docker-test-"));
        project = path.join(base, "project");
        outside = path.join(base, "outside");
        fs.mkdirSync(project);
        fs.mkdirSync(outside);
        fs.writeFileSync(path.join(project, "inside.txt"), "visible\n");
        fs.writeFileSync(path.join(outside, "secret.txt"), "must not be readable\n");
    });
    afterAll(() => {
        fs.rmSync(path.dirname(project), { recursive: true, force: true });
    });

    it("runs the command in the project directory and returns its output and exit code", async () => {
        const result = await run("pwd && cat inside.txt && exit 3");
        expect(result.stdout).toBe(`${project}\nvisible\n`);
        expect(result.exitCode).toBe(3);
        expect(result.spawnError).toBeUndefined();
    }, 120_000);

    it("cannot see the host filesystem outside the project", async () => {
        const result = await run(`cat ${path.join(outside, "secret.txt")}; ls ${outside}; ls ${os.homedir()}`);
        expect(result.stdout).not.toContain("must not be readable");
        expect(result.stdout).not.toContain("secret.txt");
        expect(result.exitCode).not.toBe(0);
    }, 120_000);

    it("receives none of the server's environment", async () => {
        process.env["PANTHEON_TEST_API_KEY"] = "super-secret-value";
        try {
            const result = await run("env");
            expect(result.stdout).not.toContain("super-secret-value");
            expect(result.stdout).toContain("HOME=/tmp");
        } finally {
            delete process.env["PANTHEON_TEST_API_KEY"];
        }
    }, 120_000);

    it("has no network", async () => {
        const result = await run("wget -q -T 3 -O - http://1.1.1.1/ ; echo status=$?");
        expect(result.stdout).not.toContain("status=0");
    }, 120_000);

    it("cannot write outside the project and /tmp, and has no privileges", async () => {
        const result = await run("touch /etc/pwned 2>&1; echo etc=$?; touch /tmp/ok; echo tmp=$?; id -u");
        expect(result.stdout).toContain("etc=1");
        expect(result.stdout).toContain("tmp=0");
        expect(result.stdout.trim().split("\n").at(-1)).toBe(String(process.getuid!()));
    }, 120_000);

    it("files it creates in the project appear on the host, owned by the server's user", async () => {
        const result = await run("echo built > artifact.txt");
        expect(result.exitCode).toBe(0);
        const file = path.join(project, "artifact.txt");
        expect(fs.readFileSync(file, "utf-8")).toBe("built\n");
        expect(fs.statSync(file).uid).toBe(process.getuid!());
    }, 120_000);

    it("a read-only project mount rejects writes", async () => {
        const readOnly = new DockerExecutor({ image: IMAGE, readOnlyProject: true });
        const result = await readOnly.run({ command: "echo x > nope.txt", cwd: project, timeoutMs: 60_000 });
        expect(result.exitCode).not.toBe(0);
        expect(fs.existsSync(path.join(project, "nope.txt"))).toBe(false);
    }, 120_000);

    it("kills and removes the container when the command times out", async () => {
        const result = await run("sleep 300", 3_000);
        expect(result.timedOut).toBe(true);
        const left = execFileSync("docker", ["ps", "-a", "--filter", "name=pantheon-exec-", "--format", "{{.Names}}"], { encoding: "utf-8" });
        expect(left.trim()).toBe("");
    }, 120_000);

    it("the shell tool works through it end to end", async () => {
        const sandbox = new Sandbox({
            projectRoot: project,
            maxOutputSize: 50_000,
            shellTimeout: 60_000,
            allowlist: { enabled: true, entries: [{ command: "ls", description: "ls" }, { command: "cat", description: "cat" }] },
            executor: docker,
        });
        const output = await shellTool.execute({ command: "ls && cat inside.txt" }, sandbox);
        expect(output).toContain("inside.txt");
        expect(output).toContain("visible");
        expect(output).toContain("Exit code: 0");
    }, 120_000);

    it("reports a missing image as a docker failure, not as the command's", async () => {
        const missing = new DockerExecutor({ image: "pantheon-test/does-not-exist:never" });
        const result = await missing.run({ command: "true", cwd: project, timeoutMs: 60_000 });
        expect(result.spawnError).toMatch(/Docker could not run the command/);
    }, 120_000);
});

describe.skipIf(available)("DockerExecutor — real daemon", () => {
    it.skip("skipped: no Docker daemon available on this machine", () => {});
});

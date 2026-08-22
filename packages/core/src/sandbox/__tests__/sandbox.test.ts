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

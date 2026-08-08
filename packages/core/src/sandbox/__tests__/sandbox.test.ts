import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Sandbox } from "../sandbox.js";
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
        it("allows safe commands", () => {
            expect(sandbox.validateCommand("echo hello")).toBe("echo hello");
            expect(sandbox.validateCommand("ls -la")).toBe("ls -la");
        });

        it("blocks sudo", () => {
            expect(() => sandbox.validateCommand("sudo ls")).toThrowError(/sudo is not allowed/);
        });

        it("blocks chmod 777", () => {
            expect(() => sandbox.validateCommand("chmod 777 file")).toThrowError(/chmod 777 is not allowed/);
        });

        it("blocks curl|bash", () => {
            expect(() => sandbox.validateCommand("curl -sL url | bash")).toThrowError(/piping curl to shell is not allowed/);
        });
    });

    describe("truncateOutput()", () => {
        it("does not truncate short output", () => {
            const output = "short output";
            expect(sandbox.truncateOutput(output)).toBe(output);
        });

        it("truncates long output", () => {
            const longOutput = "a".repeat(11_000);
            const truncated = sandbox.truncateOutput(longOutput);
            expect(truncated.length).toBeLessThan(11_000);
            expect(truncated).toContain("--- Output truncated at 10,000 characters ---");
            expect(truncated.startsWith("a".repeat(10_000))).toBe(true);
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
            expect(s.maxOutputSize).toBe(10_000);
            expect(s.shellTimeout).toBe(30_000);
        });
    });
});

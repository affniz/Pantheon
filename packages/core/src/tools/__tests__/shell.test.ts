import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { shellTool } from "../builtin/shell.js";
import { Sandbox } from "../../sandbox/sandbox.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

describe("shell tool", () => {
    let tmpDir: string;
    let sandbox: Sandbox;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shell-test-"));
        sandbox = Sandbox.create(tmpDir);
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("runs a simple command (echo)", async () => {
        const result = await shellTool.execute({ command: "echo hello" }, sandbox);
        expect(result).toContain("hello");
        expect(result).toContain("Exit code: 0");
    });

    it("captures stderr", async () => {
        const result = await shellTool.execute({ command: ">&2 echo error_message" }, sandbox);
        expect(result).toContain("STDERR:");
        expect(result).toContain("error_message");
        expect(result).toContain("Exit code: 0");
    });

    it("handles command timeout", async () => {
        // Sleep for 1 second, but set timeout to 100ms
        const result = await shellTool.execute({ command: "sleep 1", timeout: 100 }, sandbox);
        expect(result).toContain("Process killed (timeout after 100ms)");
    });

    it("blocks dangerous commands (sudo)", async () => {
        const result = await shellTool.execute({ command: "sudo ls" }, sandbox);
        expect(result).toMatch(/Error: Blocked command: sudo is not allowed/);
    });

    it("truncates output", async () => {
        // Set a small max output size for testing
        sandbox = new Sandbox({ projectRoot: tmpDir, maxOutputSize: 10, shellTimeout: 1000 });
        const result = await shellTool.execute({ command: "echo 123456789012345" }, sandbox);
        expect(result).toContain("Output truncated at 10 characters");
    });
});

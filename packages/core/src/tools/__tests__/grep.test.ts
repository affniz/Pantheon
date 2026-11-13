import { describe, it, expect, beforeEach, afterEach, beforeAll } from "vitest";
import { grepTool } from "../builtin/grep.js";
import { Sandbox } from "../../sandbox/sandbox.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFileSync } from "node:child_process";

// Detect whether ripgrep is available in PATH at test startup
let rgAvailable = false;
try { execFileSync('rg', ['--version'], { stdio: 'pipe' }); rgAvailable = true; } catch { /* not installed */ }

describe("grep tool", () => {
    let tmpDir: string;
    let sandbox: Sandbox;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "grep-test-"));
        sandbox = Sandbox.create(tmpDir);
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("has tool name grep", () => {
        expect(grepTool.definition.name).toBe("grep");
    });

    it("has safety level safe", () => {
        expect(grepTool.definition.safety).toBe("safe");
    });

    it("returns error when pattern is empty", async () => {
        const result = await grepTool.execute({ pattern: "" }, sandbox);
        expect(result).toMatch(/Error:.*pattern.*must be a non-empty string/);
    });

    it("finds a pattern in a real file", async () => {
        if (!rgAvailable) return;
        const src = "export function hello() { return 42; }\n";
        fs.writeFileSync(path.join(tmpDir, "sample.ts"), src, "utf-8");
        const result = await grepTool.execute({ pattern: "hello", path: "sample.ts" }, sandbox);
        expect(result).toContain("hello");
        expect(result).toContain("sample.ts");
    });

    it("returns No matches found when pattern not present", async () => {
        if (!rgAvailable) return;
        fs.writeFileSync(path.join(tmpDir, "empty.ts"), "const x = 1;\n", "utf-8");
        const result = await grepTool.execute({ pattern: "nothinghere_xyz789", path: "empty.ts" }, sandbox);
        expect(result).toBe("No matches found.");
    });

    it("respects fileGlob — only .ts files matched", async () => {
        if (!rgAvailable) return;
        fs.writeFileSync(path.join(tmpDir, "code.ts"), "export const hello = 1;\n", "utf-8");
        fs.writeFileSync(path.join(tmpDir, "doc.md"), "hello world\n", "utf-8");

        const tsResult = await grepTool.execute({ pattern: "hello", fileGlob: "*.ts" }, sandbox);
        expect(tsResult).toContain("code.ts");

        const mdResult = await grepTool.execute({ pattern: "hello", fileGlob: "*.md" }, sandbox);
        expect(mdResult).not.toContain("code.ts");
    });

    it("returns context lines when contextLines > 0", async () => {
        if (!rgAvailable) return;
        const src = ["line1", "MATCH_THIS", "line3"].join("\n") + "\n";
        fs.writeFileSync(path.join(tmpDir, "ctx.ts"), src, "utf-8");
        const result = await grepTool.execute({ pattern: "MATCH_THIS", contextLines: 1, path: "ctx.ts" }, sandbox);
        expect(result).toContain("line1");
        expect(result).toContain("line3");
    });

    it("caseInsensitive: finds match regardless of case", async () => {
        if (!rgAvailable) return;
        fs.writeFileSync(path.join(tmpDir, "case.ts"), "const Hello = 1;\n", "utf-8");
        const result = await grepTool.execute({ pattern: "hello", caseInsensitive: true, path: "case.ts" }, sandbox);
        expect(result).toContain("Hello");
    });
});

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { editFileTool } from "../builtin/edit-file.js";
import { Sandbox } from "../../sandbox/sandbox.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

describe("edit_file tool", () => {
    let tmpDir: string;
    let sandbox: Sandbox;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "edit-file-test-"));
        sandbox = Sandbox.create(tmpDir);
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("has tool name edit_file", () => {
        expect(editFileTool.definition.name).toBe("edit_file");
    });

    it("has safety level destructive", () => {
        expect(editFileTool.definition.safety).toBe("destructive");
    });

    it("replaces targetContent with replacementContent", async () => {
        const filePath = path.join(tmpDir, "test.ts");
        fs.writeFileSync(filePath, `const x = 1;\nconst y = 2;\n`, "utf-8");
        const result = await editFileTool.execute(
            { path: "test.ts", targetContent: "const x = 1;", replacementContent: "const x = 42;" },
            sandbox
        );
        expect(result).toContain("Successfully edited");
        const content = fs.readFileSync(filePath, "utf-8");
        expect(content).toBe(`const x = 42;\nconst y = 2;\n`);
    });

    it("returns error when targetContent is not found", async () => {
        const filePath = path.join(tmpDir, "test.ts");
        fs.writeFileSync(filePath, `const x = 1;\n`, "utf-8");
        const result = await editFileTool.execute(
            { path: "test.ts", targetContent: "const z = 99;", replacementContent: "const z = 0;" },
            sandbox
        );
        expect(result).toMatch(/Error: targetContent not found/);
        expect(fs.readFileSync(filePath, "utf-8")).toBe(`const x = 1;\n`);
    });

    it("replaces only the first occurrence when targetContent appears multiple times", async () => {
        const filePath = path.join(tmpDir, "dup.ts");
        fs.writeFileSync(filePath, `foo\nfoo\nfoo\n`, "utf-8");
        await editFileTool.execute(
            { path: "dup.ts", targetContent: "foo", replacementContent: "bar" },
            sandbox
        );
        const content = fs.readFileSync(filePath, "utf-8");
        expect(content).toBe(`bar\nfoo\nfoo\n`);
    });

    it("returns error for missing file", async () => {
        const result = await editFileTool.execute(
            { path: "nonexistent.ts", targetContent: "x", replacementContent: "y" },
            sandbox
        );
        expect(result).toMatch(/Error reading file:/);
    });

    it("enforces sandbox jail", async () => {
        const result = await editFileTool.execute(
            { path: "../outside.ts", targetContent: "x", replacementContent: "y" },
            sandbox
        );
        expect(result).toMatch(/Error/);
    });

    it("returns error when path is not a string", async () => {
        const result = await editFileTool.execute(
            { path: 42, targetContent: "x", replacementContent: "y" },
            sandbox
        );
        expect(result).toMatch(/Error:.*path.*must be a string/);
    });
});

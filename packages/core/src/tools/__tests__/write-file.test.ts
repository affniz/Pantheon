import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileTool } from "../builtin/write-file.js";
import { Sandbox } from "../../sandbox/sandbox.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

describe("write_file tool", () => {
    let tmpDir: string;
    let sandbox: Sandbox;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "write-file-test-"));
        sandbox = Sandbox.create(tmpDir);
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("has tool name write_file", () => {
        expect(writeFileTool.definition.name).toBe("write_file");
    });

    it("creates a new file", async () => {
        const result = await writeFileTool.execute({ path: "test.txt", content: "hello" }, sandbox);
        expect(result).toContain("Successfully wrote 1 lines");
        
        const content = fs.readFileSync(path.join(tmpDir, "test.txt"), "utf-8");
        expect(content).toBe("hello");
    });

    it("creates parent directories", async () => {
        await writeFileTool.execute({ path: "deep/dir/test.txt", content: "nested" }, sandbox);
        
        const content = fs.readFileSync(path.join(tmpDir, "deep/dir/test.txt"), "utf-8");
        expect(content).toBe("nested");
    });

    it("overwrites existing file", async () => {
        const filePath = path.join(tmpDir, "test.txt");
        fs.writeFileSync(filePath, "old content", "utf-8");

        await writeFileTool.execute({ path: "test.txt", content: "new content" }, sandbox);
        
        const content = fs.readFileSync(filePath, "utf-8");
        expect(content).toBe("new content");
    });

    it("enforces sandbox jail", async () => {
        const result = await writeFileTool.execute({ path: "../test.txt", content: "escape" }, sandbox);
        expect(result).toMatch(/Error writing file:.*Access denied/);
    });
});

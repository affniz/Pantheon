import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileTool } from "../builtin/read-file.js";
import { Sandbox } from "../../sandbox/sandbox.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

describe("read_file tool", () => {
    let tmpDir: string;
    let sandbox: Sandbox;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "read-file-test-"));
        sandbox = Sandbox.create(tmpDir);
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("has tool name read_file", () => {
        expect(readFileTool.definition.name).toBe("read_file");
    });

    it("reads an existing file", async () => {
        const filePath = path.join(tmpDir, "test.txt");
        fs.writeFileSync(filePath, "hello world", "utf-8");

        const result = await readFileTool.execute({ path: "test.txt" }, sandbox);
        expect(result).toBe("hello world");
    });

    it("returns error message for missing file", async () => {
        const result = await readFileTool.execute({ path: "missing.txt" }, sandbox);
        expect(result).toMatch(/Error reading file:/);
    });

    it("returns error message when reading a directory", async () => {
        const dirPath = path.join(tmpDir, "dir");
        fs.mkdirSync(dirPath);

        const result = await readFileTool.execute({ path: "dir" }, sandbox);
        expect(result).toMatch(/is a directory, not a file/);
    });

    it("caps output using maxLines", async () => {
        const filePath = path.join(tmpDir, "lines.txt");
        const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n");
        fs.writeFileSync(filePath, lines, "utf-8");

        const result = await readFileTool.execute({ path: "lines.txt", maxLines: 5 }, sandbox);
        expect(result).toContain("line 5");
        expect(result).not.toContain("line 6");
        expect(result).toContain("Showing first 5 of 10 lines");
    });

    it("enforces sandbox path (path outside jail)", async () => {
        const result = await readFileTool.execute({ path: "../outside.txt" }, sandbox);
        expect(result).toMatch(/Error reading file:.*Access denied/);
    });
});

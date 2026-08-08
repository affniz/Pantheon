import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { listDirectoryTool } from "../builtin/list-directory.js";
import { Sandbox } from "../../sandbox/sandbox.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

describe("list_directory tool", () => {
    let tmpDir: string;
    let sandbox: Sandbox;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "list-dir-test-"));
        sandbox = Sandbox.create(tmpDir);
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("has tool name list_directory", () => {
        expect(listDirectoryTool.definition.name).toBe("list_directory");
    });

    it("lists a flat directory", async () => {
        fs.writeFileSync(path.join(tmpDir, "a.txt"), "hello");
        fs.writeFileSync(path.join(tmpDir, "b.txt"), "world");

        const result = await listDirectoryTool.execute({ path: "." }, sandbox);
        expect(result).toContain("a.txt");
        expect(result).toContain("b.txt");
    });

    it("lists recursively", async () => {
        fs.mkdirSync(path.join(tmpDir, "dir"));
        fs.writeFileSync(path.join(tmpDir, "dir/a.txt"), "hello");

        const result = await listDirectoryTool.execute({ path: ".", recursive: true }, sandbox);
        expect(result).toContain("dir/");
        expect(result).toContain("dir/a.txt");
    });

    it("returns message for empty directory", async () => {
        const result = await listDirectoryTool.execute({ path: "." }, sandbox);
        expect(result).toMatch(/is empty/);
    });

    it("returns error if not a directory", async () => {
        fs.writeFileSync(path.join(tmpDir, "file.txt"), "content");
        const result = await listDirectoryTool.execute({ path: "file.txt" }, sandbox);
        expect(result).toMatch(/not a directory/);
    });

    it("enforces sandbox jail", async () => {
        const result = await listDirectoryTool.execute({ path: "../" }, sandbox);
        expect(result).toMatch(/Error listing directory:.*Access denied/);
    });
});

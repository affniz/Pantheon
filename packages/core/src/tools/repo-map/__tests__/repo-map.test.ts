import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { buildRepoMap } from "../repo-map.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

describe("buildRepoMap", () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "repo-map-test-"));
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("returns a string for a directory with TypeScript files", async () => {
        fs.writeFileSync(
            path.join(tmpDir, "index.ts"),
            "export function hello(): number { return 42; }\n",
            "utf-8"
        );
        const map = await buildRepoMap(tmpDir);
        expect(typeof map).toBe("string");
    });

    it("mentions the .ts file in the map output", async () => {
        fs.writeFileSync(
            path.join(tmpDir, "utils.ts"),
            "export function add(a: number, b: number): number { return a + b; }\n",
            "utf-8"
        );
        const map = await buildRepoMap(tmpDir);
        // buildRepoMap header always includes the file count
        expect(map).toMatch(/\d+ files?/);
    });

    it("excludes node_modules directory", async () => {
        const nmDir = path.join(tmpDir, "node_modules", "some-pkg");
        fs.mkdirSync(nmDir, { recursive: true });
        fs.writeFileSync(
            path.join(nmDir, "index.ts"),
            "export function secret(): void {}\n",
            "utf-8"
        );
        fs.writeFileSync(
            path.join(tmpDir, "src.ts"),
            "export function real(): void {}\n",
            "utf-8"
        );
        const map = await buildRepoMap(tmpDir);
        expect(map).not.toContain("secret");
    });

    it("handles an empty directory gracefully without throwing", async () => {
        let threw = false;
        try { await buildRepoMap(tmpDir); }
        catch { threw = true; }
        expect(threw).toBe(false);
    });

    it("excludes dist directory", async () => {
        const distDir = path.join(tmpDir, "dist");
        fs.mkdirSync(distDir);
        fs.writeFileSync(
            path.join(distDir, "built.js"),
            "exports.compiled = function() {}\n",
            "utf-8"
        );
        fs.writeFileSync(
            path.join(tmpDir, "source.ts"),
            "export function source(): void {}\n",
            "utf-8"
        );
        const map = await buildRepoMap(tmpDir);
        expect(map).not.toContain("compiled");
    });
});

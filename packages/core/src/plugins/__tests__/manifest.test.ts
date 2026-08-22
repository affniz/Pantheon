import { describe, it, expect } from "vitest";
import { validateManifest, parseManifest } from "../manifest.js";

describe("validateManifest()", () => {
    it("accepts a valid inline-tool manifest", () => {
        const result = validateManifest({
            name: "my-plugin",
            version: "1.0.0",
            description: "A test plugin",
            tools: [{
                name: "do_thing",
                description: "Does a thing",
                handler: "./src/handler.js",
                safety: "safe",
                parameters: { type: "object", properties: {}, required: [] },
            }],
        });
        expect(result.valid).toBe(true);
        expect(result.errors).toHaveLength(0);
    });

    it("accepts a valid MCP manifest", () => {
        const result = validateManifest({
            name: "mcp-plugin",
            version: "0.1.0",
            description: "An MCP plugin",
            mcp: { transport: "stdio", command: "node", args: ["server.js"] },
        });
        expect(result.valid).toBe(true);
    });

    it("accepts a scoped npm name", () => {
        const result = validateManifest({
            name: "@pantheon-plugins/github",
            version: "1.0.0",
            description: "GitHub plugin",
            mcp: { transport: "sse", url: "https://mcp.example.com" },
        });
        expect(result.valid).toBe(true);
    });

    it("rejects null input", () => {
        const result = validateManifest(null);
        expect(result.valid).toBe(false);
        expect(result.errors.length).toBeGreaterThan(0);
    });

    it("rejects missing required fields", () => {
        const result = validateManifest({ name: "foo" });
        expect(result.valid).toBe(false);
        const fields = result.errors.map((e) => e.field);
        expect(fields).toContain("version");
        expect(fields).toContain("description");
    });

    it("rejects invalid version format", () => {
        const result = validateManifest({
            name: "foo",
            version: "not-semver",
            description: "test",
            tools: [{ name: "t", description: "d", handler: "./h.js", safety: "safe", parameters: { type: "object", properties: {}, required: [] } }],
        });
        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.field === "version")).toBe(true);
    });

    it("rejects manifest with no tools and no mcp", () => {
        const result = validateManifest({
            name: "empty",
            version: "1.0.0",
            description: "nothing here",
        });
        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.field === "tools/mcp")).toBe(true);
    });

    it("rejects invalid tool safety value", () => {
        const result = validateManifest({
            name: "foo",
            version: "1.0.0",
            description: "test",
            tools: [{
                name: "t",
                description: "d",
                handler: "./h.js",
                safety: "maybe", // invalid
                parameters: { type: "object", properties: {}, required: [] },
            }],
        });
        expect(result.valid).toBe(false);
    });

    it("rejects stdio MCP without command", () => {
        const result = validateManifest({
            name: "foo",
            version: "1.0.0",
            description: "test",
            mcp: { transport: "stdio" }, // missing command
        });
        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.field === "mcp.command")).toBe(true);
    });

    it("rejects SSE MCP without url", () => {
        const result = validateManifest({
            name: "foo",
            version: "1.0.0",
            description: "test",
            mcp: { transport: "sse" }, // missing url
        });
        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.field === "mcp.url")).toBe(true);
    });
});

describe("parseManifest()", () => {
    it("returns the manifest on success", () => {
        const manifest = parseManifest({
            name: "test-plugin",
            version: "1.0.0",
            description: "Test",
            mcp: { transport: "stdio", command: "node" },
        });
        expect(manifest.name).toBe("test-plugin");
        expect(manifest.version).toBe("1.0.0");
    });

    it("throws on invalid manifest", () => {
        expect(() => parseManifest({ name: "bad" })).toThrow(/Invalid plugin manifest/);
    });
});

import type { PluginManifest, PluginValidationResult, PluginValidationError } from "./types.js";

/** Validate a plugin manifest object. Returns validation result with all errors found. */
export function validateManifest(manifest: unknown): PluginValidationResult {
    const errors: PluginValidationError[] = [];

    if (!manifest || typeof manifest !== "object") {
        return { valid: false, errors: [{ field: "root", message: "Manifest must be a JSON object" }] };
    }

    const m = manifest as Record<string, unknown>;

    // Required string fields
    for (const field of ["name", "version", "description"] as const) {
        if (typeof m[field] !== "string" || !(m[field] as string).trim()) {
            errors.push({ field, message: `"${field}" is required and must be a non-empty string` });
        }
    }

    // Name format: must be a valid npm-style package name
    if (typeof m.name === "string" && m.name.trim()) {
        const validName = /^(@[a-z0-9-]+\/)?[a-z0-9][a-z0-9-_.]*$/i.test(m.name);
        if (!validName) {
            errors.push({ field: "name", message: `"name" must be a valid package name (e.g. "my-plugin" or "@scope/plugin")` });
        }
    }

    // Version: basic semver format
    if (typeof m.version === "string" && m.version.trim()) {
        const validVersion = /^\d+\.\d+\.\d+/.test(m.version);
        if (!validVersion) {
            errors.push({ field: "version", message: `"version" must follow semver format (e.g. "1.0.0")` });
        }
    }

    // Must have either tools or mcp (or both)
    const hasTools = Array.isArray(m.tools) && m.tools.length > 0;
    const hasMcp = m.mcp !== undefined && m.mcp !== null;
    if (!hasTools && !hasMcp) {
        errors.push({ field: "tools/mcp", message: "Plugin must define at least one tool or an MCP server configuration" });
    }

    // Validate tools array if present
    if (m.tools !== undefined) {
        if (!Array.isArray(m.tools)) {
            errors.push({ field: "tools", message: "\"tools\" must be an array" });
        } else {
            for (let i = 0; i < m.tools.length; i++) {
                const tool = m.tools[i] as Record<string, unknown>;
                const prefix = `tools[${i}]`;
                for (const field of ["name", "description", "handler"]) {
                    if (typeof tool[field] !== "string" || !(tool[field] as string).trim()) {
                        errors.push({ field: `${prefix}.${field}`, message: `"${field}" is required` });
                    }
                }
                if (tool.safety !== "safe" && tool.safety !== "destructive") {
                    errors.push({ field: `${prefix}.safety`, message: '"safety" must be "safe" or "destructive"' });
                }
            }
        }
    }

    // Validate MCP config if present
    if (hasMcp) {
        const mcp = m.mcp as Record<string, unknown>;
        if (mcp.transport !== "stdio" && mcp.transport !== "sse") {
            errors.push({ field: "mcp.transport", message: '"mcp.transport" must be "stdio" or "sse"' });
        }
        if (mcp.transport === "stdio" && (typeof mcp.command !== "string" || !mcp.command.trim())) {
            errors.push({ field: "mcp.command", message: '"mcp.command" is required for stdio transport' });
        }
        if (mcp.transport === "sse" && (typeof mcp.url !== "string" || !mcp.url.trim())) {
            errors.push({ field: "mcp.url", message: '"mcp.url" is required for SSE transport' });
        }
    }

    // Validate env specs if present
    if (m.env !== undefined) {
        if (typeof m.env !== "object" || Array.isArray(m.env)) {
            errors.push({ field: "env", message: '"env" must be an object' });
        } else {
            for (const [key, val] of Object.entries(m.env as Record<string, unknown>)) {
                const spec = val as Record<string, unknown>;
                if (typeof spec.description !== "string") {
                    errors.push({ field: `env.${key}.description`, message: "description is required" });
                }
                if (typeof spec.required !== "boolean") {
                    errors.push({ field: `env.${key}.required`, message: "required must be a boolean" });
                }
            }
        }
    }

    return { valid: errors.length === 0, errors };
}

/** Parse and validate a manifest from a raw JSON/object value. Throws on validation errors. */
export function parseManifest(raw: unknown): PluginManifest {
    const result = validateManifest(raw);
    if (!result.valid) {
        const messages = result.errors.map((e) => `  - ${e.field}: ${e.message}`).join("\n");
        throw new Error(`Invalid plugin manifest:\n${messages}`);
    }
    return raw as PluginManifest;
}

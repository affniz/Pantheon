import type { ToolRegistry } from "../tool-registry.js";
import { readFileTool } from "./read-file.js";
import { writeFileTool } from "./write-file.js";
import { listDirectoryTool } from "./list-directory.js";
import { shellTool } from "./shell.js";

/**
 * Register all built-in tools with the given registry.
 */
export function registerBuiltinTools(registry: ToolRegistry): void {
    registry.register(readFileTool);
    registry.register(writeFileTool);
    registry.register(listDirectoryTool);
    registry.register(shellTool);
}

export { readFileTool, writeFileTool, listDirectoryTool, shellTool };

import fs from "node:fs";
import path from "node:path";

/** Root that remote users are confined to: PANTHEON_WORKSPACE, else the server's working directory. */
export function workspaceRoot(): string {
    const configured = process.env["PANTHEON_WORKSPACE"]?.trim();
    const root = path.resolve(configured || process.cwd());
    try {
        return fs.realpathSync(root);
    } catch {
        return root;
    }
}

/**
 * Validate the `workingDir` of a chat request.
 *
 * It must be an existing directory. When `confine` is set (authentication is
 * required, i.e. the caller is not simply the local user) it must additionally
 * lie inside the workspace root — symlinks resolved, so a link pointing out of
 * the workspace does not count as inside.
 */
export function resolveWorkingDir(requested: string, confine: boolean): { dir: string } | { error: string } {
    let dir: string;
    try {
        dir = fs.realpathSync(path.resolve(requested));
        if (!fs.statSync(dir).isDirectory()) return { error: "workingDir is not a directory" };
    } catch {
        return { error: "workingDir does not exist" };
    }

    if (confine) {
        const root = workspaceRoot();
        const inside = dir === root || dir.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
        if (!inside) {
            return { error: "workingDir must be inside the server's workspace (PANTHEON_WORKSPACE)" };
        }
    }
    return { dir };
}

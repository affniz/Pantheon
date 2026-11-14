import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const PANTHEON_DIR = path.join(os.homedir(), ".pantheon");
const PID_FILE = path.join(PANTHEON_DIR, "server.pid");
const PORT_FILE = path.join(PANTHEON_DIR, "server-port");
const LOG_FILE = path.join(PANTHEON_DIR, "server.log");
/** The log is truncated on start once it grows past this, so it cannot fill the disk. */
const MAX_LOG_BYTES = 5 * 1024 * 1024;
const STARTUP_TIMEOUT_MS = 8000;
const POLL_INTERVAL_MS = 200;
const DEFAULT_PORT = 3000;

/**
 * Returns the URL of the running (or to-be-started) API server.
 * Priority: PANTHEON_SERVER_URL env > port file > default :3000
 */
export function getServerUrl(): string {
    if (process.env["PANTHEON_SERVER_URL"]) return process.env["PANTHEON_SERVER_URL"];
    if (fs.existsSync(PORT_FILE)) {
        const port = fs.readFileSync(PORT_FILE, "utf-8").trim();
        if (port && !isNaN(Number(port))) return `http://localhost:${port}`;
    }
    return `http://localhost:${DEFAULT_PORT}`;
}

/**
 * Find an available TCP port starting from `startPort`.
 * Tries up to 20 consecutive ports before giving up.
 */
async function findAvailablePort(startPort: number): Promise<number> {
    for (let port = startPort; port < startPort + 20; port++) {
        const available = await new Promise<boolean>((resolve) => {
            const server = net.createServer();
            server.once("error", () => resolve(false));
            server.listen(port, "127.0.0.1", () => {
                server.close(() => resolve(true));
            });
        });
        if (available) return port;
    }
    throw new Error(`No available port found in range ${startPort}–${startPort + 19}.`);
}

/** Check if the API server is currently reachable. */
export async function isServerRunning(): Promise<boolean> {
    try {
        const res = await fetch(`${getServerUrl()}/api/health`, { signal: AbortSignal.timeout(1000) });
        return res.ok;
    } catch {
        return false;
    }
}

/**
 * Wait for the server to become reachable, polling every POLL_INTERVAL_MS.
 * Gives up early when `hasExited()` reports the process died during startup.
 */
async function waitForServer(hasExited: () => boolean): Promise<boolean> {
    const deadline = Date.now() + STARTUP_TIMEOUT_MS;
    while (Date.now() < deadline) {
        if (await isServerRunning()) return true;
        if (hasExited()) return false;
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
    return false;
}

/** Path of the background server's log file. */
export function getServerLogPath(): string {
    return LOG_FILE;
}

/** Last few lines the server wrote since `fromByte`, for startup-failure messages. */
function tailLog(fromByte: number, maxLines = 8): string {
    try {
        // Slice the Buffer, not the string: the offset is in bytes and the log has multi-byte characters.
        const text = fs.readFileSync(LOG_FILE).subarray(fromByte).toString("utf-8");
        return text.trim().split("\n").slice(-maxLines).join("\n");
    } catch {
        return "";
    }
}

/** Find the path to the built server entry point. */
function resolveServerPath(): string | null {
    // Try resolving from the installed package
    try {
        const require = createRequire(import.meta.url);
        return require.resolve("@pantheon/server");
    } catch {
        // Fallback: look relative to the CLI package (monorepo dev mode)
        const candidates = [
            // packages/cli/dist → packages/server/dist/index.js
            path.resolve(new URL(import.meta.url).pathname, "../../../server/dist/index.js"),
        ];
        for (const c of candidates) {
            if (fs.existsSync(c)) return c;
        }
        return null;
    }
}

/**
 * Ensure the Pantheon API server is running.
 * If it's already reachable, returns immediately.
 * If not, finds an available port, spawns the server as a detached background
 * process, writes the port to ~/.pantheon/server-port, and waits up to 8 seconds
 * for it to become reachable.
 *
 * Throws if the server cannot be started.
 */
export async function ensureServerRunning(): Promise<void> {
    if (await isServerRunning()) return;

    const serverPath = resolveServerPath();
    if (!serverPath) {
        throw new Error(
            "Pantheon API server not found. Run `pnpm turbo build` to build all packages first."
        );
    }

    // Find an available port (start from default, fallback to next available)
    const port = await findAvailablePort(DEFAULT_PORT);

    // Persist the chosen port so getServerUrl() returns the right address
    fs.mkdirSync(PANTHEON_DIR, { recursive: true });
    fs.writeFileSync(PORT_FILE, String(port), "utf-8");

    // Send the server's output to ~/.pantheon/server.log. It used to be discarded,
    // which made a startup failure (bad DATABASE_URL, port clash, missing build)
    // indistinguishable from a slow start.
    let logStart = 0;
    try {
        if (fs.statSync(LOG_FILE).size > MAX_LOG_BYTES) fs.rmSync(LOG_FILE, { force: true });
        else logStart = fs.statSync(LOG_FILE).size;
    } catch {
        // no log yet
    }
    const logFd = fs.openSync(LOG_FILE, "a");

    // Spawn as a detached process — survives CLI exit
    const serverProcess = spawn(process.execPath, [serverPath], {
        detached: true,
        stdio: ["ignore", logFd, logFd],
        env: { ...process.env, PORT: String(port) },
    });
    fs.closeSync(logFd); // the child holds its own copy

    let exited = false;
    serverProcess.once("exit", () => {
        exited = true;
    });
    serverProcess.unref();

    // Save PID for manual stop
    if (serverProcess.pid) {
        fs.writeFileSync(PID_FILE, String(serverProcess.pid), "utf-8");
    }

    if (port !== DEFAULT_PORT) {
        process.stdout.write(`  Starting Pantheon server on port ${port} (${DEFAULT_PORT} was in use)...\n`);
    } else {
        process.stdout.write("  Starting Pantheon server...\n");
    }

    const ready = await waitForServer(() => exited);
    if (!ready) {
        if (exited) {
            fs.rmSync(PID_FILE, { force: true });
            fs.rmSync(PORT_FILE, { force: true });
        }
        const tail = tailLog(logStart);
        throw new Error(
            (exited
                ? "Pantheon API server exited during startup."
                : `Pantheon API server failed to start within ${STARTUP_TIMEOUT_MS / 1000}s.`) +
            (tail ? `\n\n${tail}\n` : " ") +
            `\nFull log: ${LOG_FILE}`
        );
    }
}

/** Stop the background server by sending SIGTERM to its PID. */
export function stopServer(): void {
    if (!fs.existsSync(PID_FILE)) {
        console.log("No server PID file found — server may not be running.");
        return;
    }
    const pid = Number(fs.readFileSync(PID_FILE, "utf-8").trim());
    try {
        process.kill(pid, "SIGTERM");
        fs.rmSync(PID_FILE, { force: true });
        fs.rmSync(PORT_FILE, { force: true });
        console.log(`Server (PID ${pid}) stopped.`);
    } catch {
        console.log(`Could not stop server (PID ${pid}) — it may have already exited.`);
        fs.rmSync(PID_FILE, { force: true });
        fs.rmSync(PORT_FILE, { force: true });
    }
}

/** Get the running server's PID, or null if not running. */
export function getServerPid(): number | null {
    if (!fs.existsSync(PID_FILE)) return null;
    return Number(fs.readFileSync(PID_FILE, "utf-8").trim()) || null;
}

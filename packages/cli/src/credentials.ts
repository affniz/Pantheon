import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * API tokens saved by `pantheon auth login`, keyed by server URL so one machine
 * can talk to several Pantheon servers.
 *
 * Stored at ~/.pantheon/credentials with mode 0600 — like ~/.netrc or ~/.npmrc,
 * the file is only as safe as the user account it belongs to.
 */
export interface SavedCredential {
    token: string;
    /** Who the token belongs to, for `pantheon auth status`. */
    email?: string;
    name?: string;
    savedAt: string;
}

interface CredentialsFile {
    servers: Record<string, SavedCredential>;
}

export function credentialsPath(): string {
    return path.join(os.homedir(), ".pantheon", "credentials");
}

function normalize(serverUrl: string): string {
    return serverUrl.replace(/\/+$/, "").toLowerCase();
}

function read(): CredentialsFile {
    try {
        const parsed = JSON.parse(fs.readFileSync(credentialsPath(), "utf-8")) as Partial<CredentialsFile>;
        return { servers: parsed.servers && typeof parsed.servers === "object" ? parsed.servers : {} };
    } catch {
        return { servers: {} };
    }
}

function write(file: CredentialsFile): void {
    const target = credentialsPath();
    fs.mkdirSync(path.dirname(target), { recursive: true });
    // Write-then-rename so a crash can never leave a half-written credentials file,
    // and create it 0600 from the start (never world-readable, even briefly).
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(file, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, target);
    fs.chmodSync(target, 0o600);
}

export function getCredential(serverUrl: string): SavedCredential | undefined {
    return read().servers[normalize(serverUrl)];
}

export function saveCredential(serverUrl: string, credential: Omit<SavedCredential, "savedAt">): void {
    const file = read();
    file.servers[normalize(serverUrl)] = { ...credential, savedAt: new Date().toISOString() };
    write(file);
}

/** Remove the saved token for a server. Returns false when there was none. */
export function deleteCredential(serverUrl: string): boolean {
    const file = read();
    const key = normalize(serverUrl);
    if (!(key in file.servers)) return false;
    delete file.servers[key];
    write(file);
    return true;
}

/**
 * The token to send to `serverUrl`: PANTHEON_API_TOKEN wins (CI, containers),
 * then the saved credential.
 */
export function resolveToken(serverUrl: string): string | undefined {
    const env = process.env["PANTHEON_API_TOKEN"]?.trim();
    if (env) return env;
    return getCredential(serverUrl)?.token;
}

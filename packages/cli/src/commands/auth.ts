import chalk from "chalk";
import http from "node:http";
import os from "node:os";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { AuthStore, initDb, closeDb } from "@pantheon/core";
import { ensureServerRunning, getServerUrl } from "../server-manager.js";
import { credentialsPath, deleteCredential, getCredential, resolveToken, saveCredential } from "../credentials.js";

const dim = chalk.hex("#6B7280");
const brand = chalk.hex("#F5A623");
const accent = chalk.hex("#56B6C2");

const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

function fail(message: string): never {
    console.error(chalk.red(`\n  ✗ ${message}\n`));
    process.exit(1);
}

/** The server a command talks to: --server, else the local one (started on demand). */
async function resolveServer(server?: string): Promise<string> {
    if (server) return server.replace(/\/+$/, "");
    await ensureServerRunning();
    return getServerUrl();
}

async function request<T>(server: string, path: string, init: RequestInit = {}, token?: string): Promise<{ status: number; body: T }> {
    const res = await fetch(`${server}${path}`, {
        ...init,
        headers: {
            ...(init.body ? { "Content-Type": "application/json" } : {}),
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        signal: AbortSignal.timeout(15_000),
    });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as T };
}

/** Best-effort: open a URL in the user's browser. Returns false when no opener is available. */
function openBrowser(url: string): boolean {
    const [cmd, args] = process.platform === "darwin"
        ? ["open", [url]]
        : process.platform === "win32"
            ? ["cmd", ["/c", "start", "", url]]
            : ["xdg-open", [url]];
    try {
        const child = spawn(cmd as string, args as string[], { stdio: "ignore", detached: true });
        child.on("error", () => {});
        child.unref();
        return true;
    } catch {
        return false;
    }
}

/**
 * Wait for the browser to be redirected to our loopback port with a login code.
 * The server binds to 127.0.0.1 only and answers exactly one request.
 */
function waitForCode(): Promise<{ port: number; code: Promise<string>; close: () => void }> {
    return new Promise((resolve, reject) => {
        let settle: (code: string) => void;
        let abort: (err: Error) => void;
        const code = new Promise<string>((res, rej) => {
            settle = res;
            abort = rej;
        });
        // Avoid an unhandled rejection if the caller bails out before awaiting it
        code.catch(() => {});

        const server = http.createServer((req, res) => {
            const url = new URL(req.url ?? "/", "http://127.0.0.1");
            if (url.pathname !== "/callback") {
                res.writeHead(404).end();
                return;
            }
            const received = url.searchParams.get("code");
            res.writeHead(received ? 200 : 400, { "Content-Type": "text/html; charset=utf-8" });
            res.end(
                `<!doctype html><meta charset="utf-8"><title>Pantheon</title>` +
                `<body style="font:16px system-ui;max-width:32rem;margin:15vh auto;padding:0 1rem">` +
                (received
                    ? `<h1 style="font-size:1.3rem">◆ Signed in</h1><p>You can close this tab and return to the terminal.</p>`
                    : `<h1 style="font-size:1.3rem">◆ Sign-in failed</h1><p>No login code was received. Run <code>pantheon auth login</code> again.</p>`) +
                `</body>`,
            );
            if (received) settle(received);
            else abort(new Error("The sign-in did not return a login code."));
        });
        const timer = setTimeout(() => abort(new Error("Timed out waiting for the browser sign-in.")), LOGIN_TIMEOUT_MS);
        timer.unref();

        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            if (!address || typeof address === "string") {
                reject(new Error("Could not open a local port for the sign-in callback."));
                return;
            }
            resolve({
                port: address.port,
                code,
                close: () => {
                    clearTimeout(timer);
                    server.close();
                    server.closeAllConnections();
                },
            });
        });
    });
}

/** pantheon auth login [--provider github|google] [--server <url>] */
export async function authLogin(opts: { provider?: string; server?: string }): Promise<void> {
    try {
        const server = await resolveServer(opts.server);
        const { body } = await request<{ mode?: string; providers?: string[] }>(server, "/api/auth/providers");
        const providers = body.providers ?? [];

        if (providers.length === 0) {
            console.log("");
            console.log(`  ${chalk.yellow("No sign-in providers are configured on")} ${server}`);
            if (body.mode === "off") {
                console.log(dim("  Authentication is off for this server — no login is needed."));
            } else {
                console.log(dim("  Create a token on the server's machine instead:  pantheon auth token create"));
                console.log(dim("  …or configure PANTHEON_GITHUB_CLIENT_ID / PANTHEON_GOOGLE_CLIENT_ID (see README)."));
            }
            console.log("");
            return;
        }

        const provider = opts.provider ?? providers[0]!;
        if (!providers.includes(provider)) {
            fail(`Provider "${provider}" is not enabled on this server. Available: ${providers.join(", ")}`);
        }

        // PKCE-style proof: the server only ever sees the hash, so the code that
        // comes back through the browser is useless to anything but this process.
        const verifier = randomBytes(48).toString("base64url");
        const challenge = createHash("sha256").update(verifier).digest("base64url");
        const listener = await waitForCode();

        try {
            const loginUrl = `${server}/api/auth/login/${provider}?cli_port=${listener.port}&cli_challenge=${challenge}`;
            console.log("");
            console.log(`  ${brand.bold("◆")} ${chalk.white.bold("Sign in to Pantheon")} ${dim(`via ${provider}`)}`);
            console.log(`  ${dim("Opening your browser. If nothing happens, open this URL:")}`);
            console.log(`  ${accent(loginUrl)}`);
            console.log("");
            openBrowser(loginUrl);

            const code = await listener.code;
            const exchanged = await request<{ token?: string; user?: { email: string; name?: string }; error?: string }>(
                server,
                "/api/auth/cli/exchange",
                { method: "POST", body: JSON.stringify({ code, verifier, name: `pantheon CLI on ${os.hostname()}` }) },
            );
            if (exchanged.status !== 200 || !exchanged.body.token) {
                fail(exchanged.body.error ?? `Login failed (HTTP ${exchanged.status}).`);
            }

            saveCredential(server, {
                token: exchanged.body.token,
                ...(exchanged.body.user?.email ? { email: exchanged.body.user.email } : {}),
                ...(exchanged.body.user?.name ? { name: exchanged.body.user.name } : {}),
            });
            console.log(chalk.green(`  ✓ Signed in as ${exchanged.body.user?.email ?? "unknown"}`));
            console.log(dim(`    Token saved to ${credentialsPath()}`));
            console.log("");
        } finally {
            listener.close();
        }
    } catch (err) {
        fail(err instanceof Error ? err.message : String(err));
    }
}

/** pantheon auth logout [--server <url>] — revoke and forget the saved token. */
export async function authLogout(opts: { server?: string }): Promise<void> {
    try {
        const server = opts.server ? opts.server.replace(/\/+$/, "") : getServerUrl();
        const saved = getCredential(server);
        if (!saved) {
            console.log(dim(`\n  Not signed in to ${server}.\n`));
            return;
        }

        // Revoke server-side so the token is dead even if a copy leaked; if the
        // server is unreachable we still remove the local copy.
        let revoked = false;
        try {
            const list = await request<{ tokens?: Array<{ id: string; prefix: string }> }>(server, "/api/auth/tokens", {}, saved.token);
            const mine = list.body.tokens?.find((t) => saved.token.startsWith(t.prefix));
            if (mine) {
                revoked = (await request(server, `/api/auth/tokens/${mine.id}`, { method: "DELETE" }, saved.token)).status === 200;
            }
        } catch {
            // server not reachable
        }

        deleteCredential(server);
        console.log(chalk.green(`\n  ✓ Signed out of ${server}`) + (revoked ? dim(" (token revoked)") : dim(" (local token removed; could not revoke it on the server)")));
        console.log("");
    } catch (err) {
        fail(err instanceof Error ? err.message : String(err));
    }
}

/** pantheon auth status [--server <url>] */
export async function authStatus(opts: { server?: string }): Promise<void> {
    try {
        const server = await resolveServer(opts.server);
        const token = resolveToken(server);
        const { body } = await request<{
            authenticated?: boolean; mode?: string; method?: string;
            user?: { email: string; name?: string; role: string; provider: string };
        }>(server, "/api/auth/me", {}, token);

        // /me answers 401 (without a mode) when auth is required and we are not signed in
        if (!body.mode) {
            const providers = await request<{ mode?: string }>(server, "/api/auth/providers");
            if (providers.body.mode) body.mode = providers.body.mode;
        }

        console.log("");
        console.log(`  ${brand.bold("◆")} ${chalk.white.bold("Authentication")}`);
        console.log(`  ${dim("─".repeat(50))}`);
        console.log(`  ${dim("Server:")}  ${server}`);
        console.log(`  ${dim("Mode:")}    ${body.mode === "required" ? chalk.green("required") : chalk.yellow(body.mode ?? "unknown")}`);
        if (body.authenticated && body.user) {
            console.log(`  ${dim("User:")}    ${body.user.email}${body.user.name ? dim(` (${body.user.name})`) : ""}`);
            console.log(`  ${dim("Role:")}    ${body.user.role}  ${dim(`via ${body.user.provider}`)}`);
            console.log(`  ${dim("Token:")}   ${process.env["PANTHEON_API_TOKEN"] ? "PANTHEON_API_TOKEN" : credentialsPath()}`);
        } else if (token) {
            console.log(`  ${chalk.red("The saved token was not accepted")} ${dim("— run `pantheon auth login` again.")}`);
        } else if (body.mode === "required") {
            console.log(`  ${chalk.yellow("Not signed in")} ${dim("— run `pantheon auth login`.")}`);
        } else {
            console.log(`  ${dim("Not signed in (not needed while authentication is off).")}`);
        }
        console.log("");
    } catch (err) {
        fail(err instanceof Error ? err.message : String(err));
    }
}

/**
 * pantheon auth token create [--name <n>] [--email <e>] [--expires <days>] [--no-save]
 *
 * Mints a token by writing to the database directly, so it works with no OAuth
 * provider configured and before anyone has signed in. It needs the same access
 * as the server itself (the database), which is the trust boundary: whoever can
 * run this already controls the instance.
 */
export async function authTokenCreate(opts: { name?: string; email?: string; expires?: string; save?: boolean }): Promise<void> {
    try {
        const expiresInDays = opts.expires === undefined ? undefined : Number(opts.expires);
        if (expiresInDays !== undefined && (!Number.isInteger(expiresInDays) || expiresInDays < 1)) {
            fail("--expires must be a whole number of days (1 or more).");
        }

        await initDb();
        const store = new AuthStore();
        try {
            const email = opts.email ?? `${os.userInfo().username}@localhost`;
            const user = (await store.getUserByEmail(email))
                ?? (await store.upsertUser({ email, name: os.userInfo().username, provider: "local", providerUserId: email.toLowerCase() }));

            const { token, info } = await store.createToken(user.id, opts.name ?? `pantheon CLI on ${os.hostname()}`, { expiresInDays });

            console.log("");
            console.log(`  ${brand.bold("◆")} ${chalk.white.bold("API token created")}`);
            console.log(`  ${dim("─".repeat(50))}`);
            console.log(`  ${dim("User:")}     ${user.email} ${dim(`(${user.role})`)}`);
            console.log(`  ${dim("Name:")}     ${info.name}`);
            console.log(`  ${dim("Expires:")}  ${info.expiresAt ?? "never"}`);
            console.log("");
            console.log(`  ${accent(token)}`);
            console.log("");
            console.log(dim("  This is the only time the token is shown. Use it as:"));
            console.log(dim("    Authorization: Bearer <token>      or      PANTHEON_API_TOKEN=<token>"));

            if (opts.save !== false) {
                const server = getServerUrl();
                saveCredential(server, { token, email: user.email, ...(user.name ? { name: user.name } : {}) });
                console.log(dim(`  Saved for ${server} in ${credentialsPath()}`));
            }
            console.log("");
        } finally {
            await closeDb();
        }
    } catch (err) {
        fail(err instanceof Error ? err.message : String(err));
    }
}

/** pantheon auth token list [--server <url>] */
export async function authTokenList(opts: { server?: string }): Promise<void> {
    try {
        const server = await resolveServer(opts.server);
        const token = resolveToken(server);
        if (!token) fail("Not signed in — run `pantheon auth login` first.");
        const { status, body } = await request<{
            tokens?: Array<{ id: string; name: string; prefix: string; createdAt: string; lastUsedAt?: string; expiresAt?: string; revokedAt?: string }>;
            error?: string;
        }>(server, "/api/auth/tokens", {}, token);
        if (status !== 200) fail(body.error ?? `HTTP ${status}`);

        console.log("");
        console.log(`  ${brand.bold("◆")} ${chalk.white.bold("API tokens")}`);
        console.log(`  ${dim("─".repeat(86))}`);
        console.log(`  ${dim("ID".padEnd(10))}${dim("NAME".padEnd(30))}${dim("PREFIX".padEnd(14))}${dim("LAST USED".padEnd(14))}${dim("STATUS")}`);
        for (const t of body.tokens ?? []) {
            const expired = t.expiresAt !== undefined && Date.parse(t.expiresAt) <= Date.now();
            const state = t.revokedAt ? chalk.red("revoked") : expired ? chalk.yellow("expired") : chalk.green("active");
            console.log(
                `  ${t.id.slice(0, 8).padEnd(10)}${t.name.slice(0, 28).padEnd(30)}${(t.prefix + "…").padEnd(14)}` +
                `${(t.lastUsedAt?.slice(0, 10) ?? "never").padEnd(14)}${state}` +
                (token.startsWith(t.prefix) ? dim("  ← this CLI") : ""),
            );
        }
        console.log("");
    } catch (err) {
        fail(err instanceof Error ? err.message : String(err));
    }
}

/** pantheon auth token revoke <id> [--server <url>] — accepts the short id shown by `token list`. */
export async function authTokenRevoke(id: string, opts: { server?: string }): Promise<void> {
    try {
        const server = await resolveServer(opts.server);
        const token = resolveToken(server);
        if (!token) fail("Not signed in — run `pantheon auth login` first.");

        const list = await request<{ tokens?: Array<{ id: string; name: string }> }>(server, "/api/auth/tokens", {}, token);
        const matches = (list.body.tokens ?? []).filter((t) => t.id.startsWith(id));
        if (matches.length === 0) fail(`No token with id "${id}".`);
        if (matches.length > 1) fail(`"${id}" matches ${matches.length} tokens — use more characters of the id.`);

        const res = await request<{ error?: string }>(server, `/api/auth/tokens/${matches[0]!.id}`, { method: "DELETE" }, token);
        if (res.status !== 200) fail(res.body.error ?? `HTTP ${res.status}`);
        console.log(chalk.green(`\n  ✓ Revoked "${matches[0]!.name}"\n`));
    } catch (err) {
        fail(err instanceof Error ? err.message : String(err));
    }
}

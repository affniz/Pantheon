import { sign, verify } from "hono/jwt";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ALG = "HS256";
/** Browser sessions last a week; API tokens (not JWTs) are the long-lived credential. */
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
/** How long a sign-in may take between leaving for the provider and coming back. */
export const OAUTH_STATE_TTL_SECONDS = 10 * 60;

let _secret: string | null = null;

/**
 * Signing key for session and OAuth-state JWTs.
 *
 * `PANTHEON_JWT_SECRET` when set (required when several server processes must
 * accept each other's sessions). Otherwise a random key is generated once and kept
 * in ~/.pantheon/jwt-secret (0600) so sessions survive a restart.
 */
export function jwtSecret(): string {
    const fromEnv = process.env["PANTHEON_JWT_SECRET"]?.trim();
    if (fromEnv) {
        if (fromEnv.length < 32) {
            throw new Error("PANTHEON_JWT_SECRET must be at least 32 characters long.");
        }
        return fromEnv;
    }
    if (_secret) return _secret;

    const file = path.join(os.homedir(), ".pantheon", "jwt-secret");
    try {
        const existing = fs.readFileSync(file, "utf-8").trim();
        if (existing.length >= 32) return (_secret = existing);
    } catch {
        // not created yet
    }
    const generated = randomBytes(48).toString("base64url");
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        // "wx": never overwrite a key another process created in the meantime
        fs.writeFileSync(file, generated + "\n", { mode: 0o600, flag: "wx" });
    } catch {
        try {
            const raced = fs.readFileSync(file, "utf-8").trim();
            if (raced.length >= 32) return (_secret = raced);
        } catch {
            // Unwritable home: fall through to an in-memory key (sessions end on restart)
        }
    }
    return (_secret = generated);
}

/** Forget the cached key (tests). */
export function resetJwtSecretCache(): void {
    _secret = null;
}

export interface SessionClaims {
    typ: "session";
    sub: string;
}

export interface OAuthStateClaims {
    typ: "oauth_state";
    provider: string;
    /** Must match the nonce cookie set on the browser that started the sign-in. */
    nonce: string;
    /** Where to send a browser sign-in afterwards (same-origin path). */
    redirect?: string;
    /** Present for `pantheon auth login`: where the CLI listens, and its PKCE challenge. */
    cli?: { port: number; challenge: string };
}

async function signClaims(claims: Record<string, unknown>, ttlSeconds: number): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    return sign({ ...claims, iat: now, exp: now + ttlSeconds }, jwtSecret(), ALG);
}

/**
 * Verify signature, expiry and the `typ` claim. The type check matters: session
 * and state tokens share a key, and one must never be accepted as the other.
 */
async function verifyClaims<T extends { typ: string }>(token: string, typ: T["typ"]): Promise<T | undefined> {
    try {
        const payload = (await verify(token, jwtSecret(), ALG)) as unknown as T;
        return payload.typ === typ ? payload : undefined;
    } catch {
        return undefined;
    }
}

export const signSession = (userId: string) => signClaims({ typ: "session", sub: userId }, SESSION_TTL_SECONDS);
export const verifySession = (token: string) => verifyClaims<SessionClaims>(token, "session");
export const signOAuthState = (claims: Omit<OAuthStateClaims, "typ">) =>
    signClaims({ typ: "oauth_state", ...claims }, OAUTH_STATE_TTL_SECONDS);
export const verifyOAuthState = (token: string) => verifyClaims<OAuthStateClaims>(token, "oauth_state");

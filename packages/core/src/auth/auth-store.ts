import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { and, asc, count, eq } from "drizzle-orm";
import { DbStore } from "../db/store.js";

export type UserRole = "owner" | "member";
export type AuthProvider = "github" | "google" | "local";

export interface User {
    id: string;
    email: string;
    name?: string;
    provider: AuthProvider;
    role: UserRole;
    createdAt: string;
    lastLoginAt?: string;
}

/** API token metadata — never includes the token or its hash. */
export interface ApiTokenInfo {
    id: string;
    userId: string;
    name: string;
    /** First characters of the token, so a user can tell their tokens apart. */
    prefix: string;
    createdAt: string;
    lastUsedAt?: string;
    expiresAt?: string;
    revokedAt?: string;
}

/** Every Pantheon API token starts with this, which makes leaked tokens greppable. */
export const TOKEN_PREFIX = "pth_";

/** SHA-256 of a token. Tokens carry 256 bits of entropy, so a fast hash is appropriate (no salt/KDF needed). */
export function hashToken(token: string): string {
    return createHash("sha256").update(token).digest("hex");
}

/** Constant-time string comparison (for secrets such as OAuth state). */
export function safeEqual(a: string, b: string): boolean {
    const x = Buffer.from(a);
    const y = Buffer.from(b);
    return x.length === y.length && timingSafeEqual(x, y);
}

export function normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
}

/** Thrown when a sign-in is well-formed but the person is not allowed to use this instance. */
export class NotAuthorizedError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "NotAuthorizedError";
    }
}

/**
 * Users and API tokens.
 *
 * Tokens are shown to the user exactly once, at creation; only their SHA-256 hash
 * is stored, so a database leak does not leak usable credentials.
 */
export class AuthStore extends DbStore {
    // ── Users ────────────────────────────────────────────────────────────────

    async countUsers(): Promise<number> {
        const { users } = this.t;
        const [row] = await this.db.select({ n: count() }).from(users);
        return Number(row?.n ?? 0);
    }

    async getUser(id: string): Promise<User | undefined> {
        const { users } = this.t;
        const [row] = await this.db.select().from(users).where(eq(users.id, id)).limit(1);
        return row ? toUser(row) : undefined;
    }

    async getUserByEmail(email: string): Promise<User | undefined> {
        const { users } = this.t;
        const [row] = await this.db.select().from(users).where(eq(users.email, normalizeEmail(email))).limit(1);
        return row ? toUser(row) : undefined;
    }

    async listUsers(): Promise<User[]> {
        const { users } = this.t;
        return (await this.db.select().from(users).orderBy(asc(users.createdAt), asc(users.id))).map(toUser);
    }

    /**
     * Create or update a user after a successful sign-in.
     *
     * A user is matched by provider identity first, then by e-mail (so the same
     * person can sign in with GitHub one day and Google the next and keep their
     * sessions). The very first user of an instance becomes its `owner`.
     */
    async upsertUser(identity: {
        email: string;
        name?: string | undefined;
        provider: AuthProvider;
        providerUserId: string;
    }): Promise<User> {
        const { users } = this.t;
        const email = normalizeEmail(identity.email);
        const now = new Date().toISOString();

        const [byIdentity] = await this.db
            .select()
            .from(users)
            .where(and(eq(users.provider, identity.provider), eq(users.providerUserId, identity.providerUserId)))
            .limit(1);
        const existing = byIdentity ?? (await this.db.select().from(users).where(eq(users.email, email)).limit(1))[0];

        if (existing) {
            await this.db
                .update(users)
                .set({
                    email,
                    lastLoginAt: now,
                    ...(identity.name ? { name: identity.name } : {}),
                    // Re-point an e-mail-matched account at the provider used most recently
                    provider: identity.provider,
                    providerUserId: identity.providerUserId,
                })
                .where(eq(users.id, existing.id));
            return (await this.getUser(existing.id))!;
        }

        const id = randomUUID();
        const role: UserRole = (await this.countUsers()) === 0 ? "owner" : "member";
        await this.db.insert(users).values({
            id,
            email,
            name: identity.name ?? null,
            provider: identity.provider,
            providerUserId: identity.providerUserId,
            role,
            createdAt: now,
            lastLoginAt: now,
        });
        return (await this.getUser(id))!;
    }

    /**
     * Decide whether an identity that has just proven itself at an OAuth provider
     * may use this instance, and return its user.
     *
     * Signing in grants access to an agent with shell and filesystem tools, so the
     * default is closed: with no allow-list, only the first person to sign in (who
     * becomes the owner) and people who already have an account get in.
     */
    async signIn(
        identity: { email: string; name?: string | undefined; provider: AuthProvider; providerUserId: string },
        allowedEmails: string[] = [],
    ): Promise<User> {
        const email = normalizeEmail(identity.email);
        const allowed = allowedEmails.map(normalizeEmail);

        const isFirstUser = (await this.countUsers()) === 0;
        const known = (await this.getUserByEmail(email)) !== undefined;
        const listed = allowed.includes(email) || allowed.includes("*");

        if (!isFirstUser && !known && !listed) {
            throw new NotAuthorizedError(
                `${email} is not allowed to use this Pantheon instance. ` +
                "Ask its owner to add your e-mail to auth.allowedEmails.",
            );
        }
        if (isFirstUser && allowed.length > 0 && !listed) {
            throw new NotAuthorizedError(`${email} is not in auth.allowedEmails.`);
        }
        return this.upsertUser(identity);
    }

    // ── API tokens ───────────────────────────────────────────────────────────

    /**
     * Mint a token for `userId`. The returned `token` is the only time the secret
     * is available — it cannot be recovered later.
     */
    async createToken(
        userId: string,
        name: string,
        options: { expiresInDays?: number | undefined } = {},
    ): Promise<{ token: string; info: ApiTokenInfo }> {
        const { apiTokens } = this.t;
        const token = TOKEN_PREFIX + randomBytes(32).toString("base64url");
        const id = randomUUID();
        const createdAt = new Date().toISOString();
        const expiresAt = options.expiresInDays && options.expiresInDays > 0
            ? new Date(Date.now() + options.expiresInDays * 24 * 60 * 60 * 1000).toISOString()
            : null;

        await this.db.insert(apiTokens).values({
            id,
            userId,
            name: name.trim().slice(0, 100) || "token",
            tokenHash: hashToken(token),
            tokenPrefix: token.slice(0, TOKEN_PREFIX.length + 6),
            createdAt,
            expiresAt,
        });
        const [row] = await this.db.select().from(apiTokens).where(eq(apiTokens.id, id)).limit(1);
        return { token, info: toTokenInfo(row!) };
    }

    /**
     * Resolve a presented token to its user, or undefined when the token is
     * unknown, revoked or expired. Records the time of use (at most once a minute,
     * so a busy client does not turn every request into a write).
     */
    async verifyToken(token: string): Promise<{ user: User; token: ApiTokenInfo } | undefined> {
        if (!token.startsWith(TOKEN_PREFIX)) return undefined;
        const { apiTokens } = this.t;
        const [row] = await this.db.select().from(apiTokens).where(eq(apiTokens.tokenHash, hashToken(token))).limit(1);
        if (!row || row.revokedAt) return undefined;
        if (row.expiresAt && Date.parse(row.expiresAt) <= Date.now()) return undefined;

        const user = await this.getUser(row.userId);
        if (!user) return undefined;

        const now = Date.now();
        if (!row.lastUsedAt || now - Date.parse(row.lastUsedAt) > 60_000) {
            await this.db
                .update(apiTokens)
                .set({ lastUsedAt: new Date(now).toISOString() })
                .where(eq(apiTokens.id, row.id))
                .catch(() => {
                    // Bookkeeping only — never fail authentication over it
                });
        }
        return { user, token: toTokenInfo(row) };
    }

    async listTokens(userId: string): Promise<ApiTokenInfo[]> {
        const { apiTokens } = this.t;
        const rows = await this.db
            .select()
            .from(apiTokens)
            .where(eq(apiTokens.userId, userId))
            .orderBy(asc(apiTokens.createdAt), asc(apiTokens.id));
        return rows.map(toTokenInfo);
    }

    /**
     * Revoke one of `userId`'s tokens. Returns false when the token does not exist,
     * belongs to someone else, or was already revoked.
     */
    async revokeToken(userId: string, tokenId: string): Promise<boolean> {
        const { apiTokens } = this.t;
        const [row] = await this.db
            .select()
            .from(apiTokens)
            .where(and(eq(apiTokens.id, tokenId), eq(apiTokens.userId, userId)))
            .limit(1);
        if (!row || row.revokedAt) return false;
        await this.db.update(apiTokens).set({ revokedAt: new Date().toISOString() }).where(eq(apiTokens.id, tokenId));
        return true;
    }
}

type UserRow = {
    id: string;
    email: string;
    name: string | null;
    provider: string;
    role: string;
    createdAt: string;
    lastLoginAt: string | null;
};

function toUser(row: UserRow): User {
    return {
        id: row.id,
        email: row.email,
        ...(row.name ? { name: row.name } : {}),
        provider: row.provider as AuthProvider,
        role: row.role as UserRole,
        createdAt: row.createdAt,
        ...(row.lastLoginAt ? { lastLoginAt: row.lastLoginAt } : {}),
    };
}

type TokenRow = {
    id: string;
    userId: string;
    name: string;
    tokenPrefix: string;
    createdAt: string;
    lastUsedAt: string | null;
    expiresAt: string | null;
    revokedAt: string | null;
};

function toTokenInfo(row: TokenRow): ApiTokenInfo {
    return {
        id: row.id,
        userId: row.userId,
        name: row.name,
        prefix: row.tokenPrefix,
        createdAt: row.createdAt,
        ...(row.lastUsedAt ? { lastUsedAt: row.lastUsedAt } : {}),
        ...(row.expiresAt ? { expiresAt: row.expiresAt } : {}),
        ...(row.revokedAt ? { revokedAt: row.revokedAt } : {}),
    };
}

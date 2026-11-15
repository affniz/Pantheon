import type { OAuthProviderName } from "./config.js";

/** What Pantheon needs to know about someone who has signed in at a provider. */
export interface OAuthIdentity {
    providerUserId: string;
    /** A verified e-mail address. Unverified addresses are never accepted. */
    email: string;
    name?: string;
}

export class OAuthError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "OAuthError";
    }
}

interface ProviderSpec {
    authorizeUrl: string;
    scope: string;
    /** Exchange an authorization code for an access token. */
    exchange(args: { code: string; clientId: string; clientSecret: string; redirectUri: string }): Promise<string>;
    /** Resolve the signed-in identity from an access token. */
    identity(accessToken: string): Promise<OAuthIdentity>;
}

const TIMEOUT_MS = 10_000;

async function fetchJson(url: string, init: RequestInit, what: string): Promise<Record<string, unknown>> {
    let res: Response;
    try {
        res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (err) {
        throw new OAuthError(`${what} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    const body = (await res.json().catch(() => undefined)) as Record<string, unknown> | undefined;
    if (!res.ok || !body) {
        throw new OAuthError(`${what} failed (HTTP ${res.status}).`);
    }
    return body;
}

function requireAccessToken(body: Record<string, unknown>, provider: string): string {
    // GitHub reports a bad/expired code with HTTP 200 and an `error` field.
    if (typeof body["error"] === "string") {
        throw new OAuthError(`${provider} rejected the sign-in: ${String(body["error_description"] ?? body["error"])}`);
    }
    const token = body["access_token"];
    if (typeof token !== "string" || !token) throw new OAuthError(`${provider} did not return an access token.`);
    return token;
}

const PROVIDERS: Record<OAuthProviderName, ProviderSpec> = {
    github: {
        authorizeUrl: "https://github.com/login/oauth/authorize",
        scope: "read:user user:email",
        async exchange({ code, clientId, clientSecret, redirectUri }) {
            const body = await fetchJson(
                "https://github.com/login/oauth/access_token",
                {
                    method: "POST",
                    headers: { Accept: "application/json", "Content-Type": "application/json" },
                    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri }),
                },
                "GitHub token exchange",
            );
            return requireAccessToken(body, "GitHub");
        },
        async identity(accessToken) {
            const headers = {
                Authorization: `Bearer ${accessToken}`,
                Accept: "application/vnd.github+json",
                "User-Agent": "pantheon-server",
            };
            const user = await fetchJson("https://api.github.com/user", { headers }, "GitHub profile lookup");
            if (user["id"] === undefined || user["id"] === null) throw new OAuthError("GitHub profile has no id.");

            // The profile's `email` is whatever the user chose to display and is not
            // guaranteed verified; the e-mails endpoint says which one is.
            let emails: unknown;
            try {
                const res = await fetch("https://api.github.com/user/emails", {
                    headers,
                    signal: AbortSignal.timeout(TIMEOUT_MS),
                });
                emails = res.ok ? await res.json() : undefined;
            } catch {
                emails = undefined;
            }
            const verified = Array.isArray(emails)
                ? (emails as Array<{ email?: string; primary?: boolean; verified?: boolean }>).filter((e) => e.verified && e.email)
                : [];
            const email = (verified.find((e) => e.primary) ?? verified[0])?.email;
            if (!email) {
                throw new OAuthError("Your GitHub account has no verified e-mail address Pantheon can read.");
            }
            const name = typeof user["name"] === "string" && user["name"] ? user["name"] : String(user["login"] ?? "");
            return { providerUserId: String(user["id"]), email, ...(name ? { name } : {}) };
        },
    },

    google: {
        authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
        scope: "openid email profile",
        async exchange({ code, clientId, clientSecret, redirectUri }) {
            const body = await fetchJson(
                "https://oauth2.googleapis.com/token",
                {
                    method: "POST",
                    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
                    body: new URLSearchParams({
                        code,
                        client_id: clientId,
                        client_secret: clientSecret,
                        redirect_uri: redirectUri,
                        grant_type: "authorization_code",
                    }).toString(),
                },
                "Google token exchange",
            );
            return requireAccessToken(body, "Google");
        },
        async identity(accessToken) {
            const info = await fetchJson(
                "https://openidconnect.googleapis.com/v1/userinfo",
                { headers: { Authorization: `Bearer ${accessToken}` } },
                "Google profile lookup",
            );
            const email = info["email"];
            if (typeof info["sub"] !== "string" || typeof email !== "string" || !email) {
                throw new OAuthError("Google did not return an account id and e-mail address.");
            }
            if (info["email_verified"] !== true && info["email_verified"] !== "true") {
                throw new OAuthError("Your Google account's e-mail address is not verified.");
            }
            const name = typeof info["name"] === "string" ? info["name"] : "";
            return { providerUserId: info["sub"], email, ...(name ? { name } : {}) };
        },
    },
};

export function isProviderName(value: string): value is OAuthProviderName {
    return value === "github" || value === "google";
}

/** URL to send the browser to so the user can approve the sign-in. */
export function authorizeUrl(
    provider: OAuthProviderName,
    args: { clientId: string; redirectUri: string; state: string },
): string {
    const spec = PROVIDERS[provider];
    const url = new URL(spec.authorizeUrl);
    url.searchParams.set("client_id", args.clientId);
    url.searchParams.set("redirect_uri", args.redirectUri);
    url.searchParams.set("scope", spec.scope);
    url.searchParams.set("state", args.state);
    url.searchParams.set("response_type", "code");
    return url.toString();
}

/** Complete a sign-in: authorization code → verified identity. */
export async function completeSignIn(
    provider: OAuthProviderName,
    args: { code: string; clientId: string; clientSecret: string; redirectUri: string },
): Promise<OAuthIdentity> {
    const spec = PROVIDERS[provider];
    return spec.identity(await spec.exchange(args));
}

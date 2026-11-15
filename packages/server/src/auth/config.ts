import { loadConfig } from "@pantheon/core";
import type { AuthConfig } from "@pantheon/shared";

export type OAuthProviderName = "github" | "google";

export interface ResolvedAuthConfig {
    mode: "off" | "required";
    allowedEmails: string[];
    /** Public base URL (no trailing slash), when configured explicitly. */
    publicUrl: string | undefined;
    providers: Partial<Record<OAuthProviderName, { clientId: string; clientSecret: string }>>;
}

let _fileConfig: AuthConfig | undefined | null = null;

/** config.yml is read once per process; environment variables are read on every call. */
function fileConfig(): AuthConfig | undefined {
    if (_fileConfig === null) {
        try {
            _fileConfig = loadConfig().auth;
        } catch {
            _fileConfig = undefined;
        }
    }
    return _fileConfig;
}

/** Forget the cached config.yml (tests). */
export function resetAuthConfigCache(): void {
    _fileConfig = null;
}

function env(name: string): string | undefined {
    const value = process.env[name]?.trim();
    return value ? value : undefined;
}

/**
 * Effective authentication settings.
 *
 * Environment (wins) → config.yml `auth:` block → defaults.
 *   PANTHEON_AUTH=required|off
 *   PANTHEON_ALLOWED_EMAILS=a@x.com,b@y.com      ("*" = anyone)
 *   PANTHEON_PUBLIC_URL=https://pantheon.example.com
 *   PANTHEON_GITHUB_CLIENT_ID / PANTHEON_GITHUB_CLIENT_SECRET
 *   PANTHEON_GOOGLE_CLIENT_ID / PANTHEON_GOOGLE_CLIENT_SECRET
 */
export function getAuthConfig(): ResolvedAuthConfig {
    const file = fileConfig();

    const rawMode = (env("PANTHEON_AUTH") ?? file?.mode ?? "off").toLowerCase();
    // Anything that is not an explicit "off" (typos included) fails closed.
    const mode: "off" | "required" = ["off", "false", "0", "disabled", "none"].includes(rawMode) ? "off" : "required";

    const allowedEmails = env("PANTHEON_ALLOWED_EMAILS")?.split(",").map((e) => e.trim()).filter(Boolean)
        ?? file?.allowedEmails
        ?? [];

    const providers: ResolvedAuthConfig["providers"] = {};
    for (const name of ["github", "google"] as const) {
        const upper = name.toUpperCase();
        const clientId = env(`PANTHEON_${upper}_CLIENT_ID`) ?? file?.providers?.[name]?.clientId;
        const clientSecret = env(`PANTHEON_${upper}_CLIENT_SECRET`) ?? file?.providers?.[name]?.clientSecret;
        if (clientId && clientSecret) providers[name] = { clientId, clientSecret };
    }

    const publicUrl = (env("PANTHEON_PUBLIC_URL") ?? file?.publicUrl)?.replace(/\/+$/, "");
    return { mode, allowedEmails, publicUrl, providers };
}

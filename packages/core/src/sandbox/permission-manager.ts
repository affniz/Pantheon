/**
 * Two-tier permission system for tool execution.
 *
 * - Destructive tools: always prompt [y/n] before every execution
 * - Safe tools: first-use prompt with [a] allow once / [A] always allow / [n] deny
 *
 * Session-level permissions reset when the process exits.
 */

export type PermissionDecision = "allow_once" | "always_allow" | "deny";

/**
 * Callback that prompts the user for a permission decision.
 * The UI layer (CLI/Ink) provides this implementation.
 */
export type PermissionCallback = (
    toolName: string,
    args: Record<string, unknown>,
    safety: "safe" | "destructive"
) => Promise<PermissionDecision>;

export class PermissionManager {
    /** Tools the user has "always allow"-ed for this session */
    private alwaysAllowed = new Set<string>();

    constructor(private promptUser: PermissionCallback) {}

    /**
     * Check if a tool call is permitted.
     *
     * - Destructive tools: always prompt (only accept allow_once or deny)
     * - Safe tools: check alwaysAllowed set first, prompt if not found
     *
     * @returns true if the tool call is approved, false if denied
     */
    async check(
        toolName: string,
        args: Record<string, unknown>,
        safety: "safe" | "destructive"
    ): Promise<boolean> {
        if (safety === "destructive") {
            // Destructive tools always prompt — no "always allow" shortcut
            const decision = await this.promptUser(toolName, args, safety);
            return decision !== "deny";
        }

        // Safe tools — check if already always-allowed
        if (this.alwaysAllowed.has(toolName)) {
            return true;
        }

        const decision = await this.promptUser(toolName, args, safety);

        switch (decision) {
            case "always_allow":
                this.alwaysAllowed.add(toolName);
                return true;
            case "allow_once":
                return true;
            case "deny":
                return false;
        }
    }

    /** Reset all session permissions */
    reset(): void {
        this.alwaysAllowed.clear();
    }

    /** Check if a tool has been always-allowed (useful for testing/UI) */
    isAlwaysAllowed(toolName: string): boolean {
        return this.alwaysAllowed.has(toolName);
    }
}

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

    /**
     * @param promptUser  Callback that prompts the user for a permission decision.
     * @param autoApprove Tool names to pre-approve for the entire session (no prompts).
     *                    Only use for safe tools — destructive tools always prompt regardless.
     */
    constructor(
        private promptUser: PermissionCallback,
        autoApprove: string[] = []
    ) {
        for (const name of autoApprove) {
            this.alwaysAllowed.add(name);
        }
    }

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

    /**
     * Create a child PermissionManager pre-seeded with this session's grants.
     *
     * Used by the Orchestrator so that each concurrent sub-agent in a wave
     * gets its own isolated permission state — preventing shared mutable state
     * and TUI prompt races when multiple agents run in parallel.
     *
     * The child inherits all current `alwaysAllowed` entries (so previously
     * approved tools don't re-prompt), but new grants in the child do NOT
     * propagate back to the parent.
     */
    fork(): PermissionManager {
        const child = new PermissionManager(this.promptUser);
        for (const name of this.alwaysAllowed) {
            child.alwaysAllowed.add(name);
        }
        return child;
    }
}

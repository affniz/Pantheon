import { describe, it, expect, vi, beforeEach } from "vitest";
import { PermissionManager } from "../permission-manager.js";

describe("PermissionManager", () => {
    let mockPrompt: any;
    let manager: PermissionManager;

    beforeEach(() => {
        mockPrompt = vi.fn();
        manager = new PermissionManager(mockPrompt);
    });

    describe("Destructive tools", () => {
        it("always prompts, even if allowed once before", async () => {
            mockPrompt.mockResolvedValueOnce("allow_once").mockResolvedValueOnce("allow_once");
            
            const res1 = await manager.check("write", {}, "destructive");
            expect(res1).toBe(true);
            expect(mockPrompt).toHaveBeenCalledTimes(1);

            const res2 = await manager.check("write", {}, "destructive");
            expect(res2).toBe(true);
            expect(mockPrompt).toHaveBeenCalledTimes(2);
        });

        it("returns false on deny", async () => {
            mockPrompt.mockResolvedValue("deny");
            const res = await manager.check("write", {}, "destructive");
            expect(res).toBe(false);
            expect(mockPrompt).toHaveBeenCalledTimes(1);
        });
    });

    describe("Safe tools", () => {
        it("prompts on first use, skips prompt after always_allow", async () => {
            mockPrompt.mockResolvedValue("always_allow");
            
            const res1 = await manager.check("read", {}, "safe");
            expect(res1).toBe(true);
            expect(mockPrompt).toHaveBeenCalledTimes(1);

            const res2 = await manager.check("read", {}, "safe");
            expect(res2).toBe(true);
            expect(mockPrompt).toHaveBeenCalledTimes(1); // Not called again
        });

        it("prompts again after allow_once", async () => {
            mockPrompt.mockResolvedValueOnce("allow_once").mockResolvedValueOnce("allow_once");
            
            const res1 = await manager.check("read", {}, "safe");
            expect(res1).toBe(true);
            expect(mockPrompt).toHaveBeenCalledTimes(1);

            const res2 = await manager.check("read", {}, "safe");
            expect(res2).toBe(true);
            expect(mockPrompt).toHaveBeenCalledTimes(2);
        });
    });

    describe("Reset", () => {
        it("clears always_allow set", async () => {
            mockPrompt.mockResolvedValue("always_allow");
            await manager.check("read", {}, "safe");
            expect(manager.isAlwaysAllowed("read")).toBe(true);

            manager.reset();
            expect(manager.isAlwaysAllowed("read")).toBe(false);

            mockPrompt.mockResolvedValue("allow_once");
            await manager.check("read", {}, "safe");
            expect(mockPrompt).toHaveBeenCalledTimes(2);
        });
    });

    describe("fork()", () => {
        it("child inherits parent alwaysAllowed grants", async () => {
            // Grant always_allow for "read" in the parent
            mockPrompt.mockResolvedValue("always_allow");
            await manager.check("read", {}, "safe");
            expect(manager.isAlwaysAllowed("read")).toBe(true);

            // Fork the manager — child should know "read" is already allowed
            const child = manager.fork();
            expect(child.isAlwaysAllowed("read")).toBe(true);
            // Should not prompt because "read" is pre-seeded
            const result = await child.check("read", {}, "safe");
            expect(result).toBe(true);
            expect(mockPrompt).toHaveBeenCalledTimes(1); // Only the original parent grant
        });

        it("new grants in child do NOT propagate to parent", async () => {
            const child = manager.fork();

            // Grant always_allow in the child only
            mockPrompt.mockResolvedValue("always_allow");
            await child.check("write", {}, "safe");
            expect(child.isAlwaysAllowed("write")).toBe(true);

            // Parent should NOT have picked up the child's grant
            expect(manager.isAlwaysAllowed("write")).toBe(false);
        });

        it("child starts with only the parent grants, not extras from sibling forks", async () => {
            // Grant read to parent
            mockPrompt.mockResolvedValue("always_allow");
            await manager.check("read", {}, "safe");

            const child1 = manager.fork();
            const child2 = manager.fork();

            // child1 grants "shell"
            mockPrompt.mockResolvedValue("always_allow");
            await child1.check("shell", {}, "safe");

            // child2 should NOT see child1's "shell" grant
            expect(child2.isAlwaysAllowed("shell")).toBe(false);

            // But both children still have "read" from the parent
            expect(child1.isAlwaysAllowed("read")).toBe(true);
            expect(child2.isAlwaysAllowed("read")).toBe(true);
        });
    });
});

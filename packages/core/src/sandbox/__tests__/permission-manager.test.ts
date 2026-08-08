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
});

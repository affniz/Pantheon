import { describe, it, expect } from "vitest";
import { ABRouter } from "../ab-router.js";
import type { ABConfig, RoutingDecision } from "@pantheon/shared";

describe("ABRouter", () => {
    const baseDecision: RoutingDecision = {
        tier: "standard",
        selectedModelId: "deepseek-v4-flash",
        reason: "test",
    };

    it("returns null when no experiments are configured", () => {
        const router = new ABRouter({ experiments: [] });
        expect(router.resolveArm(baseDecision, "session-1")).toBeNull();
    });

    it("returns null when all experiments are inactive", () => {
        const config: ABConfig = {
            experiments: [
                {
                    id: "exp-1",
                    name: "Test Exp",
                    splitPercent: 50,
                    controlModelId: "deepseek-v4-flash",
                    variantModelId: "deepseek-v4-pro",
                    active: false,
                },
            ],
        };
        const router = new ABRouter(config);
        expect(router.resolveArm(baseDecision, "session-1")).toBeNull();
    });

    it("deterministically assigns same arm for same session+experiment", () => {
        const config: ABConfig = {
            experiments: [
                {
                    id: "exp-1",
                    name: "Test Exp",
                    splitPercent: 50,
                    controlModelId: "deepseek-v4-flash",
                    variantModelId: "deepseek-v4-pro",
                    active: true,
                },
            ],
        };
        const router = new ABRouter(config);
        const result1 = router.resolveArm(baseDecision, "same-session-id");
        const result2 = router.resolveArm(baseDecision, "same-session-id");
        expect(result1).not.toBeNull();
        expect(result1!.arm).toBe(result2!.arm);
        expect(result1!.modelId).toBe(result2!.modelId);
    });

    it("assigns both arms across different sessions (statistical)", () => {
        const config: ABConfig = {
            experiments: [
                {
                    id: "exp-1",
                    name: "Test Exp",
                    splitPercent: 50,
                    controlModelId: "control-model",
                    variantModelId: "variant-model",
                    active: true,
                },
            ],
        };
        const router = new ABRouter(config);
        const arms = new Set<string>();
        for (let i = 0; i < 50; i++) {
            const result = router.resolveArm(baseDecision, `s-${i}`);
            if (result) arms.add(result.arm);
        }
        expect(arms.has("control")).toBe(true);
        expect(arms.has("variant")).toBe(true);
    });

    it("routes 100% to variant when splitPercent=100", () => {
        const config: ABConfig = {
            experiments: [
                {
                    id: "exp-v",
                    name: "All Variant",
                    splitPercent: 100,
                    controlModelId: "control-model",
                    variantModelId: "variant-model",
                    active: true,
                },
            ],
        };
        const router = new ABRouter(config);
        const result = router.resolveArm(baseDecision, "any-session");
        expect(result!.arm).toBe("variant");
        expect(result!.modelId).toBe("variant-model");
    });

    it("routes 100% to control when splitPercent=0", () => {
        const config: ABConfig = {
            experiments: [
                {
                    id: "exp-c",
                    name: "All Control",
                    splitPercent: 0,
                    controlModelId: "control-model",
                    variantModelId: "variant-model",
                    active: true,
                },
            ],
        };
        const router = new ABRouter(config);
        const result = router.resolveArm(baseDecision, "any-session");
        expect(result!.arm).toBe("control");
        expect(result!.modelId).toBe("control-model");
    });

    it("includes experimentId in the resolution result", () => {
        const config: ABConfig = {
            experiments: [
                {
                    id: "my-experiment",
                    name: "My Exp",
                    splitPercent: 50,
                    controlModelId: "control-model",
                    variantModelId: "variant-model",
                    active: true,
                },
            ],
        };
        const router = new ABRouter(config);
        const result = router.resolveArm(baseDecision, "session-abc");
        expect(result!.experimentId).toBe("my-experiment");
    });
});


describe("ABRouter — explicit experimentId", () => {
    const decision: RoutingDecision = { tier: "standard", selectedModelId: "deepseek-v4-flash", reason: "t" };
    const config: ABConfig = {
        experiments: [
            { id: "exp-a", name: "A", splitPercent: 50, controlModelId: "c-a", variantModelId: "v-a", active: true },
            { id: "exp-b", name: "B", splitPercent: 50, controlModelId: "c-b", variantModelId: "v-b", active: true },
            { id: "exp-off", name: "Off", splitPercent: 50, controlModelId: "c-o", variantModelId: "v-o", active: false },
        ],
    };

    it("defaults to the first active experiment when none is requested", () => {
        const res = new ABRouter(config).resolveArm(decision, "s1");
        expect(res?.experimentId).toBe("exp-a");
    });

    it("routes through the requested active experiment", () => {
        const res = new ABRouter(config).resolveArm(decision, "s1", "exp-b");
        expect(res?.experimentId).toBe("exp-b");
        expect(["c-b", "v-b"]).toContain(res?.modelId);
    });

    it("returns null when the requested experiment is inactive or unknown", () => {
        const router = new ABRouter(config);
        expect(router.resolveArm(decision, "s1", "exp-off")).toBeNull();
        expect(router.resolveArm(decision, "s1", "does-not-exist")).toBeNull();
    });
});

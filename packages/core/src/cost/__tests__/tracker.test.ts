import { describe, it, expect, beforeEach } from 'vitest';
import { BACKENDS, useBackend } from '../../db/__tests__/backends.js';
import { CostTracker } from '../tracker.js';
import type { UsageRecord } from '@pantheon/shared';

describe.each(BACKENDS)('CostTracker [$name]', (backend) => {
    const getDb = useBackend(backend);
    let tracker: CostTracker;

    beforeEach(() => {
        tracker = new CostTracker(getDb());
    });

    const makeUsage = (modelId: string, inputTokens: number, outputTokens: number): Omit<UsageRecord, 'id'> => ({
        timestamp: new Date().toISOString(),
        modelId,
        inputTokens,
        outputTokens,
        costUsd: 0,
        promptPreview: 'test prompt',
    });

    it('record + getRecent', async () => {
        await tracker.record(makeUsage('model-1', 10, 20));
        const recent = await tracker.getRecent(1);
        expect(recent).toHaveLength(1);
        expect(recent[0]?.modelId).toBe('model-1');
        expect(recent[0]?.inputTokens).toBe(10);
        expect(recent[0]?.outputTokens).toBe(20);
    });

    it('getSummary with data', async () => {
        await tracker.record(makeUsage('model-1', 10, 20));
        await tracker.record(makeUsage('model-2', 5, 10));
        const summary = await tracker.getSummary();
        expect(summary.totalCalls).toBe(2);
        expect(summary.totalInputTokens).toBe(15);
        expect(summary.totalOutputTokens).toBe(30);
    });

    it('getSummary empty returns zeros', async () => {
        const summary = await tracker.getSummary();
        expect(summary.totalCalls).toBe(0);
        expect(summary.totalInputTokens).toBe(0);
        expect(summary.totalOutputTokens).toBe(0);
        expect(summary.totalCostUsd).toBe(0);
    });

    it('getByModel groups correctly', async () => {
        await tracker.record(makeUsage('model-1', 10, 20));
        await tracker.record(makeUsage('model-1', 5, 5));
        await tracker.record(makeUsage('model-2', 5, 10));

        const byModel = await tracker.getByModel();
        const model1 = byModel['model-1'];
        expect(model1).toBeDefined();
        expect(model1?.inputTokens).toBe(15);
        expect(model1?.outputTokens).toBe(25);
        expect(model1?.calls).toBe(2);

        const model2 = byModel['model-2'];
        expect(model2).toBeDefined();
        expect(model2?.inputTokens).toBe(5);
        expect(model2?.calls).toBe(1);
    });

    it('reset clears all data', async () => {
        await tracker.record(makeUsage('model-1', 10, 20));
        await tracker.reset();
        const summary = await tracker.getSummary();
        expect(summary.totalCalls).toBe(0);
        expect(summary.totalInputTokens).toBe(0);
        const recent = await tracker.getRecent();
        expect(recent).toHaveLength(0);
    });

    describe("per-session usage", () => {
        async function seedTwoSessions() {
            const { SessionManager } = await import("../../session/session-manager.js");
            const sessions = new SessionManager(getDb());
            const a = await sessions.create("a");
            const b = await sessions.create("b");
            await tracker.record({ ...makeUsage("model-1", 10, 20), costUsd: 0.5, sessionId: a });
            await tracker.record({ ...makeUsage("model-2", 1, 2), costUsd: 0.25, sessionId: a });
            await tracker.record({ ...makeUsage("model-1", 100, 200), costUsd: 4, sessionId: b });
            await tracker.record(makeUsage("model-1", 1000, 2000)); // no session
            return { a, b, sessions };
        }

        it("stores the session id and filters summary, by-model and recent by it", async () => {
            const { a, b } = await seedTwoSessions();

            expect(await tracker.getSummary(a)).toEqual({ totalCalls: 2, totalInputTokens: 11, totalOutputTokens: 22, totalCostUsd: 0.75 });
            expect(await tracker.getSummary(b)).toEqual({ totalCalls: 1, totalInputTokens: 100, totalOutputTokens: 200, totalCostUsd: 4 });
            expect((await tracker.getSummary()).totalCalls).toBe(4);

            expect(Object.keys(await tracker.getByModel(a)).sort()).toEqual(["model-1", "model-2"]);
            expect((await tracker.getByModel(b))["model-1"]).toMatchObject({ calls: 1, inputTokens: 100 });

            const recent = await tracker.getRecent(10, a);
            expect(recent.map((r) => r.modelId)).toEqual(["model-2", "model-1"]);
            expect(recent.every((r) => r.sessionId === a)).toBe(true);
        });

        it("returns zeros for a session with no usage", async () => {
            await seedTwoSessions();
            expect(await tracker.getSummary("no-such-session")).toEqual({ totalCalls: 0, totalInputTokens: 0, totalOutputTokens: 0, totalCostUsd: 0 });
            expect(await tracker.getByModel("no-such-session")).toEqual({});
        });

        it("keeps the usage (detached) when its session is deleted", async () => {
            const { a, sessions } = await seedTwoSessions();
            await sessions.delete(a);
            expect((await tracker.getSummary()).totalCalls).toBe(4);
            expect((await tracker.getSummary(a)).totalCalls).toBe(0);
        });

        it("rejects a usage record that references an unknown session", async () => {
            await expect(tracker.record({ ...makeUsage("m", 1, 1), sessionId: "ghost" })).rejects.toThrow();
        });
    });
});

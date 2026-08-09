import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { createTestDb } from '../../db/client.js';
import { CostTracker } from '../tracker.js';
import type { UsageRecord } from '@pantheon/shared';

describe('CostTracker', () => {
    let tracker: CostTracker;

    beforeEach(() => {
        const sqlite = new Database(':memory:');
        const db = createTestDb(sqlite);
        tracker = new CostTracker(db);
    });

    const makeUsage = (modelId: string, inputTokens: number, outputTokens: number): Omit<UsageRecord, 'id'> => ({
        timestamp: new Date().toISOString(),
        modelId,
        inputTokens,
        outputTokens,
        costUsd: 0,
        promptPreview: 'test prompt',
    });

    it('record + getRecent', () => {
        tracker.record(makeUsage('model-1', 10, 20));
        const recent = tracker.getRecent(1);
        expect(recent).toHaveLength(1);
        expect(recent[0]?.modelId).toBe('model-1');
        expect(recent[0]?.inputTokens).toBe(10);
        expect(recent[0]?.outputTokens).toBe(20);
    });

    it('getSummary with data', () => {
        tracker.record(makeUsage('model-1', 10, 20));
        tracker.record(makeUsage('model-2', 5, 10));
        const summary = tracker.getSummary();
        expect(summary.totalCalls).toBe(2);
        expect(summary.totalInputTokens).toBe(15);
        expect(summary.totalOutputTokens).toBe(30);
    });

    it('getSummary empty returns zeros', () => {
        const summary = tracker.getSummary();
        expect(summary.totalCalls).toBe(0);
        expect(summary.totalInputTokens).toBe(0);
        expect(summary.totalOutputTokens).toBe(0);
        expect(summary.totalCostUsd).toBe(0);
    });

    it('getByModel groups correctly', () => {
        tracker.record(makeUsage('model-1', 10, 20));
        tracker.record(makeUsage('model-1', 5, 5));
        tracker.record(makeUsage('model-2', 5, 10));

        const byModel = tracker.getByModel();
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

    it('reset clears all data', () => {
        tracker.record(makeUsage('model-1', 10, 20));
        tracker.reset();
        const summary = tracker.getSummary();
        expect(summary.totalCalls).toBe(0);
        expect(summary.totalInputTokens).toBe(0);
        const recent = tracker.getRecent();
        expect(recent).toHaveLength(0);
    });
});

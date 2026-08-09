/**
 * Standalone test runner for v0.4 database tests.
 * Runs in the main Node.js process to avoid vitest worker pool native addon issues.
 */
import Database from 'better-sqlite3';
import { createTestDb } from '../client.js';
import { SessionManager } from '../../session/session-manager.js';
import { CostTracker } from '../../cost/tracker.js';
import type { ChatMessage, UsageRecord } from '@pantheon/shared';

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string) {
    if (condition) {
        console.log(`  ✓ ${message}`);
        passed++;
    } else {
        console.error(`  ✗ ${message}`);
        failed++;
    }
}

function assertEqual(actual: unknown, expected: unknown, message: string) {
    const ok = actual === expected;
    if (ok) {
        console.log(`  ✓ ${message}`);
        passed++;
    } else {
        console.error(`  ✗ ${message} (got: ${JSON.stringify(actual)}, expected: ${JSON.stringify(expected)})`);
        failed++;
    }
}

try {
    // ─── SessionManager Tests ────────────────────────────────────
    console.log('\nSessionManager');
    console.log('─'.repeat(40));

    const db = createTestDb(new Database(':memory:'));
    const mgr = new SessionManager(db);

    // create
    const id = mgr.create('Test Session');
    assert(typeof id === 'string' && id.length > 0, 'create returns a UUID');

    // get
    const session = mgr.get(id);
    assert(session !== undefined, 'get returns the created session');
    assertEqual(session?.title, 'Test Session', 'session has correct title');
    assertEqual(session?.isArchived, false, 'session is not archived');

    // list
    mgr.create('Session 2');
    const list = mgr.list();
    assertEqual(list.length, 2, 'list returns all sessions');
    assertEqual(list[0]?.title, 'Session 2', 'list is ordered by createdAt desc');

    // addMessage + getMessages
    const msg: ChatMessage = { role: 'user', content: 'hello world' };
    mgr.addMessage(id, msg);
    const msgs = mgr.getMessages(id);
    assertEqual(msgs.length, 1, 'getMessages returns 1 message');
    assertEqual(msgs[0]?.role, 'user', 'message has correct role');
    assertEqual(msgs[0]?.content, 'hello world', 'message has correct content');

    // messageCount
    const s2 = mgr.get(id);
    assertEqual(s2?.messageCount, 1, 'get includes messageCount');

    // auto-title
    const id2 = mgr.create();
    mgr.addMessage(id2, { role: 'user', content: 'How do I configure Docker compose?' });
    const autoTitled = mgr.get(id2);
    assert(autoTitled?.title.includes('Docker') === true, 'auto-generates title from first user message');

    // toolCalls serialization
    const id3 = mgr.create('Tool Test');
    mgr.addMessage(id3, {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'tc1', name: 'read_file', arguments: { path: '/tmp/test' } }],
    });
    const toolMsgs = mgr.getMessages(id3);
    assert(toolMsgs[0]?.toolCalls !== undefined, 'toolCalls are deserialized');
    assertEqual(toolMsgs[0]?.toolCalls?.[0]?.name, 'read_file', 'toolCall has correct name');

    // archive
    mgr.archive(id);
    const archived = mgr.get(id);
    assertEqual(archived?.isArchived, true, 'archive sets isArchived');

    // list excludes archived
    const nonArchived = mgr.list();
    assert(!nonArchived.some(s => s.id === id), 'list excludes archived by default');

    const withArchived = mgr.list({ includeArchived: true });
    assert(withArchived.some(s => s.id === id), 'list includes archived with flag');

    // getLatest
    const latest = mgr.getLatest();
    assert(latest !== undefined && latest.id !== id, 'getLatest returns most recent non-archived');

    // updateTitle
    mgr.updateTitle(id, 'New Title');
    assertEqual(mgr.get(id)?.title, 'New Title', 'updateTitle works');

    // delete
    mgr.delete(id);
    assertEqual(mgr.get(id), undefined, 'delete removes session');

    // ─── CostTracker Tests ────────────────────────────────────────
    console.log('\nCostTracker');
    console.log('─'.repeat(40));

    const db2 = createTestDb(new Database(':memory:'));
    const tracker = new CostTracker(db2);

    const usage: Omit<UsageRecord, 'id'> = {
        timestamp: new Date().toISOString(),
        modelId: 'model-1',
        inputTokens: 100,
        outputTokens: 200,
        costUsd: 0.005,
        promptPreview: 'test prompt',
    };

    // record + getRecent
    tracker.record(usage);
    const recent = tracker.getRecent(1);
    assertEqual(recent.length, 1, 'record + getRecent works');
    assertEqual(recent[0]?.modelId, 'model-1', 'record stores modelId');

    // getSummary
    tracker.record({ ...usage, modelId: 'model-2', inputTokens: 50, outputTokens: 100 });
    const summary = tracker.getSummary();
    assertEqual(summary.totalCalls, 2, 'getSummary totalCalls');
    assertEqual(summary.totalInputTokens, 150, 'getSummary totalInputTokens');
    assertEqual(summary.totalOutputTokens, 300, 'getSummary totalOutputTokens');

    // getByModel
    const byModel = tracker.getByModel();
    assert(byModel['model-1'] !== undefined, 'getByModel has model-1');
    assertEqual(byModel['model-1']?.calls, 1, 'getByModel model-1 calls');
    assertEqual(byModel['model-2']?.inputTokens, 50, 'getByModel model-2 inputTokens');

    // empty state
    const db3 = createTestDb(new Database(':memory:'));
    const empty = new CostTracker(db3);
    const emptySummary = empty.getSummary();
    assertEqual(emptySummary.totalCalls, 0, 'empty getSummary totalCalls is 0');

    // reset
    tracker.reset();
    assertEqual(tracker.getSummary().totalCalls, 0, 'reset clears all data');
    assertEqual(tracker.getRecent().length, 0, 'reset clears recent');

} catch (error) {
    console.error('\n  FATAL ERROR:', error);
    failed++;
}

// ─── Results ────────────────────────────────────────────────
console.log(`\n${'─'.repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

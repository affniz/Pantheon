import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createTestDb } from '../../db/client.js';
import { SessionManager } from '../session-manager.js';
import type { ChatMessage } from '@pantheon/shared';

describe('SessionManager', () => {
    let manager: SessionManager;

    beforeEach(() => {
        const sqlite = new Database(':memory:');
        const db = createTestDb(sqlite);
        manager = new SessionManager(db);
    });

    it('create returns a UUID', () => {
        const sessionId = manager.create('test-session');
        expect(sessionId).toBeDefined();
        expect(typeof sessionId).toBe('string');
        expect(sessionId.length).toBeGreaterThan(0);
    });

    it('get returns the created session', () => {
        const sessionId = manager.create('test-session');
        const session = manager.get(sessionId);
        expect(session).toBeDefined();
        expect(session?.id).toBe(sessionId);
        expect(session?.title).toBe('test-session');
        expect(session?.isArchived).toBe(false);
    });

    it('list returns sessions ordered by createdAt desc', () => {
        // Ensure sessions have distinct timestamps by controlling time
        const base = new Date('2024-01-01T00:00:00.000Z').getTime();
        vi.useFakeTimers();
        vi.setSystemTime(base);
        manager.create('session-1');
        vi.setSystemTime(base + 1000); // 1 second later
        const sid2 = manager.create('session-2');
        vi.useRealTimers();

        const sessions = manager.list();
        expect(sessions).toHaveLength(2);
        expect(sessions[0]?.id).toBe(sid2);
    });

    it('addMessage stores and retrieves messages', () => {
        const sessionId = manager.create('test-session');
        const message: ChatMessage = { role: 'user', content: 'hello' };
        manager.addMessage(sessionId, message);

        const msgs = manager.getMessages(sessionId);
        expect(msgs).toHaveLength(1);
        expect(msgs[0]?.role).toBe('user');
        expect(msgs[0]?.content).toBe('hello');
    });

    it('get includes messageCount', () => {
        const sessionId = manager.create('test-session');
        manager.addMessage(sessionId, { role: 'user', content: 'hello' });
        manager.addMessage(sessionId, { role: 'assistant', content: 'hi' });

        const session = manager.get(sessionId);
        expect(session?.messageCount).toBe(2);
    });

    it('addMessage auto-generates title from first user message', () => {
        const sessionId = manager.create();
        const message: ChatMessage = { role: 'user', content: 'this is a long message that should be truncated' };
        manager.addMessage(sessionId, message);

        const session = manager.get(sessionId);
        expect(session?.title).toContain('this is a long');
    });

    it('addMessage serializes/deserializes toolCalls', () => {
        const sessionId = manager.create('test-session');
        const message: ChatMessage = {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: '1', name: 'test', arguments: { key: 'value' } }],
        };
        manager.addMessage(sessionId, message);

        const msgs = manager.getMessages(sessionId);
        expect(msgs[0]?.toolCalls).toBeDefined();
        expect(msgs[0]?.toolCalls?.[0]?.name).toBe('test');
        expect(msgs[0]?.toolCalls?.[0]?.arguments).toEqual({ key: 'value' });
    });

    it('archive sets isArchived to true', () => {
        const sessionId = manager.create('test-session');
        manager.archive(sessionId);
        const session = manager.get(sessionId);
        expect(session?.isArchived).toBe(true);
    });

    it('delete removes the session', () => {
        const sessionId = manager.create('test-session');
        manager.delete(sessionId);
        const session = manager.get(sessionId);
        expect(session).toBeUndefined();
    });

    it('getLatest returns most recent non-archived session', () => {
        const sid1 = manager.create('session-1');
        manager.archive(sid1);
        const sid2 = manager.create('session-2');
        const latest = manager.getLatest();
        expect(latest?.id).toBe(sid2);
    });

    it('updateTitle changes the title', () => {
        const sessionId = manager.create('test-session');
        manager.updateTitle(sessionId, 'new-title');
        const session = manager.get(sessionId);
        expect(session?.title).toBe('new-title');
    });

    it('list excludes archived by default, includes with flag', () => {
        const sid1 = manager.create('session-1');
        manager.archive(sid1);
        const sid2 = manager.create('session-2');

        const sessions = manager.list();
        expect(sessions).toHaveLength(1);
        expect(sessions[0]?.id).toBe(sid2);

        const allSessions = manager.list({ includeArchived: true });
        expect(allSessions).toHaveLength(2);
    });
});

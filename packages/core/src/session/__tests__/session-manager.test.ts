import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BACKENDS, useBackend } from '../../db/__tests__/backends.js';
import { SessionManager } from '../session-manager.js';
import type { ChatMessage } from '@pantheon/shared';

describe.each(BACKENDS)('SessionManager [$name]', (backend) => {
    const getDb = useBackend(backend);
    let manager: SessionManager;

    beforeEach(() => {
        manager = new SessionManager(getDb());
    });

    it('create returns a UUID', async () => {
        const sessionId = await manager.create('test-session');
        expect(sessionId).toBeDefined();
        expect(typeof sessionId).toBe('string');
        expect(sessionId.length).toBeGreaterThan(0);
    });

    it('get returns the created session', async () => {
        const sessionId = await manager.create('test-session');
        const session = await manager.get(sessionId);
        expect(session).toBeDefined();
        expect(session?.id).toBe(sessionId);
        expect(session?.title).toBe('test-session');
        expect(session?.isArchived).toBe(false);
    });

    it('list returns sessions ordered by createdAt desc', async () => {
        // Ensure sessions have distinct timestamps by controlling time
        const base = new Date('2024-01-01T00:00:00.000Z').getTime();
        vi.useFakeTimers();
        vi.setSystemTime(base);
        await manager.create('session-1');
        vi.setSystemTime(base + 1000); // 1 second later
        const sid2 = await manager.create('session-2');
        vi.useRealTimers();

        const sessions = await manager.list();
        expect(sessions).toHaveLength(2);
        expect(sessions[0]?.id).toBe(sid2);
    });

    it('addMessage stores and retrieves messages', async () => {
        const sessionId = await manager.create('test-session');
        const message: ChatMessage = { role: 'user', content: 'hello' };
        await manager.addMessage(sessionId, message);

        const msgs = await manager.getMessages(sessionId);
        expect(msgs).toHaveLength(1);
        expect(msgs[0]?.role).toBe('user');
        expect(msgs[0]?.content).toBe('hello');
    });

    it('get includes messageCount', async () => {
        const sessionId = await manager.create('test-session');
        await manager.addMessage(sessionId, { role: 'user', content: 'hello' });
        await manager.addMessage(sessionId, { role: 'assistant', content: 'hi' });

        const session = await manager.get(sessionId);
        expect(session?.messageCount).toBe(2);
    });

    it('addMessage auto-generates title from first user message', async () => {
        const sessionId = await manager.create();
        const message: ChatMessage = { role: 'user', content: 'this is a long message that should be truncated' };
        await manager.addMessage(sessionId, message);

        const session = await manager.get(sessionId);
        expect(session?.title).toContain('this is a long');
    });

    it('addMessage serializes/deserializes toolCalls', async () => {
        const sessionId = await manager.create('test-session');
        const message: ChatMessage = {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: '1', name: 'test', arguments: { key: 'value' } }],
        };
        await manager.addMessage(sessionId, message);

        const msgs = await manager.getMessages(sessionId);
        expect(msgs[0]?.toolCalls).toBeDefined();
        expect(msgs[0]?.toolCalls?.[0]?.name).toBe('test');
        expect(msgs[0]?.toolCalls?.[0]?.arguments).toEqual({ key: 'value' });
    });

    it('archive sets isArchived to true', async () => {
        const sessionId = await manager.create('test-session');
        await manager.archive(sessionId);
        const session = await manager.get(sessionId);
        expect(session?.isArchived).toBe(true);
    });

    it('delete removes the session', async () => {
        const sessionId = await manager.create('test-session');
        await manager.delete(sessionId);
        const session = await manager.get(sessionId);
        expect(session).toBeUndefined();
    });

    it('getLatest returns most recent non-archived session', async () => {
        const sid1 = await manager.create('session-1');
        await manager.archive(sid1);
        const sid2 = await manager.create('session-2');
        const latest = await manager.getLatest();
        expect(latest?.id).toBe(sid2);
    });

    it('updateTitle changes the title', async () => {
        const sessionId = await manager.create('test-session');
        await manager.updateTitle(sessionId, 'new-title');
        const session = await manager.get(sessionId);
        expect(session?.title).toBe('new-title');
    });

    it('list excludes archived by default, includes with flag', async () => {
        const sid1 = await manager.create('session-1');
        await manager.archive(sid1);
        const sid2 = await manager.create('session-2');

        const sessions = await manager.list();
        expect(sessions).toHaveLength(1);
        expect(sessions[0]?.id).toBe(sid2);

        const allSessions = await manager.list({ includeArchived: true });
        expect(allSessions).toHaveLength(2);
    });
});

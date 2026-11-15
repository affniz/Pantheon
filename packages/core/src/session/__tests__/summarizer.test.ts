import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import type { ChatMessage } from "@pantheon/shared";
import { BACKENDS, useBackend } from "../../db/__tests__/backends.js";
import { SessionManager } from "../session-manager.js";
import { SessionSummarizer } from "../summarizer.js";
import type { Gateway } from "../../gateway/gateway.js";

function makeGateway(reply = "They discussed X and shipped Y.") {
    const complete = vi.fn(async () => ({
        message: { role: "assistant" as const, content: reply },
        usage: { inputTokens: 1, outputTokens: 1 },
    }));
    return { gateway: { complete } as unknown as Gateway, complete };
}

const CONVERSATION: ChatMessage[] = [
    { role: "system", content: "you are helpful" },
    { role: "user", content: "How do I add an index?" },
    { role: "assistant", content: "Use CREATE INDEX." },
    { role: "tool", content: "tool output that must not be summarised" },
];

describe.each(BACKENDS)("SessionSummarizer [$name]", (backend) => {
    const getDb = useBackend(backend);
    let sessions: SessionManager;

    beforeEach(() => {
        sessions = new SessionManager(getDb());
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    /** Create sessions with strictly increasing timestamps so ordering is deterministic. */
    let clock = 0;
    async function createSession(title: string, messages: ChatMessage[] = []): Promise<string> {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-05-01T00:00:00.000Z").getTime() + ++clock * 60_000);
        const id = await sessions.create(title);
        for (const m of messages) await sessions.addMessage(id, m);
        vi.useRealTimers();
        return id;
    }

    it("summarize() sends only user and assistant turns to the model", async () => {
        const { gateway, complete } = makeGateway();
        const summary = await new SessionSummarizer(gateway, "fast-model", getDb()).summarize(CONVERSATION);

        expect(summary).toBe("They discussed X and shipped Y.");
        const [sent, modelId] = complete.mock.calls[0] as unknown as [ChatMessage[], string];
        expect(modelId).toBe("fast-model");
        expect(sent[1]!.content).toBe("user: How do I add an index?\nassistant: Use CREATE INDEX.");
    });

    it("saveForSession stores the summary and getSummary reads it back", async () => {
        const { gateway } = makeGateway("stored summary");
        const summarizer = new SessionSummarizer(gateway, "m", getDb());
        const id = await createSession("s");

        expect(await summarizer.getSummary(id)).toBeUndefined();
        await summarizer.saveForSession(id, CONVERSATION);
        expect(await summarizer.getSummary(id)).toBe("stored summary");
    });

    it("saveForSession does not call the model again once a summary exists", async () => {
        const { gateway, complete } = makeGateway();
        const summarizer = new SessionSummarizer(gateway, "m", getDb());
        const id = await createSession("s");

        await summarizer.saveForSession(id, CONVERSATION);
        await summarizer.saveForSession(id, CONVERSATION);
        expect(complete).toHaveBeenCalledTimes(1);
    });

    it("two overlapping saveForSession calls do not fail on the unique constraint", async () => {
        const { gateway } = makeGateway("racy");
        const summarizer = new SessionSummarizer(gateway, "m", getDb());
        const id = await createSession("s");

        await expect(
            Promise.all([summarizer.saveForSession(id, CONVERSATION), summarizer.saveForSession(id, CONVERSATION)]),
        ).resolves.toBeDefined();
        expect(await summarizer.getSummary(id)).toBe("racy");
        expect(await summarizer.getRecentSummaries()).toHaveLength(1);
    });

    it("getRecentSummaries joins the session title and honours the limit", async () => {
        const { gateway } = makeGateway("sum");
        const summarizer = new SessionSummarizer(gateway, "m", getDb());
        for (const title of ["one", "two", "three"]) {
            await summarizer.saveForSession(await createSession(title), CONVERSATION);
        }
        const recent = await summarizer.getRecentSummaries(2);
        expect(recent).toHaveLength(2);
        expect(recent[0]).toMatchObject({ summary: "sum" });
        expect(["one", "two", "three"]).toContain(recent[0]!.title);
    });

    describe("getEpisodicMemoryContext", () => {
        it("is empty when there is no history", async () => {
            const current = await createSession("current");
            const summarizer = new SessionSummarizer(makeGateway().gateway, "m", getDb());
            expect(await summarizer.getEpisodicMemoryContext(current)).toBe("");
        });

        it("injects the last messages of the most recent other session, oldest first", async () => {
            const past = await createSession("Refactor auth", [
                { role: "user", content: "first question" },
                { role: "assistant", content: "first answer" },
                { role: "tool", content: "TOOL NOISE" },
                { role: "user", content: "second question" },
                { role: "assistant", content: "second answer" },
            ]);
            const current = await createSession("current", [{ role: "user", content: "CURRENT SESSION TEXT" }]);
            const summarizer = new SessionSummarizer(makeGateway().gateway, "m", getDb());

            const ctx = await summarizer.getEpisodicMemoryContext(current, { recentMessageCount: 3 });

            expect(ctx).toContain('## Recent context (last session — "Refactor auth")');
            // last 3 user/assistant messages, in chronological order
            expect(ctx).toContain("assistant: first answer\nuser: second question\nassistant: second answer");
            expect(ctx).not.toContain("first question");
            expect(ctx).not.toContain("TOOL NOISE");
            expect(ctx).not.toContain("CURRENT SESSION TEXT");
            expect(past).not.toBe(current);
        });

        it("truncates very long messages", async () => {
            await createSession("long", [{ role: "user", content: "x".repeat(2000) }]);
            const current = await createSession("current");
            const ctx = await new SessionSummarizer(makeGateway().gateway, "m", getDb()).getEpisodicMemoryContext(current);
            expect(ctx).toContain("user: " + "x".repeat(500));
            expect(ctx).not.toContain("x".repeat(501));
        });

        it("ignores archived sessions", async () => {
            const archived = await createSession("archived one", [{ role: "user", content: "secret archived text" }]);
            await sessions.archive(archived);
            const current = await createSession("current");
            const ctx = await new SessionSummarizer(makeGateway().gateway, "m", getDb()).getEpisodicMemoryContext(current);
            expect(ctx).not.toContain("secret archived text");
        });

        it("adds summaries of older sessions, excluding the current and the most recent one", async () => {
            const { gateway } = makeGateway();
            const summarizer = new SessionSummarizer(gateway, "m", getDb());
            const save = async (id: string, text: string) => {
                vi.mocked(gateway.complete).mockResolvedValueOnce({
                    message: { role: "assistant", content: text },
                    usage: { inputTokens: 1, outputTokens: 1 },
                });
                await summarizer.saveForSession(id, CONVERSATION);
            };

            const oldest = await createSession("Oldest", [{ role: "user", content: "o" }]);
            const older = await createSession("Older", [{ role: "user", content: "o" }]);
            const last = await createSession("Last", [{ role: "user", content: "most recent raw message" }]);
            const current = await createSession("Current", [{ role: "user", content: "now" }]);
            await save(oldest, "summary of oldest");
            await save(older, "summary of older");
            await save(last, "summary of last");
            await save(current, "summary of current");

            const ctx = await summarizer.getEpisodicMemoryContext(current);

            expect(ctx).toContain('## Recent context (last session — "Last")');
            expect(ctx).toContain("most recent raw message");
            expect(ctx).toContain("## Past sessions (summaries)");
            expect(ctx).toContain('"Oldest" — summary of oldest');
            expect(ctx).toContain('"Older" — summary of older');
            // The last session is already present verbatim; the current one is the live conversation
            expect(ctx).not.toContain("summary of last");
            expect(ctx).not.toContain("summary of current");
        });

        it("caps the number of older summaries at summaryLimit", async () => {
            const { gateway } = makeGateway("s");
            const summarizer = new SessionSummarizer(gateway, "m", getDb());
            for (let i = 0; i < 5; i++) {
                await summarizer.saveForSession(await createSession(`old-${i}`), CONVERSATION);
            }
            const current = await createSession("current");
            const ctx = await summarizer.getEpisodicMemoryContext(current, { summaryLimit: 2 });
            expect(ctx.split("\n").filter((l) => l.startsWith("- ["))).toHaveLength(2);
        });
    });
});

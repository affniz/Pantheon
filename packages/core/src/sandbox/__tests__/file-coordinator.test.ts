import { describe, it, expect } from "vitest";
import { FileCoordinator } from "../file-coordinator.js";

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

describe("FileCoordinator", () => {
    it("runs writes to the same file one at a time, in request order", async () => {
        const files = new FileCoordinator();
        const log: string[] = [];
        const write = (name: string, ms: number) => files.withWrite("/p/a.ts", "agent", "edit", async () => {
            log.push(`${name}:start`);
            await tick(ms);
            log.push(`${name}:end`);
        });

        await Promise.all([write("first", 20), write("second", 1), write("third", 1)]);
        expect(log).toEqual(["first:start", "first:end", "second:start", "second:end", "third:start", "third:end"]);
    });

    it("does not make different files wait for each other", async () => {
        const files = new FileCoordinator();
        const log: string[] = [];
        await Promise.all([
            files.withWrite("/p/slow.ts", "a", "create", async () => { await tick(30); log.push("slow"); }),
            files.withWrite("/p/fast.ts", "b", "create", async () => { log.push("fast"); }),
        ]);
        expect(log).toEqual(["fast", "slow"]);
    });

    it("refuses a whole-file overwrite of another agent's file, but allows the owner and edits", async () => {
        const files = new FileCoordinator();
        await files.withWrite("/p/a.ts", "one", "create", () => "v1");

        await expect(files.withWrite("/p/a.ts", "two", "create", () => "v2")).rejects.toThrow(/already written by another agent/);
        await expect(files.withWrite("/p/a.ts", "one", "create", () => "v3")).resolves.toBe("v3");
        await expect(files.withWrite("/p/a.ts", "two", "edit", () => "edited")).resolves.toBe("edited");
        // After an edit the file is jointly owned in effect: the last writer is recorded
        expect(files.writtenFiles()).toEqual([{ path: "/p/a.ts", agentId: "two" }]);
    });

    it("decides conflicts in arrival order when two agents race for a new file", async () => {
        const files = new FileCoordinator();
        const results = await Promise.allSettled([
            files.withWrite("/p/new.ts", "one", "create", async () => { await tick(10); return "one"; }),
            files.withWrite("/p/new.ts", "two", "create", () => "two"),
        ]);
        expect(results[0]).toMatchObject({ status: "fulfilled", value: "one" });
        expect(results[1]!.status).toBe("rejected");
    });

    it("a failed write does not block the queue or claim ownership", async () => {
        const files = new FileCoordinator();
        await expect(files.withWrite("/p/a.ts", "one", "create", () => { throw new Error("disk full"); })).rejects.toThrow("disk full");
        await expect(files.withWrite("/p/a.ts", "two", "create", () => "ok")).resolves.toBe("ok");
        expect(files.writtenFiles()).toEqual([{ path: "/p/a.ts", agentId: "two" }]);
    });

    it("endPhase clears ownership but remembers what was touched", async () => {
        const files = new FileCoordinator();
        expect(files.hasWrites).toBe(false);
        await files.withWrite("/p/a.ts", "one", "create", () => undefined);
        files.endPhase();

        await expect(files.withWrite("/p/a.ts", "two", "create", () => "rewritten")).resolves.toBe("rewritten");
        expect(files.hasWrites).toBe(true);
        expect(files.writtenFiles()).toEqual([{ path: "/p/a.ts", agentId: "two" }]);
    });
});

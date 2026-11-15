/**
 * Coordinates file writes between agents that run in parallel on one project.
 *
 * Without it, two sub-agents of the same orchestration could interleave writes to
 * a file, or one could silently replace a file another had just written. The
 * coordinator gives each path a queue (writes are applied one at a time) and
 * remembers who wrote what, so a whole-file overwrite of another agent's work is
 * refused with an explanation the model can act on, instead of destroying it.
 *
 * Targeted edits (`edit_file`) from different agents are allowed: they are
 * serialised, and each must still match the file's current content exactly, so a
 * stale edit fails on its own.
 */
export class FileCoordinator {
    private queues = new Map<string, Promise<unknown>>();
    /** Who wrote each file during the current phase — the basis for conflict detection. */
    private writers = new Map<string, string>();
    /** Every file written during the whole run, with its most recent writer. */
    private touched = new Map<string, string>();

    /**
     * Run `write` with exclusive access to `filePath`.
     * @param mode "create" for whole-file writes, "edit" for in-place edits.
     * @throws when `mode` is "create" and another agent already wrote the file in this run.
     */
    async withWrite<T>(filePath: string, agentId: string, mode: "create" | "edit", write: () => T | Promise<T>): Promise<T> {
        const previous = this.queues.get(filePath) ?? Promise.resolve();

        const run = previous.catch(() => undefined).then(async () => {
            const owner = this.writers.get(filePath);
            if (mode === "create" && owner !== undefined && owner !== agentId) {
                throw new Error(
                    `${filePath} was already written by another agent working in parallel. ` +
                    "Overwriting it would discard their work. Read the file and apply your change with edit_file instead.",
                );
            }
            const result = await write();
            this.writers.set(filePath, agentId);
            this.touched.set(filePath, agentId);
            return result;
        });

        this.queues.set(filePath, run);
        try {
            return await run;
        } finally {
            // Drop the queue entry once it is idle so the map does not grow without bound
            if (this.queues.get(filePath) === run) this.queues.delete(filePath);
        }
    }

    /**
     * End the current phase (a wave of parallel agents). Ownership only matters
     * between agents running at the same time: an agent of a later wave builds on
     * the earlier output and may legitimately rewrite it, as may a fix agent.
     */
    endPhase(): void {
        this.writers.clear();
    }

    /** Files written during this run, with the agent that wrote each last. */
    writtenFiles(): Array<{ path: string; agentId: string }> {
        return [...this.touched].map(([path, agentId]) => ({ path, agentId }));
    }

    get hasWrites(): boolean {
        return this.touched.size > 0;
    }
}

import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        include: ['packages/*/src/**/__tests__/**/*.test.ts'],
        globals: true,
        // Use the forks pool (one child process per test file). Native addons such as
        // better-sqlite3 register per-environment cleanup hooks; with the vmThreads pool
        // a reused worker thread disposes a file's VM context while its `Database` objects
        // are still alive, and their later garbage collection aborts the whole worker
        // ("RemoveEnvironmentCleanupHook ... Assertion failed: (env) != nullptr").
        pool: 'forks',
        // Closes every test SQLite handle after each file (see vitest.setup.ts).
        setupFiles: ['./vitest.setup.ts'],
    },
});

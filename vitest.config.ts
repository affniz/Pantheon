import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        include: ['packages/*/src/**/__tests__/**/*.test.ts'],
        globals: true,
        // Use vmThreads pool — compatible with native addons like better-sqlite3
        // unlike the default 'threads' pool which crashes on native modules.
        pool: 'vmThreads',
    },
});

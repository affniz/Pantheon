import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

vi.mock("../../config/loader.js", () => ({
    loadConfig: vi.fn(() => ({})),
}));

// The Vitest setup file has already imported client.js (with the real config
// loader); reset the registry so the copy under test picks up the mock above.
vi.resetModules();
const { loadConfig } = await import("../../config/loader.js");
const {
    parseDatabaseTarget,
    resolveDatabaseTarget,
    redactUrl,
    describeTarget,
    defaultSqlitePath,
    getDb,
    initDb,
    closeDb,
    dialectOf,
    tablesFor,
    getDatabaseStatus,
} = await import("../client.js");
const sqliteSchema = await import("../schema.sqlite.js");

const ENV_KEYS = ["DATABASE_URL", "PANTHEON_DB_PATH"] as const;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
    savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of ENV_KEYS) delete process.env[k];
    vi.mocked(loadConfig).mockReturnValue({} as never);
});

afterEach(async () => {
    await closeDb();
    for (const k of ENV_KEYS) {
        if (savedEnv[k] === undefined) delete process.env[k];
        else process.env[k] = savedEnv[k];
    }
});

describe("parseDatabaseTarget", () => {
    it("recognises postgres:// and postgresql:// URLs", () => {
        expect(parseDatabaseTarget("postgres://u:p@host:5432/db")).toEqual({ dialect: "postgres", url: "postgres://u:p@host:5432/db" });
        expect(parseDatabaseTarget("postgresql://host/db").dialect).toBe("postgres");
        expect(parseDatabaseTarget("  POSTGRES://host/db ").dialect).toBe("postgres");
    });

    it("treats plain paths, file: and sqlite: locations as SQLite", () => {
        expect(parseDatabaseTarget("/var/lib/pantheon.db")).toEqual({ dialect: "sqlite", path: "/var/lib/pantheon.db" });
        expect(parseDatabaseTarget("sqlite:///data/p.db")).toEqual({ dialect: "sqlite", path: "/data/p.db" });
        expect(parseDatabaseTarget("file:/data/p.db")).toEqual({ dialect: "sqlite", path: "/data/p.db" });
        expect(parseDatabaseTarget("relative/p.db")).toEqual({ dialect: "sqlite", path: path.resolve("relative/p.db") });
    });

    it("expands ~ to the home directory", () => {
        expect(parseDatabaseTarget("~/x/p.db")).toEqual({ dialect: "sqlite", path: path.join(os.homedir(), "x/p.db") });
    });

    it("rejects other database URLs instead of treating them as file names", () => {
        expect(() => parseDatabaseTarget("mysql://root:hunter2@host/db")).toThrow(/Unsupported database URL/);
        // …and never echoes the password back
        expect(() => parseDatabaseTarget("mysql://root:hunter2@host/db")).not.toThrow(/hunter2/);
    });
});

describe("resolveDatabaseTarget precedence", () => {
    it("defaults to ~/.pantheon/pantheon.db", () => {
        expect(resolveDatabaseTarget()).toEqual({ dialect: "sqlite", path: defaultSqlitePath() });
        expect(defaultSqlitePath()).toBe(path.join(os.homedir(), ".pantheon", "pantheon.db"));
    });

    it("config.database.sqlitePath overrides the default", () => {
        vi.mocked(loadConfig).mockReturnValue({ database: { sqlitePath: "/cfg/p.db" } } as never);
        expect(resolveDatabaseTarget()).toEqual({ dialect: "sqlite", path: "/cfg/p.db" });
    });

    it("PANTHEON_DB_PATH overrides config.database.sqlitePath", () => {
        vi.mocked(loadConfig).mockReturnValue({ database: { sqlitePath: "/cfg/p.db" } } as never);
        process.env["PANTHEON_DB_PATH"] = "/env/p.db";
        expect(resolveDatabaseTarget()).toEqual({ dialect: "sqlite", path: "/env/p.db" });
    });

    it("config.database.url overrides any SQLite path", () => {
        vi.mocked(loadConfig).mockReturnValue({ database: { url: "postgres://cfg/db", sqlitePath: "/cfg/p.db" } } as never);
        process.env["PANTHEON_DB_PATH"] = "/env/p.db";
        expect(resolveDatabaseTarget()).toEqual({ dialect: "postgres", url: "postgres://cfg/db" });
    });

    it("DATABASE_URL overrides everything", () => {
        vi.mocked(loadConfig).mockReturnValue({ database: { url: "postgres://cfg/db" } } as never);
        process.env["DATABASE_URL"] = "postgres://env/db";
        expect(resolveDatabaseTarget()).toEqual({ dialect: "postgres", url: "postgres://env/db" });
    });

    it("survives an unreadable config file", () => {
        vi.mocked(loadConfig).mockImplementation(() => {
            throw new Error("bad yaml");
        });
        expect(resolveDatabaseTarget()).toEqual({ dialect: "sqlite", path: defaultSqlitePath() });
    });
});

describe("credential redaction", () => {
    it("hides the password but keeps user, host and database", () => {
        expect(redactUrl("postgres://alice:s3cr3t@db.internal:5432/pantheon")).toBe("postgres://alice:***@db.internal:5432/pantheon");
        expect(redactUrl("postgres://alice:p%40ss:word@h/db")).toBe("postgres://alice:***@h/db");
    });

    it("redacts passwords that themselves contain @ or :", () => {
        expect(redactUrl("postgres://alice:p@ss:w0rd@db.internal/pantheon")).toBe("postgres://alice:***@db.internal/pantheon");
    });

    it("does not mistake a port plus an @ later in the URL for credentials", () => {
        const url = "postgres://db.internal:5432/pantheon?application_name=a@b";
        expect(redactUrl(url)).toBe(url);
    });

    it("leaves URLs without a password untouched", () => {
        expect(redactUrl("postgres://db.internal/pantheon")).toBe("postgres://db.internal/pantheon");
        expect(redactUrl("postgres://alice@db.internal/pantheon")).toBe("postgres://alice@db.internal/pantheon");
    });

    it("describeTarget never exposes a password", () => {
        expect(describeTarget({ dialect: "postgres", url: "postgres://u:topsecret@h/db" })).not.toContain("topsecret");
        expect(describeTarget({ dialect: "sqlite", path: "/a/b.db" })).toBe("/a/b.db");
    });
});

describe("singleton", () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pantheon-db-"));
    });

    afterEach(async () => {
        await closeDb();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("getDb() opens and migrates SQLite synchronously, creating parent directories", async () => {
        const file = path.join(tmpDir, "nested", "dir", "p.db");
        process.env["PANTHEON_DB_PATH"] = file;

        const db = getDb();
        expect(fs.existsSync(file)).toBe(true);
        expect(dialectOf(db)).toBe("sqlite");
        expect(tablesFor(db)).toBe(sqliteSchema);
        expect(getDb()).toBe(db);

        const status = await getDatabaseStatus(db);
        expect(status.location).toBe(file);
        expect(status.schemaVersion).toBe(status.latestSchemaVersion);
    });

    it("initDb() returns the same handle getDb() does", async () => {
        process.env["PANTHEON_DB_PATH"] = path.join(tmpDir, "p.db");
        const db = await initDb();
        expect(getDb()).toBe(db);
        expect(await initDb()).toBe(db);
    });

    it("data persists across close and reopen", async () => {
        process.env["PANTHEON_DB_PATH"] = path.join(tmpDir, "p.db");
        const { SessionManager } = await import("../../session/session-manager.js");
        const id = await new SessionManager().create("persisted");
        await closeDb();
        expect((await new SessionManager().get(id))?.title).toBe("persisted");
    });

    it("getDb() refuses to hand out an un-migrated PostgreSQL handle", () => {
        process.env["DATABASE_URL"] = "postgres://user:pw@127.0.0.1:1/none";
        expect(() => getDb()).toThrow(/initDb\(\)/);
    });

    it("initDb() rejects (and can be retried) when PostgreSQL is unreachable", async () => {
        process.env["DATABASE_URL"] = "postgres://user:pw@127.0.0.1:1/none";
        await expect(initDb()).rejects.toThrow();
        // A later attempt with a working configuration must succeed
        delete process.env["DATABASE_URL"];
        process.env["PANTHEON_DB_PATH"] = path.join(tmpDir, "retry.db");
        expect(dialectOf(await initDb())).toBe("sqlite");
    });

    it("rejects handles it did not create", () => {
        expect(() => tablesFor({} as never)).toThrow(/Unknown database handle/);
    });
});

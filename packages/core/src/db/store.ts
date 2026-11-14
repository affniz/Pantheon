import { getDb, tablesFor, type PantheonDatabase, type Tables } from "./client.js";

/**
 * Base class for everything that reads or writes the database.
 *
 * The handle is resolved lazily, on first query, rather than in the constructor:
 * stores are routinely constructed at module load (e.g. one per API route file),
 * which happens before the server has finished `initDb()` on PostgreSQL.
 */
export abstract class DbStore {
    private readonly _db: PantheonDatabase | undefined;

    constructor(db?: PantheonDatabase) {
        this._db = db;
    }

    protected get db(): PantheonDatabase {
        return this._db ?? getDb();
    }

    /** Table objects for the connected dialect. */
    protected get t(): Tables {
        return tablesFor(this.db);
    }
}

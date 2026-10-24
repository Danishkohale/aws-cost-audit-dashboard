/**
 * Test database — uses libSQL in-memory client wrapped as fake D1.
 */
import { createClient } from "@libsql/client";
import type { D1Database } from "../src/db/jobs";
import { setTestDb } from "../src/db/libsql";

let testDb: ReturnType<typeof createClient> | null = null;

export function createTestDb(): D1Database {
	if (!testDb) {
		testDb = createClient({ url: ":memory:" });
		// Also set it for the routes to use
		setTestDb(testDb);
		// Initialize schema
		testDb.batch([
			`CREATE TABLE jobs (
			  id          TEXT PRIMARY KEY,
			  status      TEXT NOT NULL,
			  progress    INTEGER NOT NULL DEFAULT 0,
			  logs        TEXT NOT NULL DEFAULT '[]',
			  summary     TEXT,
			  cost        TEXT,
			  cost_note   TEXT,
			  error       TEXT,
			  region      TEXT,
			  days        INTEGER,
			  step        TEXT,
			  started_at  TEXT,
			  finished_at TEXT,
			  created_at  TEXT NOT NULL
			);`,
			`CREATE INDEX jobs_created_at ON jobs(created_at);`,
			`CREATE TABLE findings (
			  job_id         TEXT NOT NULL,
			  seq            INTEGER NOT NULL,
			  service        TEXT NOT NULL,
			  resource       TEXT NOT NULL,
			  category       TEXT NOT NULL,
			  detail         TEXT NOT NULL,
			  saving         REAL NOT NULL DEFAULT 0,
			  recommendation TEXT NOT NULL,
			  meta           TEXT,
			  PRIMARY KEY (job_id, seq),
			  FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
			);`,
			`CREATE INDEX findings_job ON findings(job_id);`,
		]);
	}

	class FakeStatement {
		constructor(private readonly sql: string) {}

		private values: unknown[] = [];

		bind(...values: unknown[]): FakeStatement {
			this.values = values;
			return this;
		}

		private params(): unknown[] {
			return this.values;
		}

		async run(): Promise<{ success: boolean; results: unknown[]; meta: object }> {
			await testDb!.execute({ sql: this.sql, args: this.params() });
			return { success: true, results: [], meta: {} };
		}

		async first<T = unknown>(): Promise<T | null> {
			const result = await testDb!.execute({ sql: this.sql, args: this.params() });
			return (result.rows[0] as T | undefined) ?? null;
		}

		async all<T = unknown>(): Promise<{ success: boolean; results: T[]; meta: object }> {
			const result = await testDb!.execute({ sql: this.sql, args: this.params() });
			return { success: true, results: result.rows as T[], meta: {} };
		}
	}

	class FakeD1 {
		prepare(sql: string): FakeStatement {
			return new FakeStatement(sql);
		}

		async batch(statements: FakeStatement[]) {
			return Promise.all(statements.map((s) => s.run()));
		}

		async exec(sql: string): Promise<{ count: number; duration: number }> {
			await testDb!.execute({ sql });
			return { count: 0, duration: 0 };
		}
	}

	return new FakeD1() as unknown as D1Database;
}

export function resetTestDb(): void {
	if (testDb) {
		testDb = null;
	}
}
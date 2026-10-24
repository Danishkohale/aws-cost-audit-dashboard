/**
 * Test SQLite database — in-memory for Vitest (Node.js).
 */
import Database from "better-sqlite3";
import type { D1Database } from "../src/db/jobs";

let testDb: Database.Database | null = null;

export function createTestDb(): D1Database {
	if (!testDb) {
		testDb = new Database(":memory:");
		testDb.pragma("journal_mode = WAL");
		testDb.pragma("foreign_keys = ON");
		testDb.exec(`
		CREATE TABLE jobs (
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
		);
		CREATE INDEX jobs_created_at ON jobs(created_at);

		CREATE TABLE findings (
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
		);
		CREATE INDEX findings_job ON findings(job_id);
		`);
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
			testDb!.prepare(this.sql).run(...this.params());
			return { success: true, results: [], meta: {} };
		}

		async first<T = unknown>(): Promise<T | null> {
			const row = testDb!.prepare(this.sql).get(...this.params());
			return (row as T | undefined) ?? null;
		}

		async all<T = unknown>(): Promise<{ success: boolean; results: T[]; meta: object }> {
			const rows = testDb!.prepare(this.sql).all(...this.params()) as T[];
			return { success: true, results: rows, meta: {} };
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
			testDb!.exec(sql);
			return { count: 0, duration: 0 };
		}
	}

	return new FakeD1() as unknown as D1Database;
}

export function resetTestDb(): void {
	if (testDb) {
		testDb.close();
		testDb = null;
	}
}
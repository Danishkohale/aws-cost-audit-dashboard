import { createClient } from "@libsql/client";

const url = process.env.TURSO_DATABASE_URL!;
const authToken = process.env.TURSO_AUTH_TOKEN!;

const db = createClient({ url, authToken });

async function runMigrations() {
	console.log("Running migrations on Turso...");
	
	await db.batch([
		`CREATE TABLE IF NOT EXISTS jobs (
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
		`CREATE INDEX IF NOT EXISTS jobs_created_at ON jobs(created_at);`,
		`CREATE TABLE IF NOT EXISTS findings (
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
		`CREATE INDEX IF NOT EXISTS findings_job ON findings(job_id);`,
	]);
	
	console.log("Migrations completed successfully!");
	
	// Verify tables exist
	const tables = await db.execute("SELECT name FROM sqlite_master WHERE type='table'");
	console.log("Tables:", tables.rows.map(r => r.name));
}

runMigrations().catch(console.error).finally(() => process.exit(0));
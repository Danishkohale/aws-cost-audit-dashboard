/**
 * libSQL (Turso) job store — replaces SQLite for distributed deployment.
 * Uses @libsql/client which works with both remote (Turso) and local databases.
 * 
 * This module provides a factory function to create a database instance.
 * In production, it uses a singleton. In tests, it uses the injected instance.
 */
import { createClient, type Client } from "@libsql/client";
import { randomId } from "./jobs";
import type { Finding, Job, JobStatus, Payload, Summary } from "../types";
import { round2 } from "../report/format";
import { todayIso } from "../report/format";

const TURSO_DATABASE_URL = process.env.TURSO_DATABASE_URL;
const TURSO_AUTH_TOKEN = process.env.TURSO_AUTH_TOKEN;

let productionDb: Client | null = null;

function createDb(): Client {
	if (TURSO_DATABASE_URL && TURSO_AUTH_TOKEN) {
		return createClient({ url: TURSO_DATABASE_URL, authToken: TURSO_AUTH_TOKEN });
	}
	if (process.env.VITEST || process.env.NODE_ENV === "test") {
		return createClient({ url: ":memory:" });
	}
	return createClient({ url: "file:./data/audit.db" });
}

function getProductionDb(): Client {
	if (!productionDb) {
		productionDb = createDb();
	}
	return productionDb;
}

/** Get database instance - uses production singleton unless overridden for tests */
let testDbOverride: Client | null = null;

export function setTestDb(db: Client): void {
	testDbOverride = db;
}

export function clearTestDb(): void {
	testDbOverride = null;
}

export function getDb(): Client {
	return testDbOverride ?? getProductionDb();
}

const TTL_MS = 30 * 60 * 1000;
const MAX_LOGS = 200;
const VIEW_LOGS = 50;

// Initialize schema at module load time for production
let schemaInitPromise: Promise<void>;

async function initSchema(db: Client): Promise<void> {
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
}

// Initialize production schema
schemaInitPromise = initSchema(getProductionDb());

export async function waitForSchema(): Promise<void> {
	await schemaInitPromise;
	// Also ensure test db schema is initialized if overridden
	if (testDbOverride) {
		await initSchema(testDbOverride);
	}
}

// Helper to run with proper db instance
function withDb<T>(fn: (db: Client) => Promise<T>): Promise<T> {
	return fn(getDb());
}

function nowIso(): string {
	return new Date().toISOString();
}

export async function createJob(opts: { id: string; region: string; days: number }): Promise<void> {
	await withDb(async (db) => {
		await db.execute({
			sql: `INSERT INTO jobs (id, status, progress, logs, region, days, created_at)
				  VALUES (?, 'running', 0, '["Queued..."]', ?, ?, ?)`,
			args: [opts.id, opts.region, opts.days, nowIso()],
		});
	});
}

export async function getRow(id: string) {
	return withDb(async (db) => {
		const result = await db.execute({
			sql: "SELECT * FROM jobs WHERE id = ?",
			args: [id],
		});
		return result.rows[0] as
			| {
					id: string;
					status: string;
					progress: number;
					logs: string;
					summary: string | null;
					cost: string | null;
					cost_note: string | null;
					error: string | null;
					region: string | null;
					days: number | null;
					step: string | null;
					started_at: string | null;
					finished_at: string | null;
					created_at: string;
			  }
			| undefined;
	});
}

export async function markStarted(id: string): Promise<void> {
	await withDb(async (db) => {
		await db.execute({
			sql: "UPDATE jobs SET started_at = ? WHERE id = ? AND started_at IS NULL",
			args: [nowIso(), id],
		});
	});
}

export async function appendLog(id: string, line: string): Promise<void> {
	await withDb(async (db) => {
		const row = await db.execute({
			sql: "SELECT * FROM jobs WHERE id = ?",
			args: [id],
		});
		const job = row.rows[0] as typeof row.rows[0] | undefined;
		if (!job) return;
		let logs: string[] = [];
		try {
			logs = JSON.parse(job.logs as string) as string[];
		} catch {
			logs = [];
		}
		logs.push(line);
		if (logs.length > MAX_LOGS) logs = logs.slice(-MAX_LOGS);
		await db.execute({
			sql: "UPDATE jobs SET logs = ? WHERE id = ?",
			args: [JSON.stringify(logs), id],
		});
	});
}

export async function setProgress(id: string, progress: number, step: string): Promise<void> {
	await withDb(async (db) => {
		await db.execute({
			sql: "UPDATE jobs SET progress = ?, step = ? WHERE id = ?",
			args: [progress, step, id],
		});
	});
}

export async function setCost(id: string, cost: Record<string, number>, note: string): Promise<void> {
	await withDb(async (db) => {
		await db.execute({
			sql: "UPDATE jobs SET cost = ?, cost_note = ? WHERE id = ?",
			args: [JSON.stringify(cost), note, id],
		});
	});
}

export async function insertFindings(id: string, findings: Finding[], startSeq: number): Promise<number> {
	if (findings.length === 0) return 0;
	
	return withDb(async (db) => {
		const statements = findings.map((f, i) => ({
			sql: `INSERT INTO findings (job_id, seq, service, resource, category, detail, saving, recommendation, meta)
				  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			args: [
				id,
				startSeq + i,
				f.service,
				f.resource,
				f.category,
				f.detail,
				Number(f.est_monthly_saving_usd) || 0,
				f.recommendation,
				f.meta ? JSON.stringify(f.meta) : null,
			],
		}));
		
		await db.batch(statements);
		return findings.length;
	});
}

export async function nextSeq(id: string): Promise<number> {
	return withDb(async (db) => {
		const result = await db.execute({
			sql: "SELECT COALESCE(MAX(seq), -1) + 1 AS n FROM findings WHERE job_id = ?",
			args: [id],
		});
		return (result.rows[0]?.n as number) ?? 0;
	});
}

export async function getFindings(id: string): Promise<Finding[]> {
	return withDb(async (db) => {
		const result = await db.execute({
			sql: "SELECT service, resource, category, detail, saving, recommendation, meta FROM findings WHERE job_id = ? ORDER BY seq",
			args: [id],
		});
		return result.rows.map((r) => {
			const f: Finding = {
				service: r.service as string,
				resource: r.resource as string,
				category: r.category as string,
				detail: r.detail as string,
				est_monthly_saving_usd: r.saving as number,
				recommendation: r.recommendation as string,
			};
			if (r.meta) f.meta = JSON.parse(r.meta as string);
			return f;
		});
	});
}

export function buildSummary(payload: Payload, docxAvailable: boolean): Summary {
	const total = round2(payload.findings.reduce((s, f) => s + (Number(f.est_monthly_saving_usd) || 0), 0));
	const liveTotal = round2(Object.values(payload.live_cost_by_service).reduce((s, v) => s + (Number(v) || 0), 0));
	return {
		findings_count: payload.findings.length,
		total_savings: total,
		live_cost_total: liveTotal,
		region: payload.region,
		date: payload.date,
		lookback_days: payload.lookback_days,
		cost_note: payload.cost_note,
		docx_available: docxAvailable,
	};
}

export async function finalizeJob(id: string): Promise<void> {
	await withDb(async (db) => {
		const rowResult = await db.execute({
			sql: "SELECT * FROM jobs WHERE id = ?",
			args: [id],
		});
		const row = rowResult.rows[0] as typeof rowResult.rows[0] | undefined;
		if (!row) return;
		
		const aggResult = await db.execute({
			sql: "SELECT COUNT(*) AS c, COALESCE(SUM(saving), 0) AS s FROM findings WHERE job_id = ?",
			args: [id],
		});
		const agg = aggResult.rows[0] as { c: number; s: number } | undefined;
		
		let liveTotal = 0;
		try {
			liveTotal = Object.values(JSON.parse(row.cost as string ?? "{}") as Record<string, number>).reduce((a, v) => a + (Number(v) || 0), 0);
		} catch {
			liveTotal = 0;
		}
		const summary: Summary = {
			findings_count: agg?.c ?? 0,
			total_savings: round2(agg?.s ?? 0),
			live_cost_total: round2(liveTotal),
			region: row.region as string ?? "aws",
			date: (row.created_at as string).slice(0, 10),
			lookback_days: row.days as number ?? 14,
			cost_note: row.cost_note as string ?? "",
			docx_available: false,
		};
		await db.execute({
			sql: "UPDATE jobs SET status = 'done', progress = 100, summary = ?, finished_at = ? WHERE id = ?",
			args: [JSON.stringify(summary), nowIso(), id],
		});
	});
}

export async function failJob(id: string, error: string): Promise<void> {
	await withDb(async (db) => {
		await db.execute({
			sql: "UPDATE jobs SET status = 'error', error = ?, finished_at = ? WHERE id = ?",
			args: [error, nowIso(), id],
		});
	});
}

export async function jobView(id: string): Promise<Job | null> {
	return withDb(async (db) => {
		const rowResult = await db.execute({
			sql: "SELECT * FROM jobs WHERE id = ?",
			args: [id],
		});
		const row = rowResult.rows[0] as typeof rowResult.rows[0] | undefined;
		if (!row) return null;
		let logs: string[] = [];
		try {
			logs = JSON.parse(row.logs as string) as string[];
		} catch {
			logs = [];
		}
		const view: Job = {
			job_id: row.id as string,
			status: row.status as JobStatus,
			progress: row.progress as number,
			logs: logs.slice(-VIEW_LOGS),
		};
		if (row.started_at) view.started_at = row.started_at as string;
		if (row.finished_at) view.finished_at = row.finished_at as string;
		if (row.summary) {
			try {
				view.summary = JSON.parse(row.summary as string) as Summary;
			} catch {
				/* ignore malformed summary */
			}
		}
		if (row.error) view.error = row.error as string;
		if (row.status === "done") view.payload = await payloadFor(db, row);
		return view;
	});
}

async function payloadFor(db: Client, row: typeof rowResult.rows[0]): Promise<Payload> {
	let cost: Record<string, number> = {};
	try {
		cost = JSON.parse(row.cost as string ?? "{}") as Record<string, number>;
	} catch {
		cost = {};
	}
	const findings = await getFindings(row.id as string);
	return {
		date: (row.created_at as string).slice(0, 10),
		region: row.region as string ?? "aws",
		lookback_days: row.days as number ?? 14,
		live_cost_by_service: cost,
		cost_note: row.cost_note as string ?? "",
		findings,
	};
}

export async function cleanupOld(now: number = Date.now()): Promise<void> {
	const cutoff = new Date(now - TTL_MS).toISOString();
	await withDb(async (db) => {
		await db.batch([
			{ sql: "DELETE FROM findings WHERE job_id IN (SELECT id FROM jobs WHERE created_at < ?)", args: [cutoff] },
			{ sql: "DELETE FROM jobs WHERE created_at < ?", args: [cutoff] },
		]);
	});
}

export { getDb as db };
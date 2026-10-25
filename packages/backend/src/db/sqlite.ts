/**
 * SQLite job store — uses Bun's built-in SQLite (bun:sqlite).
 * Falls back to better-sqlite3 for Node.js (tests).
 */
import type { Finding, Job, JobStatus, Payload, Summary } from "../types";
import { round2 } from "../report/format";
import { todayIso } from "../report/format";
import { randomId } from "./jobs";
import { packMeta, unpackMeta } from "./findingrow";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DB_DIR = process.env.DB_DIR || "./data";
const DB_PATH = `${DB_DIR}/audit.db`;

mkdirSync(DB_DIR, { recursive: true });

// Use Bun's native SQLite or better-sqlite3 for Node
let db: any;

const isBun = typeof Bun !== "undefined";

if (isBun) {
	// Bun native SQLite
	const { Database } = await import("bun:sqlite");
	db = new Database(DB_PATH);
	db.exec("PRAGMA journal_mode = WAL");
	db.exec("PRAGMA foreign_keys = ON");
} else {
	// Node.js (tests) - use better-sqlite3
	const Database = (await import("better-sqlite3")).default;
	db = new Database(DB_PATH);
	db.pragma("journal_mode = WAL");
	db.pragma("foreign_keys = ON");
}

db.exec(`
CREATE TABLE IF NOT EXISTS jobs (
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
CREATE INDEX IF NOT EXISTS jobs_created_at ON jobs(created_at);

CREATE TABLE IF NOT EXISTS findings (
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
CREATE INDEX IF NOT EXISTS findings_job ON findings(job_id);
`);

const TTL_MS = 30 * 60 * 1000;
const MAX_LOGS = 200;
const VIEW_LOGS = 50;

function nowIso(): string {
	return new Date().toISOString();
}

export function createJob(opts: { id: string; region: string; days: number }): void {
	db.prepare(
		`INSERT INTO jobs (id, status, progress, logs, region, days, created_at)
		 VALUES (?, 'running', 0, '["Queued..."]', ?, ?, ?)`
	).run(opts.id, opts.region, opts.days, nowIso());
}

export function getRow(id: string) {
	return db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as
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
}

export function markStarted(id: string): void {
	db.prepare("UPDATE jobs SET started_at = ? WHERE id = ? AND started_at IS NULL").run(nowIso(), id);
}

export function appendLog(id: string, line: string): void {
	const row = getRow(id);
	if (!row) return;
	let logs: string[] = [];
	try {
		logs = JSON.parse(row.logs) as string[];
	} catch {
		logs = [];
	}
	logs.push(line);
	if (logs.length > MAX_LOGS) logs = logs.slice(-MAX_LOGS);
	db.prepare("UPDATE jobs SET logs = ? WHERE id = ?").run(JSON.stringify(logs), id);
}

export function setProgress(id: string, progress: number, step: string): void {
	db.prepare("UPDATE jobs SET progress = ?, step = ? WHERE id = ?").run(progress, step, id);
}

export function setCost(id: string, cost: Record<string, number>, note: string): void {
	db.prepare("UPDATE jobs SET cost = ?, cost_note = ? WHERE id = ?").run(JSON.stringify(cost), note, id);
}

export function insertFindings(id: string, findings: Finding[], startSeq: number): number {
	if (findings.length === 0) return 0;
	const stmt = db.prepare(
		`INSERT INTO findings (job_id, seq, service, resource, category, detail, saving, recommendation, meta)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
	);
	const insertMany = db.transaction((rows: Finding[]) => {
		let seq = startSeq;
		for (const f of rows) {
			stmt.run(
				id,
				seq++,
				f.service,
				f.resource,
				f.category,
				f.detail,
				Number(f.est_monthly_saving_usd) || 0,
				f.recommendation,
				packMeta(f)
			);
		}
	});
	insertMany(findings);
	return findings.length;
}

export function nextSeq(id: string): number {
	const row = db.prepare("SELECT COALESCE(MAX(seq), -1) + 1 AS n FROM findings WHERE job_id = ?").get(id) as { n: number } | undefined;
	return row?.n ?? 0;
}

export function getFindings(id: string): Finding[] {
	const rows = db.prepare(
		"SELECT service, resource, category, detail, saving, recommendation, meta FROM findings WHERE job_id = ? ORDER BY seq"
	).all(id) as {
		service: string;
		resource: string;
		category: string;
		detail: string;
		saving: number;
		recommendation: string;
		meta: string | null;
	}[];
	return rows.map((r) => ({
		service: r.service,
		resource: r.resource,
		category: r.category,
		detail: r.detail,
		est_monthly_saving_usd: r.saving,
		recommendation: r.recommendation,
		...unpackMeta(r.meta),
	}));
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

export function finalizeJob(id: string): void {
	const row = getRow(id);
	if (!row) return;
	const agg = db.prepare("SELECT COUNT(*) AS c, COALESCE(SUM(saving), 0) AS s FROM findings WHERE job_id = ?").get(id) as { c: number; s: number };
	let liveTotal = 0;
	try {
		liveTotal = Object.values(JSON.parse(row.cost ?? "{}") as Record<string, number>).reduce((a, v) => a + (Number(v) || 0), 0);
	} catch {
		liveTotal = 0;
	}
	const summary: Summary = {
		findings_count: agg?.c ?? 0,
		total_savings: round2(agg?.s ?? 0),
		live_cost_total: round2(liveTotal),
		region: row.region ?? "aws",
		date: row.created_at.slice(0, 10),
		lookback_days: row.days ?? 14,
		cost_note: row.cost_note ?? "",
		docx_available: false,
	};
	db.prepare(
		"UPDATE jobs SET status = 'done', progress = 100, summary = ?, finished_at = ? WHERE id = ?"
	).run(JSON.stringify(summary), nowIso(), id);
}

export function failJob(id: string, error: string): void {
	db.prepare("UPDATE jobs SET status = 'error', error = ?, finished_at = ? WHERE id = ?").run(error, nowIso(), id);
}

export function jobView(id: string): Job | null {
	const row = getRow(id);
	if (!row) return null;
	let logs: string[] = [];
	try {
		logs = JSON.parse(row.logs) as string[];
	} catch {
		logs = [];
	}
	const view: Job = {
		job_id: row.id,
		status: row.status as JobStatus,
		progress: row.progress,
		logs: logs.slice(-VIEW_LOGS),
	};
	if (row.started_at) view.started_at = row.started_at;
	if (row.finished_at) view.finished_at = row.finished_at;
	if (row.summary) {
		try {
			view.summary = JSON.parse(row.summary) as Summary;
		} catch {
			/* ignore malformed summary */
		}
	}
	if (row.error) view.error = row.error;
	if (row.status === "done") view.payload = payloadFor(row);
	return view;
}

function payloadFor(row: ReturnType<typeof getRow>): Payload {
	let cost: Record<string, number> = {};
	try {
		cost = JSON.parse(row!.cost ?? "{}") as Record<string, number>;
	} catch {
		cost = {};
	}
	return {
		date: row!.created_at.slice(0, 10),
		region: row!.region ?? "aws",
		lookback_days: row!.days ?? 14,
		live_cost_by_service: cost,
		cost_note: row!.cost_note ?? "",
		findings: getFindings(row!.id),
	};
}

export function cleanupOld(now: number = Date.now()): void {
	const cutoff = new Date(now - TTL_MS).toISOString();
	db.prepare("DELETE FROM findings WHERE job_id IN (SELECT id FROM jobs WHERE created_at < ?)").run(cutoff);
	db.prepare("DELETE FROM jobs WHERE created_at < ?").run(cutoff);
}

export { db };
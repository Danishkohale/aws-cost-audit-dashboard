/**
 * Job store — unified interface using libSQL (Turso).
 * Works with both remote Turso and local file database.
 */
import type { Finding, Job, JobStatus, Payload, Summary } from "../types";
import { round2 } from "../report/format";

// Re-export from the libSQL implementation
export * from "./libsql";

/** Mirrors REPORT_TTL_SEC = 30 min in app.py. */
export const TTL_MS = 30 * 60 * 1000;

/** Python caps stored logs implicitly; we cap at 200 and return the last 50. */
export const MAX_LOGS = 200;
export const VIEW_LOGS = 50;

/** URL-safe random id (replaces Python `uuid.uuid4().hex[:12]`). */
export function randomId(bytes = 6): string {
	const arr = new Uint8Array(bytes);
	crypto.getRandomValues(arr);
	return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
}

function nowIso(): string {
	return new Date().toISOString();
}

/** Build summary from payload. */
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
/**
 * Small shared helpers for the AWS layer.
 */
import { round2 } from "../report/format";

/**
 * Port of `detailed_audit.py:61-70` `_age_days()`.
 * Returns the whole-day age of a timestamp, or `null` when unavailable.
 */
export function ageDays(dt?: Date | string | null): number | null {
	if (dt === null || dt === undefined) return null;
	try {
		const d = dt instanceof Date ? dt : new Date(dt);
		const t = d.getTime();
		if (!Number.isFinite(t)) return null;
		return Math.floor((Date.now() - t) / 86_400_000);
	} catch {
		return null;
	}
}

/** YYYY-MM-DD for a Date (UTC), matching `datetime.date.isoformat()`. */
export function isoDate(d: Date): string {
	return d.toISOString().slice(0, 10);
}

/** `datetime.date.today()` in UTC. */
export function todayUtc(): Date {
	return new Date();
}

/** `end - timedelta(days=n)`. */
export function minusDays(d: Date, n: number): Date {
	return new Date(d.getTime() - n * 86_400_000);
}

/** Python `str(exception)` — the message only, without the "Error: " prefix. */
export function errMsg(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

export { round2 };

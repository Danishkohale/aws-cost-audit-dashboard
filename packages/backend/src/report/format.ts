/**
 * Number/date formatting helpers that reproduce the Python report output.
 *
 * Python formats money as `f"{v:,.2f}"` (thousands separators, 2 decimals) and
 * prints raw numbers with `str()`. JS numbers cannot distinguish `18.0` from
 * `18`, so `pyNum` appends `.0` to integers to match Python's `str(float)` in
 * the common case. This is a documented, intentional deviation for values the
 * Python source literally wrote as integers (see plan.md risks).
 */

/** Python `f"{v:,.2f}"` — e.g. 182.4 → "182.40", 2.0 → "2.00". */
export function money(n: number | string | null | undefined): string {
	const v = Number(n ?? 0) || 0;
	return v.toLocaleString("en-US", {
		minimumFractionDigits: 2,
		maximumFractionDigits: 2,
	});
}

/** Python `str()` for a float — e.g. 18 → "18.0", 0.48 → "0.48". */
export function pyNum(n: number | string | null | undefined): string {
	if (typeof n === "string") return n;
	const v = Number(n ?? 0);
	if (!Number.isFinite(v)) return String(n ?? "");
	return Number.isInteger(v) ? `${v}.0` : String(v);
}

/**
 * Python `str()` for an arbitrary interpolated value — `None` for null/undefined,
 * `True`/`False` for booleans, and the plain number/string otherwise.
 */
export function pyStr(v: unknown): string {
	if (v === null || v === undefined) return "None";
	if (typeof v === "boolean") return v ? "True" : "False";
	return String(v);
}

/**
 * Python `str()` for a value that came from the AWS JSON as an **integer**
 * (Size, VolumeSize, AllocatedStorage, …). Python prints `100`, not `100.0`.
 */
export function raw(v: number | string | null | undefined): string {
	return String(v ?? "");
}

/** Python `str(bool)` → "True" / "False" (JS would print "true"/"false"). */
export function pyBool(v: boolean | null | undefined): string {
	return v ? "True" : "False";
}

/**
 * Python `str(datetime)` for an aware UTC datetime → "2026-01-01 00:00:00+00:00".
 * Returns "None" for a null/undefined value, matching Python.
 */
export function pyDate(v: Date | string | null | undefined): string {
	if (v === null || v === undefined) return "None";
	const d = v instanceof Date ? v : new Date(v);
	if (Number.isNaN(d.getTime())) return String(v);
	const pad = (x: number) => String(x).padStart(2, "0");
	return (
		`${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
		`${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}+00:00`
	);
}

/** Python `f"{v:.1f}"`. */
export function f1(v: number | null | undefined): string {
	return (Number(v) || 0).toFixed(1);
}

/** Python `f"{v:.0f}"`. */
export function f0(v: number | null | undefined): string {
	return (Number(v) || 0).toFixed(0);
}

/** Python `f"{v:.2f}"`. */
export function f2(v: number | null | undefined): string {
	return (Number(v) || 0).toFixed(2);
}

/** Python `f"{int(v):,}"` — truncated integer with thousands separators. */
export function comma(v: number | null | undefined): string {
	return Math.trunc(Number(v) || 0).toLocaleString("en-US");
}

/** Python `str(list)` for a list of strings → `['a', 'b']`. */
export function pyList(v: unknown): string {
	if (v === null || v === undefined) return "None";
	if (!Array.isArray(v)) return String(v);
	return "[" + v.map((x) => (typeof x === "string" ? `'${x}'` : String(x))).join(", ") + "]";
}

/** Python `datetime.date.today().isoformat()` (local date) → "YYYY-MM-DD". */
export function todayIso(now: Date = new Date()): string {
	const y = now.getFullYear();
	const m = String(now.getMonth() + 1).padStart(2, "0");
	const d = String(now.getDate()).padStart(2, "0");
	return `${y}-${m}-${d}`;
}

/** Python `round(x, 2)` equivalent (matches pricing.round2). */
export function round2(n: number): number {
	return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * Finding ⇄ DB row serialization, shared by the libSQL and SQLite stores.
 *
 * The structured recommendation (`rec`) has no column of its own — it rides
 * inside the existing `meta` JSON column under a reserved `__rec` key and is
 * unpacked transparently on read, so no schema migration is needed.
 */
import type { Finding } from "../types";

const REC_KEY = "__rec";

/** Serialize a finding's meta + rec into the single `meta` JSON column value. */
export function packMeta(f: Finding): string | null {
	if (!f.meta && !f.rec) return null;
	const packed: Record<string, unknown> = { ...f.meta };
	if (f.rec) packed[REC_KEY] = f.rec;
	return JSON.stringify(packed);
}

/** Rebuild meta + rec from the serialized `meta` column value. */
export function unpackMeta(raw: unknown): Pick<Finding, "meta" | "rec"> {
	if (!raw) return {};
	try {
		const obj = JSON.parse(String(raw)) as Record<string, unknown>;
		if (!obj || typeof obj !== "object") return {};
		const rec = obj[REC_KEY];
		const rest = { ...obj };
		delete rest[REC_KEY];
		return {
			meta: rest as Finding["meta"],
			rec: rec && typeof rec === "object" ? (rec as Finding["rec"]) : undefined,
		};
	} catch {
		return {};
	}
}

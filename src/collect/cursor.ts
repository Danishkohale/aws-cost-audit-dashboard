/**
 * Opaque resume cursors for the chunked fan-out.
 *
 * The browser treats these as tokens: it echoes whatever the previous call
 * returned. Internally they carry the resource offset plus the per-step
 * accumulator (e.g. S3's lifecycle counters) that must survive between chunks.
 */
import type { ScanRange } from "../aws/range";

export function encodeCursor(next: number | null, state?: unknown): string | null {
	if (next === null) return null;
	return JSON.stringify(state === undefined ? { o: next } : { o: next, s: state });
}

export function decodeCursor(cursor: string | null | undefined): ScanRange | undefined {
	if (!cursor) return undefined;
	try {
		const parsed = JSON.parse(cursor) as { o?: unknown; s?: unknown };
		const offset = Number(parsed.o);
		if (!Number.isFinite(offset)) return undefined;
		return { offset, limit: 0, state: parsed.s };
	} catch {
		return undefined;
	}
}

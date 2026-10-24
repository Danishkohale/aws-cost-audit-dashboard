/**
 * Chunking primitives for the Free-plan fan-out.
 *
 * Cloudflare's Free plan allows 50 subrequests per invocation, so no single
 * request may scan an unbounded number of resources. Every scanner therefore
 * accepts an optional `ScanRange` describing which slice of its resource list to
 * process, and returns the offset to resume from.
 *
 * Omitting `range` means "scan everything" — that is how `runAwsAudit()` keeps
 * the original whole-account behaviour (and its tests) intact.
 */
import { paginateAll, paginateSome } from "./paginate";

/** Upper bound on how many resources one chunked call will list. */
export const MAX_LIST = 1000;

export interface ScanRange {
	/** Index of the first resource to process. */
	offset: number;
	/** How many resources to process (may be `Infinity`). */
	limit: number;
	/** Optional per-step accumulator carried between chunks. */
	state?: unknown;
}

export interface ScanResult {
	/** Resume offset, or `null` when this step is finished. */
	next: number | null;
	/** Accumulator to hand back on the next chunk. */
	state?: unknown;
}

export interface Sliced<T> {
	items: T[];
	next: number | null;
}

/** `offset === 0` short-circuits the "one-off" work each step does first. */
export function isFirst(range?: ScanRange): boolean {
	return (range?.offset ?? 0) === 0;
}

/** Slice a fully-materialised list according to `range`. */
export function sliceList<T>(all: T[], range?: ScanRange): Sliced<T> {
	const offset = range?.offset ?? 0;
	if (!range || !Number.isFinite(range.limit)) {
		return { items: all.slice(offset), next: null };
	}
	const items = all.slice(offset, offset + range.limit);
	const consumed = offset + items.length;
	return { items, next: consumed < all.length ? consumed : null };
}

/**
 * List just enough resources to serve this slice, plus one to detect whether
 * more remain. Unbounded (full) listing when `range` is omitted.
 */
export async function fetchList<T>(
	paginator: AsyncIterable<unknown>,
	key: string,
	range?: ScanRange,
): Promise<T[]> {
	if (!range || !Number.isFinite(range.limit)) return paginateAll<T>(paginator, key);
	const want = Math.min(range.offset + range.limit + 1, MAX_LIST);
	return paginateSome<T>(paginator, key, want);
}

/** A bounded full listing for steps that are never chunked. */
export async function fetchAllBounded<T>(
	paginator: AsyncIterable<unknown>,
	key: string,
	max: number = MAX_LIST,
): Promise<T[]> {
	return paginateSome<T>(paginator, key, max);
}

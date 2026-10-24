/**
 * Pagination helpers — port of `cost-optimization.py:55-64` `paginate()`.
 *
 * SDK v3 exposes named paginators (`paginateDescribeVolumes`, …). We pass the
 * returned async-iterable through `guardClient`, so each page's underlying
 * `send()` is still validated by the read-only allowlist.
 *
 * `paginateSome()` exists for the chunked (Free-plan) path: it stops after
 * `maxItems` so a single invocation can never walk an unbounded list and blow
 * the 50-subrequest budget.
 */
export async function paginateAll<T>(paginator: AsyncIterable<unknown>, key: string): Promise<T[]> {
	const items: T[] = [];
	for await (const page of paginator) {
		const value = (page as Record<string, unknown>)[key];
		if (Array.isArray(value)) items.push(...(value as T[]));
	}
	return items;
}

/** Like `paginateAll`, but stops fetching pages once `maxItems` is reached. */
export async function paginateSome<T>(
	paginator: AsyncIterable<unknown>,
	key: string,
	maxItems: number,
): Promise<T[]> {
	const items: T[] = [];
	if (maxItems <= 0) return items;
	for await (const page of paginator) {
		const value = (page as Record<string, unknown>)[key];
		if (Array.isArray(value)) items.push(...(value as T[]));
		if (items.length >= maxItems) break;
	}
	return items;
}

/**
 * Finding helpers — ports of the two `add()` variants in the Python source.
 *
 * - `addFinding`  ← `cost-optimization.py:126-130` (base scan). Does **not** round.
 * - `addDetail`   ← `detailed_audit.py:43-51` (deep scan). Rounds to 2dp and
 *                   attaches the optional `meta` object.
 */
import type { Finding, FindingMeta } from "../types";
import { round2 } from "../report/format";

export function addFinding(
	findings: Finding[],
	service: string,
	resource: string,
	category: string,
	detail: string,
	saving: number,
	action: string,
): void {
	findings.push({
		service,
		resource,
		category,
		detail,
		est_monthly_saving_usd: saving,
		recommendation: action,
	});
}

export function addDetail(
	findings: Finding[],
	service: string,
	resource: string,
	category: string,
	detail: string,
	saving: number,
	action: string,
	meta?: FindingMeta,
): void {
	const row: Finding = {
		service,
		resource,
		category,
		detail,
		est_monthly_saving_usd: round2(Number(saving) || 0),
		recommendation: action,
	};
	if (meta) row.meta = meta;
	findings.push(row);
}

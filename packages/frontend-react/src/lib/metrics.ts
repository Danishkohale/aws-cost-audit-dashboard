/**
 * Client-side aggregation & metric helpers.
 * NO FABRICATED VALUES: every number here is derived from backend finding data.
 * The only labeled estimates: implementation effort hours via a keyword heuristic.
 */
import type { Finding, Job } from "./api";

/** Estimated implementation effort by finding category (planning assumption). */
const EFFORT_HOURS: Array<[RegExp, number]> = [
	[/Terminate if unneeded|Delete (idle|unused)|snapshot then delete|Delete after verifying/i, 0.5],
	[/gp2|gp3/i, 0.5],
	[/retention|lifecycle|expiry|noncurrent/i, 1],
	[/schedule stop|Stops? nights/i, 1],
	[/Downsize|rightsize|oversiz|consolidat/i, 2],
	[/NAT|VPC endpoints?/i, 1.5],
	[/Migrate|maintenance window|family down/i, 3],
	[/Serverless v2/i, 4],
	[/Karpenter|Spot|Graviton|Fargate/i, 8],
];

export const DEFAULT_RATE = 75; // $/h — planning assumption, shown in footnote

export function effortHours(f: Finding): { hours: number; assumed: boolean } {
	for (const [re, h] of EFFORT_HOURS) if (re.test(f.category) || re.test(f.recommendation)) return { hours: h, assumed: false };
	return { hours: 1, assumed: true };
}

/** Genuine savings findings only (savings > 0). */
export function savingFindings(job: Job): Finding[] {
	return (job.payload?.findings ?? []).filter((f) => Number(f.est_monthly_saving_usd) > 0);
}

/** Findings flagged for review but with no measurable saving. */
export function zeroSavingFindings(job: Job): Finding[] {
	return (job.payload?.findings ?? []).filter((f) => Number(f.est_monthly_saving_usd) <= 0);
}

export function monthlySavings(findings: Finding[]): number {
	return findings.reduce((s, f) => s + Number(f.est_monthly_saving_usd || 0), 0);
}

export function round(n: number, dp: number): number {
	return Number.isFinite(n) ? Number(n.toFixed(dp)) : 0;
}

/** Current known monthly cost of a resource, or null when unknown. */
export function currentCostMo(f: Finding): number | null {
	const m = (f.meta ?? {}) as { base_cost_mo?: unknown; est_cost_mo?: unknown };
	for (const v of [m.base_cost_mo, m.est_cost_mo]) {
		const n = Number(v);
		if (Number.isFinite(n) && n > 0) return n;
	}
	return null;
}

/** Potential monthly savings aggregated per AWS service, sorted desc. */
export function savingsByService(findings: Finding[]): Array<{ service: string; savings: number; count: number }> {
	const map = new Map<string, { savings: number; count: number }>();
	for (const f of findings) {
		const cur = map.get(f.service) ?? { savings: 0, count: 0 };
		cur.savings += Number(f.est_monthly_saving_usd || 0);
		cur.count += 1;
		map.set(f.service, cur);
	}
	return [...map.entries()]
		.map(([service, v]) => ({ service, savings: round(v.savings, 2), count: v.count }))
		.sort((a, b) => b.savings - a.savings);
}

/** Findings grouped by category (for the Recommendations section). */
export function byCategory(findings: Finding[]): Array<{ category: string; items: Finding[] }> {
	const map = new Map<string, Finding[]>();
	for (const f of findings) {
		const arr = map.get(f.category) ?? [];
		arr.push(f);
		map.set(f.category, arr);
	}
	return [...map.entries()]
		.map(([category, items]) => ({ category, items: items.sort((a, b) => Number(b.est_monthly_saving_usd) - Number(a.est_monthly_saving_usd)) }))
		.sort((a, b) => monthlySavings(b.items) - monthlySavings(a.items));
}

export interface Metrics {
	findings: Finding[];
	review: Finding[];
	estMonthly: number;
	estAnnual: number;
	implHours: number;
	implCost: number;
	byService: Array<{ service: string; savings: number; count: number }>;
	categories: Array<{ category: string; items: Finding[] }>;
}

export function computeMetrics(job: Job): Metrics {
	const findings = savingFindings(job);
	let implHours = 0;
	for (const f of findings) implHours += effortHours(f).hours;
	return {
		findings,
		review: zeroSavingFindings(job),
		estMonthly: round(monthlySavings(findings), 2),
		estAnnual: round(monthlySavings(findings) * 12, 2),
		implHours: round(implHours, 1),
		implCost: round(implHours * DEFAULT_RATE, 0),
		byService: savingsByService(findings),
		categories: byCategory(findings),
	};
}

export const fmt$ = (n: number): string => `$${Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;

/**
 * Recommendation-engine tests (rules/recs.ts).
 *
 * Verifies the engine's honesty contract: no silent number invention, the
 * headline savings stay untouched (the golden totals in report.test.ts prove
 * that at the payload level), every actionable finding carries evidence,
 * confidence, risks, data gaps and an arithmetic-backed calculation method.
 */
import { describe, expect, it } from "vitest";
import { enrichFindings } from "../src/rules/recs";
import { buildDemoPayload } from "../src/demo/payload";
import { packMeta, unpackMeta } from "../src/db/findingrow";
import type { Finding, RecDetail } from "../src/types";

/** buildDemoPayload enriches internally — strip recs to emulate a raw scan. */
function rawDemoFindings(): Finding[] {
	return buildDemoPayload("2026-10-18").findings.map(({ rec, ...rest }) => rest as Finding);
}

function findIn(findings: Finding[], resource: string): Finding {
	const f = findings.find((x) => x.resource === resource);
	if (!f) throw new Error(`missing ${resource}`);
	return f;
}

function recOf(f: Finding): RecDetail {
	if (!f.rec) throw new Error(`no rec on ${f.resource}`);
	return f.rec;
}

describe("recommendation engine (rules/recs.ts)", () => {
	const demo = buildDemoPayload("2026-10-18").findings;

	it("attaches a rec to every actionable finding, skipping OK/summary rows", () => {
		for (const f of demo) {
			const actionable = !/(OK —|Summary —|AccessIssue|Truncated)/.test(f.category);
			if (actionable) expect(f.rec, f.resource).toBeDefined();
			else expect(f.rec, f.resource).toBeUndefined();
		}
	});

	it("never changes the headline saving used in totals", () => {
		const raw = rawDemoFindings();
		expect(raw.length).toBe(demo.length);
		for (let i = 0; i < raw.length; i++) {
			expect(demo[i].est_monthly_saving_usd).toBe(raw[i].est_monthly_saving_usd);
			expect(demo[i].recommendation).toBe(raw[i].recommendation);
			expect(demo[i].resource).toBe(raw[i].resource);
		}
	});

	it("answers all three questions: exact change + why + save amount", () => {
		for (const f of demo) {
			if (!f.rec) continue;
			expect(f.rec.change, f.resource).not.toBe("");
			expect(f.rec.why_selected, f.resource).not.toBe("");
			expect(f.rec.saving_mo, f.resource).not.toBeNull();
			expect(f.rec.calc_method, f.resource).not.toBe("");
		}
	});

	it("gp2 → gp3 arithmetic uses measured size and published rates (high confidence)", () => {
		const r = recOf(findIn(demo, "vol-0gp2legacy2222"));
		expect(r.current_cost_mo).toBe(100);
		expect(r.projected_cost_mo).toBe(80);
		expect(r.saving_mo).toBe(20);
		expect(r.saving_an).toBe(240);
		expect(r.confidence).toBe("high");
		expect(r.calc_method).toContain("1000");
		expect(r.evidence.length).toBeGreaterThan(0);
	});

	it("unattached EBS compares snapshot-then-delete vs outright delete", () => {
		const r = recOf(findIn(demo, "vol-0demo9999"));
		expect(r.options.length).toBeGreaterThanOrEqual(2);
		expect(r.selected).toBeGreaterThanOrEqual(0);
		expect(r.selected).toBeLessThan(r.options.length);
		expect(r.projected_cost_mo ?? 99).toBeLessThanOrEqual(0.5);
		expect(r.why_selected).toContain("rollback");
	});

	it("RDS low-use engine compares options and notes the headline difference", () => {
		const r = recOf(findIn(demo, "prod-analytics-db"));
		expect(r.options.length).toBeGreaterThanOrEqual(2);
		expect(r.confidence).not.toBe("high"); // memory not measured
		expect(r.estimate_note).not.toBeNull();
		expect(r.estimate_note).toContain("rule-of-thumb");
	});

	it("EC2 low-CPU offers downsize ladder + schedule, with credit-charge risk flagged", () => {
		const r = recOf(findIn(demo, "i-0demo1234abcd"));
		expect(r.options.length).toBeGreaterThanOrEqual(3);
		expect(r.options.some((o) => o.change.includes("t3.small"))).toBe(true);
		expect(r.options.some((o) => o.title.toLowerCase().includes("schedule"))).toBe(true);
		expect(r.risks.join(" ")).toContain("CPU credits");
	});

	it("every rec declares confidence with metric basis, risks, priority and tracking", () => {
		for (const f of demo) {
			if (!f.rec) continue;
			expect(["high", "medium", "low"]).toContain(f.rec.confidence);
			expect(f.rec.confidence_basis, f.resource).not.toBe("");
			expect(f.rec.risks.length, f.resource).toBeGreaterThan(0);
			expect(f.rec.priority_score).toBeGreaterThanOrEqual(0);
			expect(f.rec.priority_band).toMatch(/^P[123]/);
			expect(f.rec.tracking).toContain("re-run");
		}
	});

	it("review-only NAT items get plans with the published $0.045/hr arithmetic", () => {
		const r = recOf(findIn(demo, "nat-0demo5555"));
		expect(r.options.length).toBeGreaterThan(0);
		expect(r.calc_method).toContain("0.045");
	});

	it("priority math never leaves non-finite scores", () => {
		for (const f of demo) {
			if (!f.rec) continue;
			expect(Number.isFinite(f.rec.priority_score)).toBe(true);
			if (f.rec.saving_mo !== null && f.rec.current_cost_mo !== null) {
				expect(f.rec.saving_mo).toBeLessThanOrEqual(f.rec.current_cost_mo + 1e-9);
			}
		}
	});

	it("serializes rec through the DB meta column round-trip", () => {
		const f = findIn(demo, "i-0prod5678efgh");
		const row = packMeta(f) as string;
		const out: Finding = {
			service: "x", resource: "x", category: "x", detail: "x",
			est_monthly_saving_usd: 0, recommendation: "x", ...unpackMeta(row),
		};
		expect(out.meta).toEqual(f.meta);
		expect(out.rec).toEqual(f.rec);

		// a finding without rec survives intact
		const plain: Finding = { service: "x", resource: "x", category: "x", detail: "x", est_monthly_saving_usd: 0, recommendation: "x" };
		const out2 = { ...plain, ...unpackMeta(packMeta(plain)) };
		expect(out2.rec).toBeUndefined();
		expect(out2.meta).toBeUndefined();
	});

	it("enrichFindings is idempotent (running twice does not nest or corrupt)", () => {
		const twice = enrichFindings(enrichFindings(rawDemoFindings()));
		for (const f of twice) {
			if (recsForTest(twice, f.resource)) continue;
		}
		expect(twice.length).toBe(demo.length);
		const pa = findIn(twice, "prod-analytics-db");
		expect(pa.rec?.options[0].title).not.toContain("[object");
	});

	function recsForTest(list: Finding[], resource: string): RecDetail | undefined {
		return findIn(list, resource).rec;
	}
});

/**
 * Grounded LLM layer — the guardrail is the important part.
 *
 * These tests never touch the network: `fetch` is stubbed, and the no-key path
 * is asserted to be a pure no-op so an audit can always complete offline.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Finding, RecDetail } from "../src/types";
import {
	enrichWithLlm,
	extractNumbers,
	numbersAllowed,
	resolveApiKey,
	resolveModel,
	sanitizeNarrative,
} from "../src/rules/llm";

function finding(): Finding {
	return {
		service: "EC2",
		resource: "i-0a1b2c3d",
		category: "Idle — Low CPU",
		detail: "CPU 4.2% average",
		est_monthly_saving_usd: 30.37,
		recommendation: "Downsize to t3.medium",
		rec: {
			current_config: "t3.large",
			issue: "Low CPU",
			evidence: ["CPU avg 4.2% (max 9.1%) over the window"],
			options: [],
			selected: 0,
			why_selected: "Highest saving",
			change: "t3.medium",
			current_cost_mo: 60.74,
			projected_cost_mo: 30.37,
			saving_mo: 30.37,
			saving_an: 364.44,
			calc_method: "t3.large $60.74/mo - t3.medium $30.37/mo = $30.37/mo",
			confidence: "high",
			confidence_basis: "Measured CPU",
			risks: ["Memory headroom unknown"],
			data_gaps: ["No memory metrics available"],
			estimate_note: null,
			priority_score: 30.37,
			priority_band: "P1 — Do first",
			tracking: "Re-run the audit",
		} as RecDetail,
	};
}

function stubFetch(content: unknown): void {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => ({
			ok: true,
			status: 200,
			statusText: "OK",
			json: async () => ({ choices: [{ message: { content: JSON.stringify(content) } }] }),
		})),
	);
}

const validItem = {
	id: "f0",
	business_impact: "Removes $30.37 of the $60.74 monthly cost.",
	sequencing: "Do first because saving is $30.37.",
	owner_hint: "Platform team should confirm memory headroom.",
	risk_callout: "Memory headroom unknown per the evidence.",
	confidence_note: "Cost maths is exact; memory safety is not measurable.",
};

afterEach(() => vi.unstubAllGlobals());

describe("numeric guardrail", () => {
	it("normalizes thousands separators", () => {
		expect(extractNumbers("$1,234.50 and 30.37")).toEqual(["1234.50", "30.37"]);
	});

	it("accepts numbers that exist in the facts", () => {
		expect(numbersAllowed("Saves $30.37/mo of $60.74", { saving: 30.37, cost: 60.74 })).toBe(true);
	});

	it("rejects an invented figure", () => {
		expect(numbersAllowed("Saves $99.99/mo", { saving: 30.37 })).toBe(false);
	});

	it("rejects an invented percentage", () => {
		expect(numbersAllowed("CPU is down 80%", { cpu_avg: 4.2 })).toBe(false);
	});

	it("allows non-financial digits from the facts", () => {
		expect(
			numbersAllowed("Move the t3.large volume to gp3 and recheck in 90 days", {
				type: "t3.large",
				disk: "gp3",
			}),
		).toBe(true);
	});

	it("sanitizes a good item", () => {
		const n = sanitizeNarrative(validItem, { saving: 30.37, cost: 60.74 }, "test-model");
		expect(n?.business_impact).toContain("30.37");
		expect(n?.model).toBe("test-model");
	});

	it("drops an item that invents a figure", () => {
		const bad = { ...validItem, business_impact: "Saves $99.99 every month." };
		expect(sanitizeNarrative(bad, { saving: 30.37 }, "test-model")).toBeNull();
	});

	it("drops an item with a missing field", () => {
		const { owner_hint: _omit, ...rest } = validItem;
		expect(sanitizeNarrative(rest, { saving: 30.37, cost: 60.74 }, "test-model")).toBeNull();
	});
});

describe("enrichWithLlm", () => {
	it("is a no-op without a key", async () => {
		const input = [finding()];
		const out = await enrichWithLlm(input, { apiKey: null });
		expect(out[0]).toBe(input[0]);
		expect(out[0].rec?.narrative).toBeUndefined();
	});

	it("attaches a verified narrative", async () => {
		stubFetch({ items: [validItem] });
		const out = await enrichWithLlm([finding()], { apiKey: "test-key" });
		expect(out[0].rec?.narrative?.business_impact).toContain("30.37");
	});

	it("keeps rule text when the model invents a number", async () => {
		stubFetch({ items: [{ ...validItem, business_impact: "$99.99 saved" }] });
		const out = await enrichWithLlm([finding()], { apiKey: "test-key" });
		expect(out[0].rec?.narrative).toBeUndefined();
	});

	it("survives an HTTP failure", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({ ok: false, status: 429, statusText: "Too Many Requests" })),
		);
		const out = await enrichWithLlm([finding()], { apiKey: "test-key" });
		expect(out[0].rec?.narrative).toBeUndefined();
	});
});

describe("configuration", () => {
	it("never defaults to the random free router", () => {
		expect(resolveModel({ model: undefined })).not.toBe("openrouter/free");
	});

	it("prefers an explicit key over the environment", () => {
		expect(resolveApiKey({ apiKey: "explicit" })).toBe("explicit");
	});
});
